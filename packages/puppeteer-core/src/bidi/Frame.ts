/**
 * @license
 * Copyright 2023 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Bidi from 'chromium-bidi/protocol/protocol.js';

import type {Observable} from '../../third_party/rxjs/rxjs.js';
import {
  combineLatest,
  defer,
  delayWhen,
  filter,
  first,
  firstValueFrom,
  map,
  of,
  race,
  raceWith,
  switchMap,
} from '../../third_party/rxjs/rxjs.js';
import type {CDPSession} from '../api/CDPSession.js';
import {
  Frame,
  throwIfDetached,
  type GoToOptions,
  type WaitForOptions,
} from '../api/Frame.js';
import {PageEvent} from '../api/Page.js';
import {Accessibility} from '../cdp/Accessibility.js';
import type {ConsoleMessageType} from '../common/ConsoleMessage.js';
import {
  ConsoleMessage,
  type ConsoleMessageLocation,
} from '../common/ConsoleMessage.js';
import {TargetCloseError, UnsupportedOperation} from '../common/Errors.js';
import type {TimeoutSettings} from '../common/TimeoutSettings.js';
import type {Awaitable} from '../common/types.js';
import {
  debugError,
  fromAbortSignal,
  fromEmitterEvent,
  timeout,
} from '../common/util.js';
import {isErrorLike} from '../util/ErrorLike.js';

import {BidiCdpSession} from './CDPSession.js';
import type {BrowsingContext} from './core/BrowsingContext.js';
import type {Navigation} from './core/Navigation.js';
import type {Request} from './core/Request.js';
import {BidiDeserializer} from './Deserializer.js';
import {BidiDialog} from './Dialog.js';
import type {BidiElementHandle} from './ElementHandle.js';
import {ExposableFunction} from './ExposedFunction.js';
import {BidiHTTPRequest, requests} from './HTTPRequest.js';
import type {BidiHTTPResponse} from './HTTPResponse.js';
import {BidiJSHandle} from './JSHandle.js';
import type {BidiPage} from './Page.js';
import type {BidiRealm} from './Realm.js';
import {BidiFrameRealm} from './Realm.js';
import {rewriteNavigationError} from './util.js';
import {BidiWebWorker} from './WebWorker.js';

// TODO: Remove this and map CDP the correct method.
// Requires breaking change.
function convertConsoleMessageLevel(method: string): ConsoleMessageType {
  switch (method) {
    case 'group':
      return 'startGroup';
    case 'groupCollapsed':
      return 'startGroupCollapsed';
    case 'groupEnd':
      return 'endGroup';
    default:
      return method as ConsoleMessageType;
  }
}

export class BidiFrame extends Frame {
  static from(
    parent: BidiPage | BidiFrame,
    browsingContext: BrowsingContext,
  ): BidiFrame {
    const frame = new BidiFrame(parent, browsingContext);
    frame.#initialize();
    return frame;
  }

  readonly #parent: BidiPage | BidiFrame;
  readonly browsingContext: BrowsingContext;
  readonly #frames = new WeakMap<BrowsingContext, BidiFrame>();
  readonly realms: {default: BidiFrameRealm; internal: BidiFrameRealm};

  override readonly _id: string;
  override readonly client: BidiCdpSession;
  override readonly accessibility: Accessibility;

  private constructor(
    parent: BidiPage | BidiFrame,
    browsingContext: BrowsingContext,
  ) {
    super();
    this.#parent = parent;
    this.browsingContext = browsingContext;

    this._id = browsingContext.id;
    this.client = new BidiCdpSession(this);
    this.realms = {
      default: BidiFrameRealm.from(this.browsingContext.defaultRealm, this),
      internal: BidiFrameRealm.from(
        this.browsingContext.createWindowRealm(
          `__puppeteer_internal_${Math.ceil(Math.random() * 10000)}`,
        ),
        this,
      ),
    };
    this.accessibility = new Accessibility(this.realms.default, this._id);
  }

  #initialize(): void {
    for (const browsingContext of this.browsingContext.children) {
      this.#createFrameTarget(browsingContext);
    }

    this.browsingContext.on('browsingcontext', ({browsingContext}) => {
      this.#createFrameTarget(browsingContext);
    });
    this.browsingContext.on('closed', () => {
      for (const session of BidiCdpSession.sessions.values()) {
        if (session.frame === this) {
          session.onClose();
        }
      }
      this.page().trustedEmitter.emit(PageEvent.FrameDetached, this);
    });

    this.browsingContext.on('request', ({request}) => {
      const httpRequest = BidiHTTPRequest.from(request, this);
      request.once('success', () => {
        this.page().trustedEmitter.emit(PageEvent.RequestFinished, httpRequest);
      });

      request.once('error', () => {
        this.page().trustedEmitter.emit(PageEvent.RequestFailed, httpRequest);
      });
      void httpRequest.finalizeInterceptions();
    });

    this.browsingContext.on('navigation', ({navigation}) => {
      navigation.once('fragment', () => {
        this.page().trustedEmitter.emit(PageEvent.FrameNavigated, this);
      });
    });
    this.browsingContext.on('load', () => {
      this.page().trustedEmitter.emit(PageEvent.Load, undefined);
    });
    this.browsingContext.on('DOMContentLoaded', () => {
      this._hasStartedLoading = true;
      this.page().trustedEmitter.emit(PageEvent.DOMContentLoaded, undefined);
      this.page().trustedEmitter.emit(PageEvent.FrameNavigated, this);
    });

    this.browsingContext.on('userprompt', ({userPrompt}) => {
      this.page().trustedEmitter.emit(
        PageEvent.Dialog,
        BidiDialog.from(userPrompt),
      );
    });

    this.browsingContext.on('log', ({entry}) => {
      if (this._id !== entry.source.context) {
        return;
      }
      if (isConsoleLogEntry(entry)) {
        const args = entry.args.map(arg => {
          return this.mainRealm().createHandle(arg);
        });

        const text = args
          .reduce((value, arg) => {
            const parsedValue =
              arg instanceof BidiJSHandle && arg.isPrimitiveValue
                ? BidiDeserializer.deserialize(arg.remoteValue())
                : arg.toString();
            return `${value} ${parsedValue}`;
          }, '')
          .slice(1);

        this.page().trustedEmitter.emit(
          PageEvent.Console,
          new ConsoleMessage(
            convertConsoleMessageLevel(entry.method),
            text,
            args,
            getStackTraceLocations(entry.stackTrace),
            this,
          ),
        );
      } else if (isJavaScriptLogEntry(entry)) {
        const error = new Error(entry.text ?? '');

        const messageHeight = error.message.split('\n').length;
        const messageLines = error.stack!.split('\n').splice(0, messageHeight);

        const stackLines = [];
        if (entry.stackTrace) {
          for (const frame of entry.stackTrace.callFrames) {
            // Note we need to add `1` because the values are 0-indexed.
            stackLines.push(
              `    at ${frame.functionName || '<anonymous>'} (${frame.url}:${
                frame.lineNumber + 1
              }:${frame.columnNumber + 1})`,
            );
            if (stackLines.length >= Error.stackTraceLimit) {
              break;
            }
          }
        }

        error.stack = [...messageLines, ...stackLines].join('\n');
        this.page().trustedEmitter.emit(PageEvent.PageError, error);
      } else {
        debugError(
          `Unhandled LogEntry with type "${entry.type}", text "${entry.text}" and level "${entry.level}"`,
        );
      }
    });

    this.browsingContext.on('worker', ({realm}) => {
      const worker = BidiWebWorker.from(this, realm);
      realm.on('destroyed', () => {
        this.page().trustedEmitter.emit(PageEvent.WorkerDestroyed, worker);
      });
      this.page().trustedEmitter.emit(PageEvent.WorkerCreated, worker);
    });
  }

  #createFrameTarget(browsingContext: BrowsingContext) {
    const frame = BidiFrame.from(this, browsingContext);
    this.#frames.set(browsingContext, frame);
    this.page().trustedEmitter.emit(PageEvent.FrameAttached, frame);

    browsingContext.on('closed', () => {
      this.#frames.delete(browsingContext);
    });

    return frame;
  }

  get timeoutSettings(): TimeoutSettings {
    return this.page()._timeoutSettings;
  }

  override mainRealm(): BidiFrameRealm {
    return this.realms.default;
  }

  override isolatedRealm(): BidiFrameRealm {
    return this.realms.internal;
  }

  realm(id: string): BidiRealm | undefined {
    for (const realm of Object.values(this.realms)) {
      if (realm.realm.id === id) {
        return realm;
      }
    }
    return;
  }

  override page(): BidiPage {
    let parent = this.#parent;
    while (parent instanceof BidiFrame) {
      parent = parent.#parent;
    }
    return parent;
  }

  override url(): string {
    return this.browsingContext.url;
  }

  override parentFrame(): BidiFrame | null {
    if (this.#parent instanceof BidiFrame) {
      return this.#parent;
    }
    return null;
  }

  override childFrames(): BidiFrame[] {
    return [...this.browsingContext.children].map(child => {
      return this.#frames.get(child)!;
    });
  }

  #detached$() {
    return defer(() => {
      if (this.detached) {
        return of(this as Frame);
      }
      return fromEmitterEvent(
        this.page().trustedEmitter,
        PageEvent.FrameDetached,
      ).pipe(
        filter(detachedFrame => {
          return detachedFrame === this;
        }),
      );
    });
  }

  @throwIfDetached
  override async goto(
    url: string,
    options: GoToOptions = {},
  ): Promise<BidiHTTPResponse | null> {
    const [response] = await Promise.all([
      this.waitForNavigation(options),
      // Some implementations currently only report errors when the
      // readiness=interactive.
      //
      // Related: https://bugzilla.mozilla.org/show_bug.cgi?id=1846601
      this.browsingContext
        .navigate(url, Bidi.BrowsingContext.ReadinessState.Interactive)
        .catch(error => {
          if (
            isErrorLike(error) &&
            error.message.includes('net::ERR_HTTP_RESPONSE_CODE_FAILURE')
          ) {
            return;
          }

          if (error.message.includes('navigation canceled')) {
            return;
          }

          if (
            error.message.includes(
              'Navigation was aborted by another navigation',
            )
          ) {
            return;
          }

          throw error;
        }),
    ]).catch(
      rewriteNavigationError(
        url,
        options.timeout ?? this.timeoutSettings.navigationTimeout(),
      ),
    );
    return response;
  }

  @throwIfDetached
  override async setContent(
    html: string,
    options: WaitForOptions = {},
  ): Promise<void> {
    await Promise.all([
      this.setFrameContent(html),
      firstValueFrom(
        combineLatest([
          this.#waitForLoad$(options),
          this.#waitForNetworkIdle$(options),
        ]),
      ),
    ]);
  }

  @throwIfDetached
  override async waitForNavigation(
    options: WaitForOptions = {},
  ): Promise<BidiHTTPResponse | null> {
    const {timeout: ms = this.timeoutSettings.navigationTimeout(), signal} =
      options;

    const frames = this.childFrames().map(frame => {
      return frame.#detached$();
    });
    return await firstValueFrom(
      combineLatest([
        race(
          fromEmitterEvent(this.browsingContext, 'navigation'),
          fromEmitterEvent(this.browsingContext, 'historyUpdated').pipe(
            map(() => {
              return {navigation: null};
            }),
          ),
        )
          .pipe(first())
          .pipe(
            switchMap(({navigation}) => {
              if (navigation === null) {
                return of(null);
              }
              return this.#waitForLoad$(options).pipe(
                delayWhen(() => {
                  if (frames.length === 0) {
                    return of(undefined);
                  }
                  return combineLatest(frames);
                }),
                raceWith(
                  fromEmitterEvent(navigation, 'fragment'),
                  fromEmitterEvent(navigation, 'failed'),
                  fromEmitterEvent(navigation, 'aborted'),
                ),
                switchMap(() => {
                  if (navigation.request) {
                    function requestFinished$(
                      request: Request,
                    ): Observable<Navigation | null> {
                      if (navigation === null) {
                        return of(null);
                      }
                      // Reduces flakiness if the response events arrive after
                      // the load event.
                      // Usually, the response or error is already there at this point.
                      if (request.response || request.error) {
                        return of(navigation);
                      }
                      if (request.redirect) {
                        return requestFinished$(request.redirect);
                      }
                      return fromEmitterEvent(request, 'success')
                        .pipe(
                          raceWith(fromEmitterEvent(request, 'error')),
                          raceWith(fromEmitterEvent(request, 'redirect')),
                        )
                        .pipe(
                          switchMap(() => {
                            return requestFinished$(request);
                          }),
                        );
                    }
                    return requestFinished$(navigation.request);
                  }
                  return of(navigation);
                }),
              );
            }),
          ),
        this.#waitForNetworkIdle$(options),
      ]).pipe(
        map(([navigation]) => {
          if (!navigation) {
            return null;
          }
          const request = navigation.request;
          if (!request) {
            return null;
          }
          const lastRequest = request.lastRedirect ?? request;
          const httpRequest = requests.get(lastRequest)!;
          return httpRequest.response();
        }),
        raceWith(
          timeout(ms),
          fromAbortSignal(signal),
          this.#detached$().pipe(
            map(() => {
              throw new TargetCloseError('Frame detached.');
            }),
          ),
        ),
      ),
    );
  }

  override waitForDevicePrompt(): never {
    throw new UnsupportedOperation();
  }

  override get detached(): boolean {
    return this.browsingContext.closed;
  }

  #exposedFunctions = new Map<string, ExposableFunction<never[], unknown>>();
  async exposeFunction<Args extends unknown[], Ret>(
    name: string,
    apply: (...args: Args) => Awaitable<Ret>,
  ): Promise<void> {
    if (this.#exposedFunctions.has(name)) {
      throw new Error(
        `Failed to add page binding with name ${name}: globalThis['${name}'] already exists!`,
      );
    }
    const exposable = await ExposableFunction.from(this, name, apply);
    this.#exposedFunctions.set(name, exposable);
  }

  async removeExposedFunction(name: string): Promise<void> {
    const exposedFunction = this.#exposedFunctions.get(name);
    if (!exposedFunction) {
      throw new Error(
        `Failed to remove page binding with name ${name}: window['${name}'] does not exists!`,
      );
    }

    this.#exposedFunctions.delete(name);
    await exposedFunction[Symbol.asyncDispose]();
  }

  async createCDPSession(): Promise<CDPSession> {
    if (!this.page().browser().cdpSupported) {
      throw new UnsupportedOperation();
    }

    const cdpConnection = this.page().browser().cdpConnection!;
    return await cdpConnection._createSession({targetId: this._id});
  }

  @throwIfDetached
  #waitForLoad$(options: WaitForOptions = {}): Observable<void> {
    let {waitUntil = 'load'} = options;
    const {timeout: ms = this.timeoutSettings.navigationTimeout()} = options;

    if (!Array.isArray(waitUntil)) {
      waitUntil = [waitUntil];
    }

    const events = new Set<'load' | 'DOMContentLoaded'>();
    for (const lifecycleEvent of waitUntil) {
      switch (lifecycleEvent) {
        case 'load': {
          events.add('load');
          break;
        }
        case 'domcontentloaded': {
          events.add('DOMContentLoaded');
          break;
        }
      }
    }
    if (events.size === 0) {
      return of(undefined);
    }

    return combineLatest(
      [...events].map(event => {
        return fromEmitterEvent(this.browsingContext, event);
      }),
    ).pipe(
      map(() => {}),
      first(),
      raceWith(
        timeout(ms),
        this.#detached$().pipe(
          map(() => {
            throw new Error('Frame detached.');
          }),
        ),
      ),
    );
  }

  @throwIfDetached
  #waitForNetworkIdle$(options: WaitForOptions = {}): Observable<void> {
    let {waitUntil = 'load'} = options;
    if (!Array.isArray(waitUntil)) {
      waitUntil = [waitUntil];
    }

    let concurrency = Infinity;
    for (const event of waitUntil) {
      switch (event) {
        case 'networkidle0': {
          concurrency = Math.min(0, concurrency);
          break;
        }
        case 'networkidle2': {
          concurrency = Math.min(2, concurrency);
          break;
        }
      }
    }
    if (concurrency === Infinity) {
      return of(undefined);
    }

    return this.page().waitForNetworkIdle$({
      idleTime: 500,
      timeout: options.timeout ?? this.timeoutSettings.timeout(),
      concurrency,
    });
  }

  @throwIfDetached
  async setFiles(element: BidiElementHandle, files: string[]): Promise<void> {
    await this.browsingContext.setFiles(
      // SAFETY: ElementHandles are always remote references.
      element.remoteValue() as Bidi.Script.SharedReference,
      files,
    );
  }

  @throwIfDetached
  async locateNodes(
    element: BidiElementHandle,
    locator: Bidi.BrowsingContext.Locator,
  ): Promise<Bidi.Script.NodeRemoteValue[]> {
    return await this.browsingContext.locateNodes(
      locator,
      // SAFETY: ElementHandles are always remote references.
      [element.remoteValue() as Bidi.Script.SharedReference],
    );
  }
}

function isConsoleLogEntry(
  event: Bidi.Log.Entry,
): event is Bidi.Log.ConsoleLogEntry {
  return event.type === 'console';
}

function isJavaScriptLogEntry(
  event: Bidi.Log.Entry,
): event is Bidi.Log.JavascriptLogEntry {
  return event.type === 'javascript';
}

function getStackTraceLocations(
  stackTrace?: Bidi.Script.StackTrace,
): ConsoleMessageLocation[] {
  const stackTraceLocations: ConsoleMessageLocation[] = [];
  if (stackTrace) {
    for (const callFrame of stackTrace.callFrames) {
      stackTraceLocations.push({
        url: callFrame.url,
        lineNumber: callFrame.lineNumber,
        columnNumber: callFrame.columnNumber,
      });
    }
  }
  return stackTraceLocations;
}

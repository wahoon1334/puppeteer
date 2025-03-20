/**
 * @license
 * Copyright 2023 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type Protocol from 'devtools-protocol';

import type {EventType} from '../common/EventEmitter.js';

import type {CdpFrame} from './Frame.js';
import type {IsolatedWorld} from './IsolatedWorld.js';

const FrameAttached = Symbol('FrameManager.FrameAttached');
const FrameNavigated = Symbol('FrameManager.FrameNavigated');
const FrameDetached = Symbol('FrameManager.FrameDetached');
const FrameSwapped = Symbol('FrameManager.FrameSwapped');
const LifecycleEvent = Symbol('FrameManager.LifecycleEvent');
const FrameNavigatedWithinDocument = Symbol(
  'FrameManager.FrameNavigatedWithinDocument',
);
const ConsoleApiCalled = Symbol('FrameManager.ConsoleApiCalled');
const BindingCalled = Symbol('FrameManager.BindingCalled');

/**
 * We use symbols to prevent external parties listening to these events.
 * They are internal to Puppeteer.
 *
 * @internal
 */
export const FrameManagerEvent = {
  FrameAttached,
  FrameNavigated,
  FrameDetached,
  FrameSwapped,
  LifecycleEvent,
  FrameNavigatedWithinDocument,
  ConsoleApiCalled,
  BindingCalled,
} as const;

/**
 * @internal
 */
export interface FrameManagerEvents extends Record<EventType, unknown> {
  [FrameManagerEvent.FrameAttached]: CdpFrame;
  [FrameManagerEvent.FrameNavigated]: CdpFrame;
  [FrameManagerEvent.FrameDetached]: CdpFrame;
  [FrameManagerEvent.FrameSwapped]: CdpFrame;
  [FrameManagerEvent.LifecycleEvent]: CdpFrame;
  [FrameManagerEvent.FrameNavigatedWithinDocument]: CdpFrame;
  // Emitted when a new console message is logged.
  [FrameManagerEvent.ConsoleApiCalled]: [
    IsolatedWorld,
    Protocol.Runtime.ConsoleAPICalledEvent,
  ];
  [FrameManagerEvent.BindingCalled]: [
    IsolatedWorld,
    Protocol.Runtime.BindingCalledEvent,
  ];
}

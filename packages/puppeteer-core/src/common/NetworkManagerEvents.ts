/**
 * @license
 * Copyright 2022 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import type {HTTPRequest} from '../api/HTTPRequest.js';
import type {HTTPResponse} from '../api/HTTPResponse.js';

import type {EventType} from './EventEmitter.js';

const Request = Symbol('NetworkManager.Request');
const RequestServedFromCache = Symbol('NetworkManager.RequestServedFromCache');
const Response = Symbol('NetworkManager.Response');
const RequestFailed = Symbol('NetworkManager.RequestFailed');
const RequestFinished = Symbol('NetworkManager.RequestFinished');
/**
 * We use symbols to prevent any external parties listening to these events.
 * They are internal to Puppeteer.
 *
 * @internal
 */
export const NetworkManagerEvent = {
  Request,
  RequestServedFromCache,
  Response,
  RequestFailed,
  RequestFinished,
} as const;

/**
 * @internal
 */
export interface NetworkManagerEvents extends Record<EventType, unknown> {
  [NetworkManagerEvent.Request]: HTTPRequest;
  [NetworkManagerEvent.RequestServedFromCache]: HTTPRequest;
  [NetworkManagerEvent.Response]: HTTPResponse;
  [NetworkManagerEvent.RequestFailed]: HTTPRequest;
  [NetworkManagerEvent.RequestFinished]: HTTPRequest;
}

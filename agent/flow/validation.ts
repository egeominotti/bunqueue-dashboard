import type { FlowJobTarget, FlowMutationOperation } from './types';
import { readLimitedJsonBody } from '../server/jsonBody';

const MAX_PROGRESS_JSON_BYTES = 65_536;
const MAX_PROGRESS_DEPTH = 32;
const MAX_PROGRESS_VALUES = 10_000;
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_FLOW_BODY_BYTES = 1024 * 1024;

export interface FlowProgressWireValue {
  progress: number;
  message?: string;
}

export function validateFlowTarget(target: FlowJobTarget): void {
  if (!target.id || target.id.length > 1024) {
    throw new Error('Flow job id must contain 1–1024 characters');
  }
  if (!target.queueName || target.queueName.length > 256) {
    throw new Error('Flow queue name must contain 1–256 characters');
  }
}

export function validateParentIds(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 1_000) {
    throw new Error('Flow parent IDs must contain between 1 and 1000 entries');
  }
  for (const id of value) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 1024) {
      throw new Error('Each Flow parent ID must contain 1–1024 characters');
    }
  }
}

export function validateMutationPayload(
  operation: FlowMutationOperation,
  payload: Record<string, unknown>
): void {
  const keys: Partial<Record<FlowMutationOperation, readonly string[]>> = {
    updateData: ['data'],
    updateProgress: ['progress', 'message'],
    log: ['message'],
    changeDelay: ['delay'],
    changePriority: ['priority', 'lifo'],
    clearLogs: ['keepLogs'],
  };
  const allowed = keys[operation] ?? [];
  const unknown = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown Flow ${operation} option: ${unknown[0]}`);
  if (operation === 'updateData' && !Object.hasOwn(payload, 'data')) {
    throw new Error('Flow updateData requires data');
  }
  if (operation === 'updateProgress') validateProgress(payload);
  if (
    operation === 'log' &&
    (typeof payload.message !== 'string' || payload.message.length > 65_536)
  ) {
    throw new Error('Flow log message must be a string of at most 65536 characters');
  }
  if (operation === 'changeDelay') {
    boundedInteger(payload.delay, 'delay', 10 * 365 * 24 * 60 * 60 * 1_000);
  }
  if (operation === 'changePriority') {
    boundedInteger(payload.priority, 'priority', 2_147_483_647);
    if (payload.lifo !== undefined && typeof payload.lifo !== 'boolean') {
      throw new Error('Flow lifo must be boolean');
    }
  }
  if (operation === 'clearLogs' && payload.keepLogs !== undefined) {
    boundedInteger(payload.keepLogs, 'keepLogs', 1_000_000);
  }
}

export function asFlowRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Flow request must be an object');
  }
  return value as Record<string, unknown>;
}

export function assertExactFlowKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown Flow ${label} option: ${unknown}`);
}

export async function readFlowJsonBody(request: Request): Promise<unknown> {
  return readLimitedJsonBody(request, {
    scope: 'Flow',
    maxBytes: MAX_FLOW_BODY_BYTES,
    limitLabel: '1 MiB',
    invalidContentLengthMessage: 'Flow Content-Length must be an integer',
  });
}

export function assertNoFlowBody(request: Request): void {
  const declared = request.headers.get('content-length');
  if (request.body !== null || (declared !== null && declared !== '0')) {
    throw new Error('This Flow operation does not accept a request body');
  }
}

export function assertFlowBodySize(value: unknown): void {
  if (JSON.stringify(value).length > MAX_FLOW_BODY_BYTES) {
    throw new Error('Flow request exceeds 1 MiB');
  }
}

export function normalizeFlowProgressPayload(
  payload: Record<string, unknown>
): FlowProgressWireValue {
  const value = payload.progress;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error('Flow progress must be a number from 0 to 100 or a JSON object');
    }
    const message = optionalProgressMessage(payload.message);
    return message === undefined ? { progress: value } : { progress: value, message };
  }
  if (!isPlainRecord(value)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      throw new Error('Flow progress object must use only plain JSON objects and arrays');
    }
    throw new Error('Flow progress must be a number from 0 to 100 or a JSON object');
  }
  if (payload.message !== undefined) {
    throw new Error('Flow progress message is only supported with numeric progress');
  }
  validateJsonValue(value, new WeakSet(), { count: 0 }, 0);
  const message = JSON.stringify(value);
  if (new TextEncoder().encode(message).byteLength > MAX_PROGRESS_JSON_BYTES) {
    throw new Error(`Flow progress object must encode to at most ${MAX_PROGRESS_JSON_BYTES} bytes`);
  }
  return { progress: 0, message };
}

function validateProgress(payload: Record<string, unknown>): void {
  normalizeFlowProgressPayload(payload);
}

function optionalProgressMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength > MAX_PROGRESS_JSON_BYTES
  ) {
    throw new Error('Flow progress message must be a string of at most 65536 bytes');
  }
  return value;
}

function validateJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
  budget: { count: number },
  depth: number
): void {
  budget.count += 1;
  if (budget.count > MAX_PROGRESS_VALUES) {
    throw new Error(`Flow progress object may contain at most ${MAX_PROGRESS_VALUES} values`);
  }
  if (depth > MAX_PROGRESS_DEPTH) {
    throw new Error(`Flow progress object may be at most ${MAX_PROGRESS_DEPTH} levels deep`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Flow progress object must contain valid JSON');
    return;
  }
  if (typeof value !== 'object') throw new Error('Flow progress object must contain valid JSON');
  if (ancestors.has(value)) throw new Error('Flow progress object must not contain cycles');
  if (!Array.isArray(value) && !isPlainRecord(value)) {
    throw new Error('Flow progress object must use only plain JSON objects and arrays');
  }
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('Flow progress object must use only plain JSON objects and arrays');
  }
  ancestors.add(value);
  validateJsonProperties(value, ancestors, budget, depth);
  ancestors.delete(value);
}

function validateJsonProperties(
  value: object,
  ancestors: WeakSet<object>,
  budget: { count: number },
  depth: number
): void {
  if (Array.isArray(value)) validateJsonArrayShape(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string' || UNSAFE_JSON_KEYS.has(key)) {
      throw new Error('Flow progress object contains an unsafe property name');
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Flow progress object must contain plain enumerable JSON values');
    }
    validateJsonValue(descriptor.value, ancestors, budget, depth + 1);
  }
}

function validateJsonArrayShape(value: unknown[]): void {
  if (value.length > MAX_PROGRESS_VALUES) {
    throw new Error(`Flow progress object may contain at most ${MAX_PROGRESS_VALUES} values`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index) || !Object.hasOwn(value, index))
  ) {
    throw new Error('Flow progress object must contain dense arrays without extra properties');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedInteger(value: unknown, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`Flow ${label} must be an integer from 0 to ${maximum}`);
  }
}

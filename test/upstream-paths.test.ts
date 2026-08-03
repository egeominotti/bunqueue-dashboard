import { describe, expect, test } from 'bun:test';
import {
  decodedHttpPathError,
  decodedHttpPathSegment,
  eventQueuePathSegment,
  opaqueHttpIdError,
  opaqueHttpPathSegment,
  queueHttpPathError,
  queueHttpPathSegment,
} from '../src/lib/upstreamPaths';

const ORIGIN = 'https://queue.example';

describe('upstream HTTP path segments', () => {
  test('refuses job dot segments before WHATWG URL parsing can retarget the request', () => {
    expect(new URL('/jobs/.', ORIGIN).pathname).toBe('/jobs/');
    expect(new URL('/jobs/..', ORIGIN).pathname).toBe('/');

    for (const id of ['.', '..', '%2e', '%2E', '.%2e', '.%2E', '%2e.', '%2E.', '%2e%2e']) {
      expect(opaqueHttpIdError(id)).toContain('path traversal segment');
      expect(() => opaqueHttpPathSegment(id)).toThrow('path traversal segment');
    }
  });

  test('keeps every HTTP-addressable opaque job character byte-for-byte', () => {
    const id = "AZaz09._~!$&'()*+,;=:@%[]|-";
    expect(opaqueHttpIdError(id)).toBeNull();
    expect(opaqueHttpPathSegment(id)).toBe(id);
    expect(new URL(`/jobs/${opaqueHttpPathSegment(id)}`, ORIGIN).pathname).toBe(`/jobs/${id}`);
  });

  test('rejects every ASCII character that cannot remain one opaque route segment', () => {
    for (const id of ['has space', 'has/slash', 'has\\backslash', 'has?query', 'has#fragment']) {
      expect(opaqueHttpIdError(id)).not.toBeNull();
      expect(() => opaqueHttpPathSegment(id)).toThrow();
    }
  });

  test('encodes decoded queue routes but keeps the non-decoding event suffix raw', () => {
    const queue = 'orders:eu.1';
    const encoded = queueHttpPathSegment(queue);
    expect(encoded).toBe('orders%3Aeu.1');

    const queueRoute = new URL(`/queues/${encoded}/jobs/list`, ORIGIN);
    expect(queueRoute.pathname).toBe('/queues/orders%3Aeu.1/jobs/list');
    expect(decodeURIComponent(queueRoute.pathname.split('/')[2] ?? '')).toBe(queue);

    const eventRoute = new URL(`/events/queues/${eventQueuePathSegment(queue)}`, ORIGIN);
    expect(eventRoute.pathname).toBe('/events/queues/orders:eu.1');
  });

  test('refuses queue dot segments consistently for decoded and event routes', () => {
    expect(new URL('/queues/./pause', ORIGIN).pathname).toBe('/queues/pause');
    expect(new URL('/events/queues/..', ORIGIN).pathname).toBe('/events/');

    for (const queue of ['.', '..']) {
      expect(queueHttpPathError(queue)).toContain('path traversal segment');
      expect(() => queueHttpPathSegment(queue)).toThrow('path traversal segment');
      expect(() => eventQueuePathSegment(queue)).toThrow('path traversal segment');
    }
  });

  test('decoded resource routes preserve punctuation and reject untransportable values', () => {
    expect(decodedHttpPathSegment('name/with spaces:%', 'Cron name')).toBe(
      'name%2Fwith%20spaces%3A%25'
    );
    expect(decodedHttpPathError('.', 'Cron name')).toContain('path traversal segment');
    expect(decodedHttpPathError('..', 'Custom job ID')).toContain('path traversal segment');
    expect(decodedHttpPathError('\ud800', 'Database table')).toContain('valid Unicode');
    expect(() => decodedHttpPathSegment('.', 'Cron name')).toThrow('path traversal segment');
  });
});

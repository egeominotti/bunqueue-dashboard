import { describe, expect, test } from 'bun:test';
import {
  decodeWorkflowObject,
  decodeWorkflowValue,
  jsonSafeWorkflowValue,
} from '../agent/workflow/codec';

// Frozen with msgpackr 1.12.1 new Packr({ structuredClone: true }), matching
// bunqueue 2.9.20's workflow/storeCodec. Keep these independent of the installed
// encoder: persisted SQLite BLOBs must survive a dashboard dependency upgrade.
// The input has the values asserted below; order and repeatedOrder reference the
// same { orderId: 'ord_1' } object. The second fixture is { self: <itself> }.
const legacyInput = Buffer.from(
  '1HJAmaZhbW91bnSoZW5vcm1vdXOqcmVjZWl2ZWRBdKZsYWJlbHOqYXR0cmlidXRlc6VieXRlc6hjb3VudGVyc6VvcmRlcq1yZXBlYXRlZE9yZGVy' +
    '0wAgAAAAAAABxyhCAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEdb/at9AwNRzAJKoYXBwcm92ZWSkcGFpZIGmcmVnaW9uomV1' +
    'xwR0AQAB/8cFdAQBAP//1mkAAAAB1HJBkadvcmRlcklkpW9yZF8x1nAAAAAB',
  'base64'
);
const legacyCycle = Buffer.from('1mkAAAAB1HJAkaRzZWxm1nAAAAAB', 'base64');
const cap = 4096;

describe('persisted workflow MessagePack compatibility', () => {
  test('preserves legacy input extensions and repeated object identity', () => {
    const value = decodeWorkflowObject(legacyInput, cap, 'input');

    expect(value.amount).toBe(9007199254740993n);
    expect(value.enormous).toBe(
      115792089237316195423570985008687907853269984665640564039457584007913129639953n
    );
    expect(value.receivedAt).toEqual(new Date('2026-10-26T12:00:00.000Z'));
    expect(value.labels).toBeInstanceOf(Set);
    expect(value.labels).toEqual(new Set(['approved', 'paid']));
    expect(value.attributes).toBeInstanceOf(Map);
    expect(value.attributes).toEqual(new Map([['region', 'eu']]));
    expect(value.bytes).toBeInstanceOf(Uint8Array);
    expect(value.bytes).toEqual(new Uint8Array([0, 1, 255]));
    expect(value.counters).toBeInstanceOf(Uint16Array);
    expect(value.counters).toEqual(new Uint16Array([1, 65535]));
    expect(value.order).toEqual({ orderId: 'ord_1' });
    expect(value.repeatedOrder).toBe(value.order);
  });

  test('normalizes legacy extensions into lossless JSON-safe workflow input', () => {
    const value = jsonSafeWorkflowValue(decodeWorkflowValue(legacyInput, cap, 'input'));

    // Repeated references are not cycles and must remain inspectable over HTTP.
    expect(JSON.parse(JSON.stringify(value))).toEqual({
      amount: '9007199254740993',
      enormous: '115792089237316195423570985008687907853269984665640564039457584007913129639953',
      receivedAt: '2026-10-26T12:00:00.000Z',
      labels: ['approved', 'paid'],
      attributes: { region: 'eu' },
      bytes: '<binary 3 B>',
      counters: { 0: 1, 1: 65535 },
      order: { orderId: 'ord_1' },
      repeatedOrder: { orderId: 'ord_1' },
    });
  });

  test('rejects a decoded legacy cycle before serializing workflow detail', () => {
    const value = decodeWorkflowObject(legacyCycle, cap, 'input');

    expect(value.self).toBe(value);
    expect(() => jsonSafeWorkflowValue(value)).toThrow('Workflow detail contains a cyclic value');
  });
});

import { describe, expect, test } from 'bun:test';
import { toCsv } from '../src/lib/exportFile';

describe('toCsv', () => {
  test('emits header + rows in the given column order', () => {
    const csv = toCsv([{ a: 1, b: 2 }], ['a', 'b']);
    expect(csv).toBe('a,b\n1,2');
  });

  test('quotes cells containing comma, quote, or newline', () => {
    const csv = toCsv([{ a: 'x,y', b: 'he "said"', c: 'line1\nline2' }], ['a', 'b', 'c']);
    expect(csv).toBe('a,b,c\n"x,y","he ""said""","line1\nline2"');
  });

  test('renders null/undefined as empty and serializes objects', () => {
    const csv = toCsv([{ a: null, b: undefined, c: { k: 1 } }], ['a', 'b', 'c']);
    expect(csv).toBe('a,b,c\n,,"{""k"":1}"');
  });

  test('derives the union of keys (first-seen order) when columns omitted', () => {
    const csv = toCsv([{ a: 1 }, { b: 2, a: 3 }]);
    expect(csv).toBe('a,b\n1,\n3,2');
  });

  test('an empty row set still emits the header', () => {
    expect(toCsv([], ['a', 'b'])).toBe('a,b');
  });

  test('neutralizes formula-injection in text cells but not numeric ones', () => {
    // A string starting with a formula trigger gets a leading apostrophe.
    expect(toCsv([{ a: '=SUM(A1)' }], ['a'])).toBe("a\n'=SUM(A1)");
    expect(toCsv([{ a: '@cmd' }], ['a'])).toBe("a\n'@cmd");
    // A negative NUMBER is left intact (still a number, not a formula).
    expect(toCsv([{ a: -5 }], ['a'])).toBe('a\n-5');
    // A leading-dash STRING is guarded (could be a formula in a spreadsheet).
    expect(toCsv([{ a: '-5+1' }], ['a'])).toBe("a\n'-5+1");
  });
});

/**
 * Regression tests for the Control ▸ Database SQLite inspector helpers
 * (src/pages/control/Database.tsx). Only the pure helpers plus `download` are
 * covered here — the row-detail drawer's stale-`full` reset and the full-table
 * export cap live inside React components / async loops and stay untested.
 */
import { describe, expect, test } from 'bun:test';
import { csvEscape, download, pretty, toCsv } from '../src/pages/control/Database';
import { ensureDom } from './domSetup';

describe('csvEscape', () => {
  test('neutralizes the classic = + - @ formula triggers', () => {
    expect(csvEscape('=1+1')).toBe("'=1+1");
    expect(csvEscape('+x')).toBe("'+x");
    expect(csvEscape('-x')).toBe("'-x");
    expect(csvEscape('@x')).toBe("'@x");
  });

  test('neutralizes a leading TAB or CR, which Excel strips before evaluating', () => {
    // Regression: the escaper used /^[=+\-@]/ and let \t=HYPERLINK(...) through raw.
    expect(csvEscape('\t=HYPERLINK("http://evil.example","x")')).toBe(
      '"\'\t=HYPERLINK(""http://evil.example"",""x"")"'
    );
    expect(csvEscape("\r=cmd|'/c calc'!A1")).toBe("\"'\r=cmd|'/c calc'!A1\"");
  });

  test('leaves numbers untouched and still quotes comma/quote/newline cells', () => {
    expect(csvEscape(-5)).toBe('-5');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('he said "hi"')).toBe('"he said ""hi"""');
  });

  test('toCsv escapes header cells too', () => {
    expect(toCsv(['\tcol'], [['v']])).toBe("'\tcol\nv");
  });
});

describe('pretty', () => {
  test('still expands embedded JSON objects and arrays', () => {
    expect(pretty('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(pretty(' [1,2]')).toBe('[\n  1,\n  2\n]');
  });

  test('shows scalar strings verbatim instead of JSON round-tripping them', () => {
    // Regression: JSON.parse/stringify rewrote stored values in an inspector.
    expect(pretty('1.50')).toBe('1.50');
    expect(pretty('12345678901234567890')).toBe('12345678901234567890');
    expect(pretty('1e3')).toBe('1e3');
    expect(pretty('"quoted"')).toBe('"quoted"');
  });

  test('NULL and non-strings keep their existing rendering', () => {
    expect(pretty(null)).toBe('NULL');
    expect(pretty(undefined)).toBe('NULL');
    expect(pretty(42)).toBe('42');
  });
});

describe('download', () => {
  test('attaches the anchor and defers revoking the object URL past the click', async () => {
    ensureDom();
    const created: string[] = [];
    const revoked: string[] = [];
    const url = globalThis.URL as unknown as {
      createObjectURL: (b: Blob) => string;
      revokeObjectURL: (u: string) => void;
    };
    const prevCreate = url.createObjectURL;
    const prevRevoke = url.revokeObjectURL;
    url.createObjectURL = () => {
      const u = `blob:test-${created.length}`;
      created.push(u);
      return u;
    };
    url.revokeObjectURL = (u: string) => revoked.push(u);
    let attachedAtClick = false;
    try {
      const proto = (globalThis.document.createElement('a') as HTMLAnchorElement)
        .constructor as unknown as { prototype: { click: () => void } };
      const prevClick = proto.prototype.click;
      proto.prototype.click = function patched(this: HTMLAnchorElement) {
        attachedAtClick = this.isConnected;
      };
      try {
        download('x.csv', 'text/csv', 'a,b');
      } finally {
        proto.prototype.click = prevClick;
      }
      expect(attachedAtClick).toBe(true);
      // Regression: the URL used to be revoked synchronously, in the same task.
      expect(revoked).toEqual([]);
      await new Promise((r) => setTimeout(r, 5));
      expect(revoked).toEqual(created);
      expect(globalThis.document.querySelectorAll('a').length).toBe(0);
    } finally {
      url.createObjectURL = prevCreate;
      url.revokeObjectURL = prevRevoke;
    }
  });
});

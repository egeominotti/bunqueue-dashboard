import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { downloadCsv, downloadFile, downloadJson } from '../src/lib/exportFile';
import { ensureDom } from './domSetup';

const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let originalClick: typeof window.HTMLAnchorElement.prototype.click;
let files: Blob[];
let clicked: { anchor: HTMLAnchorElement; href: string; filename: string; connected: boolean }[];
let revoked: string[];
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  ensureDom();
  files = [];
  clicked = [];
  revoked = [];
  originalClick = window.HTMLAnchorElement.prototype.click;
  // Keep Blob construction and DOM attachment/removal real; intercept only browser downloads.
  URL.createObjectURL = (blob) => {
    files.push(blob as Blob);
    return `blob:download-safety-${files.length}`;
  };
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  window.HTMLAnchorElement.prototype.click = function () {
    clicked.push({
      anchor: this,
      href: this.href,
      filename: this.download,
      connected: this.isConnected,
    });
  };
});

afterEach(async () => {
  // Flush the helper's deferred cleanup before restoring the browser boundary.
  await nextTick();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  window.HTMLAnchorElement.prototype.click = originalClick;
});

const payload = 'name: "<script>alert(\'東京 🐈\')</script> & café"\r\nvalue: "<&>"\n';

describe('download MIME safety', () => {
  for (const mime of [undefined, 'application/yaml;charset=utf-8']) {
    test(`rewraps an incoming HTML Blob using ${mime ?? 'the default MIME'}`, async () => {
      const incoming = new Blob([payload], { type: 'text/html' });
      downloadFile('literal.yml', incoming, mime);
      expect(files).toHaveLength(1);
      expect(files[0].type).toBe(mime ?? 'application/octet-stream');
      expect(files[0]).not.toBe(incoming);
      expect(await files[0].bytes()).toEqual(new TextEncoder().encode(payload));
    });
  }

  for (const mime of [
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/javascript',
    'application/javascript',
    'application/pdf',
    'application/json;charset=utf-8',
    'text/plain;charset=iso-8859-1',
    'text/csv;charset=utf-8;foo=bar',
    '',
  ]) {
    test(`downloads unsupported requested MIME ${JSON.stringify(mime)} as binary`, async () => {
      downloadFile('literal.data', payload, mime);
      expect(files[0].type).toBe('application/octet-stream');
      expect(await files[0].bytes()).toEqual(new TextEncoder().encode(payload));
    });
  }

  // Bun's real Blob canonicalizes bare JSON/plain types by appending its UTF-8 charset.
  for (const [mime, expectedType] of [
    ['application/octet-stream', 'application/octet-stream'],
    ['application/json', 'application/json;charset=utf-8'],
    ['application/yaml', 'application/yaml'],
    ['application/yaml;charset=utf-8', 'application/yaml;charset=utf-8'],
    ['text/csv', 'text/csv'],
    ['text/csv;charset=utf-8', 'text/csv;charset=utf-8'],
    ['text/plain', 'text/plain;charset=utf-8'],
    ['text/plain;charset=utf-8', 'text/plain;charset=utf-8'],
  ]) {
    test(`preserves literal Unicode and HTML-like bytes with allowed MIME ${mime}`, async () => {
      downloadFile('literal.data', payload, mime);
      expect(files[0].type).toBe(expectedType);
      expect(await files[0].bytes()).toEqual(new TextEncoder().encode(payload));
    });
  }

  test('normalizes only casing and outer whitespace before checking the MIME allowlist', () => {
    downloadFile('literal.yml', payload, '  APPLICATION/YAML;CHARSET=UTF-8  ');
    expect(files[0].type).toBe('application/yaml;charset=utf-8');
    downloadFile('literal.html', payload, ' TEXT/HTML ');
    expect(files[1].type).toBe('application/octet-stream');
  });

  test('preserves arbitrary Blob and typed-array bytes when the MIME is unsupported', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 60, 62]);
    downloadFile('raw.bin', new Blob([bytes], { type: 'image/svg+xml' }), 'text/html');
    downloadFile('raw.bin', bytes, 'text/html');
    for (const file of files) {
      expect(file.type).toBe('application/octet-stream');
      expect(await file.bytes()).toEqual(new Uint8Array([0, 255, 128, 13, 10, 60, 62]));
    }
  });

  test('attaches and clicks the named download, removes its anchor, then revokes its URL', async () => {
    downloadFile('東京 <report>.yaml', payload, 'application/yaml');
    expect(clicked).toHaveLength(1);
    expect(clicked[0].filename).toBe('東京 <report>.yaml');
    expect(clicked[0].href).toBe('blob:download-safety-1');
    expect(clicked[0].connected).toBe(true);
    expect(clicked[0].anchor.isConnected).toBe(false);
    expect(revoked).toEqual([]);
    await nextTick();
    expect(revoked).toEqual(['blob:download-safety-1']);
  });

  test('keeps JSON and CSV serialization, formula protection, and filename suffixes intact', async () => {
    downloadJson('東京', { value: '<b>café & 🐈</b>' });
    downloadCsv('東京', [{ value: '<b>café & 🐈</b>' }, { value: '=SUM(A1)' }], ['value']);
    expect(files.map((file) => file.type)).toEqual([
      'application/json;charset=utf-8',
      'text/csv;charset=utf-8',
    ]);
    expect(await files[0].text()).toBe('{\n  "value": "<b>café & 🐈</b>"\n}');
    expect(await files[1].text()).toBe("value\n<b>café & 🐈</b>\n'=SUM(A1)");
    expect(clicked.map((item) => item.filename)).toEqual(['東京.json', '東京.csv']);
  });

  test('does not drop an empty export', async () => {
    downloadFile('empty.yml', '', 'application/yaml');
    expect(files[0].type).toBe('application/yaml');
    expect(await files[0].text()).toBe('');
    expect(clicked[0].filename).toBe('empty.yml');
  });
});

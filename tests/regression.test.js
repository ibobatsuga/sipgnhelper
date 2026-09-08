'use strict';

// Defects found by auditing the code rather than by extending the happy path.
// Each test here reproduced a real failure against the code as it stood before
// the accompanying fix, so each one is a genuine guard and not a restatement of
// what already worked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { callHandler, bukuPayload } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browserAvailable = fs.existsSync(CHROME) && (() => {
  try { require.resolve('playwright'); return true; } catch { return false; }
})();

// ---------------------------------------------------------------------------
// 1. A belanja book keyed by an inherited Object property
//
// The dispatch table is a plain object literal, so `BELANJA_TEMPLATES[key]`
// also answers for everything on Object.prototype. "constructor" returned the
// Object function — truthy, so the `if (!templateName) return` skip did not
// fire — and the value was then handed to getWorksheet(), which threw a plain
// Error and surfaced as a 500. An unknown key is bad input, not a server
// fault: it has to be skipped exactly like any other unrecognised key.
// ---------------------------------------------------------------------------
const INHERITED_KEYS = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];

for (const key of INHERITED_KEYS) {
  test(`a belanja key of '${key}' is skipped, not answered by Object.prototype`, async () => {
    const payload = bukuPayload();
    payload.buku.belanja = [{ key, jenis: 'Bahan Baku', rows: [] }];

    const res = await callHandler(payload);

    assert.notEqual(res.statusCode, 500, `'${key}' was resolved through the prototype chain and crashed the build`);
    assert.equal(res.statusCode, 200, 'an unrecognised belanja key should be skipped, leaving the rest of the book intact');
    assert.ok(res.buffer && res.buffer.length > 0, 'the workbook should still be produced');
  });
}

test('a legitimate belanja key still builds its sheet', async () => {
  const payload = bukuPayload();
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200);
  assert.ok(res.buffer.length > 0);
});

// ---------------------------------------------------------------------------
// 2. The OCR rate limiter got more expensive the harder it was pushed
//
// Every call appended a timestamp, including calls that were already being
// rejected. The per-caller array therefore grew for as long as the flood ran,
// and each rejection re-filtered the whole array — so the cost of saying "no"
// grew with the size of the attack. Rejection has to stay flat.
// ---------------------------------------------------------------------------
const extractHandler = require('../api/receipt/extract.js');

const stubRes = () => ({
  headers: {}, statusCode: 0, body: null,
  setHeader(k, v) { this.headers[k] = v; return this; },
  status(c) { this.statusCode = c; return this; },
  json(p) { this.body = p; return this; },
  send(b) { this.buffer = b; return this; },
});

const hammer = async (ip, times) => {
  let lastStatus = 0;
  for (let i = 0; i < times; i += 1) {
    const res = stubRes();
    await extractHandler({ method: 'POST', headers: { 'x-forwarded-for': ip }, body: {} }, res);
    lastStatus = res.statusCode;
  }
  return lastStatus;
};

test('rejecting a flooding caller does not get more expensive as the flood grows', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';

  try {
    // Saturate one caller, then time a fixed batch of rejections against it and
    // the same batch against a caller seen for the first time. Both are served
    // entirely by the limiter, so the two should cost about the same.
    await hammer('203.0.113.1', 20_000);

    const startSaturated = process.hrtime.bigint();
    const status = await hammer('203.0.113.1', 2_000);
    const saturated = Number(process.hrtime.bigint() - startSaturated) / 1e6;

    const startFresh = process.hrtime.bigint();
    await hammer('203.0.113.99', 2_000);
    const fresh = Number(process.hrtime.bigint() - startFresh) / 1e6;

    assert.equal(status, 429, 'the flooding caller must still be rate limited');

    // Before the fix this ratio measured ~11x and climbed with the flood. The
    // bound is loose enough to survive a noisy CI box but tight enough that
    // unbounded growth cannot slip back in.
    const ratio = saturated / Math.max(fresh, 0.5);
    assert.ok(ratio < 4, `rejecting a saturated caller cost ${ratio.toFixed(1)}x a fresh one (${saturated.toFixed(0)}ms vs ${fresh.toFixed(0)}ms)`);
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('a caller under the limit is still served after a flood from another caller', async () => {
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    await hammer('198.51.100.7', 500);
    const res = stubRes();
    await extractHandler({ method: 'POST', headers: { 'x-forwarded-for': '198.51.100.200' }, body: {} }, res);
    // 400 = it got past the limiter and was judged on its (empty) body.
    assert.equal(res.statusCode, 400, 'an unrelated caller must not inherit another calleris budget');
  } finally {
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
});

// ---------------------------------------------------------------------------
// 3. The one unescaped interpolation in the UI
//
// Every screen is mounted with innerHTML and every field is passed through
// esc() — except the pemasok <option value="">, which interpolated the raw id.
// Ids are generated by uid() today, so nothing reaches it; the existing XSS
// suite passed because it only ever poisoned text fields. That makes it a hole
// in the barrier that no test was watching, which is the thing worth fixing.
// ---------------------------------------------------------------------------
test('an id field cannot break out of the attribute it is rendered into', { skip: browserAvailable ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof renderSetup === 'function');

  const payloads = [
    '"><img src=x onerror="window.__pwned.push(1)">',
    '" onmouseover="window.__pwned.push(1)" x="',
  ];

  for (const payload of payloads) {
    const drawn = await page.evaluate((p) => {
      window.__pwned = [];
      DB.pemasok = [{ id: p, nama: 'Toko Sayur', kontak: '', alamat: '' }];
      DB.pembelian = [{
        id: 'pb1', status: 'draft', pemasokId: p, akunKas: '1100',
        tanggalTransaksi: '2026-08-01', tanggalDiterima: '2026-08-01',
        items: [{ namaBarang: 'Beras', kategori: 'KH', harga: 1000, jumlah: 1, satuan: 'kg', total: 1000 }],
      }];
      const host = document.createElement('div');
      document.body.appendChild(host);
      const screens = ['renderSipgn', 'renderTransaksi', 'renderSetup'];
      for (const name of screens) host.innerHTML = window[name]();
      return screens.length;
    }, payload);

    assert.equal(drawn, 3, 'a screen failed to render');
    await page.waitForTimeout(250);
    const fired = await page.evaluate(() => window.__pwned.length);
    assert.equal(fired, 0, `an id broke out of its attribute and executed ${fired}x: ${payload}`);
  }
});

// ---------------------------------------------------------------------------
// 4. esc() cannot defend a JS string inside an HTML attribute
//
// delBarang('${esc(b.kode)}') looked guarded, and the XSS suite passed, because
// that suite only ever poisoned text fields. A kode is operator-editable, and
// the handler position is decoded twice: esc() turns a quote into &#39;, the
// HTML parser turns it straight back into a quote, and the JS parser then reads
// it as the end of the argument. A single apostrophe was enough to run code.
// ---------------------------------------------------------------------------
const HANDLER_BREAKOUTS = [
  "'); window.__pwned.push(1); ('",
  "\\'); window.__pwned.push(1); ('",
  '&#39;); window.__pwned.push(1); (&#39;',
  '"); window.__pwned.push(1); ("',
];

test('a value rendered into an event handler cannot close the call and run code', { skip: browserAvailable ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof renderSetup === 'function');

  for (const payload of HANDLER_BREAKOUTS) {
    // Rendering alone is not the test: the handler only runs when the operator
    // clicks, so every button drawn from the poisoned row gets clicked.
    const clicked = await page.evaluate((p) => {
      window.__pwned = [];
      DB.barang = [{ kode: p, nama: 'Beras putih', satuan: 'kg', level: 3 }];
      DB.pemasok = [{ id: p, nama: 'Toko', kontak: '', alamat: '' }];
      DB.nominatif = [{
        id: p, nama: 'Personel', departemen: 'Dapur', pekerjaan: 'Pemorsian',
        hari: 1, tarif: 1000, upah: 1000, bpjs: 0, honorPJ: 0, grandTotal: 1000,
      }];
      const host = document.createElement('div');
      document.body.appendChild(host);
      let n = 0;
      for (const screen of ['renderSetup', 'renderTransaksi']) {
        host.innerHTML = window[screen]();
        for (const el of host.querySelectorAll('button, input[type=checkbox]')) {
          try { el.click(); n += 1; } catch (e) { /* handler may reject the id; that is fine */ }
        }
      }
      return n;
    }, payload);

    assert.ok(clicked > 0, 'no handler was exercised, so the test proved nothing');
    await page.waitForTimeout(250);
    const fired = await page.evaluate(() => window.__pwned.length);
    assert.equal(fired, 0, `a handler argument executed ${fired}x: ${payload}`);
  }
});

test('escJs round-trips a value so the handler still receives it verbatim', { skip: browserAvailable ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof escJs === 'function');

  // Escaping is only correct if the handler gets the original string back —
  // otherwise the delete buttons would silently stop matching their row.
  const cases = ['KH.01.001', "Toko A & B <Pusat>", "O'Brien", 'a"b', 'c\\d', 'plain-id_123'];
  const seen = await page.evaluate((values) => {
    const out = [];
    window.__capture = (v) => out.push(v);
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = values
      .map((v) => `<button onclick="__capture('${escJs(v)}')">x</button>`)
      .join('');
    for (const b of host.querySelectorAll('button')) b.click();
    return out;
  }, cases);

  assert.deepEqual(seen, cases, 'a value did not survive the escape/decode round trip');
});

test('a pemasok is still selectable after its id is escaped', { skip: browserAvailable ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof renderSetup === 'function');

  // Escaping must not break the round trip that actually matters: the option
  // the app marks selected has to be the one the browser reports as selected.
  const result = await page.evaluate(() => {
    DB.pemasok = [
      { id: 'abc123', nama: 'Toko A & B <Pusat>', kontak: '', alamat: '' },
      { id: 'def456', nama: 'Toko Kedua', kontak: '', alamat: '' },
    ];
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.innerHTML = `<select id="probe">${pemasokOptions('def456')}</select>`;
    const select = host.querySelector('#probe');
    return {
      value: select.value,
      count: select.options.length,
      firstLabel: select.options[0].textContent,
    };
  });

  assert.equal(result.count, 2, 'both pemasok should be listed');
  assert.equal(result.value, 'def456', 'the selected pemasok id did not survive escaping');
  assert.equal(result.firstLabel, 'Toko A & B <Pusat>', 'the literal supplier name was mangled');
});

'use strict';

// The barang persediaan catalogue: shipped as a default every account holds,
// extendable by hand, and printed into the exported Ref_Brg sheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { callHandler, readGenerated, cellValue, bukuPayload, plain, baseDB } = require('./helpers');

// The catalogue lives above the LAPORAN marker that helpers.js cuts at, but the
// functions that manage it sit below, so this suite loads the whole script.
const loadCatalogueApi = () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  const cut = script.indexOf('// ---------- auth ----------');
  assert.ok(cut > 0, 'auth marker missing from index.html');

  const noop = () => {};
  const sandbox = {
    window: {}, console, setTimeout, setInterval: noop, clearInterval: noop, fetch: noop,
    document: { getElementById: () => null, querySelectorAll: () => [], addEventListener: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    AbortSignal: { timeout: noop },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${script.slice(0, cut)}
    globalThis.__api = {
      DEFAULT_BARANG,
      defaultDB,
      setDB: (value) => { DB = value; },
      getBarang: () => DB.barang,
      subKelompokBarang, namaKelompok, kodeBarangBerikutnya,
    };`, sandbox);
  return sandbox.__api;
};

test('the catalogue ships with the master three levels intact', () => {
  const { DEFAULT_BARANG } = loadCatalogueApi();
  const items = plain(DEFAULT_BARANG);
  assert.equal(items.length, 304);
  assert.equal(items.filter((b) => b.level === 1).length, 6, 'kelompok');
  assert.equal(items.filter((b) => b.level === 2).length, 27, 'sub-kelompok');
  assert.equal(items.filter((b) => b.level === 3).length, 271, 'item');

  assert.deepEqual(items[0], { kode: 'KH', nama: 'KARBOHIDRAT', satuan: '', level: 1 });
  assert.deepEqual(items[2], { kode: 'KH.01.001', nama: 'Beras putih (premium)', satuan: 'kg', level: 3 });
  assert.deepEqual(items[items.length - 1], {
    kode: 'BB.07.099', nama: 'Bahan minuman pendamping-lainnya', satuan: 'pcs', level: 3,
  });

  assert.deepEqual(
    items.filter((b) => b.level === 1).map((b) => b.kode),
    ['KH', 'PH', 'PN', 'SY', 'BU', 'BB'],
  );
  // Every item carries a unit; only the grouping rows are unitless.
  assert.equal(items.filter((b) => b.level === 3 && !b.satuan).length, 0);
  assert.deepEqual(
    [...new Set(items.filter((b) => b.satuan).map((b) => b.satuan))].sort(),
    ['botol', 'dus', 'ikat', 'kg', 'liter', 'pak', 'pcs'],
  );
});

test('every code is unique and sits under a sub-kelompok that exists', () => {
  const { DEFAULT_BARANG } = loadCatalogueApi();
  const items = plain(DEFAULT_BARANG);
  const codes = items.map((b) => b.kode);
  assert.equal(new Set(codes).size, codes.length, 'duplicate kode in the catalogue');

  const groups = new Set(items.filter((b) => b.level <= 2).map((b) => b.kode));
  for (const item of items.filter((b) => b.level === 3)) {
    const parent = item.kode.split('.').slice(0, 2).join('.');
    assert.ok(groups.has(parent), `${item.kode} has no sub-kelompok ${parent}`);
  }
});

test('a fresh account starts with the whole catalogue', () => {
  const api = loadCatalogueApi();
  const fresh = plain(api.defaultDB());
  assert.equal(fresh.barang.length, 304);
  assert.equal(fresh.barang[2].nama, 'Beras putih (premium)');
});

test('a new code fills the first free slot and never lands on 099', () => {
  const api = loadCatalogueApi();
  api.setDB(baseDB({
    barang: [
      { kode: 'KH', nama: 'KARBOHIDRAT', satuan: '', level: 1 },
      { kode: 'KH.01', nama: 'BERAS DAN OLAHAN PADI', satuan: '', level: 2 },
      { kode: 'KH.01.001', nama: 'Beras premium', satuan: 'kg', level: 3 },
      { kode: 'KH.01.003', nama: 'Beras merah', satuan: 'kg', level: 3 },
      { kode: 'KH.01.099', nama: 'Beras lainnya', satuan: 'kg', level: 3 },
    ],
  }));
  // 002 is the gap left between 001 and 003.
  assert.equal(api.kodeBarangBerikutnya('KH.01'), 'KH.01.002');
  assert.equal(api.namaKelompok('KH.01.003'), 'KARBOHIDRAT');
  assert.deepEqual(plain(api.subKelompokBarang()).map((b) => b.kode), ['KH.01']);
});

test('a sub-kelompok whose slots run past 098 keeps counting instead of reusing 099', () => {
  const api = loadCatalogueApi();
  const penuh = [{ kode: 'SY.01', nama: 'SAYUR', satuan: '', level: 2 }];
  for (let n = 1; n <= 98; n += 1) {
    penuh.push({ kode: `SY.01.${String(n).padStart(3, '0')}`, nama: `Sayur ${n}`, satuan: 'kg', level: 3 });
  }
  penuh.push({ kode: 'SY.01.099', nama: 'Sayur lainnya', satuan: 'kg', level: 3 });
  api.setDB(baseDB({ barang: penuh }));
  assert.equal(api.kodeBarangBerikutnya('SY.01'), 'SY.01.100');
});

test('the exported Ref_Brg is written from the account catalogue', async () => {
  const payload = bukuPayload();
  payload.buku.barang.katalog = [
    { kode: 'KH', nama: 'KARBOHIDRAT', satuan: '' },
    { kode: 'KH.01', nama: 'BERAS DAN OLAHAN PADI', satuan: '' },
    { kode: 'KH.01.001', nama: 'Beras putih (premium)', satuan: 'kg' },
    { kode: 'KH.01.900', nama: 'Beras organik lokal', satuan: 'kg' },
  ];
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { workbook } = await readGenerated(res.buffer);
  const sheet = workbook.getWorksheet('Ref_Brg');

  assert.equal(cellValue(sheet, 'A8'), 'KH');
  assert.equal(cellValue(sheet, 'A10'), 'KH.01.001');
  // The item the operator added travels with the workbook.
  assert.equal(cellValue(sheet, 'A11'), 'KH.01.900');
  assert.equal(cellValue(sheet, 'B11'), 'Beras organik lokal');
  assert.equal(cellValue(sheet, 'C11'), 'kg');
  // Rows the shortened catalogue does not reach are cleared, not left holding
  // the master's own items.
  assert.equal(cellValue(sheet, 'A12'), null);
  assert.equal(cellValue(sheet, 'B311'), null);
  // The dependent sheets still line up row for row.
  assert.equal(cellValue(workbook.getWorksheet('Saldo_Brg'), 'A11'), '=IF(Ref_Brg!A11="","",Ref_Brg!A11)');
  assert.equal(cellValue(workbook.getWorksheet('Stock_Brg (D)'), 'A11'), '=IF(Ref_Brg!A11="","",Ref_Brg!A11)');
});

test('a catalogue longer than the master grows its dependent sheets with it', async () => {
  const payload = bukuPayload();
  payload.buku.barang.katalog = Array.from({ length: 340 }, (_, i) => ({
    kode: `XX.01.${String(i + 1).padStart(3, '0')}`, nama: `Barang ${i + 1}`, satuan: 'kg',
  }));
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { workbook } = await readGenerated(res.buffer);

  const sheet = workbook.getWorksheet('Ref_Brg');
  assert.equal(cellValue(sheet, 'B347'), 'Barang 340');
  // Row 347 is past the master's own catalogue, so the mirrors must reach it too.
  assert.equal(cellValue(workbook.getWorksheet('Saldo_Brg'), 'A347'), '=IF(Ref_Brg!A347="","",Ref_Brg!A347)');
  assert.match(cellValue(workbook.getWorksheet('Stock_Brg (D)'), 'D347'), /^=IFERROR\(VLOOKUP\(B347,Saldo_Brg!/);
});

test('an export without a catalogue keeps the master list rather than blanking it', async () => {
  const payload = bukuPayload();
  delete payload.buku.barang.katalog;
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { workbook } = await readGenerated(res.buffer);
  assert.equal(cellValue(workbook.getWorksheet('Ref_Brg'), 'B10'), 'Beras putih (premium)');
});

test('a malformed catalogue row is rejected, not written', async () => {
  const payload = bukuPayload();
  payload.buku.barang.katalog = [{ kode: '', nama: 'Tanpa kode' }];
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Referensi Barang/);
});

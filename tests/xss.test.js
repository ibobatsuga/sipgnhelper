'use strict';

// Every screen is mounted with innerHTML, so any text an operator types, an OCR
// run extracts from a photo, or a CSV import carries becomes markup unless it is
// escaped. This suite fires a working payload through every field of every
// screen in a real browser and fails if any of it executes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const available = fs.existsSync(CHROME) && (() => {
  try { require.resolve('playwright'); return true; } catch { return false; }
})();

const SCREENS = [
  'renderDashboard', 'renderSipgn', 'renderOcr', 'renderApproval', 'renderTransaksi',
  'renderKas', 'renderPajak', 'renderBuku', 'renderLaporan', 'renderSetup',
];

// Poisons every free-text field the app stores, then draws each screen.
const poisonAndRender = ({ screens, payload }) => {
  window.__pwned = [];
  const p = payload;

  DB.setup = {
    ...DB.setup, namaSPPG: p, idSPPG: p, alamat: p, namaYayasan: p, ketuaYayasan: p,
    kepalaSPPG: p, akuntan: p, rekening: p, namaPengirimDefault: p,
    tempatPelaporan: p, tanggalPelaporan: p, nomorLPA: p, nomorBAPSD: p, tahunAnggaran: p,
    approvalThreshold: 500000, periodeMulai: '2026-08-01', periodeSelesai: '2026-08-31',
  };
  DB.anggaran = { periode: p, mulai: '2026-08-01', selesai: '2026-08-31', bahanMakanan: 1, operasional: 1, insentifFasilitas: 1 };
  DB.coa = DB.coa.map((c) => ({ ...c, nama: p }));
  DB.pemasok = [{ id: 'p1', nama: p, kontak: p, alamat: p }];
  DB.barang = [
    { kode: 'KH', nama: p, satuan: '', level: 1 },
    { kode: 'KH.01', nama: p, satuan: '', level: 2 },
    { kode: 'KH.01.001', nama: p, satuan: p, level: 3 },
  ];
  DB.transaksi = [{
    id: 't1', tanggal: '2026-08-01', noBukti: p, uraian: p, keterangan: p,
    akunKas: '1100', akunLawan: '2010', tipe: 'K', jumlah: 1000, approvalStatus: 'approved',
  }];
  DB.nominatif = [{
    id: 'n1', nama: p, departemen: p, pekerjaan: p,
    hari: 1, tarif: 1000, upah: 1000, bpjs: 0, honorPJ: 0, grandTotal: 1000,
  }];
  DB.approvals = [{ id: 'a1', type: 'pembelian', status: 'pending', tanggal: '2026-08-01', deskripsi: p, jumlah: 1000 }];
  DB.batch = [{ id: 'b1', status: 'draft', jenis: 'vendor', penerima: p, uraian: p, jumlah: 1000, jatuhTempo: '2026-08-10', akunKas: '1100', akunLawan: '2010' }];
  DB.pembelian = [{
    id: 'pb1', status: 'draft', pemasokId: 'p1', akunKas: '1100',
    tanggalTransaksi: '2026-08-01', tanggalDiterima: '2026-08-01',
    items: [{ namaBarang: p, kategori: p, harga: 1000, jumlah: 1, satuan: p, total: 1000 }],
  }];

  const host = document.createElement('div');
  document.body.appendChild(host);
  const drawn = [];
  for (const name of screens) {
    host.innerHTML = window[name]();
    drawn.push(name);
  }
  return { drawn, text: host.textContent };
};

test('no stored text can execute as script on any screen', { skip: available ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => typeof renderSetup === 'function');

  // Four shapes: element injection, attribute break-out of a value="", of an
  // onclick="", and a javascript: URL.
  const payloads = [
    '<img src=x onerror="window.__pwned.push(1)">',
    '"><img src=x onerror="window.__pwned.push(1)">',
    "'); window.__pwned.push(1); ('",
    '<svg/onload="window.__pwned.push(1)">',
  ];

  for (const payload of payloads) {
    const result = await page.evaluate(poisonAndRender, { screens: SCREENS, payload }).catch((e) => ({ error: String(e) }));
    assert.ok(!result.error, `rendering threw on payload ${payload}: ${result.error}`);
    assert.equal(result.drawn.length, SCREENS.length, 'a screen failed to render');

    // onerror/onload fire on the next tick, so give them one.
    await page.waitForTimeout(250);
    const fired = await page.evaluate(() => window.__pwned.length);
    assert.equal(fired, 0, `payload executed ${fired}x: ${payload}`);
  }

  assert.deepEqual(pageErrors, []);
});

test('escaped text is still shown to the operator, not swallowed', { skip: available ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => typeof renderSetup === 'function');

  // A supplier really can be called "Toko A & B <Pusat>"; escaping must not eat it.
  const result = await page.evaluate(poisonAndRender, { screens: ['renderSetup', 'renderTransaksi'], payload: 'Toko A & B <Pusat>' });
  assert.match(result.text, /Toko A & B <Pusat>/, 'the literal text disappeared from the screen');
});

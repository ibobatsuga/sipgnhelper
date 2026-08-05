'use strict';

// End-to-end across the real seam: a real Chromium loads the real index.html
// over HTTP, the page's own export button posts to the real Vercel handler, and
// the downloaded bytes are opened as a workbook. Nothing between the browser and
// the handler is stubbed, so a mismatch between the payload index.html builds
// and the contract the handler enforces fails this test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ExcelJS = require('exceljs');

// Playwright is deliberately not a package.json dependency: its postinstall
// downloads browsers, which would slow and can break the Vercel build. Run
// `npm i --no-save playwright` to include these two tests; without it they skip.
const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const handler = require(path.join(ROOT, 'api/report/generate-workbook.js'));

const available = fs.existsSync(CHROME) && (() => {
  try { require.resolve('playwright'); return true; } catch { return false; }
})();

const startServer = () => new Promise((resolve) => {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/report/generate-workbook')) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const shim = {
        statusCode: 200,
        setHeader: (k, v) => res.setHeader(k, v),
        status(code) { this.statusCode = code; return this; },
        json(payload) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); return this; },
        send(buffer) { res.writeHead(this.statusCode); res.end(buffer); return this; },
      };
      await handler({ method: req.method, body }, shim);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

const seedApp = () => {
  DB.setup.namaSPPG = 'SPPG Melati';
  DB.setup.idSPPG = 'SPPG-0142';
  DB.setup.alamat = 'Jl. Merdeka 10';
  DB.anggaran = { periode: 'Agustus 2026', mulai: '2026-08-01', selesai: '2026-08-31', bahanMakanan: 0, operasional: 0, insentifFasilitas: 0 };
  DB.nominatif = [
    { id: 'n1', nama: 'Siti Aminah', departemen: 'Dapur', pekerjaan: 'Pemorsian', hari: 20, tarif: 100000, upah: 2000000, bpjs: 68000, honorPJ: 0, grandTotal: 2068000 },
    // A legacy row with numbers stored as text and no id: the export must repair it.
    { nama: 'Budi Santoso', departemen: 'Distribusi', pekerjaan: 'Distribusi', hari: '22', tarif: '50000', upah: 1100000, bpjs: '68000', honorPJ: 50000, grandTotal: 1218000 },
  ];
  DB.transaksi = [
    { id: 't0', tanggal: '2026-07-20', noBukti: 'J-1', uraian: 'Sisa bulan lalu', akunKas: '1100', akunLawan: '2000', tipe: 'D', jumlah: 1500000, approvalStatus: 'approved' },
    { id: 't1', tanggal: '2026-08-01', noBukti: 'A-1', uraian: 'Dana bahan makanan', akunKas: '1100', akunLawan: '2000', tipe: 'D', jumlah: 25000000, approvalStatus: 'approved' },
    { id: 't2', tanggal: '2026-08-03', noBukti: 'A-2', uraian: 'Belanja sayur', akunKas: '1100', akunLawan: '2010', tipe: 'K', jumlah: 3200000, approvalStatus: 'approved' },
    // Legacy CSV date: must be normalised, not rejected.
    { id: 't3', tanggal: '18/08/2026', noBukti: 'A-3', uraian: 'Gas dan air', akunKas: '1000', akunLawan: '2110', tipe: 'K', jumlah: 450000, approvalStatus: 'approved' },
    { id: 't4', tanggal: '2026-08-20', noBukti: 'A-4', uraian: 'PPN', akunKas: '1100', akunLawan: '2170', tipe: 'K', jumlah: 352000, approvalStatus: 'approved' },
    { id: 't5', tanggal: '2026-08-22', noBukti: 'A-5', uraian: 'Belum disetujui', akunKas: '1100', akunLawan: '2010', tipe: 'K', jumlah: 999999, approvalStatus: 'pending' },
  ];
};

test('the app downloads a real workbook without anyone ticked', { skip: available ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const { server, port } = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  t.after(async () => { await browser.close(); server.close(); });

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof renderBuku === 'function');
  await page.evaluate(seedApp);

  // Draw the real Buku Otomatis screen and press its own export button.
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'e2e';
    host.innerHTML = renderBuku();
    document.body.appendChild(host);
  });

  const button = page.locator('#e2e button.btn-gold');
  assert.equal(await button.isDisabled(), false, 'the monthly export must not require a tick');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    button.click(),
  ]);

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sipgn-e2e-')), download.suggestedFilename());
  await download.saveAs(file);
  assert.equal(path.basename(file), 'Buku_Otomatis_Bulanan.xlsx');

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  assert.deepEqual(workbook.worksheets.map((s) => s.name), [
    'BKU', 'BP Kas Kecil (Petty Cash)', 'BP Kas di Bank',
    'BP Bahan Baku', 'BP Operasional', 'BP Fasilitas',
    'BP Pajak PPN', 'Catatan', 'DafNom',
  ]);

  const bku = workbook.getWorksheet('BKU');
  assert.equal(bku.getCell('E9').value, ':  SPPG Melati');
  assert.equal(bku.getCell('I10').value, 1500000, 'saldo awal must carry the previous month');
  // Four approved rows in August; the pending one must not be there.
  assert.equal(bku.getCell('F16').value, 'Dana bahan makanan');
  assert.equal(bku.getCell('F19').value, 'PPN');
  assert.equal(bku.getCell('F20').value, null);
  // The legacy dd/mm/yyyy row landed on the right day.
  const gasRow = [16, 17, 18, 19].find((r) => bku.getCell(`F${r}`).value === 'Gas dan air');
  assert.ok(gasRow, 'the legacy-dated transaksi is missing from the book');
  assert.equal(bku.getCell(`C${gasRow}`).value.toISOString().slice(0, 10), '2026-08-18');

  // The legacy personel row with text numbers was repaired, not dropped.
  const dafnom = workbook.getWorksheet('DafNom');
  assert.equal(dafnom.getCell('D7').value, 'Siti Aminah');
  assert.equal(dafnom.getCell('D8').value, 'Budi Santoso');
  assert.equal(dafnom.getCell('E8').value, 50000);

  assert.deepEqual(pageErrors, []);
});

test('the biweekly button exports the half period it names', { skip: available ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const { server, port } = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); server.close(); });

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof renderBuku === 'function');
  await page.evaluate(seedApp);
  await page.evaluate(() => {
    bukuParuhIndex = 1; // 16–31 Agustus
    const host = document.createElement('div');
    host.id = 'e2e';
    host.innerHTML = renderBuku();
    document.body.appendChild(host);
  });

  const biweekly = page.locator('#e2e button', { hasText: 'Unduh Buku Biweekly' });
  assert.match((await biweekly.textContent()).trim(), /16–31 Agustus 2026/);

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    biweekly.click(),
  ]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sipgn-e2e-')), download.suggestedFilename());
  await download.saveAs(file);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const catatan = workbook.getWorksheet('Catatan');
  assert.equal(catatan.getCell('C23').value.toISOString().slice(0, 10), '2026-08-16');
  assert.equal(catatan.getCell('C38').value.toISOString().slice(0, 10), '2026-08-31');

  const bku = workbook.getWorksheet('BKU');
  // The half opens on what the first half closed with: 1.5jt + 25jt - 3.2jt.
  assert.equal(bku.getCell('I10').value, 23300000);
  assert.equal(bku.getCell('F16').value, 'Gas dan air');
});

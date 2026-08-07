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
  DB.setup.kepalaSPPG = 'Dr. Rina';
  DB.setup.akuntan = 'Andi';
  DB.setup.namaYayasan = 'Yayasan Sejahtera';
  DB.setup.ketuaYayasan = 'H. Sulaiman';
  DB.pemasok = [{ id: 'p1', nama: 'Koperasi Desa', kontak: '', alamat: '' }];
  DB.pembelian = [{
    id: 'pb1', status: 'terkirim', pemasokId: 'p1', akunKas: '1100',
    tanggalTransaksi: '2026-08-03', tanggalDiterima: '2026-08-03',
    items: [{ namaBarang: 'Beras premium', kategori: '', harga: 12000, jumlah: 40, satuan: 'kg', total: 480000 }],
  }];
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
    'Setup', 'Saldo Buku', 'Anggaran', 'Transaksi',
    'BKU', 'BP Kas Kecil (Petty Cash)', 'BP Kas di Bank',
    'BP Bahan Baku', 'BP Operasional', 'BP Fasilitas', 'BP Pajak PPN',
    'LPA', 'SPTJ', 'BAPSD', 'Catatan', 'DafNom',
    'Ref_Brg', 'Saldo_Brg', 'Masuk', 'Keluar', 'Stock_Brg (D)', 'Stock_Brg (R)',
  ]);

  // Menu Input, filled by the app rather than left as the master's examples.
  const setup = workbook.getWorksheet('Setup');
  assert.equal(setup.getCell('C6').value, 'SPPG Melati');
  assert.equal(setup.getCell('C9').value, 'Dr. Rina');
  assert.equal(setup.getCell('C15').value, '01-08-2026');
  assert.equal(setup.getCell('C16').value, '31-08-2026');

  const transaksi = workbook.getWorksheet('Transaksi');
  assert.equal(transaksi.getCell('F11').value, 'Dana bahan makanan');
  assert.equal(transaksi.getCell('I11').value, 'Dana Bantuan Pemerintah');
  assert.equal(transaksi.getCell('J11').value, 'Kas di Bank');
  assert.equal(transaksi.getCell('J13').value, 'Petty Cash');

  // Cetak Laporan: the letters carry the period's money.
  const lpa = workbook.getWorksheet('LPA');
  assert.equal(lpa.getCell('F19').value, 26500000, 'dana pemasukan includes last period');
  assert.equal(lpa.getCell('F21').value, 3200000);
  assert.equal(lpa.getCell('F22').value, 450000);

  // Barang Persediaan: catalogue intact, purchases carried over.
  assert.equal(workbook.getWorksheet('Ref_Brg').getCell('B10').value, 'Beras putih (premium)');
  const masuk = workbook.getWorksheet('Masuk');
  assert.equal(masuk.getCell('E312').value, 'Beras premium');
  assert.equal(masuk.getCell('D312').value, 'Koperasi Desa');
  assert.equal(masuk.getCell('H312').value, 40);

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

// The buttons no longer name a period; the two dropdowns beside them decide it.
// So the dropdowns are driven the way an operator drives them — selectOption on
// the real <select>, which fires the app's own onchange — and the downloaded
// workbook has to match what was picked.
test('the export follows the dropdown selection, not the button label', { skip: available ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const { server, port } = await startServer();
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); server.close(); });

  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof renderBuku === 'function');
  await page.evaluate(seedApp);
  await page.evaluate(() => {
    // Two months of Anggaran, so the Periode dropdown has a real choice to make.
    DB.anggaran = { periode: 'Agustus 2026', mulai: '2026-08-01', selesai: '2026-09-30', bahanMakanan: 0, operasional: 0, insentifFasilitas: 0 };
    DB.transaksi.push({
      id: 't9', tanggal: '2026-09-04', noBukti: 'S-1', uraian: 'Belanja September',
      akunKas: '1100', akunLawan: '2010', tipe: 'K', jumlah: 700000, approvalStatus: 'approved',
    });
    activeTab = 'buku';
    render();
    // Supabase's CDN script cannot load here, so the app stays behind its login
    // gate. The screen itself is fully rendered underneath; reveal it so the
    // dropdowns can be operated exactly as an operator would.
    document.getElementById('authScreen').style.display = 'none';
    // The stylesheet keeps .app-layout at display:none until sign-in, so the
    // inline value has to name the layout it normally uses.
    document.querySelector('.app-layout').style.display = 'flex';
  });

  const periode = page.locator('select').filter({ hasText: 'Agustus 2026' }).first();
  const paruh = page.locator('select').filter({ hasText: '–' }).last();
  const bulanan = page.locator('button', { hasText: 'Unduh Buku Bulanan' });
  const biweekly = page.locator('button', { hasText: 'Unduh Buku Biweekly' });

  // The labels stay plain now that the dropdowns carry the period.
  assert.equal((await bulanan.textContent()).trim(), 'Unduh Buku Bulanan');
  assert.equal((await biweekly.textContent()).trim(), 'Unduh Buku Biweekly');

  const unduh = async (locator) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      locator.click(),
    ]);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sipgn-e2e-')), download.suggestedFilename());
    await download.saveAs(file);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file);
    return workbook;
  };
  const rentangCatatan = (workbook) => {
    const sheet = workbook.getWorksheet('Catatan');
    const dates = [];
    for (let row = 23; row < 23 + 40; row += 1) {
      const value = sheet.getCell(`C${row}`).value;
      if (value instanceof Date) dates.push(value.toISOString().slice(0, 10));
    }
    return [dates[0], dates[dates.length - 1]];
  };

  // Second half of August.
  await paruh.selectOption('1');
  assert.deepEqual(rentangCatatan(await unduh(biweekly)), ['2026-08-16', '2026-08-31']);

  // Back to the first half — same button, different dropdown.
  await paruh.selectOption('0');
  assert.deepEqual(rentangCatatan(await unduh(biweekly)), ['2026-08-01', '2026-08-15']);

  // August as a whole month.
  assert.deepEqual(rentangCatatan(await unduh(bulanan)), ['2026-08-01', '2026-08-31']);

  // Switching the Periode dropdown moves both buttons to September.
  await periode.selectOption('1');
  const september = await unduh(bulanan);
  assert.deepEqual(rentangCatatan(september), ['2026-09-01', '2026-09-30']);
  assert.equal(september.getWorksheet('BKU').getCell('F16').value, 'Belanja September');

  // The Paruh dropdown re-populated for September, and the biweekly export follows.
  assert.deepEqual(rentangCatatan(await unduh(biweekly)), ['2026-09-01', '2026-09-15']);
});

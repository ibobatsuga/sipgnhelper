'use strict';

// The three sheet groups the MASTER_4 menu offers beside Cetak Buku:
// Menu Input, Cetak Laporan and Barang Persediaan.

const test = require('node:test');
const assert = require('node:assert/strict');

const { callHandler, readGenerated, cellValue, bukuPayload } = require('./helpers');

const workbookFor = async (payload = bukuPayload()) => {
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const { workbook } = await readGenerated(res.buffer);
  return workbook;
};

test('Setup carries the identity every other sheet reads', async () => {
  const sheet = (await workbookFor()).getWorksheet('Setup');
  assert.equal(cellValue(sheet, 'B3'), 'SETUP USER');
  assert.equal(cellValue(sheet, 'C6'), 'SPPG Melati');
  assert.equal(cellValue(sheet, 'C7'), 'SPPG-0142');
  assert.equal(cellValue(sheet, 'C9'), 'Dr. Rina');
  assert.equal(cellValue(sheet, 'C11'), 'Yayasan Sejahtera');
  assert.equal(cellValue(sheet, 'C12'), 'H. Sulaiman');
  assert.equal(cellValue(sheet, 'C15'), '01-08-2026');
  assert.equal(cellValue(sheet, 'C16'), '31-08-2026');
  assert.equal(cellValue(sheet, 'C19'), 'Bandung');
  assert.equal(cellValue(sheet, 'C20'), 'LPA/08/2026');
});

test('Saldo Buku opens each book and keeps the BKU link live', async () => {
  const sheet = (await workbookFor()).getWorksheet('Saldo Buku');
  assert.equal(cellValue(sheet, 'B1'), 'SALDO AWAL BUKU');
  assert.equal(cellValue(sheet, 'D8'), 1500000);
  // The master computes the BKU closing balance from the BKU sheet itself.
  assert.equal(cellValue(sheet, 'E8'), '=BKU!I11');
  assert.equal(cellValue(sheet, 'D11'), 1500000);
  assert.equal(cellValue(sheet, 'E11'), 26400000);
  assert.equal(cellValue(sheet, 'C10'), 'Petty Cash');
});

test('Transaksi keeps the input columns and its own derived columns', async () => {
  const sheet = (await workbookFor()).getWorksheet('Transaksi');
  assert.equal(cellValue(sheet, 'C4'), 'INPUT DATA TRANSAKSI');
  // The heading reads its name and period straight from Setup, which travels along.
  assert.equal(cellValue(sheet, 'C3'), '=IF(Setup!C6="","Nama SPPG.....",Setup!C6)');
  assert.equal(cellValue(sheet, 'C5'), '="Periode : "&Setup!C15&" s.d. "&Setup!C16');

  assert.equal(cellValue(sheet, 'C11').toISOString().slice(0, 10), '2026-08-01');
  assert.equal(cellValue(sheet, 'F11'), 'Dana bahan makanan');
  assert.equal(cellValue(sheet, 'G11'), 25000000);
  assert.equal(cellValue(sheet, 'I11'), 'Dana Bantuan Pemerintah');
  assert.equal(cellValue(sheet, 'J11'), 'Kas di Bank');
  assert.equal(cellValue(sheet, 'H12'), 100000);
  assert.equal(cellValue(sheet, 'I12'), 'Biaya Bahan Baku');
  // Same-sheet derived columns are what the master's own books read.
  assert.equal(cellValue(sheet, 'K11'), '=IF(I11="",0,I11)');
  assert.match(cellValue(sheet, 'Q11'), /^=IF\(I11="Biaya Bahan Baku"/);
});

test('Anggaran ships as the planning form it is in the master', async () => {
  const sheet = (await workbookFor()).getWorksheet('Anggaran');
  assert.equal(cellValue(sheet, 'C2'), '1. ANGGARAN BAHAN MAKANAN');
  assert.equal(cellValue(sheet, 'D3'), 'Jumlah Paket MBG');
  assert.equal(cellValue(sheet, 'E3'), 'Balita');
});

test('LPA reports the money and reads its names from Setup', async () => {
  const sheet = (await workbookFor()).getWorksheet('LPA');
  assert.equal(cellValue(sheet, 'B5'), 'LAPORAN PENGGUNAAN DANA DUA PEKANAN');
  assert.equal(cellValue(sheet, 'F19'), 26500000);
  assert.equal(cellValue(sheet, 'F21'), 100000);
  assert.equal(cellValue(sheet, 'F24'), '=SUM(F21:F23)');
  assert.equal(cellValue(sheet, 'F25'), '=F19-F24');
  assert.equal(cellValue(sheet, 'AB26'), 26400000);
  assert.equal(cellValue(sheet, 'E14'), '=IF(Setup!C6="","….............",Setup!C6)');
  assert.match(cellValue(sheet, 'B35'), /Sisa dana sebesar Rp26\.400\.000/);
});

test('SPTJ and BAPSD hang off LPA rather than repeating its arithmetic', async () => {
  const workbook = await workbookFor();
  const sptj = workbook.getWorksheet('SPTJ');
  assert.equal(cellValue(sptj, 'A5'), 'SURAT PERNYATAAN TANGGUNG JAWAB');
  assert.equal(cellValue(sptj, 'E20'), '=LPA!F19');
  assert.equal(cellValue(sptj, 'E22'), '=LPA!F24');
  assert.equal(cellValue(sptj, 'E24'), '=E20-E22');

  const bapsd = workbook.getWorksheet('BAPSD');
  assert.equal(cellValue(bapsd, 'A5'), 'BERITA ACARA PENGALIHAN SISA DANA');
  assert.match(cellValue(bapsd, 'A10'), /Sisa dana sebesar Rp26\.400\.000/);
});

test('Ref_Brg brings the official item catalogue along', async () => {
  const sheet = (await workbookFor()).getWorksheet('Ref_Brg');
  assert.equal(cellValue(sheet, 'A4'), 'REFERENSI BARANG PERSEDIAAN');
  assert.equal(cellValue(sheet, 'A8'), 'KH');
  assert.equal(cellValue(sheet, 'B8'), 'KARBOHIDRAT');
  assert.equal(cellValue(sheet, 'A10'), 'KH.01.001');
  assert.equal(cellValue(sheet, 'B10'), 'Beras putih (premium)');
  assert.equal(cellValue(sheet, 'C10'), 'kg');
  // The catalogue runs to row 311 in the master.
  assert.equal(cellValue(sheet, 'A311'), 'BB.07.099');
});

test('Penerimaan Barang is filled from the pembelian items', async () => {
  const sheet = (await workbookFor()).getWorksheet('Masuk');
  assert.equal(cellValue(sheet, 'A4'), 'PEMBELIAN/PENERIMAAN BARANG');
  assert.equal(cellValue(sheet, 'C312').toISOString().slice(0, 10), '2026-08-02');
  assert.equal(cellValue(sheet, 'D312'), 'Koperasi Desa');
  assert.equal(cellValue(sheet, 'E312'), 'Beras putih (medium)');
  assert.equal(cellValue(sheet, 'G312'), 'kg');
  assert.equal(cellValue(sheet, 'H312'), 50);
  assert.equal(cellValue(sheet, 'I312'), 12000);
  // The master's structured-table formula is rebuilt as plain arithmetic.
  assert.equal(cellValue(sheet, 'J312'), '=IF(H312="","",H312*I312)');
  assert.equal(cellValue(sheet, 'I6'), '=SUM(J312:J511)');
});

test('the stock report stays a live calculation over the group', async () => {
  const workbook = await workbookFor();
  const detail = workbook.getWorksheet('Stock_Brg (D)');
  assert.equal(cellValue(detail, 'A4'), 'LAPORAN STOCK BARANG (DETIL)');
  assert.equal(cellValue(detail, 'A10'), '=IF(Ref_Brg!A10="","",Ref_Brg!A10)');
  assert.match(cellValue(detail, 'D10'), /^=IFERROR\(VLOOKUP\(B10,Saldo_Brg!/);
  assert.match(cellValue(detail, 'E10'), /^=SUMIF\(Masuk!/);
  assert.match(cellValue(detail, 'F10'), /^=SUMIF\(Keluar!/);
  assert.equal(cellValue(detail, 'G10'), '=D10+E10-F10');

  const rekap = workbook.getWorksheet('Stock_Brg (R)');
  assert.equal(cellValue(rekap, 'A2'), 'LAPORAN STOCK BARANG (REKAP)');
  assert.match(cellValue(rekap, 'C7'), /^=SUMIF\('Stock_Brg \(D\)'!/);
  assert.equal(cellValue(rekap, 'F7'), '=C7+D7-E7');
});

test('Pengeluaran Barang ships as an empty form ready to fill', async () => {
  const sheet = (await workbookFor()).getWorksheet('Keluar');
  assert.equal(cellValue(sheet, 'B4'), 'PENGELUARAN/PEMAKAIAN BARANG');
  assert.equal(cellValue(sheet, 'B7'), 'No');
  assert.equal(cellValue(sheet, 'D7'), 'Petugas');
  assert.equal(cellValue(sheet, 'E8'), null, 'no invented stock movement');
  // Satuan still resolves itself once a catalogue item is typed in.
  assert.match(cellValue(sheet, 'G8'), /^=IF\(E8="","",VLOOKUP\(E8,Ref_Brg!/);
});

test('a period with no purchases still ships the Barang Persediaan forms', async () => {
  const payload = bukuPayload();
  payload.buku.barang = { masuk: [] };
  const workbook = await workbookFor(payload);
  for (const name of ['Ref_Brg', 'Saldo_Brg', 'Masuk', 'Keluar', 'Stock_Brg (D)', 'Stock_Brg (R)']) {
    assert.ok(workbook.getWorksheet(name), `${name} missing`);
  }
  assert.equal(cellValue(workbook.getWorksheet('Masuk'), 'E312'), null);
});

test('a payload without the new sections still produces the sheets', async () => {
  const payload = bukuPayload();
  delete payload.buku.transaksi;
  delete payload.buku.saldoBuku;
  delete payload.buku.laporan;
  delete payload.buku.barang;
  const workbook = await workbookFor(payload);
  assert.equal(workbook.worksheets.length, 22);
  assert.equal(cellValue(workbook.getWorksheet('Saldo Buku'), 'D8'), 0);
  assert.equal(cellValue(workbook.getWorksheet('LPA'), 'F19'), 0);
});

test('a malformed Transaksi or Penerimaan row is rejected, not written', async () => {
  const badTransaksi = bukuPayload();
  badTransaksi.buku.transaksi = [{ tanggal: '01/08/2026', uraian: 'x', debet: 0, kredit: 0 }];
  const res1 = await callHandler(badTransaksi);
  assert.equal(res1.statusCode, 400);
  assert.match(res1.body.message, /Transaksi/);

  const badMasuk = bukuPayload();
  badMasuk.buku.barang = { masuk: [{ tanggal: '2026-08-02', vol: 'banyak', harga: 1 }] };
  const res2 = await callHandler(badMasuk);
  assert.equal(res2.statusCode, 400);
  assert.match(res2.body.message, /Penerimaan Barang/);
});

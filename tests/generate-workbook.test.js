'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  callHandler, readGenerated, cellValue, bukuPayload, worker, ledgerRow,
} = require('./helpers');

const okWorkbook = async (payload) => {
  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.ok(Buffer.isBuffer(res.buffer) && res.buffer.length > 5000, 'workbook bytes missing');
  const { workbook } = await readGenerated(res.buffer);
  return workbook;
};

test('rejects anything but POST', async () => {
  const res = await callHandler({}, 'GET');
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('rejects a body without a workers array', async () => {
  const res = await callHandler({ filename: 'x.xlsx' });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /personel/i);
});

test('rejects a slip request with nobody on it', async () => {
  const res = await callHandler({ workers: [], dayCount: 10 });
  assert.equal(res.statusCode, 400);
});

test('rejects malformed personel', async () => {
  for (const bad of [
    { ...worker(), nama: '' },
    { ...worker(), hari: -1 },
    { ...worker(), tarif: 'banyak' },
    { ...worker(), bpjs: null },
  ]) {
    const res = await callHandler({ workers: [bad], dayCount: 10 });
    assert.equal(res.statusCode, 400, `accepted ${JSON.stringify(bad)}`);
  }
});

test('rejects more personel than one workbook should carry', async () => {
  const res = await callHandler({ workers: Array.from({ length: 101 }, () => worker()), dayCount: 10 });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Maksimal/);
});

test('rejects an impossible day count', async () => {
  for (const dayCount of [0, -3, 32, 1.5, '10', NaN]) {
    const res = await callHandler({ workers: [worker()], dayCount });
    assert.equal(res.statusCode, 400, `accepted dayCount=${dayCount}`);
  }
});

test('rejects unparseable dates instead of writing a broken book', async () => {
  const res = await callHandler(bukuPayload({
    buku: { bku: { saldoAwal: 0, rows: [ledgerRow({ tanggal: '01/08/2026' })] } },
  }));
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /tidak valid/i);
});

test('slip export keeps one sheet per personel', async () => {
  const workbook = await okWorkbook({
    filename: 'Slip.xlsx', dayCount: 10, periodeLabel: 'Agustus 2026',
    workers: [worker({ nama: 'Siti Aminah' }), worker({ nama: 'Budi Santoso' })],
  });
  assert.deepEqual(workbook.worksheets.map((s) => s.name), ['Siti Aminah', 'Budi Santoso']);
  const sheet = workbook.getWorksheet('Siti Aminah');
  assert.equal(cellValue(sheet, 'D7'), 'Siti Aminah');
  assert.equal(cellValue(sheet, 'B7'), 1);
  // 10 day columns E..N, then HONORARIUM..TOTAL in O..S.
  assert.equal(cellValue(sheet, 'O7'), '=SUM(E7:N7)');
  assert.equal(cellValue(sheet, 'S7'), '=O7+P7+Q7+R7');
});

test('book export carries every book of Bab 9', async () => {
  const workbook = await okWorkbook(bukuPayload());
  assert.deepEqual(workbook.worksheets.map((s) => s.name), [
    'BKU', 'BP Kas di Bank', 'BP Kas Kecil (Petty Cash)',
    'BP Bahan Baku', 'BP Operasional', 'BP Fasilitas',
    'BP Pajak PPN', 'Catatan', 'DafNom',
  ]);
});

test('books carry the MASTER_4 titles, identity block and period', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const bku = workbook.getWorksheet('BKU');
  assert.equal(cellValue(bku, 'C5'), 'BUKU KAS UMUM');
  assert.equal(cellValue(bku, 'C6'), 'Periode : 01 Agu 2026 s.d. 31 Agu 2026');
  assert.equal(cellValue(bku, 'C9'), 'Nama SPPG');
  assert.equal(cellValue(bku, 'E9'), ':  SPPG Melati');
  assert.equal(cellValue(bku, 'E10'), ':  SPPG-0142');
  assert.equal(cellValue(bku, 'E11'), ':  Jl. Merdeka 10');
  assert.equal(cellValue(bku, 'C13'), 'Bulan');
  assert.equal(cellValue(bku, 'I13'), 'Saldo');
  assert.equal(workbook.getWorksheet('BP Bahan Baku').getCell('C5').value, 'BUKU PEMBANTU DANA BAHAN BAKU/PANGAN');
  assert.equal(workbook.getWorksheet('Catatan').getCell('C5').value, 'CATATAN PENGELUARAN HARIAN');
});

test('no cross-sheet formula from the master survives the clone', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const offenders = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const formula = cell.formula || (cell.value && cell.value.sharedFormula);
        if (!formula) return;
        if (/Transaksi!|Setup!|'Saldo Buku'!|LR!|#REF!|INDIRECT/.test(formula)) {
          offenders.push(`${sheet.name}!${row.getCell(col).address}=${formula}`);
        }
      });
    });
  });
  assert.deepEqual(offenders, []);
});

test('BKU opens on its saldo awal and chains the running balance', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const bku = workbook.getWorksheet('BKU');
  assert.equal(cellValue(bku, 'I10'), 1500000);
  assert.equal(cellValue(bku, 'F15'), 'SALDO AWAL BULAN BERJALAN');
  assert.equal(cellValue(bku, 'G15'), '=I10');
  assert.equal(cellValue(bku, 'I15'), '=I10');
  assert.equal(cellValue(bku, 'G16'), 25000000);
  assert.equal(cellValue(bku, 'I16'), '=I15+G16-H16');
  assert.equal(cellValue(bku, 'I17'), '=I16+G17-H17');
  // Saldo akhir must point at the last row that exists, not the template's I215.
  assert.equal(cellValue(bku, 'I11'), '=I17');
});

test('an empty book still balances instead of pointing at nothing', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const petty = workbook.getWorksheet('BP Kas Kecil (Petty Cash)');
  assert.equal(cellValue(petty, 'I11'), '=I15');
  const fasilitas = workbook.getWorksheet('BP Fasilitas');
  assert.equal(cellValue(fasilitas, 'H11'), '=SUM(G17:G17)');
  assert.equal(cellValue(fasilitas, 'G17'), null);
});

test('buku pembantu totals span exactly the rows written', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    tanggal: `2026-08-0${i + 1}`, noBukti: `B-${i}`, uraian: `Belanja ${i}`, jumlah: 10000 * (i + 1), keterangan: '', sumber: 'Kas di Bank',
  }));
  const payload = bukuPayload();
  payload.buku.belanja[0].rows = rows;
  const workbook = await okWorkbook(payload);
  const sheet = workbook.getWorksheet('BP Bahan Baku');
  assert.equal(cellValue(sheet, 'H11'), '=SUM(G17:G21)');
  assert.equal(cellValue(sheet, 'G21'), 50000);
  assert.equal(cellValue(sheet, 'F11'), 'Bahan Baku');
});

test('BP Pajak closes on a TOTAL row that feeds saldo akhir', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const sheet = workbook.getWorksheet('BP Pajak PPN');
  assert.equal(cellValue(sheet, 'F11'), 'PPN');
  assert.equal(cellValue(sheet, 'H16'), 11000);
  assert.equal(cellValue(sheet, 'F18'), 'TOTAL');
  assert.equal(cellValue(sheet, 'G18'), '=SUM(G16:G16)');
  assert.equal(cellValue(sheet, 'I18'), '=I16');
  assert.equal(cellValue(sheet, 'I11'), '=I18');
});

test('Catatan keeps the dana summary and totals the daily rows', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const sheet = workbook.getWorksheet('Catatan');
  assert.equal(cellValue(sheet, 'E12'), 1500000);
  assert.equal(cellValue(sheet, 'E13'), 25000000);
  assert.equal(cellValue(sheet, 'E14'), '=E12+E13');
  assert.equal(cellValue(sheet, 'E18'), '=E15+E16+E17');
  assert.equal(cellValue(sheet, 'E19'), '=E14-E18');
  assert.equal(cellValue(sheet, 'D23'), null); // day with no spending stays blank
  assert.equal(cellValue(sheet, 'D24'), 'Pengeluaran harian');
  assert.equal(cellValue(sheet, 'E24'), 100000);
  assert.equal(cellValue(sheet, 'D25'), 'Total Pengeluaran');
  assert.equal(cellValue(sheet, 'E25'), '=SUM(E23:E24)');
});

test('DafNom lists every personel on one sheet and totals the columns', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const sheet = workbook.getWorksheet('DafNom');
  assert.equal(cellValue(sheet, 'B7'), 1);
  assert.equal(cellValue(sheet, 'D7'), 'Siti Aminah');
  assert.equal(cellValue(sheet, 'B8'), 2);
  assert.equal(cellValue(sheet, 'D8'), 'Budi Santoso');
  assert.equal(cellValue(sheet, 'C9'), 'TOTAL');
  assert.equal(cellValue(sheet, 'E9'), '=SUM(E7:E8)');
  // 31 day columns E..AI, so HONORARIUM lands in AJ and TOTAL in AN.
  assert.equal(cellValue(sheet, 'AJ7'), '=SUM(E7:AI7)');
  assert.equal(cellValue(sheet, 'AN7'), '=AJ7+AK7+AL7+AM7');
  // Only 10 of the 31 days are paid for this worker.
  assert.equal(cellValue(sheet, 'N7'), 100000);
  assert.equal(cellValue(sheet, 'O7'), null);
});

test('the departemen line only appears when the sheet is one departemen', async () => {
  const mixedPayload = bukuPayload();
  mixedPayload.workers[1].departemen = 'Distribusi';
  const mixed = await okWorkbook(mixedPayload);
  assert.equal(cellValue(mixed.getWorksheet('DafNom'), 'B4'), null);

  const uniform = bukuPayload();
  uniform.workers = uniform.workers.map((w) => ({ ...w, departemen: 'Dapur' }));
  const single = await okWorkbook(uniform);
  assert.equal(cellValue(single.getWorksheet('DafNom'), 'B4'), 'Departemen: Dapur');
});

test('books without personel are still a valid workbook', async () => {
  const workbook = await okWorkbook(bukuPayload({ workers: [] }));
  assert.ok(!workbook.worksheets.some((s) => s.name === 'DafNom'));
  assert.ok(workbook.getWorksheet('BKU'));
});

test('dates land as real dates with the master number format', async () => {
  const workbook = await okWorkbook(bukuPayload());
  const cell = workbook.getWorksheet('BKU').getCell('C16');
  assert.ok(cell.value instanceof Date, `expected a Date, got ${typeof cell.value}`);
  assert.equal(cell.value.toISOString().slice(0, 10), '2026-08-01');
  assert.equal(cell.numFmt, 'dd mmm yy');
  assert.equal(workbook.getWorksheet('Catatan').getCell('C23').numFmt, 'dd-mm-yyyy');
  assert.match(workbook.getWorksheet('BKU').getCell('G16').numFmt, /#,##0/);
});

test('text that looks like a formula stays text', async () => {
  const payload = bukuPayload();
  payload.buku.bku.rows = [ledgerRow({ uraian: '=SUM(A1:A9)', noBukti: '+1+1' })];
  const workbook = await okWorkbook(payload);
  const sheet = workbook.getWorksheet('BKU');
  assert.equal(sheet.getCell('F16').value, '=SUM(A1:A9)');
  assert.equal(sheet.getCell('F16').formula, undefined);
  assert.equal(sheet.getCell('E16').value, '+1+1');
  assert.equal(sheet.getCell('E16').formula, undefined);
});

test('sheet names stay unique, legal and inside Excel limits', async () => {
  const payload = bukuPayload();
  payload.buku.kas = [
    { nama: 'Kas Operasional Cabang Utama Bandung Raya', jenis: 'bank', saldoAwal: 0, rows: [] },
    { nama: 'Kas Operasional Cabang Utama Bandung Raya', jenis: 'bank', saldoAwal: 0, rows: [] },
    { nama: 'Kas [Utama]/Cadangan*?', jenis: 'petty', saldoAwal: 0, rows: [] },
    { nama: "'Kas Titipan'", jenis: 'bank', saldoAwal: 0, rows: [] },
  ];
  const workbook = await okWorkbook(payload);
  const names = workbook.worksheets.map((s) => s.name);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, `duplicate sheet name in ${names}`);
  for (const name of names) {
    assert.ok(name.length <= 31, `sheet name too long: ${name}`);
    assert.doesNotMatch(name, /[\\/?*[\]:]/, `illegal character in ${name}`);
    assert.doesNotMatch(name, /^'|'$/, `sheet name may not start or end with an apostrophe: ${name}`);
  }
});

test('oversized text is truncated rather than rejected', async () => {
  const payload = bukuPayload();
  payload.buku.bku.rows = [ledgerRow({ uraian: 'X'.repeat(5000) })];
  payload.profil = { namaSPPG: 'N'.repeat(500), idSPPG: 'I'.repeat(500), alamat: 'A'.repeat(500) };
  const workbook = await okWorkbook(payload);
  const sheet = workbook.getWorksheet('BKU');
  assert.ok(sheet.getCell('F16').value.length <= 300);
  assert.ok(sheet.getCell('E9').value.length <= 130);
});

test('a period of one day produces a one-column DafNom', async () => {
  const workbook = await okWorkbook(bukuPayload({ dayCount: 1 }));
  const sheet = workbook.getWorksheet('DafNom');
  assert.equal(cellValue(sheet, 'E6'), 1);
  assert.equal(cellValue(sheet, 'F7'), '=SUM(E7:E7)'); // HONORARIUM moves to F
  assert.equal(cellValue(sheet, 'J7'), '=F7+G7+H7+I7');
});

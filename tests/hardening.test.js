'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHash } = require('node:crypto');

const { callHandler, readGenerated, cellValue, bukuPayload, worker, ledgerRow } = require('./helpers');

test('a raw JSON string body is understood, not misreported', async () => {
  const res = await callHandler(JSON.stringify(bukuPayload()));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('an unparseable body fails as a bad request, never as a crash', async () => {
  for (const body of ['not json at all', undefined, null, 42, []]) {
    const res = await callHandler(body);
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)} gave ${res.statusCode}`);
    assert.ok(res.body.message);
  }
});

test('no payload field can smuggle a formula into a cell', async () => {
  const payload = bukuPayload({
    periodeText: '=cmd|calc!A1',
    profil: { namaSPPG: '=1+1', idSPPG: '@SUM(A1)', alamat: '+HYPERLINK("x")' },
  });
  payload.buku.kas[0].nama = '=WEBSERVICE("http://x")';
  payload.buku.belanja[0].jenis = '=1+2';
  payload.buku.pajak[0].jenis = '=3+4';
  payload.buku.belanja[0].rows = [{
    tanggal: '2026-08-02', noBukti: '=A1', uraian: '=B1', jumlah: 1000, keterangan: '=C1', sumber: '=D1',
  }];

  const res = await callHandler(payload);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const { workbook } = await readGenerated(res.buffer);

  const formulas = [];
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        if (cell.formula) formulas.push({ where: `${sheet.name}!${cell.address}`, formula: cell.formula });
      });
    });
  });
  // Every formula in the output must be one the generator wrote itself. A sheet
  // *name* may still echo the payload text — Excel never evaluates those.
  assert.ok(formulas.length > 0, 'the generator writes formulas; none found');
  for (const { where, formula } of formulas) {
    assert.match(formula, /^(SUM\([A-Z]+\d+:[A-Z]+\d+\)|[A-Z]+\d+([+-][A-Z]+\d+)*)$/, `unexpected formula at ${where}: ${formula}`);
  }
  const bku = workbook.getWorksheet('BKU');
  assert.equal(bku.getCell('C6').value, '=cmd|calc!A1');
  assert.equal(bku.getCell('C6').formula, undefined);
  assert.equal(bku.getCell('E9').value, ':  =1+1');
});

test('the row cap holds at its documented boundary', async () => {
  const rows = (count) => Array.from({ length: count }, (_, i) => ledgerRow({ tanggal: '2026-08-02', uraian: `Baris ${i}` }));
  const atCap = await callHandler(bukuPayload({ buku: { bku: { saldoAwal: 0, rows: rows(2000) } }, workers: [] }));
  assert.equal(atCap.statusCode, 200, JSON.stringify(atCap.body));
  const overCap = await callHandler(bukuPayload({ buku: { bku: { saldoAwal: 0, rows: rows(2001) } }, workers: [] }));
  assert.equal(overCap.statusCode, 400);
  assert.match(overCap.body.message, /2000 baris/);
});

test('a full-size month builds inside the serverless budget', async () => {
  const ledgerRows = Array.from({ length: 900 }, (_, i) => ledgerRow({
    tanggal: `2026-08-${String((i % 31) + 1).padStart(2, '0')}`,
    noBukti: `BKT-${i}`, uraian: `Belanja harian nomor ${i} dengan uraian panjang untuk menguji ukuran`,
    debet: i % 2 ? 0 : 125000, kredit: i % 2 ? 250000 : 0,
  }));
  const belanjaRows = ledgerRows.slice(0, 400).map((r) => ({
    tanggal: r.tanggal, noBukti: r.noBukti, uraian: r.uraian, jumlah: 250000, keterangan: 'tunai', sumber: 'Kas di Bank',
  }));
  const payload = bukuPayload({
    workers: Array.from({ length: 100 }, (_, i) => worker({ nama: `Personel ${i}`, hari: 26 })),
    buku: {
      bku: { saldoAwal: 5000000, rows: ledgerRows },
      kas: [
        { nama: 'Kas di Bank', jenis: 'bank', saldoAwal: 5000000, rows: ledgerRows.slice(0, 500) },
        { nama: 'Kas Kecil', jenis: 'petty', saldoAwal: 250000, rows: ledgerRows.slice(500) },
      ],
      belanja: [
        { key: 'bahan', jenis: 'Bahan Baku', rows: belanjaRows },
        { key: 'operasional', jenis: 'Operasional', rows: belanjaRows.slice(0, 100) },
        { key: 'fasilitas', jenis: 'Insentif Fasilitas', rows: belanjaRows.slice(0, 50) },
      ],
      pajak: [
        { jenis: 'PPN', saldoAwal: 0, rows: ledgerRows.slice(0, 200) },
        { jenis: 'PPh 21/22/23', saldoAwal: 0, rows: ledgerRows.slice(0, 60) },
      ],
      catatan: {
        ringkasan: { sisaLalu: 5000000, diterima: 90000000, bahanBaku: 100000000, operasional: 25000000, fasilitas: 12500000 },
        rows: Array.from({ length: 31 }, (_, i) => ({ tanggal: `2026-08-${String(i + 1).padStart(2, '0')}`, jumlah: 4500000 })),
      },
    },
  });

  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  const started = Date.now();
  const res = await callHandler(payload);
  const elapsed = Date.now() - started;

  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  // Vercel caps the request body at 4.5 MB and a Node function at 10 s by default.
  assert.ok(payloadBytes < 4 * 1024 * 1024, `payload ${payloadBytes} bytes is close to the 4.5 MB limit`);
  assert.ok(elapsed < 8000, `generation took ${elapsed} ms`);

  const { workbook } = await readGenerated(res.buffer);
  assert.equal(workbook.worksheets.length, 10);
  const dafnom = workbook.getWorksheet('DafNom');
  assert.equal(cellValue(dafnom, 'D106'), 'Personel 99');
  assert.equal(cellValue(dafnom, 'C107'), 'TOTAL');
  process.stdout.write(`# stress: payload ${(payloadBytes / 1024).toFixed(0)} KB, workbook ${(res.buffer.length / 1024).toFixed(0)} KB, ${elapsed} ms\n`);
});

test('a warm container reuses the parsed template instead of re-reading it', async () => {
  await callHandler(bukuPayload({ workers: [] })); // warm the cache
  const started = Date.now();
  await callHandler(bukuPayload({ workers: [] }));
  const warm = Date.now() - started;
  assert.ok(warm < 1500, `warm request took ${warm} ms`);
  process.stdout.write(`# warm request: ${warm} ms\n`);
});

test('a run of mixed payloads leaves the shared template exactly as it was', async () => {
  // Fingerprints every cell of every sheet, so any drift in the cached template
  // — a stray value, a lost style, a shifted row — changes the digest.
  const fingerprint = async (buffer) => {
    const { workbook } = await readGenerated(buffer);
    const parts = [];
    workbook.eachSheet((sheet) => {
      parts.push(`#${sheet.name}|${sheet.rowCount}|${sheet.columnCount}`);
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
          parts.push(`${rowNumber}!${cell.address}=${JSON.stringify(cell.value)}~${cell.numFmt || ''}~${JSON.stringify(cell.font || {})}`);
        });
      });
    });
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  };

  const reference = bukuPayload();
  const before = await fingerprint((await callHandler(reference)).buffer);

  // Payloads that touch different rows, columns and sheets of the template.
  await callHandler(bukuPayload({ dayCount: 1, workers: [worker()] }));
  await callHandler(bukuPayload({ dayCount: 31, workers: Array.from({ length: 40 }, () => worker()) }));
  await callHandler(bukuPayload({ workers: [], buku: { catatan: { ringkasan: {}, rows: [] } } }));
  await callHandler({ workers: [worker()], dayCount: 10, filename: 'Slip.xlsx' });
  await callHandler(bukuPayload({ buku: { bku: { saldoAwal: 0, rows: [ledgerRow({ tanggal: 'rusak' })] } } }));

  const after = await fingerprint((await callHandler(reference)).buffer);
  assert.equal(after, before, 'the same payload stopped producing the same workbook');
});

test('the cached template is never mutated by the sheets it produces', async () => {
  const first = await callHandler(bukuPayload());
  const second = await callHandler(bukuPayload());
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  const a = await readGenerated(first.buffer);
  const b = await readGenerated(second.buffer);
  for (const name of a.workbook.worksheets.map((s) => s.name)) {
    const sheetA = a.workbook.getWorksheet(name);
    const sheetB = b.workbook.getWorksheet(name);
    assert.equal(sheetB.rowCount, sheetA.rowCount, `${name} row count drifted between runs`);
    assert.equal(cellValue(sheetB, 'C5'), cellValue(sheetA, 'C5'), `${name} title drifted between runs`);
  }
});

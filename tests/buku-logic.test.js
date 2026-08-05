'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBrowserLogic, baseDB, trx, plain } = require('./helpers');

const withDB = (overrides) => {
  const api = loadBrowserLogic();
  api.setDB(baseDB(overrides));
  return api;
};

const AGUSTUS = [
  trx({ id: 'a', tanggal: '2026-07-20', uraian: 'Dana bulan lalu', akunLawan: '2000', tipe: 'D', jumlah: 1500000 }),
  trx({ id: 'b', tanggal: '2026-08-01', uraian: 'Dana bahan makanan', akunLawan: '2000', tipe: 'D', jumlah: 25000000 }),
  trx({ id: 'c', tanggal: '2026-08-03', uraian: 'Belanja sayur', akunLawan: '2010', jumlah: 3200000 }),
  trx({ id: 'd', tanggal: '2026-08-18', uraian: 'Gas dan air', akunKas: '1000', akunLawan: '2110', jumlah: 450000 }),
  trx({ id: 'e', tanggal: '2026-08-20', uraian: 'PPN', akunLawan: '2170', jumlah: 352000 }),
  trx({ id: 'f', tanggal: '2026-08-22', uraian: 'Menunggu approval', akunLawan: '2010', jumlah: 999999, approvalStatus: 'pending' }),
  trx({ id: 'g', tanggal: '2026-09-02', uraian: 'Bulan depan', akunLawan: '2010', jumlah: 700000 }),
];

test('only approved transaksi reach the books', () => {
  const api = withDB({ transaksi: AGUSTUS });
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  const uraian = buku.bku.rows.map((r) => r.uraian);
  assert.ok(!uraian.includes('Menunggu approval'));
  assert.equal(buku.bku.rows.length, 4);
});

test('a rejected transaksi never reaches the books either', () => {
  const api = withDB({ transaksi: [trx({ id: 'x', tanggal: '2026-08-04', approvalStatus: 'rejected' })] });
  assert.equal(api.bukuIsiPeriode(api.periodeInfo()).bku.rows.length, 0);
});

test('the period is inclusive on both ends and excludes its neighbours', () => {
  const api = withDB({
    transaksi: [
      trx({ id: 'p', tanggal: '2026-07-31' }), trx({ id: 'q', tanggal: '2026-08-01' }),
      trx({ id: 'r', tanggal: '2026-08-31' }), trx({ id: 's', tanggal: '2026-09-01' }),
    ],
  });
  const rows = plain(api.bukuIsiPeriode(api.periodeInfo()).bku.rows).map((r) => r.tanggal);
  assert.deepEqual(rows, ['2026-08-01', '2026-08-31']);
});

test('transaksi before the period become the opening balance, not rows', () => {
  const api = withDB({ transaksi: AGUSTUS });
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  assert.equal(buku.bku.saldoAwal, 1500000);
  assert.equal(buku.catatan.ringkasan.sisaLalu, 1500000);
});

test('the two halves of a month join up without a gap or an overlap', () => {
  const api = withDB({ transaksi: AGUSTUS });
  const [awal, akhir] = api.paruhOptions();
  assert.deepEqual([awal.mulai, awal.selesai], ['2026-08-01', '2026-08-15']);
  assert.deepEqual([akhir.mulai, akhir.selesai], ['2026-08-16', '2026-08-31']);

  const satu = api.bukuIsiPeriode(awal);
  const dua = api.bukuIsiPeriode(akhir);
  const tutupParuhSatu = satu.bku.saldoAwal
    + satu.bku.rows.reduce((total, r) => total + r.debet - r.kredit, 0);
  assert.equal(dua.bku.saldoAwal, tutupParuhSatu);

  const bulanan = api.bukuIsiPeriode(api.periodeInfo());
  assert.equal(satu.bku.rows.length + dua.bku.rows.length, bulanan.bku.rows.length);
});

test('half-period options follow a partial Anggaran range', () => {
  const api = withDB({ anggaran: { mulai: '2026-08-10', selesai: '2026-09-05' } });
  assert.deepEqual(plain(api.paruhOptions()).map((o) => `${o.mulai}..${o.selesai}`), ['2026-08-10..2026-08-15', '2026-08-16..2026-08-31']);
  api.setPeriodeIndex(1);
  assert.deepEqual(plain(api.paruhOptions()).map((o) => `${o.mulai}..${o.selesai}`), ['2026-09-01..2026-09-05']);
});

test('a range that starts after the 15th offers only the second half', () => {
  const api = withDB({ anggaran: { mulai: '2026-08-20', selesai: '2026-08-31' } });
  const halves = api.paruhOptions();
  assert.equal(halves.length, 1);
  assert.deepEqual([halves[0].mulai, halves[0].selesai], ['2026-08-20', '2026-08-31']);
  assert.equal(halves[0].dayCount, 12);
});

test('a single-day period is still a valid book', () => {
  const api = withDB({ anggaran: { mulai: '2026-08-07', selesai: '2026-08-07' }, transaksi: [trx({ tanggal: '2026-08-07' })] });
  const periode = api.periodeInfo();
  assert.equal(periode.dayCount, 1);
  const buku = api.bukuIsiPeriode(periode);
  assert.equal(buku.bku.rows.length, 1);
  assert.equal(buku.catatan.rows.length, 1);
});

test('an empty database produces empty books instead of throwing', () => {
  const api = withDB({});
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  assert.equal(buku.bku.rows.length, 0);
  assert.equal(buku.bku.saldoAwal, 0);
  assert.equal(buku.kas.length, 2);
  assert.equal(buku.belanja.length, 3);
  assert.equal(buku.pajak.length, 1, 'BP Pajak must exist even with no tax entries');
  assert.equal(buku.catatan.rows.length, 31);
});

test('a missing Anggaran range falls back to the running month', () => {
  const api = withDB({ anggaran: { mulai: '', selesai: '' } });
  const periode = api.periodeInfo();
  const now = new Date();
  assert.equal(periode.mulai.slice(0, 7), `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  assert.ok(periode.dayCount >= 28 && periode.dayCount <= 31);
});

test('a reversed Anggaran range does not produce a negative period', () => {
  const api = withDB({ anggaran: { mulai: '2026-08-20', selesai: '2026-08-01' } });
  const periode = api.periodeInfo();
  assert.ok(periode.dayCount >= 1, `dayCount was ${periode.dayCount}`);
  assert.ok(periode.mulai <= periode.selesai);
});

test('daily Catatan rows cover the period and match the buku pembantu totals', () => {
  const api = withDB({ transaksi: AGUSTUS });
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  assert.equal(buku.catatan.rows.length, 31);
  assert.equal(buku.catatan.rows[0].tanggal, '2026-08-01');
  assert.equal(buku.catatan.rows[30].tanggal, '2026-08-31');

  const totalHarian = buku.catatan.rows.reduce((sum, r) => sum + r.jumlah, 0);
  const { bahanBaku, operasional, fasilitas } = buku.catatan.ringkasan;
  assert.equal(totalHarian, bahanBaku + operasional + fasilitas);

  const totalBelanja = buku.belanja.reduce((sum, b) => sum + b.rows.reduce((s, r) => s + r.jumlah, 0), 0);
  assert.equal(totalHarian, totalBelanja);
});

test('cash books split by akun kas and keep their own opening balance', () => {
  const api = withDB({
    transaksi: [
      trx({ id: 'a', tanggal: '2026-07-15', akunKas: '1000', tipe: 'D', jumlah: 500000 }),
      trx({ id: 'b', tanggal: '2026-08-05', akunKas: '1000', jumlah: 200000 }),
      trx({ id: 'c', tanggal: '2026-08-06', akunKas: '1100', jumlah: 300000 }),
    ],
  });
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  const petty = buku.kas.find((k) => k.jenis === 'petty');
  const bank = buku.kas.find((k) => k.jenis === 'bank');
  assert.equal(petty.saldoAwal, 500000);
  assert.equal(petty.rows.length, 1);
  assert.equal(bank.saldoAwal, 0);
  assert.equal(bank.rows.length, 1);
});

test('BP Pajak splits per jenis pajak', () => {
  const api = withDB({
    transaksi: [
      trx({ id: 'a', tanggal: '2026-08-05', akunLawan: '2170', jumlah: 110000 }),
      trx({ id: 'b', tanggal: '2026-08-06', akunLawan: '2180', jumlah: 50000 }),
    ],
  });
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  assert.deepEqual(plain(buku.pajak).map((p) => p.jenis).sort(), ['PPN', 'PPh 21/22/23']);
});

test('legacy import dates are normalised instead of breaking the books', () => {
  const api = withDB({
    transaksi: [
      trx({ id: 'a', tanggal: '05/08/2026', uraian: 'CSV dd/mm/yyyy' }),
      trx({ id: 'b', tanggal: '6-8-2026', uraian: 'CSV dd-mm-yyyy' }),
      trx({ id: 'c', tanggal: '7.8.26', uraian: 'CSV dd.mm.yy' }),
      trx({ id: 'd', tanggal: '2026/08/08', uraian: 'CSV yyyy/mm/dd' }),
      trx({ id: 'e', tanggal: '46243', uraian: 'Excel serial' }),
    ],
  });
  const rows = api.bukuIsiPeriode(api.periodeInfo()).bku.rows;
  assert.deepEqual(plain(rows).map((r) => r.tanggal), ['2026-08-05', '2026-08-06', '2026-08-07', '2026-08-08', '2026-08-09']);
  assert.equal(api.tanggalTakTerbaca(), 0);
});

test('date normalisation refuses to invent a date it cannot read', () => {
  const api = withDB({});
  for (const bad of ['', 'kemarin', '2026-13-01', '31/02/2026', '99/99/9999', null, undefined, {}, '12']) {
    assert.equal(api.normalisasiTanggal(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(api.normalisasiTanggal('2026-08-05'), '2026-08-05');
  assert.equal(api.normalisasiTanggal('  05/08/2026 '), '2026-08-05');
});

test('unreadable dates are reported and kept out of the books, not silently dropped', () => {
  const api = withDB({
    transaksi: [
      trx({ id: 'a', tanggal: '2026-08-05', jumlah: 100000 }),
      trx({ id: 'b', tanggal: 'entah kapan', jumlah: 250000 }),
    ],
  });
  assert.equal(api.tanggalTakTerbaca(), 1);
  const buku = api.bukuIsiPeriode(api.periodeInfo());
  assert.equal(buku.bku.rows.length, 1);
  // The row still counts in the ledger totals, so validasi saldo is unchanged.
  assert.equal(api.sortedTransaksi().length, 2);
});

test('selection narrows the personel list, no selection means everyone on screen', () => {
  const api = withDB({
    nominatif: [
      { id: 'n1', nama: 'A', departemen: 'Dapur', pekerjaan: 'Pemorsian', hari: 1, upah: 1, bpjs: 0, honorPJ: 0, grandTotal: 1 },
      { id: 'n2', nama: 'B', departemen: 'Distribusi', pekerjaan: 'Distribusi', hari: 1, upah: 1, bpjs: 0, honorPJ: 0, grandTotal: 1 },
    ],
  });
  assert.equal(api.bukuExportWorkers().length, 2);
  api.setFilterDept('Dapur');
  assert.deepEqual(plain(api.bukuExportWorkers()).map((n) => n.nama), ['A']);
  api.selectNominatif(['n2']);
  assert.deepEqual(plain(api.bukuExportWorkers()).map((n) => n.nama), ['B'], 'an explicit tick wins over the department filter');
});

test('profil feeds the identity block the books print', () => {
  const api = withDB({});
  assert.deepEqual(plain(api.profilBuku()), { namaSPPG: 'SPPG Melati', idSPPG: 'SPPG-0142', alamat: 'Jl. Merdeka 10' });
});

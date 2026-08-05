const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE_PATH = path.join(__dirname, 'templates/MASTER_4.xlsx');

// MASTER_4 is read purely as a style source and never re-serialized: ExcelJS
// models only a subset of OOXML, so writing that workbook back out drops its
// pivot caches, external links, comments and all but a handful of its 243
// defined names, which makes Excel report the download as corrupt and "repair"
// it. Emitting a fresh workbook that only holds the generated sheets keeps the
// layout identical with nothing to repair.
//
// Parsing those 2 MB dominates a request, so a warm container parses them once.
// The promise (not the workbook) is cached, so two requests arriving together
// share one parse instead of racing; a failed parse is dropped so the next
// request retries rather than serving the failure forever. The template is only
// ever read from, never written to, so sharing it between requests is safe.
let templatePromise = null;
const loadTemplate = () => {
  if (!templatePromise) {
    templatePromise = new ExcelJS.Workbook().xlsx.readFile(TEMPLATE_PATH)
      .catch((error) => { templatePromise = null; throw error; });
  }
  return templatePromise;
};

// ---------------------------------------------------------------------------
// DafNom (daftar nominatif upah) — one row per personel.
// ---------------------------------------------------------------------------
const DAFNOM_SHEET_NAME = 'DafNom';
// DafNom's row 7 is the first worker slot in the master roster; rows 1-6 hold
// the title/column headers that every generated sheet reuses.
const HEADER_ROWS = 6;
const DATA_ROW = HEADER_ROWS + 1;
// DafNom natively spans 10 day columns (E..N) — two blocks of five working days,
// i.e. exactly one biweekly period. A monthly book reuses the same layout but
// widens that block to the number of days in the reporting month, pushing the
// HONORARIUM..TOTAL group (template O..S) to the right by the extra columns.
const BIWEEKLY_DAY_COUNT = 10;
const MAX_DAY_COUNT = 31;
const FIRST_DAY_COL = 5; // column E
const TEMPLATE_LAST_DAY_COL = FIRST_DAY_COL + BIWEEKLY_DAY_COUNT - 1; // column N
const TRAILING_COLS = 5; // O..S: HONORARIUM, DANA KESEHATAN, TK, PJ, TOTAL
const DAFNOM_TOTAL_ROW = 57; // the master's TOTAL row, reused for its styling
const MAX_WORKERS = 100;

// Ledger sheets are capped well above a realistic month — a busy SPPG books a
// few dozen transaksi a day — so a corrupt payload cannot make the function
// build an endless workbook, without the cap ever being reached in practice.
const MAX_ROWS_PER_BOOK = 2000;
const MAX_BOOKS_PER_GROUP = 12;

// Reported to the caller instead of being swallowed as an internal fault.
class PayloadError extends Error {}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isFiniteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const isWorker = (worker) => worker && typeof worker === 'object'
  && isNonEmptyString(worker.id)
  && isNonEmptyString(worker.nama)
  && isNonEmptyString(worker.pekerjaan)
  && isFiniteNonNegative(worker.hari)
  && isFiniteNonNegative(worker.tarif)
  && isFiniteNonNegative(worker.bpjs)
  && isFiniteNonNegative(worker.honorPJ)
  && (worker.departemen === undefined || typeof worker.departemen === 'string');

const sanitizeSheetName = (raw, fallback, usedNames) => {
  // Excel bans \/?*[]: anywhere and a single quote at either end, and caps the
  // name at 31 characters. A rejected name makes ExcelJS throw mid-write, so the
  // name is scrubbed here rather than trusted from the payload.
  const cleaned = String(raw)
    .replace(/[\\/?*[\]:]/g, ' ')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/^['\s]+|['\s]+$/g, '')
    .slice(0, 28)
    .replace(/['\s]+$/, '');
  const base = cleaned || fallback;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})`.slice(0, 31);
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
};

const parseRangeRows = (range) => {
  const match = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(range);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
};

const columnIndex = (letters) => letters.split('')
  .reduce((acc, char) => acc * 26 + (char.charCodeAt(0) - 64), 0);

const rangeLastColumn = (range) => {
  const match = /^([A-Z]+)\d+:([A-Z]+)\d+$/.exec(range);
  return match ? Math.max(columnIndex(match[1]), columnIndex(match[2])) : Infinity;
};

const asText = (value, max = 300) => (typeof value === 'string' ? value.slice(0, max) : '');
const asNumber = (value) => (isFiniteNumber(value) ? value : 0);

// Parsed as UTC so the serial number Excel stores is the date the app sent,
// with no timezone drift on either side of the request.
const parseISODate = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
};

// ---------------------------------------------------------------------------
// Generic MASTER_4 cloning
//
// MASTER_4 is a live workbook: every book sheet is a formula view over its
// Transaksi/Setup/LR sheets. The generated workbook carries only the finished
// books, so those cross-sheet formulas are dropped during the clone and the
// caller writes literal values from SIPGN Helper in their place. Formulas that
// stay inside one sheet (running saldo, totals) are rebuilt for the real row
// count, which keeps the export a working spreadsheet rather than a dump.
// ---------------------------------------------------------------------------

// Columns A and B hold the master's VLOOKUP scaffolding ("Transaksi!", "W1000",
// row counters). They mean nothing without the Transaksi sheet, so the clone
// keeps their widths but never their content.
const HELPER_COLS = 2;

const cloneHeaderRegion = (templateSheet, targetSheet, lastRow, lastCol) => {
  for (let col = 1; col <= lastCol; col += 1) {
    const source = templateSheet.getColumn(col);
    const target = targetSheet.getColumn(col);
    target.width = source.width;
    target.hidden = source.hidden;
  }

  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const sourceRow = templateSheet.getRow(rowNumber);
    const targetRow = targetSheet.getRow(rowNumber);
    for (let col = 1; col <= lastCol; col += 1) {
      const sourceCell = sourceRow.getCell(col);
      const targetCell = targetRow.getCell(col);
      targetCell.style = sourceCell.style;
      targetCell.value = col <= HELPER_COLS ? null : literalValueOf(sourceCell);
    }
    targetRow.height = sourceRow.height;
  }

  templateSheet.model.merges.forEach((range) => {
    const rows = parseRangeRows(range);
    if (rows && rows[1] <= lastRow && rangeLastColumn(range) <= lastCol) targetSheet.mergeCells(range);
  });
};

const literalValueOf = (cell) => {
  if (cell.formula || cell.sharedFormula) return null;
  const value = cell.value;
  if (value === undefined) return null;
  if (value && typeof value === 'object' && !(value instanceof Date) && !value.richText) return null;
  return value;
};

const copyRowStyle = (templateSheet, targetSheet, templateRowNumber, targetRowNumber, lastCol) => {
  const sourceRow = templateSheet.getRow(templateRowNumber);
  const targetRow = targetSheet.getRow(targetRowNumber);
  for (let col = 1; col <= lastCol; col += 1) {
    targetRow.getCell(col).style = sourceRow.getCell(col).style;
  }
  targetRow.height = sourceRow.height;
  return targetRow;
};

// ---------------------------------------------------------------------------
// Whole-sheet cloning for the form sheets (Setup, Transaksi, the letters and the
// Barang Persediaan group).
//
// Unlike the book sheets, these keep the master's formulas wherever they still
// resolve. A formula survives only when every sheet it names is also in the
// generated workbook — the Barang Persediaan sheets reference each other, so
// exporting the group intact keeps its stock arithmetic live. Anything pointing
// at a sheet left behind, at a structured table (ExcelJS cannot recreate the
// table definitions), or at a broken reference is dropped so Excel never opens
// on a #REF!.
// ---------------------------------------------------------------------------
// Excel requires quotes around any sheet name that is not a bare identifier, so
// an unquoted reference can only be [A-Za-z0-9_]. Letting spaces or brackets
// into that class makes "IF(Setup!C6" parse as a sheet named "IF(Setup", which
// silently deletes perfectly good formulas.
const SHEET_REF = /(?:'([^']+)'|([A-Za-z0-9_]+))!/g;

const formulaIsPortable = (formula, presentSheets) => {
  if (/#REF!|\[/.test(formula)) return false;
  SHEET_REF.lastIndex = 0;
  let match = SHEET_REF.exec(formula);
  while (match) {
    const sheet = match[1] || match[2];
    if (!presentSheets.has(sheet.trim())) return false;
    match = SHEET_REF.exec(formula);
  }
  return true;
};

const cloneSheet = (workbook, templateSheet, sheetName, options) => {
  const { lastRow, lastCol, presentSheets = new Set(), overrides = {} } = options;
  const sheet = workbook.addWorksheet(sheetName, {
    properties: { tabColor: templateSheet.properties.tabColor },
    views: templateSheet.views,
  });

  for (let col = 1; col <= lastCol; col += 1) {
    const source = templateSheet.getColumn(col);
    sheet.getColumn(col).width = source.width;
    sheet.getColumn(col).hidden = source.hidden;
  }

  for (let rowNumber = 1; rowNumber <= lastRow; rowNumber += 1) {
    const sourceRow = templateSheet.getRow(rowNumber);
    const targetRow = sheet.getRow(rowNumber);
    for (let col = 1; col <= lastCol; col += 1) {
      const sourceCell = sourceRow.getCell(col);
      const targetCell = targetRow.getCell(col);
      targetCell.style = sourceCell.style;
      const formula = sourceCell.formula
        || (sourceCell.value && sourceCell.value.sharedFormula ? sourceCell.value.sharedFormula : null);
      if (formula) {
        // A shared formula is re-anchored by ExcelJS on read, so the master
        // formula of the group is the one worth carrying.
        targetCell.value = sourceCell.formula && formulaIsPortable(sourceCell.formula, presentSheets)
          ? { formula: sourceCell.formula }
          : null;
      } else {
        targetCell.value = literalValueOf(sourceCell);
      }
    }
    targetRow.height = sourceRow.height;
  }

  (templateSheet.model.merges || []).forEach((range) => {
    const rows = parseRangeRows(range);
    if (rows && rows[1] <= lastRow && rangeLastColumn(range) <= lastCol) sheet.mergeCells(range);
  });

  Object.entries(overrides).forEach(([address, value]) => {
    sheet.getCell(address).value = value === undefined ? null : value;
  });
  return sheet;
};

const setIdentity = (sheet, cells, profil) => {
  // The master writes identity as ":  " & Setup!… so the colon lines up in the
  // merged label column; the generated books keep that shape.
  if (cells.nama) sheet.getCell(cells.nama).value = `:  ${profil.namaSPPG}`;
  if (cells.id) sheet.getCell(cells.id).value = `:  ${profil.idSPPG}`;
  if (cells.alamat) sheet.getCell(cells.alamat).value = `:  ${profil.alamat}`;
};

// ---------------------------------------------------------------------------
// BKU / BP Kas / BP Petty Cash — debet, kredit and a running saldo
// ---------------------------------------------------------------------------
const LEDGER_LAYOUT = { lastCol: 9, headerRows: 15, openingRow: 15, dataRow: 16 };

const buildLedgerSheet = (workbook, templateSheet, spec) => {
  const { headerRows, openingRow, dataRow, lastCol } = LEDGER_LAYOUT;
  const sheet = workbook.addWorksheet(spec.sheetName, {
    properties: { tabColor: templateSheet.properties.tabColor },
  });
  cloneHeaderRegion(templateSheet, sheet, headerRows, lastCol);

  sheet.getCell('C6').value = spec.periodeText;
  setIdentity(sheet, spec.identity, spec.profil);
  if (spec.jenisCell) sheet.getCell(spec.jenisCell).value = spec.jenis;

  sheet.getCell('I10').value = spec.saldoAwal;
  // "SALDO AWAL BULAN BERJALAN" carries the balance the period opens with; the
  // 'x' the master parks in the Bulan column is scaffolding, not data.
  sheet.getCell(`C${openingRow}`).value = null;
  sheet.getCell(`G${openingRow}`).value = { formula: 'I10' };
  sheet.getCell(`H${openingRow}`).value = 0;
  sheet.getCell(`I${openingRow}`).value = { formula: 'I10' };

  spec.rows.forEach((entry, index) => {
    const rowNumber = dataRow + index;
    const row = copyRowStyle(templateSheet, sheet, dataRow, rowNumber, lastCol);
    row.getCell('C').value = parseISODate(entry.tanggal);
    row.getCell('E').value = asText(entry.noBukti, 40);
    row.getCell('F').value = asText(entry.uraian);
    row.getCell('G').value = asNumber(entry.debet) || null;
    row.getCell('H').value = asNumber(entry.kredit) || null;
    row.getCell('I').value = { formula: `I${rowNumber - 1}+G${rowNumber}-H${rowNumber}` };
    row.commit();
  });

  const lastRow = spec.rows.length ? dataRow + spec.rows.length - 1 : openingRow;
  sheet.getCell('I11').value = { formula: `I${lastRow}` };
  return sheet;
};

// ---------------------------------------------------------------------------
// BP Bahan Baku / Operasional / Fasilitas — one column of realised spending
// ---------------------------------------------------------------------------
const BELANJA_LAYOUT = { lastCol: 9, headerRows: 16, dataRow: 17 };

const buildBelanjaSheet = (workbook, templateSheet, spec) => {
  const { headerRows, dataRow, lastCol } = BELANJA_LAYOUT;
  const sheet = workbook.addWorksheet(spec.sheetName, {
    properties: { tabColor: templateSheet.properties.tabColor },
  });
  cloneHeaderRegion(templateSheet, sheet, headerRows, lastCol);

  sheet.getCell('C6').value = spec.periodeText;
  setIdentity(sheet, { nama: 'E8', id: 'E9', alamat: 'E10' }, spec.profil);
  sheet.getCell('F11').value = spec.jenis;
  // F12/F13 are #REF! leftovers in the master.
  sheet.getCell('F12').value = null;
  sheet.getCell('F13').value = null;

  spec.rows.forEach((entry, index) => {
    const rowNumber = dataRow + index;
    const row = copyRowStyle(templateSheet, sheet, dataRow, rowNumber, lastCol);
    row.getCell('C').value = parseISODate(entry.tanggal);
    row.getCell('E').value = asText(entry.noBukti, 40);
    row.getCell('F').value = asText(entry.uraian);
    row.getCell('G').value = asNumber(entry.jumlah) || null;
    row.getCell('H').value = asText(entry.keterangan, 120) || null;
    row.getCell('I').value = asText(entry.sumber, 120) || null;
    row.commit();
  });

  const lastRow = dataRow + Math.max(spec.rows.length, 1) - 1;
  sheet.getCell('H11').value = { formula: `SUM(G${dataRow}:G${lastRow})` };
  return sheet;
};

// ---------------------------------------------------------------------------
// BP Pajak — same shape as the cash books plus a jenis pajak and a TOTAL row
// ---------------------------------------------------------------------------
const PAJAK_LAYOUT = { lastCol: 10, headerRows: 15, openingRow: 15, dataRow: 16, totalTemplateRow: 2795 };

const buildPajakSheet = (workbook, templateSheet, spec) => {
  const { headerRows, openingRow, dataRow, lastCol, totalTemplateRow } = PAJAK_LAYOUT;
  const sheet = workbook.addWorksheet(spec.sheetName, {
    properties: { tabColor: templateSheet.properties.tabColor },
  });
  cloneHeaderRegion(templateSheet, sheet, headerRows, lastCol);

  sheet.getCell('C6').value = spec.periodeText;
  setIdentity(sheet, { nama: 'E8', alamat: 'E9' }, spec.profil);
  sheet.getCell('F11').value = spec.jenis;

  sheet.getCell('I10').value = spec.saldoAwal;
  sheet.getCell(`C${openingRow}`).value = null;
  sheet.getCell(`G${openingRow}`).value = { formula: 'I10' };
  sheet.getCell(`H${openingRow}`).value = 0;
  sheet.getCell(`I${openingRow}`).value = { formula: 'I10' };

  spec.rows.forEach((entry, index) => {
    const rowNumber = dataRow + index;
    const row = copyRowStyle(templateSheet, sheet, dataRow, rowNumber, lastCol);
    row.getCell('C').value = parseISODate(entry.tanggal);
    row.getCell('E').value = asText(entry.noBukti, 40);
    row.getCell('F').value = asText(entry.uraian);
    row.getCell('G').value = asNumber(entry.debet) || null;
    row.getCell('H').value = asNumber(entry.kredit) || null;
    row.getCell('I').value = { formula: `I${rowNumber - 1}+G${rowNumber}-H${rowNumber}` };
    row.getCell('J').value = asText(entry.keterangan, 120) || null;
    row.commit();
  });

  const lastRow = spec.rows.length ? dataRow + spec.rows.length - 1 : openingRow;
  const totalRowNumber = lastRow + 2;
  const totalRow = copyRowStyle(templateSheet, sheet, totalTemplateRow, totalRowNumber, lastCol);
  totalRow.getCell('F').value = 'TOTAL';
  totalRow.getCell('G').value = { formula: `SUM(G${dataRow}:G${lastRow})` };
  totalRow.getCell('H').value = { formula: `SUM(H${dataRow}:H${lastRow})` };
  totalRow.getCell('I').value = { formula: `I${lastRow}` };
  totalRow.commit();

  sheet.getCell('I11').value = { formula: `I${totalRowNumber}` };
  return sheet;
};

// ---------------------------------------------------------------------------
// Catatan Pengeluaran Harian — dana summary plus one row per calendar day
// ---------------------------------------------------------------------------
const CATATAN_LAYOUT = { lastCol: 5, headerRows: 22, dataRow: 23, totalTemplateRow: 35 };

const buildCatatanSheet = (workbook, templateSheet, spec) => {
  const { headerRows, dataRow, lastCol, totalTemplateRow } = CATATAN_LAYOUT;
  const sheet = workbook.addWorksheet(spec.sheetName, {
    properties: { tabColor: templateSheet.properties.tabColor },
  });
  cloneHeaderRegion(templateSheet, sheet, headerRows, lastCol);

  sheet.getCell('C6').value = spec.periodeText;
  setIdentity(sheet, { nama: 'D8', id: 'D9', alamat: 'D10' }, spec.profil);

  const r = spec.ringkasan;
  sheet.getCell('E12').value = asNumber(r.sisaLalu);
  sheet.getCell('E13').value = asNumber(r.diterima);
  sheet.getCell('E14').value = { formula: 'E12+E13' };
  sheet.getCell('E15').value = asNumber(r.bahanBaku);
  sheet.getCell('E16').value = asNumber(r.operasional);
  sheet.getCell('E17').value = asNumber(r.fasilitas);
  sheet.getCell('E18').value = { formula: 'E15+E16+E17' };
  sheet.getCell('E19').value = { formula: 'E14-E18' };

  spec.rows.forEach((entry, index) => {
    const rowNumber = dataRow + index;
    const row = copyRowStyle(templateSheet, sheet, dataRow, rowNumber, lastCol);
    row.getCell('C').value = parseISODate(entry.tanggal);
    row.getCell('D').value = asNumber(entry.jumlah) ? 'Pengeluaran harian' : null;
    row.getCell('E').value = asNumber(entry.jumlah) || null;
    row.commit();
  });

  const lastRow = dataRow + Math.max(spec.rows.length, 1) - 1;
  const totalRow = copyRowStyle(templateSheet, sheet, totalTemplateRow, lastRow + 1, lastCol);
  totalRow.getCell('D').value = 'Total Pengeluaran';
  totalRow.getCell('E').value = { formula: `SUM(E${dataRow}:E${lastRow})` };
  totalRow.commit();
  return sheet;
};

const formatRupiah = (value) => `Rp${Math.round(asNumber(value)).toLocaleString('id-ID')}`;

// ---------------------------------------------------------------------------
// Menu Input — Setup, Saldo Buku, Anggaran, Transaksi
// ---------------------------------------------------------------------------

// Setup drives the identity and period text every other sheet reads, so it is
// filled from the app rather than left as the master's example values.
const buildSetupSheet = (workbook, templateSheet, profil, presentSheets) => cloneSheet(
  workbook, templateSheet, 'Setup',
  {
    lastRow: 25,
    lastCol: 8,
    presentSheets,
    overrides: {
      C6: profil.namaSPPG, C7: profil.idSPPG, C8: profil.alamat,
      C9: profil.kepalaSPPG, C10: profil.akuntan, C11: profil.namaYayasan,
      C12: profil.ketuaYayasan, C13: profil.rekening, C14: profil.tahunAnggaran,
      // The master stores the period as text so its "s.d." line reads naturally.
      C15: profil.periodeMulaiText, C16: profil.periodeSelesaiText,
      C17: profil.periodeBerikutnyaText, C18: profil.tanggalPelaporan,
      C19: profil.tempatPelaporan, C20: profil.nomorLPA, C21: profil.nomorBAPSD,
    },
  },
);

// Saldo Buku column D is the master's yellow input block: the balance each book
// opens the period with. Column E is its closing counterpart; only the BKU cell
// can stay a formula, the rest come from the app.
const SALDO_BUKU_ROWS = [
  ['bku', 8], ['pettyCash', 10], ['kasBank', 11], ['danaBantuan', 13],
  ['ppn', 14], ['pph21', 15], ['pph22', 16], ['pph23', 17], ['pph4', 18],
  ['biayaBahan', 19], ['biayaOperasional', 20], ['biayaFasilitas', 21], ['biayaLain', 22],
];

const buildSaldoBukuSheet = (workbook, templateSheet, saldo, presentSheets) => {
  const overrides = {};
  SALDO_BUKU_ROWS.forEach(([key, row]) => {
    overrides[`D${row}`] = asNumber(saldo.awal ? saldo.awal[key] : 0);
    // E8 keeps the master's =BKU!I11; every other closing balance is computed here.
    if (row !== 8) overrides[`E${row}`] = asNumber(saldo.akhir ? saldo.akhir[key] : 0);
  });
  return cloneSheet(workbook, templateSheet, 'Saldo Buku', { lastRow: 25, lastCol: 9, presentSheets, overrides });
};

// The master's Anggaran sheet plans MBG meal packages per day and category.
// SIPGN Helper records budgets in rupiah only, so this ships as the blank
// planning form it is in MASTER_4.
const buildAnggaranSheet = (workbook, templateSheet, presentSheets) => cloneSheet(
  workbook, templateSheet, 'Anggaran', { lastRow: 20, lastCol: 17, presentSheets },
);

// Transaksi is the master's input sheet; every book in MASTER_4 is a view over
// it. Columns C..J are what an operator types, K..T are same-sheet formulas that
// survive the clone, so the exported sheet behaves like the original.
const TRANSAKSI_FIRST_ROW = 11;

const buildTransaksiSheet = (workbook, templateSheet, rows, presentSheets) => {
  const lastRow = Math.max(TRANSAKSI_FIRST_ROW + rows.length - 1, TRANSAKSI_FIRST_ROW + 9);
  const sheet = cloneSheet(workbook, templateSheet, 'Transaksi', { lastRow, lastCol: 20, presentSheets });

  rows.forEach((entry, index) => {
    const row = sheet.getRow(TRANSAKSI_FIRST_ROW + index);
    row.getCell('C').value = parseISODate(entry.tanggal);
    row.getCell('E').value = asText(entry.noBukti, 40);
    row.getCell('F').value = asText(entry.uraian);
    row.getCell('G').value = asNumber(entry.debet) || null;
    row.getCell('H').value = asNumber(entry.kredit) || null;
    row.getCell('I').value = asText(entry.jenisBuku, 60) || null;
    row.getCell('J').value = asText(entry.akunKas, 60) || null;
    row.commit();
  });
  return sheet;
};

// ---------------------------------------------------------------------------
// Cetak Laporan — LPA, SPTJ, BAPSD
//
// These are letters, not ledgers: they read names and dates from Setup and their
// figures from LR, a sheet the export leaves behind. The Setup references
// survive the clone; the LR ones are replaced with totals the app computed.
// ---------------------------------------------------------------------------
const sisaDana = (laporan) => asNumber(laporan.danaPemasukan)
  - (asNumber(laporan.bahanBaku) + asNumber(laporan.operasional) + asNumber(laporan.fasilitas));

const buildLpaSheet = (workbook, templateSheet, laporan, presentSheets) => cloneSheet(
  workbook, templateSheet, 'LPA',
  {
    lastRow: 54,
    lastCol: 12,
    presentSheets,
    overrides: {
      F19: asNumber(laporan.danaPemasukan),
      F21: asNumber(laporan.bahanBaku),
      F22: asNumber(laporan.operasional),
      F23: asNumber(laporan.fasilitas),
      // BAPSD and the closing sentence both read the sisa from this cell.
      AB26: sisaDana(laporan),
      B35: `Sisa dana sebesar ${formatRupiah(sisaDana(laporan))} akan dialihkan ke periode berikutnya.`,
    },
  },
);

const buildSptjSheet = (workbook, templateSheet, presentSheets) => cloneSheet(
  workbook, templateSheet, 'SPTJ', { lastRow: 35, lastCol: 12, presentSheets },
);

const buildBapsdSheet = (workbook, templateSheet, laporan, presentSheets) => cloneSheet(
  workbook, templateSheet, 'BAPSD',
  {
    lastRow: 33,
    lastCol: 10,
    presentSheets,
    overrides: {
      A10: `Sisa dana sebesar ${formatRupiah(sisaDana(laporan))} akan dialihkan ke periode selanjutnya.`,
    },
  },
);

// ---------------------------------------------------------------------------
// Barang Persediaan — Ref_Brg, Saldo_Brg, Masuk, Keluar, Stock_Brg (D)/(R)
//
// This group is self-contained: the stock report is computed from the reference
// list, the opening balances and the two movement sheets, all of which travel
// together. Exporting them under their MASTER_4 names keeps that arithmetic
// live, so whatever an operator types into Saldo_Brg or Keluar still totals up.
// SIPGN Helper has no stock module yet, so only Penerimaan Barang carries data —
// built from the pembelian items already recorded.
// ---------------------------------------------------------------------------
const REF_BRG_LAST_ROW = 315; // the catalogue itself runs to row 311
const MASUK_ENTRY_ROW = 312; // rows 9..311 mirror Saldo_Brg; entries start here
const KELUAR_ENTRY_ROW = 8;
const MASUK_MIN_ROWS = 40;
const KELUAR_FORM_ROWS = 40;

const buildBarangSheets = (workbook, templateFor, barang, presentSheets) => {
  cloneSheet(workbook, templateFor('Ref_Brg'), 'Ref_Brg', { lastRow: REF_BRG_LAST_ROW, lastCol: 6, presentSheets });
  cloneSheet(workbook, templateFor('Saldo_Brg'), 'Saldo_Brg', { lastRow: REF_BRG_LAST_ROW, lastCol: 8, presentSheets });

  const masukRows = barang.masuk || [];
  const masuk = cloneSheet(workbook, templateFor('Masuk'), 'Masuk', {
    lastRow: MASUK_ENTRY_ROW + Math.max(masukRows.length, MASUK_MIN_ROWS) - 1,
    lastCol: 12,
    presentSheets,
  });
  masukRows.forEach((entry, index) => {
    const rowNumber = MASUK_ENTRY_ROW + index;
    const row = masuk.getRow(rowNumber);
    row.getCell('C').value = parseISODate(entry.tanggal);
    row.getCell('D').value = asText(entry.supplier, 80) || null;
    row.getCell('E').value = asText(entry.nama, 120) || null;
    // The master derives satuan by VLOOKUP against Ref_Brg, which only resolves
    // for catalogue names; a purchase carries its own, so that one wins.
    row.getCell('G').value = asText(entry.satuan, 20) || null;
    row.getCell('H').value = asNumber(entry.vol) || null;
    row.getCell('I').value = asNumber(entry.harga) || null;
    // Column J is a structured-table formula in the master and cannot survive
    // the clone, so it is rebuilt as plain arithmetic.
    row.getCell('J').value = { formula: `IF(H${rowNumber}="","",H${rowNumber}*I${rowNumber})` };
    row.commit();
  });

  cloneSheet(workbook, templateFor('Keluar'), 'Keluar', {
    lastRow: KELUAR_ENTRY_ROW + KELUAR_FORM_ROWS - 1, lastCol: 8, presentSheets,
  });
  // Column AA feeds the rekap's SUMIF, so the detail sheet keeps its full width.
  cloneSheet(workbook, templateFor('Stock_Brg (D)'), 'Stock_Brg (D)', { lastRow: REF_BRG_LAST_ROW, lastCol: 28, presentSheets });
  cloneSheet(workbook, templateFor('Stock_Brg (R)'), 'Stock_Brg (R)', { lastRow: 48, lastCol: 8, presentSheets });
};

// ---------------------------------------------------------------------------
// DafNom
// ---------------------------------------------------------------------------

// Maps a column of the generated sheet back to the template column whose style it
// should inherit. Day columns past the template's N all reuse E's styling; the
// HONORARIUM..TOTAL group keeps its own styles at its shifted position.
const sourceColumnFor = (targetCol, dayCount) => {
  if (targetCol < FIRST_DAY_COL) return targetCol;
  const lastDayCol = FIRST_DAY_COL + dayCount - 1;
  if (targetCol <= lastDayCol) {
    const offset = targetCol - FIRST_DAY_COL;
    return offset < BIWEEKLY_DAY_COUNT ? FIRST_DAY_COL + offset : FIRST_DAY_COL;
  }
  return TEMPLATE_LAST_DAY_COL + (targetCol - lastDayCol);
};

// Clones DafNom's header block (rows 1..DATA_ROW) into a fresh sheet, preserving
// column widths, cell styles and formulas. The example values in the template's
// data row are intentionally NOT copied — the caller fills the data rows with
// real personel right after this returns.
const cloneDafNomHeader = (templateSheet, targetSheet, dayCount, periodeLabel) => {
  const lastDayCol = FIRST_DAY_COL + dayCount - 1;
  const totalCols = lastDayCol + TRAILING_COLS;

  for (let col = 1; col <= totalCols; col += 1) {
    const source = templateSheet.getColumn(sourceColumnFor(col, dayCount));
    const target = targetSheet.getColumn(col);
    target.width = source.width;
    target.hidden = source.hidden;
  }

  for (let rowNumber = 1; rowNumber <= DATA_ROW; rowNumber += 1) {
    const targetRow = targetSheet.getRow(rowNumber);
    for (let col = 1; col <= totalCols; col += 1) {
      const sourceCol = sourceColumnFor(col, dayCount);
      const sourceCell = templateSheet.getRow(rowNumber).getCell(sourceCol);
      const targetCell = targetRow.getCell(col);
      targetCell.style = sourceCell.style;
      if (rowNumber === DATA_ROW) continue; // data rows are filled by fillWorkerRow

      const isDayColumn = col >= FIRST_DAY_COL && col <= lastDayCol;
      if (isDayColumn && rowNumber === HEADER_ROWS) {
        // Spell the day numbers out instead of carrying the template's
        // IF(E6="","",E6+1) chain, which stays blank unless someone types a
        // seed date by hand and cannot span more than the original 10 columns.
        targetCell.value = col - FIRST_DAY_COL + 1;
      } else if (isDayColumn && rowNumber === HEADER_ROWS - 1) {
        targetCell.value = col === FIRST_DAY_COL ? periodeLabel : null;
      } else if (sourceCell.formula) {
        targetCell.value = { formula: sourceCell.formula };
      } else {
        targetCell.value = sourceCell.value;
      }
    }
    targetRow.height = templateSheet.getRow(rowNumber).height;
  }

  templateSheet.model.merges.forEach((range) => {
    const rows = parseRangeRows(range);
    if (rows && rows[1] <= DATA_ROW) targetSheet.mergeCells(range);
  });
};

const dafNomColumnLetters = (sheet, dayCount) => {
  const lastDayCol = FIRST_DAY_COL + dayCount - 1;
  return {
    lastDayCol,
    firstLetter: sheet.getColumn(FIRST_DAY_COL).letter,
    lastLetter: sheet.getColumn(lastDayCol).letter,
    trailing: Array.from({ length: TRAILING_COLS }, (_, i) => sheet.getColumn(lastDayCol + 1 + i).letter),
  };
};

const fillWorkerRow = (sheet, worker, dayCount, rowNumber, urutan) => {
  const row = sheet.getRow(rowNumber);
  const { lastDayCol, firstLetter, lastLetter, trailing } = dafNomColumnLetters(sheet, dayCount);
  const [honorCol, danaCol, tkCol, pjCol, totalCol] = trailing;

  row.getCell('B').value = urutan;
  row.getCell('C').value = worker.pekerjaan;
  row.getCell('D').value = worker.nama;

  // A worker can be scheduled for at most the days the period actually has.
  const paidDays = Math.min(worker.hari, dayCount);
  for (let col = FIRST_DAY_COL; col <= lastDayCol; col += 1) {
    row.getCell(col).value = col - FIRST_DAY_COL < paidDays ? worker.tarif : null;
  }

  row.getCell(honorCol).value = { formula: `SUM(${firstLetter}${rowNumber}:${lastLetter}${rowNumber})` };
  // BPJS Kesehatan + Ketenagakerjaan are tracked as one combined figure upstream.
  row.getCell(danaCol).value = worker.bpjs || null;
  row.getCell(pjCol).value = worker.honorPJ || null;
  row.getCell(totalCol).value = {
    formula: `${honorCol}${rowNumber}+${danaCol}${rowNumber}+${tkCol}${rowNumber}+${pjCol}${rowNumber}`,
  };
  row.commit();
};

const buildDafNomSheet = (workbook, templateSheet, sheetName, workers, dayCount, periodeLabel, withTotal) => {
  const sheet = workbook.addWorksheet(sheetName, {
    properties: { tabColor: templateSheet.properties.tabColor },
  });
  cloneDafNomHeader(templateSheet, sheet, dayCount, periodeLabel);

  // The header carries one departemen line, so it is only meaningful when every
  // personel on the sheet belongs to the same one.
  const departemen = workers.length && workers.every((w) => w.departemen && w.departemen === workers[0].departemen)
    ? workers[0].departemen
    : '';
  if (departemen) sheet.getCell('B4').value = `Departemen: ${departemen}`;

  const totalCols = FIRST_DAY_COL + dayCount - 1 + TRAILING_COLS;
  workers.forEach((worker, index) => {
    const rowNumber = DATA_ROW + index;
    if (index > 0) {
      const targetRow = sheet.getRow(rowNumber);
      for (let col = 1; col <= totalCols; col += 1) {
        targetRow.getCell(col).style = templateSheet.getRow(DATA_ROW).getCell(sourceColumnFor(col, dayCount)).style;
      }
      targetRow.height = templateSheet.getRow(DATA_ROW).height;
    }
    fillWorkerRow(sheet, worker, dayCount, rowNumber, index + 1);
  });

  if (!withTotal || workers.length === 0) return sheet;

  const lastRow = DATA_ROW + workers.length - 1;
  const totalRowNumber = lastRow + 1;
  const totalRow = sheet.getRow(totalRowNumber);
  for (let col = 1; col <= totalCols; col += 1) {
    totalRow.getCell(col).style = templateSheet.getRow(DAFNOM_TOTAL_ROW).getCell(sourceColumnFor(col, dayCount)).style;
  }
  totalRow.height = templateSheet.getRow(DAFNOM_TOTAL_ROW).height;
  totalRow.getCell('C').value = 'TOTAL';
  for (let col = FIRST_DAY_COL; col <= totalCols; col += 1) {
    const letter = sheet.getColumn(col).letter;
    totalRow.getCell(col).value = { formula: `SUM(${letter}${DATA_ROW}:${letter}${lastRow})` };
  }
  totalRow.commit();
  return sheet;
};

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------
const isLedgerRow = (row) => row && typeof row === 'object'
  && parseISODate(row.tanggal) !== null
  && isFiniteNumber(row.debet ?? 0) && isFiniteNumber(row.kredit ?? 0);

const isBelanjaRow = (row) => row && typeof row === 'object'
  && parseISODate(row.tanggal) !== null
  && isFiniteNumber(row.jumlah ?? 0);

const isCatatanRow = (row) => row && typeof row === 'object'
  && parseISODate(row.tanggal) !== null
  && isFiniteNumber(row.jumlah ?? 0);

const validateRows = (rows, predicate, label) => {
  if (!Array.isArray(rows)) throw new PayloadError(`Data ${label} tidak valid`);
  if (rows.length > MAX_ROWS_PER_BOOK) throw new PayloadError(`${label} melebihi ${MAX_ROWS_PER_BOOK} baris`);
  if (!rows.every(predicate)) throw new PayloadError(`Data ${label} tidak valid`);
  return rows;
};

const validateGroup = (group, label) => {
  if (!Array.isArray(group)) throw new PayloadError(`Data ${label} tidak valid`);
  if (group.length > MAX_BOOKS_PER_GROUP) throw new PayloadError(`${label} melebihi ${MAX_BOOKS_PER_GROUP} buku`);
  return group;
};

// Only the three identity fields are needed by the book headers; the rest fill
// the Setup sheet and the three letters, and each is optional.
const PROFIL_FIELDS = [
  ['namaSPPG', 120], ['idSPPG', 60], ['alamat', 200], ['kepalaSPPG', 120],
  ['akuntan', 120], ['namaYayasan', 120], ['ketuaYayasan', 120], ['rekening', 60],
  ['tahunAnggaran', 20], ['periodeMulaiText', 40], ['periodeSelesaiText', 40],
  ['periodeBerikutnyaText', 40], ['tanggalPelaporan', 40], ['tempatPelaporan', 60],
  ['nomorLPA', 60], ['nomorBAPSD', 60],
];

const readProfil = (raw) => Object.fromEntries(
  PROFIL_FIELDS.map(([field, max]) => [field, asText(raw && raw[field], max)]),
);

const isTransaksiRow = (row) => row && typeof row === 'object'
  && parseISODate(row.tanggal) !== null
  && isFiniteNumber(row.debet ?? 0) && isFiniteNumber(row.kredit ?? 0);

const isMasukRow = (row) => row && typeof row === 'object'
  && parseISODate(row.tanggal) !== null
  && isFiniteNumber(row.vol ?? 0) && isFiniteNumber(row.harga ?? 0);

// ---------------------------------------------------------------------------
// Workbook assembly
// ---------------------------------------------------------------------------
const buildBukuWorkbook = (workbook, templateWorkbook, buku, profil, periodeText, periodeLabel, workers, dayCount) => {
  const usedNames = new Set();
  const sheetFor = (name) => sanitizeSheetName(name, 'Buku', usedNames);
  const templateFor = (name) => {
    const sheet = templateWorkbook.getWorksheet(name);
    if (!sheet) throw new Error(`Sheet template '${name}' tidak ditemukan pada MASTER_4.xlsx`);
    return sheet;
  };

  // Sheets that keep their MASTER_4 name, so the formulas pointing at them still
  // resolve inside the export. A formula naming anything outside this set is
  // dropped by cloneSheet.
  const presentSheets = new Set([
    'Setup', 'Saldo Buku', 'Anggaran', 'Transaksi', 'BKU',
    'LPA', 'SPTJ', 'BAPSD', 'Catatan', 'DafNom',
    'Ref_Brg', 'Saldo_Brg', 'Masuk', 'Keluar', 'Stock_Brg (D)', 'Stock_Brg (R)',
  ]);

  // --- Menu Input -----------------------------------------------------------
  buildSetupSheet(workbook, templateFor('Setup'), profil, presentSheets);
  usedNames.add('setup');
  buildSaldoBukuSheet(workbook, templateFor('Saldo Buku'), buku.saldoBuku || {}, presentSheets);
  usedNames.add('saldo buku');
  buildAnggaranSheet(workbook, templateFor('Anggaran'), presentSheets);
  usedNames.add('anggaran');
  buildTransaksiSheet(
    workbook, templateFor('Transaksi'),
    validateRows(buku.transaksi || [], isTransaksiRow, 'Transaksi'),
    presentSheets,
  );
  usedNames.add('transaksi');

  if (buku.bku) {
    buildLedgerSheet(workbook, templateFor('BKU'), {
      sheetName: sheetFor('BKU'),
      identity: { nama: 'E9', id: 'E10', alamat: 'E11' },
      profil,
      periodeText,
      saldoAwal: asNumber(buku.bku.saldoAwal),
      rows: validateRows(buku.bku.rows || [], isLedgerRow, 'BKU'),
    });
  }

  validateGroup(buku.kas || [], 'BP Kas').forEach((kas) => {
    const isPetty = kas.jenis === 'petty';
    buildLedgerSheet(workbook, templateFor(isPetty ? 'BP Petty Cash' : 'BP Bank'), {
      sheetName: sheetFor(`BP ${asText(kas.nama, 24) || 'Kas'}`),
      identity: { nama: 'E8', id: 'E9', alamat: 'E10' },
      profil,
      periodeText,
      jenisCell: 'F11',
      jenis: asText(kas.nama, 60),
      saldoAwal: asNumber(kas.saldoAwal),
      rows: validateRows(kas.rows || [], isLedgerRow, `BP ${asText(kas.nama, 24)}`),
    });
  });

  const BELANJA_TEMPLATES = {
    bahan: 'BP Bahan Baku',
    operasional: 'BP Operasional',
    fasilitas: 'BP Fasilitas',
  };
  validateGroup(buku.belanja || [], 'Buku Pembantu').forEach((belanja) => {
    const templateName = BELANJA_TEMPLATES[belanja.key];
    if (!templateName) return;
    buildBelanjaSheet(workbook, templateFor(templateName), {
      sheetName: sheetFor(templateName),
      profil,
      periodeText,
      jenis: asText(belanja.jenis, 60),
      rows: validateRows(belanja.rows || [], isBelanjaRow, templateName),
    });
  });

  validateGroup(buku.pajak || [], 'BP Pajak').forEach((pajak) => {
    buildPajakSheet(workbook, templateFor('BP Pajak'), {
      sheetName: sheetFor(`BP Pajak ${asText(pajak.jenis, 18)}`.trim()),
      profil,
      periodeText,
      jenis: asText(pajak.jenis, 60),
      saldoAwal: asNumber(pajak.saldoAwal),
      rows: validateRows(pajak.rows || [], isLedgerRow, 'BP Pajak'),
    });
  });

  // --- Cetak Laporan --------------------------------------------------------
  const laporan = buku.laporan || {};
  buildLpaSheet(workbook, templateFor('LPA'), laporan, presentSheets);
  usedNames.add('lpa');
  buildSptjSheet(workbook, templateFor('SPTJ'), presentSheets);
  usedNames.add('sptj');
  buildBapsdSheet(workbook, templateFor('BAPSD'), laporan, presentSheets);
  usedNames.add('bapsd');

  if (buku.catatan) {
    buildCatatanSheet(workbook, templateFor('Catatan'), {
      sheetName: sheetFor('Catatan'),
      profil,
      periodeText,
      ringkasan: buku.catatan.ringkasan || {},
      rows: validateRows(buku.catatan.rows || [], isCatatanRow, 'Catatan Pengeluaran'),
    });
  }

  if (workers.length > 0) {
    buildDafNomSheet(workbook, templateFor(DAFNOM_SHEET_NAME), sheetFor('DafNom'), workers, dayCount, periodeLabel, true);
  }

  // --- Barang Persediaan ----------------------------------------------------
  const barang = buku.barang || {};
  validateRows(barang.masuk || [], isMasukRow, 'Penerimaan Barang');
  buildBarangSheets(workbook, templateFor, barang, presentSheets);
};

// The platform parses application/json for us, but a body that arrives as raw
// text should still be understood rather than reported as invalid personel data.
const readBody = (raw) => {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return {}; }
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  req.body = readBody(req.body);
  const workers = req.body?.workers;
  const buku = req.body?.buku && typeof req.body.buku === 'object' ? req.body.buku : null;
  const filename = typeof req.body?.filename === 'string' && /^[\w.-]{1,80}$/.test(req.body.filename)
    ? req.body.filename
    : 'Buku_Otomatis_Nominatif.xlsx';
  const dayCount = req.body?.dayCount ?? BIWEEKLY_DAY_COUNT;
  const periodeLabel = typeof req.body?.periodeLabel === 'string' && req.body.periodeLabel.trim().length <= 40
    ? req.body.periodeLabel.trim()
    : '';
  const periodeText = typeof req.body?.periodeText === 'string' && req.body.periodeText.trim().length <= 120
    ? req.body.periodeText.trim()
    : (periodeLabel ? `Periode : ${periodeLabel}` : '');
  const profil = readProfil(req.body?.profil);

  if (!Array.isArray(workers)) {
    return res.status(400).json({ success: false, message: 'Data personel tidak valid' });
  }
  // Without the books, the workbook is a per-personel slip and needs someone on it.
  if (!buku && workers.length === 0) {
    return res.status(400).json({ success: false, message: 'Pilih minimal satu personel untuk diekspor' });
  }
  if (workers.length > MAX_WORKERS) {
    return res.status(400).json({ success: false, message: `Maksimal ${MAX_WORKERS} personel per ekspor` });
  }
  if (!workers.every(isWorker)) {
    return res.status(400).json({ success: false, message: 'Data personel tidak valid' });
  }
  if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > MAX_DAY_COUNT) {
    return res.status(400).json({ success: false, message: `Jumlah hari harus antara 1 dan ${MAX_DAY_COUNT}` });
  }

  try {
    const templateWorkbook = await loadTemplate();

    const workbook = new ExcelJS.Workbook();
    workbook.calcProperties.fullCalcOnLoad = true;

    if (buku) {
      buildBukuWorkbook(workbook, templateWorkbook, buku, profil, periodeText, periodeLabel, workers, dayCount);
      if (workbook.worksheets.length === 0) {
        return res.status(400).json({ success: false, message: 'Tidak ada buku yang bisa diekspor untuk periode ini' });
      }
    } else {
      // Per-personel slip: one DafNom sheet per worker, named after them.
      const templateSheet = templateWorkbook.getWorksheet(DAFNOM_SHEET_NAME);
      if (!templateSheet) throw new Error(`Sheet template '${DAFNOM_SHEET_NAME}' tidak ditemukan pada MASTER_4.xlsx`);
      const usedNames = new Set();
      workers.forEach((worker, index) => {
        const sheetName = sanitizeSheetName(worker.nama, `Personel ${index + 1}`, usedNames);
        buildDafNomSheet(workbook, templateSheet, sheetName, [worker], dayCount, periodeLabel, false);
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Workbook generation failed:', message);
    // A PayloadError says what the operator can fix; anything else is an
    // internal fault whose detail stays in the log, not in the response.
    if (error instanceof PayloadError) {
      return res.status(400).json({ success: false, message });
    }
    return res.status(500).json({ success: false, message: 'Gagal membuat workbook' });
  }
};

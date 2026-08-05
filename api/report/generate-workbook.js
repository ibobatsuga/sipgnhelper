const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE_PATH = path.join(__dirname, 'templates/MASTER_4.xlsx');

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

// Ledger sheets are capped well above a realistic month so a corrupt payload
// cannot make the function build an endless workbook.
const MAX_ROWS_PER_BOOK = 600;
const MAX_BOOKS_PER_GROUP = 12;

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
  const cleaned = String(raw).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28);
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
  if (!Array.isArray(rows)) throw new Error(`Data ${label} tidak valid`);
  if (rows.length > MAX_ROWS_PER_BOOK) throw new Error(`${label} melebihi ${MAX_ROWS_PER_BOOK} baris`);
  if (!rows.every(predicate)) throw new Error(`Data ${label} tidak valid`);
  return rows;
};

const validateGroup = (group, label) => {
  if (!Array.isArray(group)) throw new Error(`Data ${label} tidak valid`);
  if (group.length > MAX_BOOKS_PER_GROUP) throw new Error(`${label} melebihi ${MAX_BOOKS_PER_GROUP} buku`);
  return group;
};

const readProfil = (raw) => ({
  namaSPPG: asText(raw && raw.namaSPPG, 120),
  idSPPG: asText(raw && raw.idSPPG, 60),
  alamat: asText(raw && raw.alamat, 200),
});

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
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

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
    // MASTER_4 is read purely as a style source and never re-serialized: ExcelJS
    // models only a subset of OOXML, so writing that workbook back out drops its
    // pivot caches, external links, comments and all but a handful of its 243
    // defined names, which makes Excel report the download as corrupt and
    // "repair" it. Emitting a fresh workbook that only holds the generated
    // sheets keeps the layout identical with nothing to repair.
    const templateWorkbook = new ExcelJS.Workbook();
    await templateWorkbook.xlsx.readFile(TEMPLATE_PATH);

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
    // Validation errors carry a message meant for the operator; anything else is
    // an internal fault and stays generic.
    if (/tidak valid|melebihi/.test(message)) {
      return res.status(400).json({ success: false, message });
    }
    return res.status(500).json({ success: false, message: 'Gagal membuat workbook' });
  }
};

const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE_PATH = path.join(__dirname, 'templates/MASTER_4.xlsx');
const TEMPLATE_SHEET_NAME = 'DafNom';
// DafNom's row 7 is the first worker slot in the master roster; rows 1-6 hold
// the title/column headers that every generated per-worker sheet reuses.
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
const MAX_WORKERS = 100;

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isFiniteNonNegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

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
// data row are intentionally NOT copied — the caller fills that row with one
// worker's real data right after this returns.
const cloneHeaderIntoSheet = (templateSheet, targetSheet, dayCount, periodeLabel) => {
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
      if (rowNumber === DATA_ROW) continue; // data row is filled by fillWorkerRow

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

const fillWorkerRow = (sheet, worker, dayCount) => {
  const row = sheet.getRow(DATA_ROW);
  const lastDayCol = FIRST_DAY_COL + dayCount - 1;
  const firstLetter = sheet.getColumn(FIRST_DAY_COL).letter;
  const lastLetter = sheet.getColumn(lastDayCol).letter;
  const [honorCol, danaCol, tkCol, pjCol, totalCol] = Array.from(
    { length: TRAILING_COLS }, (_, i) => sheet.getColumn(lastDayCol + 1 + i).letter,
  );

  row.getCell('B').value = 1;
  row.getCell('C').value = worker.pekerjaan;
  row.getCell('D').value = worker.nama;

  // A worker can be scheduled for at most the days the period actually has.
  const paidDays = Math.min(worker.hari, dayCount);
  for (let col = FIRST_DAY_COL; col <= lastDayCol; col += 1) {
    row.getCell(col).value = col - FIRST_DAY_COL < paidDays ? worker.tarif : null;
  }

  row.getCell(honorCol).value = { formula: `SUM(${firstLetter}${DATA_ROW}:${lastLetter}${DATA_ROW})` };
  // BPJS Kesehatan + Ketenagakerjaan are tracked as one combined figure upstream.
  row.getCell(danaCol).value = worker.bpjs || null;
  row.getCell(pjCol).value = worker.honorPJ || null;
  row.getCell(totalCol).value = {
    formula: `${honorCol}${DATA_ROW}+${danaCol}${DATA_ROW}+${tkCol}${DATA_ROW}+${pjCol}${DATA_ROW}`,
  };

  if (worker.departemen) sheet.getCell('B4').value = `Departemen: ${worker.departemen}`;
  row.commit();
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const workers = req.body?.workers;
  const filename = typeof req.body?.filename === 'string' && /^[\w.-]{1,80}$/.test(req.body.filename)
    ? req.body.filename
    : 'Buku_Otomatis_Nominatif.xlsx';
  const dayCount = req.body?.dayCount ?? BIWEEKLY_DAY_COUNT;
  const periodeLabel = typeof req.body?.periodeLabel === 'string' && req.body.periodeLabel.trim().length <= 40
    ? req.body.periodeLabel.trim()
    : '';

  if (!Array.isArray(workers) || workers.length === 0) {
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
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(TEMPLATE_PATH);
    workbook.calcProperties.fullCalcOnLoad = true;

    const templateSheet = workbook.getWorksheet(TEMPLATE_SHEET_NAME);
    if (!templateSheet) throw new Error(`Sheet template '${TEMPLATE_SHEET_NAME}' tidak ditemukan pada MASTER_4.xlsx`);

    const usedNames = new Set(workbook.worksheets.map((sheet) => sheet.name.toLowerCase()));
    workers.forEach((worker, index) => {
      const sheetName = sanitizeSheetName(worker.nama, `Personel ${index + 1}`, usedNames);
      const sheet = workbook.addWorksheet(sheetName, {
        properties: { tabColor: templateSheet.properties.tabColor },
      });
      cloneHeaderIntoSheet(templateSheet, sheet, dayCount, periodeLabel);
      fillWorkerRow(sheet, worker, dayCount);
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error('Workbook generation failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: 'Gagal membuat workbook multi-sheet' });
  }
};

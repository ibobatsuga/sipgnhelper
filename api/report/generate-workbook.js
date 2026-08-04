const path = require('path');
const ExcelJS = require('exceljs');

const TEMPLATE_PATH = path.join(__dirname, 'templates/MASTER_4.xlsx');
const TEMPLATE_SHEET_NAME = 'DafNom';
// DafNom's row 7 is the first worker slot in the master roster; rows 1-6 hold
// the title/column headers that every generated per-worker sheet reuses.
const HEADER_ROWS = 6;
const DATA_ROW = HEADER_ROWS + 1;
// The template's day columns (E..N) only cover a 10-day reporting period.
const DAY_COLUMNS = ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];
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

// Clones DafNom's header block (rows 1..DATA_ROW) into a fresh sheet, preserving
// column widths, cell styles and formulas. The example values that live in the
// template's data row are intentionally NOT copied — the caller fills that row
// with one worker's real data right after this returns.
const cloneHeaderIntoSheet = (templateSheet, targetSheet) => {
  templateSheet.columns.forEach((col, index) => {
    const targetCol = targetSheet.getColumn(index + 1);
    targetCol.width = col.width;
    targetCol.hidden = col.hidden;
  });

  for (let rowNumber = 1; rowNumber <= DATA_ROW; rowNumber += 1) {
    const sourceRow = templateSheet.getRow(rowNumber);
    const targetRow = targetSheet.getRow(rowNumber);
    sourceRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const targetCell = targetRow.getCell(colNumber);
      targetCell.style = cell.style;
      if (cell.formula) {
        targetCell.value = { formula: cell.formula };
      } else if (rowNumber < DATA_ROW) {
        targetCell.value = cell.value;
      }
    });
    targetRow.height = sourceRow.height;
  }

  templateSheet.model.merges.forEach((range) => {
    const rows = parseRangeRows(range);
    if (rows && rows[1] <= DATA_ROW) targetSheet.mergeCells(range);
  });
};

const fillWorkerRow = (sheet, worker) => {
  const row = sheet.getRow(DATA_ROW);
  row.getCell('B').value = 1;
  row.getCell('C').value = worker.pekerjaan;
  row.getCell('D').value = worker.nama;
  DAY_COLUMNS.forEach((col, dayIndex) => {
    row.getCell(col).value = dayIndex < worker.hari ? worker.tarif : null;
  });
  // BPJS Kesehatan + Ketenagakerjaan are tracked as one combined figure upstream.
  row.getCell('P').value = worker.bpjs || null;
  row.getCell('R').value = worker.honorPJ || null;
  // O7 (=SUM(E7:N7)) and S7 (=O7+P7+Q7+R7) keep the formulas cloned above.
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
  if (!Array.isArray(workers) || workers.length === 0) {
    return res.status(400).json({ success: false, message: 'Pilih minimal satu personel untuk diekspor' });
  }
  if (workers.length > MAX_WORKERS) {
    return res.status(400).json({ success: false, message: `Maksimal ${MAX_WORKERS} personel per ekspor` });
  }
  if (!workers.every(isWorker)) {
    return res.status(400).json({ success: false, message: 'Data personel tidak valid' });
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
      cloneHeaderIntoSheet(templateSheet, sheet);
      fillWorkerRow(sheet, worker);
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Buku_Otomatis_Nominatif.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error('Workbook generation failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: 'Gagal membuat workbook multi-sheet' });
  }
};

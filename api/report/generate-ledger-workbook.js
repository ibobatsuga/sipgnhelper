const ExcelJS = require('exceljs');

const MAX_SHEETS = 30;
const MAX_ROWS_PER_SHEET = 5000;
const CURRENCY_HEADERS = new Set(['Debit', 'Kredit', 'Saldo', 'Dana Masuk', 'Biaya', 'Jumlah']);

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
const isCellValue = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

const isSheetSpec = (sheet) => sheet && typeof sheet === 'object'
  && isNonEmptyString(sheet.name)
  && Array.isArray(sheet.headers)
  && sheet.headers.every(isNonEmptyString)
  && Array.isArray(sheet.rows)
  && sheet.rows.length <= MAX_ROWS_PER_SHEET
  && sheet.rows.every((row) => Array.isArray(row) && row.length === sheet.headers.length && row.every(isCellValue));

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

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const sheets = req.body?.sheets;
  if (!Array.isArray(sheets) || sheets.length === 0) {
    return res.status(400).json({ success: false, message: 'Tidak ada data buku untuk diekspor' });
  }
  if (sheets.length > MAX_SHEETS) {
    return res.status(400).json({ success: false, message: `Maksimal ${MAX_SHEETS} sheet per workbook` });
  }
  if (!sheets.every(isSheetSpec)) {
    return res.status(400).json({ success: false, message: 'Data buku tidak valid' });
  }

  try {
    const workbook = new ExcelJS.Workbook();
    const usedNames = new Set();

    sheets.forEach((sheetSpec) => {
      const sheet = workbook.addWorksheet(sanitizeSheetName(sheetSpec.name, 'Sheet', usedNames));
      sheet.columns = sheetSpec.headers.map((header) => ({
        header,
        width: Math.max(14, header.length + 4),
        style: CURRENCY_HEADERS.has(header) ? { numFmt: '#,##0' } : undefined,
      }));
      sheet.getRow(1).font = { bold: true };
      sheetSpec.rows.forEach((row) => sheet.addRow(row));
    });

    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Buku_Otomatis.xlsx"');
    return res.status(200).send(Buffer.from(buffer));
  } catch (error) {
    console.error('Ledger workbook generation failed:', error instanceof Error ? error.message : error);
    return res.status(500).json({ success: false, message: 'Gagal membuat workbook' });
  }
};

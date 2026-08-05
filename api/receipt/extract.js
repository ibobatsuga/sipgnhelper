const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const DEFAULT_MODEL = 'gemini-3.5-flash';
// A model reads whatever the photo shows, so its answer is untrusted text. These
// caps keep a crafted receipt from storing a novel in the operator's database.
const MAX_VENDOR_CHARS = 120;
const MAX_ITEM_CHARS = 160;
const MAX_ITEMS = 200;
// Each call spends the owner's Gemini quota, so one caller cannot loop on it.
// The window is per warm container, which bounds a burst without ever getting in
// the way of someone photographing receipts by hand.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_CALLS = 12;
const callLog = new Map();

const rateLimited = (key) => {
  const now = Date.now();
  const recent = (callLog.get(key) || []).filter((at) => now - at < RATE_WINDOW_MS);
  recent.push(now);
  callLog.set(key, recent);
  // Old callers are dropped so the map cannot grow without bound.
  if (callLog.size > 500) {
    for (const [id, times] of callLog) {
      if (!times.some((at) => now - at < RATE_WINDOW_MS)) callLog.delete(id);
    }
  }
  return recent.length > RATE_MAX_CALLS;
};

// The platform parses application/json, but a body arriving as raw text should
// still be understood rather than reported as a broken photo.
const readBody = (raw) => {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { return JSON.parse(raw); } catch { return {}; }
};

const receiptPrompt = (today) =>
  `Ekstrak data dari foto struk/nota belanja ini. Balas HANYA dengan json valid, tanpa teks lain, tanpa markdown, format persis: {"tanggal":"YYYY-MM-DD","vendor":"nama toko","items":[{"nama":"nama barang","jumlah":1,"harga":0}],"total":0}. Jika tanggal tidak jelas terbaca, gunakan tanggal hari ini (${today}). Angka harga/total tanpa titik/koma pemisah ribuan.`;

const stripCodeFence = (value) => value.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();

const parseFirstJsonObject = (value) => {
  const clean = stripCodeFence(value);
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < clean.length; index += 1) {
    const character = clean[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) return JSON.parse(clean.slice(start, index + 1));
      if (depth < 0) break;
    }
  }
  throw new Error('Incomplete JSON object in Gemini response');
};
const isNonNegativeNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isReceipt = (value) => {
  if (!value || typeof value !== 'object') return false;
  return typeof value.tanggal === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value.tanggal)
    && typeof value.vendor === 'string'
    && value.vendor.trim().length > 0
    && value.vendor.length <= MAX_VENDOR_CHARS
    && Array.isArray(value.items)
    && value.items.length <= MAX_ITEMS
    && value.items.every((item) => item
      && typeof item.nama === 'string'
      && item.nama.trim().length > 0
      && item.nama.length <= MAX_ITEM_CHARS
      && isNonNegativeNumber(item.jumlah)
      && isNonNegativeNumber(item.harga))
    && isNonNegativeNumber(value.total);
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const caller = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  if (rateLimited(caller)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ success: false, message: 'Terlalu banyak permintaan. Tunggu sebentar sebelum membaca struk lagi.' });
  }

  const body = readBody(req.body);
  const imageBase64 = body.imageBase64;
  if (typeof imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    return res.status(400).json({ success: false, message: 'Foto struk tidak valid' });
  }

  const imageBytes = Buffer.byteLength(imageBase64, 'base64');
  if (imageBytes === 0 || imageBytes > MAX_IMAGE_BYTES) {
    return res.status(413).json({ success: false, message: 'Ukuran foto maksimal 3 MB' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ success: false, message: 'Layanan pembaca struk belum dikonfigurasi' });
  }

  try {
    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [
            { text: receiptPrompt(new Date().toISOString().slice(0, 10)) },
            { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
          ],
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 2048,
        },
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : 502;
      const message = upstream.status === 429
        ? 'Layanan pembaca struk sedang mencapai batas permintaan. Coba lagi sebentar.'
        : 'Layanan pembaca struk tidak dapat memproses permintaan saat ini';
      return res.status(status).json({ success: false, message });
    }

    const body = await upstream.json();
    const text = body.candidates?.[0]?.content?.parts?.find((part) => typeof part.text === 'string')?.text;
    if (!text) throw new Error('Missing text content in Gemini response');

    const receipt = parseFirstJsonObject(text);
    if (!isReceipt(receipt)) {
      return res.status(422).json({ success: false, message: 'Data pada struk tidak dapat dibaca dengan lengkap' });
    }

    return res.status(200).json({ success: true, data: receipt });
  } catch (error) {
    console.error('Vercel receipt extraction failed:', error instanceof Error ? error.message : error);
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Waktu pembacaan struk habis. Coba lagi.'
      : 'Layanan pembaca struk mengalami gangguan';
    return res.status(502).json({ success: false, message });
  }
};

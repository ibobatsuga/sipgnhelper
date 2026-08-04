import { Request, Response } from 'express';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MODEL = 'qwen/qwen3.6-27b';

type ReceiptItem = { nama: string; jumlah: number; harga: number };
type Receipt = { tanggal: string; vendor: string; items: ReceiptItem[]; total: number };

const receiptPrompt = (today: string) =>
  `Ekstrak data dari foto struk/nota belanja ini. Balas HANYA dengan json valid, tanpa teks lain, tanpa markdown, format persis: {"tanggal":"YYYY-MM-DD","vendor":"nama toko","items":[{"nama":"nama barang","jumlah":1,"harga":0}],"total":0}. Jika tanggal tidak jelas terbaca, gunakan tanggal hari ini (${today}). Angka harga/total tanpa titik/koma pemisah ribuan.`;

const stripCodeFence = (value: string) => value.replace(/^```(?:json)?\s*|\s*```$/gi, '').trim();

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isReceipt = (value: unknown): value is Receipt => {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Partial<Receipt>;
  return typeof receipt.tanggal === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(receipt.tanggal)
    && typeof receipt.vendor === 'string'
    && receipt.vendor.trim().length > 0
    && Array.isArray(receipt.items)
    && receipt.items.length <= 200
    && receipt.items.every((item) => item
      && typeof item.nama === 'string'
      && item.nama.trim().length > 0
      && isNonNegativeNumber(item.jumlah)
      && isNonNegativeNumber(item.harga))
    && isNonNegativeNumber(receipt.total);
};

export const extractReceipt = async (req: Request, res: Response) => {
  const { imageBase64 } = req.body as { imageBase64?: unknown };
  if (typeof imageBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
    res.status(400).json({ success: false, message: 'Foto struk tidak valid' });
    return;
  }

  const imageBytes = Buffer.byteLength(imageBase64, 'base64');
  if (imageBytes === 0 || imageBytes > MAX_IMAGE_BYTES) {
    res.status(413).json({ success: false, message: 'Ukuran foto maksimal 5 MB' });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(503).json({ success: false, message: 'Layanan pembaca struk belum dikonfigurasi' });
    return;
  }

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || DEFAULT_MODEL,
        max_tokens: 1000,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: receiptPrompt(new Date().toISOString().slice(0, 10)) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
          ],
        }],
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) {
      const status = upstream.status === 429 ? 429 : 502;
      res.status(status).json({
        success: false,
        message: upstream.status === 429
          ? 'Layanan pembaca struk sedang mencapai batas permintaan. Coba lagi sebentar.'
          : 'Layanan pembaca struk tidak dapat memproses permintaan saat ini',
      });
      return;
    }

    const body = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('Missing text content in provider response');

    const receipt: unknown = JSON.parse(stripCodeFence(text));
    if (!isReceipt(receipt)) {
      res.status(422).json({ success: false, message: 'Data pada struk tidak dapat dibaca dengan lengkap' });
      return;
    }

    res.json({ success: true, data: receipt });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Waktu pembacaan struk habis. Coba lagi.'
      : 'Layanan pembaca struk mengalami gangguan';
    res.status(502).json({ success: false, message });
  }
};

'use strict';

// The OCR endpoint had no tests at all. It is the app's only outbound
// dependency, it spends the owner's Gemini quota, and everything it returns is
// text a model read off a photograph — so it is exercised here against a stubbed
// upstream rather than the real one, with the handler itself running for real.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const handler = require(path.join(__dirname, '..', 'api/receipt/extract.js'));

const collect = () => ({
  headers: {}, statusCode: 0, body: null,
  setHeader(k, v) { this.headers[k] = v; return this; },
  status(c) { this.statusCode = c; return this; },
  json(payload) { this.body = payload; return this; },
});

// A distinct caller per test so one test's calls never trip another's limit.
let callerSeq = 0;
const call = async (body, { method = 'POST', caller, headers } = {}) => {
  const res = collect();
  callerSeq += 1;
  await handler({
    method,
    body,
    headers: headers || { 'x-forwarded-for': caller || `10.0.0.${callerSeq}` },
  }, res);
  return res;
};

const IMAGE = Buffer.alloc(1024, 7).toString('base64');

const geminiReply = (payload) => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] } }] }),
});

const validReceipt = {
  tanggal: '2026-08-05', vendor: 'Koperasi Desa', total: 150000,
  items: [{ nama: 'Beras premium', jumlah: 10, harga: 15000 }],
};

let originalFetch;
let originalKey;
test.before(() => { originalFetch = global.fetch; originalKey = process.env.GEMINI_API_KEY; });
test.afterEach(() => { global.fetch = originalFetch; process.env.GEMINI_API_KEY = originalKey; });

const stubGemini = (reply) => {
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, options }); return typeof reply === 'function' ? reply() : reply; };
  return calls;
};

test('rejects anything but POST', async () => {
  const res = await call({}, { method: 'GET' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'POST');
});

test('rejects a body that is not a photo', async () => {
  process.env.GEMINI_API_KEY = 'k';
  for (const body of [{}, { imageBase64: 123 }, { imageBase64: 'not base64!!' }, { imageBase64: '' }, null, 'garbage']) {
    const res = await call(body);
    assert.ok(res.statusCode === 400 || res.statusCode === 413, `body ${JSON.stringify(body)} gave ${res.statusCode}`);
  }
});

test('a raw JSON string body is understood', async () => {
  process.env.GEMINI_API_KEY = 'k';
  stubGemini(geminiReply(validReceipt));
  const res = await call(JSON.stringify({ imageBase64: IMAGE }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
});

test('refuses a photo larger than the documented limit', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const huge = Buffer.alloc(3 * 1024 * 1024 + 1024, 1).toString('base64');
  const res = await call({ imageBase64: huge });
  assert.equal(res.statusCode, 413);
  assert.match(res.body.message, /3 MB/);
});

test('says so plainly when the service is not configured', async () => {
  delete process.env.GEMINI_API_KEY;
  const res = await call({ imageBase64: IMAGE });
  assert.equal(res.statusCode, 503);
  // The key must never leak into a response, configured or not.
  assert.doesNotMatch(JSON.stringify(res.body), /key/i);
});

test('passes the photo upstream without ever echoing the key back', async () => {
  process.env.GEMINI_API_KEY = 'secret-key-value';
  const calls = stubGemini(geminiReply(validReceipt));
  const res = await call({ imageBase64: IMAGE });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'secret-key-value');
  assert.doesNotMatch(JSON.stringify(res.body), /secret-key-value/);
  assert.deepEqual(res.body.data, validReceipt);
});

test('reads the receipt out of a fenced or chatty reply', async () => {
  process.env.GEMINI_API_KEY = 'k';
  stubGemini(geminiReply('```json\n' + JSON.stringify(validReceipt) + '\n```'));
  const fenced = await call({ imageBase64: IMAGE });
  assert.equal(fenced.statusCode, 200);

  stubGemini(geminiReply(`Tentu, ini hasilnya: ${JSON.stringify(validReceipt)} semoga membantu.`));
  const chatty = await call({ imageBase64: IMAGE });
  assert.equal(chatty.statusCode, 200);
  assert.equal(chatty.body.data.vendor, 'Koperasi Desa');
});

test('an upstream rate limit is reported as one, not as a crash', async () => {
  process.env.GEMINI_API_KEY = 'k';
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const res = await call({ imageBase64: IMAGE });
  assert.equal(res.statusCode, 429);
  assert.match(res.body.message, /batas permintaan/);
});

test('an upstream fault never leaks its detail to the operator', async () => {
  process.env.GEMINI_API_KEY = 'k';
  global.fetch = async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:443 key=abc'); };
  const res = await call({ imageBase64: IMAGE });
  assert.equal(res.statusCode, 502);
  assert.doesNotMatch(res.body.message, /ECONNREFUSED|10\.1\.2\.3|key=/);
});

test('a timeout is named as a timeout so the operator knows to retry', async () => {
  process.env.GEMINI_API_KEY = 'k';
  global.fetch = async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; };
  const res = await call({ imageBase64: IMAGE });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.message, /Waktu pembacaan struk habis/);
});

test('a reply that is not a receipt is refused rather than stored', async () => {
  process.env.GEMINI_API_KEY = 'k';
  const bad = [
    'bukan json sama sekali',
    { tanggal: '5 Agustus 2026', vendor: 'X', items: [], total: 0 },
    { tanggal: '2026-08-05', vendor: '', items: [], total: 0 },
    { tanggal: '2026-08-05', vendor: 'X', items: [{ nama: 'A', jumlah: -1, harga: 0 }], total: 0 },
    { tanggal: '2026-08-05', vendor: 'X', items: [{ nama: 'A', jumlah: 1, harga: 'gratis' }], total: 0 },
    { tanggal: '2026-08-05', vendor: 'X', items: 'bukan array', total: 0 },
  ];
  for (const reply of bad) {
    stubGemini(geminiReply(reply));
    const res = await call({ imageBase64: IMAGE });
    assert.ok(res.statusCode === 422 || res.statusCode === 502, `${JSON.stringify(reply)} gave ${res.statusCode}`);
  }
});

test('a model answer cannot smuggle an unbounded name into the database', async () => {
  process.env.GEMINI_API_KEY = 'k';
  stubGemini(geminiReply({ ...validReceipt, vendor: 'V'.repeat(5000) }));
  const vendor = await call({ imageBase64: IMAGE });
  assert.equal(vendor.statusCode, 422);

  stubGemini(geminiReply({ ...validReceipt, items: [{ nama: 'N'.repeat(5000), jumlah: 1, harga: 1 }] }));
  const item = await call({ imageBase64: IMAGE });
  assert.equal(item.statusCode, 422);

  stubGemini(geminiReply({ ...validReceipt, items: Array.from({ length: 201 }, () => ({ nama: 'A', jumlah: 1, harga: 1 })) }));
  const many = await call({ imageBase64: IMAGE });
  assert.equal(many.statusCode, 422);
});

test('one caller cannot loop on the endpoint and burn the quota', async () => {
  process.env.GEMINI_API_KEY = 'k';
  stubGemini(geminiReply(validReceipt));
  const caller = '203.0.113.9';
  const codes = [];
  for (let i = 0; i < 15; i += 1) {
    codes.push((await call({ imageBase64: IMAGE }, { caller })).statusCode);
  }
  assert.equal(codes.filter((c) => c === 200).length, 12, 'the documented burst must still get through');
  assert.ok(codes.includes(429), 'the endpoint never pushed back');
  const limited = await call({ imageBase64: IMAGE }, { caller });
  assert.equal(limited.headers['Retry-After'], '60');
});

test('the limit is per caller, not shared across operators', async () => {
  process.env.GEMINI_API_KEY = 'k';
  stubGemini(geminiReply(validReceipt));
  for (let i = 0; i < 13; i += 1) await call({ imageBase64: IMAGE }, { caller: '198.51.100.1' });
  const other = await call({ imageBase64: IMAGE }, { caller: '198.51.100.2' });
  assert.equal(other.statusCode, 200, 'a second operator was blocked by the first');
});

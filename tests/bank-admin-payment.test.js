'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browserAvailable = fs.existsSync(CHROME) && (() => {
  try { require.resolve('playwright'); return true; } catch { return false; }
})();

function loadPaymentLogic() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const script = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
  const cut = script.indexOf('// ---------- LAPORAN ----------');
  assert.ok(cut > 0, 'LAPORAN marker missing from index.html');

  const noop = () => {};
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      createElement: () => ({ remove: noop }),
      body: { appendChild: noop },
    },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    setTimeout: noop,
    setInterval: noop,
    clearInterval: noop,
    console,
    fetch: noop,
    AbortSignal: { timeout: noop },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${script.slice(0, cut)}
    globalThis.__api = { transaksiBatchDisetujui };
  `, sandbox);
  return sandbox.__api;
}

const batch = (overrides = {}) => ({
  id: 'batch-123456',
  jenis: 'vendor',
  penerima: 'Toko Pangan',
  jumlah: 100000,
  biayaAdmin: 2500,
  jatuhTempo: '2026-09-08',
  akunKas: '1100',
  akunLawan: '2010',
  status: 'menunggu',
  ...overrides,
});

test('batch transfer separates the bank fee from the principal payment', () => {
  const { transaksiBatchDisetujui } = loadPaymentLogic();
  const rows = JSON.parse(JSON.stringify(transaksiBatchDisetujui(batch())));

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.jumlah), [100000, 2500]);
  assert.equal(rows[0].akunLawan, '2010');
  assert.equal(rows[1].akunLawan, '2195');
  assert.equal(rows[1].akunKas, '1100');
  assert.equal(rows[1].approvalStatus, 'approved');
  assert.equal(rows.reduce((sum, row) => sum + row.jumlah, 0), 102500);
});

test('a legacy batch without a bank fee keeps the original single transaction', () => {
  const { transaksiBatchDisetujui } = loadPaymentLogic();
  const rows = JSON.parse(JSON.stringify(transaksiBatchDisetujui(batch({ biayaAdmin: undefined }))));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].jumlah, 100000);
  assert.equal(rows[0].akunLawan, '2010');
});

test('Kas & Pembayaran collects the fee and approves the full bank debit', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const section = html.slice(
    html.indexOf('// ---------- KAS & PEMBAYARAN ----------'),
    html.indexOf('// ---------- PAJAK & UPAH ----------'),
  );

  assert.match(section, /id="b_biayaAdmin"/);
  assert.match(section, /Biaya Admin Bank\/Layanan/);
  assert.match(section, /jumlah:\s*totalDebet/);
});

test('the real payment screen carries the bank fee through approval', { skip: browserAvailable ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof setTab === 'function');
  await page.evaluate(() => {
    showApp();
    DB = defaultDB();
    setTab('kas');
  });

  await page.fill('#b_penerima', 'Toko Pangan');
  await page.fill('#b_jumlah', '100000');
  await page.fill('#b_biayaAdmin', '2500');
  await page.fill('#b_jatuhTempo', '2026-09-08');
  assert.equal(await page.locator('#b_totalDebet').innerText(), 'Rp 102.500');

  await page.getByRole('button', { name: 'Ajukan untuk Approval' }).click();
  const submitted = await page.evaluate(() => ({
    batch: DB.batch[0],
    approval: DB.approvals[0],
  }));
  assert.equal(submitted.batch.biayaAdmin, 2500);
  assert.equal(submitted.approval.jumlah, 102500);

  await page.evaluate(() => approveApproval(DB.approvals[0].id));
  const approved = await page.evaluate(() => ({
    status: DB.batch[0].status,
    approvalStatus: DB.approvals[0].status,
    transaksi: DB.transaksi,
  }));
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvalStatus, 'approved');
  assert.equal(approved.transaksi.length, 2);
  assert.equal(approved.transaksi[0].jumlah, 100000);
  assert.equal(approved.transaksi[1].jumlah, 2500);
  assert.equal(approved.transaksi[1].akunLawan, '2195');
});

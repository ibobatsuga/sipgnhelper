'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browserAvailable = fs.existsSync(CHROME) && (() => {
  try { require.resolve('playwright'); return true; } catch { return false; }
})();

test('account recovery is wired to the Supabase recovery contract', () => {
  assert.match(HTML, /Lupa Kata Sandi/);
  assert.match(HTML, /resetPasswordForEmail/);
  assert.match(HTML, /PASSWORD_RECOVERY/);
  assert.match(HTML, /updateUser\(\{\s*password\s*\}\)/);
  assert.match(HTML, /id="auth_password_confirm"/);
});

test('the real auth screen requests recovery and accepts a confirmed new password', { skip: browserAvailable ? false : 'Chromium or playwright unavailable' }, async (t) => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage();
  t.after(async () => { await browser.close(); });

  await page.goto('file://' + path.join(ROOT, 'index.html'));
  await page.waitForFunction(() => typeof setAuthMode === 'function');
  await page.evaluate(() => {
    window.__recoveryCalls = [];
    window.__updatedPasswords = [];
    sb.auth.resetPasswordForEmail = async (email, options) => {
      window.__recoveryCalls.push({ email, options });
      return { data: {}, error: null };
    };
    sb.auth.updateUser = async ({ password }) => {
      window.__updatedPasswords.push(password);
      return { data: {}, error: null };
    };
    sb.auth.signOut = async () => ({ error: null });
  });

  await page.getByRole('link', { name: 'Lupa Kata Sandi' }).click();
  assert.equal(await page.locator('#auth_password').isVisible(), false);
  assert.equal(await page.locator('#authSubmitBtn').innerText(), 'Kirim Tautan Pemulihan');

  await page.fill('#auth_email', 'operator@example.com');
  await page.locator('#authSubmitBtn').click();
  const calls = await page.evaluate(() => window.__recoveryCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, 'operator@example.com');
  assert.match(await page.locator('#authError').innerText(), /Jika email terdaftar/);

  await page.evaluate(() => handleAuthStateChange('PASSWORD_RECOVERY', { user: { id: 'user-1' } }));
  await page.waitForFunction(() => document.getElementById('authSubmitBtn').textContent === 'Simpan Kata Sandi Baru');
  assert.equal(await page.locator('#auth_email').isVisible(), false);
  assert.equal(await page.locator('#auth_password_confirm').isVisible(), true);

  await page.fill('#auth_password', 'new-password-123');
  await page.fill('#auth_password_confirm', 'different-password');
  await page.locator('#authSubmitBtn').click();
  assert.deepEqual(await page.evaluate(() => window.__updatedPasswords), []);
  assert.match(await page.locator('#authError').innerText(), /tidak sama/);

  await page.fill('#auth_password_confirm', 'new-password-123');
  await page.locator('#authSubmitBtn').click();
  assert.deepEqual(await page.evaluate(() => window.__updatedPasswords), ['new-password-123']);
  assert.match(await page.locator('#authError').innerText(), /berhasil diperbarui/);
});

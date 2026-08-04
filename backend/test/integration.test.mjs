import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';

const port = 5101;
const baseUrl = `http://127.0.0.1:${port}/api`;
let server;

const request = async (path, options) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
};

before(async () => {
  server = spawn('node', ['dist/server.js'], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const { response } = await request('/health');
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Backend did not become ready');
});

after(() => server?.kill('SIGTERM'));

test('health check and baseline read endpoints return real API responses', async () => {
  const health = await request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok');

  const data = await request('/data');
  assert.equal(data.response.status, 200);
  assert.equal(data.body.total, 5);
  assert.equal(data.body.data.length, 5);
});

test('input validation rejects malformed data and invalid statuses', async () => {
  const invalidData = await request('/data', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', category: 'Audit', value: -1 }),
  });
  assert.equal(invalidData.response.status, 400);

  const invalidStatus = await request('/data/1/status', {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'unknown' }),
  });
  assert.equal(invalidStatus.response.status, 400);

  const malformedJson = await fetch(`${baseUrl}/data`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  });
  assert.equal(malformedJson.status, 400);
});

test('receipt endpoint fails closed until the provider key is configured', async () => {
  const receipt = await request('/receipt/extract', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ imageBase64: 'aGVsbG8=' }),
  });
  assert.equal(receipt.response.status, 503);
  assert.equal(receipt.body.success, false);
});

test('CORS rejects untrusted browser origins', async () => {
  const { response, body } = await request('/health', {
    headers: { origin: 'https://untrusted.example' },
  });
  assert.equal(response.status, 403);
  assert.equal(body.success, false);
});

test('concurrent additions retain unique identifiers and valid values', async () => {
  const creations = await Promise.all(Array.from({ length: 40 }, (_, index) => request('/data', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Load test ${index}`, category: 'Audit', value: index }),
  })));
  assert.ok(creations.every(({ response }) => response.status === 201));
  const ids = creations.map(({ body }) => body.data.id);
  assert.equal(new Set(ids).size, 40);
  assert.ok(creations.every(({ body }, index) => body.data.value === index));
});

test('a running task cannot be launched twice and eventually completes', async () => {
  const started = await request('/automation/tasks/task-1/run', { method: 'POST' });
  assert.equal(started.response.status, 200);
  assert.equal(started.body.data.status, 'running');

  const duplicate = await request('/automation/tasks/task-1/run', { method: 'POST' });
  assert.equal(duplicate.response.status, 409);

  await new Promise((resolve) => setTimeout(resolve, 2700));
  const tasks = await request('/automation/tasks');
  assert.equal(tasks.response.status, 200);
  assert.equal(tasks.body.data.find((task) => task.id === 'task-1').status, 'completed');
});

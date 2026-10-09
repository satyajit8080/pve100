import { test, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.OPTIONS_PROVIDER = 'null';
process.env.PORT = '4293';
process.env.DASHBOARD_PASSWORD = 'testpw';
const { httpServer } = await import('../server.js');
const BASE = 'http://127.0.0.1:4293';
async function login() {
  const r = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'testpw' }) });
  return r.headers.get('set-cookie').split(';')[0];
}
test('scan endpoints require auth', async () => {
  const r = await fetch(BASE + '/api/scan/run', { method: 'POST' });
  assert.equal(r.status, 401);
  const s = await fetch(BASE + '/api/scan/status');
  assert.equal(s.status, 401);
});
test('status reports idle; run refuses without a provider', async () => {
  const c = await login();
  const s = await (await fetch(BASE + '/api/scan/status', { headers: { cookie: c } })).json();
  assert.equal(s.ok, true); assert.equal(s.running, false);
  const r = await fetch(BASE + '/api/scan/run', { method: 'POST', headers: { cookie: c, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 400);              // provider is 'null' → no quota spent
});
after(() => httpServer && httpServer.close());

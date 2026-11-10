const baseUrl = process.env.HERMES_MOBILE_URL;
const token = process.env.HERMES_MOBILE_TOKEN;
if (!baseUrl || !token) {
  console.error('Set HERMES_MOBILE_URL and HERMES_MOBILE_TOKEN.');
  process.exit(2);
}
const clean = baseUrl.replace(/\/$/, '');
const headers = { 'X-Hermes-Session-Token': token };
const status = await fetch(`${clean}/api/status`, { headers });
console.log('GET /api/status', status.status);
if (!status.ok) process.exit(1);
const body = await status.json();
console.log(JSON.stringify({ ok: true, version: body.version ?? body.hermes_version ?? null, tui: body.tui ?? body.embedded_chat ?? null }, null, 2));

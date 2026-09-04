// Runnable example: a plain node:http site with "Connect wallet".
//
//   LC_DOMAIN=example.com LC_NETWORK=testnet node example/server.mjs
//   open http://127.0.0.1:8080
//
// What it does:
//   - serves example/index.html, the button and its QR encoder;
//   - POST /api/connect/start   -> { request_id, deep_link, expires_at }
//   - GET  /api/connect/status  -> { status, ... } (+ signed session cookie once approved)
//   - GET  /api/me              -> who is connected (from the cookie)
//   - POST /api/logout          -> clears the cookie and stops the wallet session
//
// Env: LC_DOMAIN (required: the RP domain the wallet will show; must hold a
// domain-control proof, see ../README.md), LC_NETWORK=testnet|mainnet
// (default testnet), LC_CONNECT_URL (override the server URL), PORT
// (8080), BIND (127.0.0.1), LC_COOKIE_SECRET (random per start if unset,
// which logs everyone out on restart).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { LiquidConnectRP } from '../rp/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DOMAIN = process.env.LC_DOMAIN;
const NETWORK = process.env.LC_NETWORK ?? 'testnet';
const PORT = Number(process.env.PORT ?? 8080);
const BIND = process.env.BIND ?? '127.0.0.1';
const COOKIE = 'lc_session';
const COOKIE_SECRET = process.env.LC_COOKIE_SECRET ?? randomBytes(32).toString('hex');
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SECURE_COOKIE = process.env.LC_COOKIE_SECURE === '1';

if (!DOMAIN) { console.error('LC_DOMAIN is required (the domain your site is served from, e.g. example.com)'); process.exit(2); }
if (NETWORK === 'mainnet' && process.env.LC_ALLOW_MAINNET !== '1') {
  console.error('Refusing LC_NETWORK=mainnet without LC_ALLOW_MAINNET=1 (the production server routes real wallets).');
  process.exit(2);
}

// ---- the relying party -------------------------------------------------

const rp = new LiquidConnectRP({
  domain: DOMAIN,
  network: NETWORK,
  url: process.env.LC_CONNECT_URL,
  log: (level, msg) => { if (level !== 'debug' || process.env.LC_DEBUG) console.error(`[rp:${level}] ${msg}`); },
});
rp.on('connected', ({ sessions }) => console.error(`[example] logged in to Liquid Connect as ${DOMAIN} (${sessions} live sessions)`));
rp.on('loginRefused', (err) => console.error(`[example] connect server refused our login: ${err.message}`));
rp.on('disconnected', ({ reason, reconnecting }) => console.error(`[example] connect server connection ended (${reason})${reconnecting ? '; reconnecting' : ''}`));
rp.on('sessionCreated', (s) => console.error(`[example] wallet ${s.wallet_id.slice(0, 8)}… approved request ${s.request_id.slice(0, 8)}… (session ${s.session_id.slice(0, 8)}…)`));
rp.on('sessionRemoved', (s) => {
  console.error(`[example] session ${s.session_id.slice(0, 8)}… ended by the wallet`);
  for (const [id, sess] of sessions) if (sess.session_id === s.session_id) sessions.delete(id);
});
await rp.connect();

// ---- signed cookie sessions ----------------------------------------------

/** id -> { wallet_id, session_id, request_id, created_at } — the wallet binding never leaves this process. */
const sessions = new Map();

function sign(value) { return createHmac('sha256', COOKIE_SECRET).update(value).digest('base64url'); }
function issueCookie(id) {
  const v = `${id}.${sign(id)}`;
  return `${COOKIE}=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${SECURE_COOKIE ? '; Secure' : ''}`;
}
function clearCookie() { return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`; }
function readSession(req) {
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '')?.[1];
  if (!raw) return null;
  const [id, mac] = raw.split('.');
  if (!id || !mac) return null;
  const expected = sign(id);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.created_at > SESSION_TTL_MS) { sessions.delete(id); return null; }
  return { id, ...s };
}

// ---- http ------------------------------------------------------------------

const STATIC = {
  '/': ['example/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['example/index.html', 'text/html; charset=utf-8'],
  // Same layout as the hub: the button loads its QR encoder from
  // `<parent of its own directory>/vendor/qrcodegen.js`.
  '/connect/lc-connect.js': ['button/lc-connect.js', 'text/javascript; charset=utf-8'],
  '/vendor/qrcodegen.js': ['button/vendor/qrcodegen.js', 'text/javascript; charset=utf-8'],
};

function json(res, status, body, cookie) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
  if (cookie) headers['set-cookie'] = cookie;
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 64 * 1024) throw new Error('body too large'); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (STATIC[p] && req.method === 'GET') {
      const [file, type] = STATIC[p];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      fs.createReadStream(path.join(ROOT, file)).pipe(res);
      return;
    }

    if (p === '/api/connect/start' && req.method === 'POST') {
      await readBody(req).catch(() => ({}));
      try {
        await rp.ready(10_000);
        const started = await rp.startLogin({ clientData: { ua: String(req.headers['user-agent'] ?? '').slice(0, 80) } });
        json(res, 200, started);
      } catch (err) {
        json(res, 503, { error: rp.loggedIn ? err.message : 'wallet connection service unavailable; try again shortly' });
      }
      return;
    }

    if (p === '/api/connect/status' && req.method === 'GET') {
      const rid = url.searchParams.get('request_id') ?? '';
      const s = rp.status(rid);
      if (s.status !== 'approved') { json(res, 200, { status: s.status, expires_at: s.expires_at }); return; }
      // Approved: issue our own session. One cookie per request id; a
      // second poll after approval reuses it rather than minting another.
      let id = [...sessions].find(([, v]) => v.request_id === rid)?.[0];
      if (!id) {
        id = randomBytes(18).toString('base64url');
        sessions.set(id, { wallet_id: s.wallet_id, session_id: s.session_id, request_id: rid, created_at: Date.now() });
      }
      json(res, 200, { status: 'approved', connected: true, wallet: s.wallet_id, session_id: s.session_id }, issueCookie(id));
      return;
    }

    if (p === '/api/me' && req.method === 'GET') {
      const s = readSession(req);
      if (!s) { json(res, 200, { connected: false }); return; }
      const live = rp.sessions.has(s.session_id);
      json(res, 200, { connected: true, wallet: s.wallet_id, session_id: s.session_id, live });
      return;
    }

    if (p === '/api/logout' && req.method === 'POST') {
      const s = readSession(req);
      if (s) { sessions.delete(s.id); rp.stopSession(s.session_id); }
      json(res, 200, { ok: true }, clearCookie());
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, BIND, () => {
  console.error(`[example] http://${BIND}:${PORT}  domain=${DOMAIN} network=${NETWORK} server=${rp.url}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { rp.close(); server.close(); process.exit(0); });

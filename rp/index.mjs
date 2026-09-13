// Liquid Connect relying-party client for Node (>= 20, ESM, no dependencies).
//
// A website that wants "Connect wallet" runs one of these in its backend.
// It holds a persistent WebSocket to the connect server's RP socket
// (`/server-connect`), logs in as the site's domain, starts login
// requests, and learns when a wallet approves one. The browser never
// talks to Liquid Connect: it asks THIS process (see ../example) and the
// button (../button/lc-connect.js) polls the answer.
//
// The frames and the connection discipline are modelled on the reference
// Rust relying party (sideswap_web_rp in rf-swaption_be) and the shared
// Rust websocket client (sideswap_common::ws_client):
//
//   - on open, send `Login{domain}` with request id 0; the reply with id 0
//     carries the domain's snapshot (sessions, pending login requests,
//     wallets) and means "logged in";
//   - request ids are increasing i32 from 1; `Resp`/`Error` are matched
//     by id, `Notif` has none;
//   - pending requests fail when the socket drops; requests made while
//     disconnected fail immediately;
//   - server actions (cancel/stop) are queued and replayed after every
//     re-login until answered;
//   - reconnect with jittered exponential backoff (1 s -> 15 s, x2, +-30 %,
//     reset once a connection has lived 60 s);
//   - keepalive tick every 15 s: after 60 s without any inbound message
//     send a ping, after 90 s drop the socket and reconnect;
//   - a refused Login (domain verdict pending/unverified) does NOT close
//     the socket; the Rust RP drops it on its next 5 s tick so the login
//     runs again against the (by then cached) verdict — same here.
//
// Where the Node port had to choose something the Rust does not, the
// choice is marked `// UNVERIFIED:` and listed in README.md.

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

export const ENDPOINTS = Object.freeze({
  testnet: 'wss://connect-testnet.liquidconnect.io/server-connect',
  mainnet: 'wss://connect.liquidconnect.io/server-connect',
});

/**
 * The app link the wallet opens; identical to the Rust `app_link("login", id)`.
 * `network` ('liquid' | 'liquid-testnet') names the network the connect
 * server serves: a wallet on another network refuses the link at once and
 * declines the request over HTTP (button v0.4 / SDK 2026-09-13), instead
 * of leaving the page waiting for a request it can never link. Omit only
 * when unknown — a wallet reads "no network" as unknown, never as "mine".
 */
export function deepLink(requestId, path = 'login', network) {
  const u = new URL(`liquidconnect://${path}/`);
  u.searchParams.append('request_id', requestId);
  if (network) u.searchParams.append('network', network);
  return u.toString();
}

const LINK_NETWORK = Object.freeze({ testnet: 'liquid-testnet', mainnet: 'liquid' });

const TICK_MS = 15_000;
const PING_AFTER_MS = 60_000;
const DEAD_AFTER_MS = 90_000;
const RELOGIN_AFTER_REFUSAL_MS = 5_000;
const CONNECT_TIMEOUT_MS = 30_000;
const LOGIN_TTL_MS = 300_000; // what the server grants today (5 min); we only use it for local GC

/** sideswap_types::retry_delay::RetryDelay::default() */
class RetryDelay {
  constructor({ base = 1, max = 15, multiply = 2, spread = 0.3 } = {}) {
    Object.assign(this, { initialBase: base, base, max, multiply, spread });
  }
  next() {
    const random = (Math.random() * 2 - 1) * this.spread;
    const value = this.base * (1 + random);
    this.base = Math.min(this.max, value * this.multiply);
    return value * 1000;
  }
  reset() { this.base = this.initialBase; }
}

export class LiquidConnectError extends Error {
  constructor(code, message) { super(message); this.name = 'LiquidConnectError'; this.code = code; }
}

/**
 * Resolve a WebSocket constructor: an injected one, the global (Node >= 22,
 * Node 20/21 with --experimental-websocket), or the optional `ws` package.
 */
async function resolveWebSocket(injected) {
  if (injected) return injected;
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    const mod = await import('ws');
    return mod.WebSocket ?? mod.default;
  } catch {
    throw new Error('No WebSocket available: use Node >= 22, run Node 20 with --experimental-websocket, or `npm i ws`');
  }
}

/** Parse our `client_data` envelope; null when the record is another RP's (shared domain) or garbage. */
function readEnvelope(tag, clientData) {
  if (typeof clientData !== 'string') return null;
  try {
    const parsed = JSON.parse(clientData);
    if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, tag)) return parsed[tag];
  } catch { /* not JSON */ }
  return null;
}

/** The serde shape of `LoginRequestStatus`: a bare string for unit variants, `{Succeed:{...}}` for the struct one. */
function readLoginStatus(status) {
  if (typeof status === 'string') return { kind: status };
  if (status && typeof status === 'object') {
    const [kind] = Object.keys(status);
    return { kind, ...status[kind] };
  }
  return { kind: 'Unknown' };
}

/**
 * @typedef {Object} RpOptions
 * @property {string} domain            The RP domain (the site's hostname, lowercase, no scheme, no port).
 * @property {'testnet'|'mainnet'} [network='testnet']
 * @property {string} [url]             Override the connect server URL (e.g. a local rf-connect).
 * @property {string} [clientTag='liquidconnect_js']  Envelope key in `client_data`; lets several RPs share one domain.
 * @property {Function} [WebSocket]     Constructor to use instead of the global one / `ws`.
 * @property {(level:string, msg:string, extra?:object)=>void} [log]
 */

export class LiquidConnectRP extends EventEmitter {
  /** @param {RpOptions} options */
  constructor(options) {
    super();
    if (!options || typeof options.domain !== 'string' || !options.domain) throw new Error('domain is required');
    const domain = options.domain.trim();
    // Mirrors connect_server utils::parse_domain_name: a hostname, lowercase, no whitespace, no IP literal.
    if (domain !== domain.toLowerCase() || /\s/.test(domain) || /^[\d.]+$/.test(domain) || domain.includes(':') || domain.includes('/')) {
      throw new Error(`invalid RP domain "${options.domain}": a lowercase hostname only (no scheme, port, path or IP)`);
    }
    this.domain = domain;
    this.network = options.network ?? 'testnet';
    this.url = options.url ?? ENDPOINTS[this.network];
    if (!this.url) throw new Error(`unknown network "${this.network}"`);
    this.clientTag = options.clientTag ?? 'liquidconnect_js';
    this.log = options.log ?? (() => {});
    this._WebSocketOpt = options.WebSocket;

    this.loggedIn = false;
    /** @type {Map<string, object>} request_id -> login record */
    this.logins = new Map();
    /** @type {Map<string, object>} session_id -> { session_id, request_id, wallet_id, client_data } */
    this.sessions = new Map();
    /** @type {Map<string, object>} wallet_id -> last WalletUpdated (utxos, addresses) */
    this.wallets = new Map();

    this._ws = null;
    this._closed = false;
    this._nextId = 0;
    this._pending = new Map();      // id -> { resolve, reject }
    this._actions = new Map();      // id -> ServerAction (replayed after re-login)
    this._retry = new RetryDelay();
    this._reconnectTimer = null;
    this._tickTimer = null;
    this._lastReceived = 0;
    this._connectedAt = 0;
    this._readyWaiters = [];
  }

  // ---- lifecycle -------------------------------------------------------

  /** Start the connection loop. Resolves once the socket class is known (not once logged in: see ready()). */
  async connect() {
    if (this._ws || this._closed) return;
    this._WebSocket = await resolveWebSocket(this._WebSocketOpt);
    this._open();
  }

  /** Resolves when logged in as the domain; rejects on timeout. */
  ready(timeoutMs = 30_000) {
    if (this.loggedIn) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this._readyWaiters = this._readyWaiters.filter((w) => w !== waiter); reject(new Error('timed out waiting for the connect server login')); }, timeoutMs);
      const waiter = () => { clearTimeout(t); resolve(); };
      this._readyWaiters.push(waiter);
    });
  }

  /** Close for good; no reconnect. Pending requests are rejected. */
  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._teardown('closed by caller');
  }

  // ---- the RP API --------------------------------------------------------

  /**
   * Start a login request for this domain.
   * @param {{clientData?: any, serviceChallenge?: string}} [opts]
   * @returns {Promise<{request_id:string, deep_link:string, expires_at:number, network:string}>}
   */
  async startLogin(opts = {}) {
    const envelope = JSON.stringify({ [this.clientTag]: { data: opts.clientData ?? null } });
    const req = { StartLogin: { client_data: envelope } };
    if (opts.serviceChallenge != null) req.StartLogin.service_challenge = String(opts.serviceChallenge);
    const resp = await this.request(req);
    const lr = resp?.StartLogin?.login_request;
    if (!lr || typeof lr.request_id !== 'string') throw new LiquidConnectError('Unknown', 'unexpected connect server response');
    this._foldLogin(lr);
    const network = LINK_NETWORK[this.network];
    return { request_id: lr.request_id, deep_link: deepLink(lr.request_id, 'login', network), expires_at: Number(lr.expires_at), network };
  }

  /**
   * What the button polls. Maps the server's LoginRequestStatus onto the
   * endpoint contract in button/README.md.
   * @returns {{status:'pending'|'WaitUser'|'approved'|'canceled'|'expired'|'failed'|'unknown', request_id:string, wallet_id?:string, session_id?:string, service_key?:string, expires_at?:number, reason?:string}}
   */
  status(requestId) {
    const rec = this.logins.get(requestId);
    if (!rec) {
      // A session can outlive our memory of the request (process restart:
      // the Login snapshot lists sessions, not finished requests).
      for (const s of this.sessions.values()) {
        if (s.request_id === requestId) return { status: 'approved', request_id: requestId, session_id: s.session_id, wallet_id: s.wallet_id };
      }
      return { status: 'unknown', request_id: requestId };
    }
    const out = { status: 'pending', request_id: requestId, expires_at: rec.expires_at };
    switch (rec.status.kind) {
      case 'WaitLink': out.status = 'pending'; break;
      case 'WaitUser': out.status = 'WaitUser'; break;
      case 'Succeed':
        out.status = 'approved';
        out.session_id = rec.status.session_id;
        out.wallet_id = rec.status.wallet_id;
        if (rec.status.service_key) out.service_key = rec.status.service_key;
        break;
      case 'Canceled': out.status = 'canceled'; break;
      case 'Timeout': out.status = 'expired'; break;
      // The wallet could not act on the link (wrong network, most often)
      // and declined it; `reason` is written for the person on the page.
      case 'Failed': out.status = 'failed'; out.reason = String(rec.status.reason ?? ''); break;
      default: out.status = 'unknown';
    }
    if (rec.session_id && !out.session_id) { out.session_id = rec.session_id; out.status = 'approved'; }
    if (rec.wallet_id && !out.wallet_id) out.wallet_id = rec.wallet_id;
    return out;
  }

  /** The session a request produced, or null. */
  sessionFor(requestId) {
    for (const s of this.sessions.values()) if (s.request_id === requestId) return s;
    return null;
  }

  /** Cancel a pending login request (fire-and-forget, replayed after reconnect like the Rust RP). */
  cancelLogin(requestId) { this.serverAction({ CancelLoginRequest: { request_id: requestId } }); }

  /** End a wallet session (logout). The wallet stops listing the site. */
  stopSession(sessionId) {
    this.serverAction({ StopSession: { session_id: sessionId } });
    // Drop it locally now; the SessionRemoved notification is a no-op then.
    const s = this.sessions.get(sessionId);
    if (s) { this.sessions.delete(sessionId); this.emit('sessionRemoved', s); }
  }

  /** Queue a ServerAction; unlike request() it survives reconnects and never rejects. */
  serverAction(action) {
    const id = ++this._nextId;
    this._actions.set(id, action);
    if (this.loggedIn) this._send(id, { ServerAction: { action } });
    return id;
  }

  /**
   * Send any `Req` variant and await its `Resp`. Rejects with
   * LiquidConnectError on an `Error` frame, when not logged in, or when
   * the socket drops first.
   */
  request(req) {
    if (!this.loggedIn) return Promise.reject(new LiquidConnectError('Server', 'connect server is disconnected'));
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._send(id, req);
    });
  }

  // ---- socket ----------------------------------------------------------

  _open() {
    if (this._closed) return;
    this.log('debug', `connecting to ${this.url}`);
    let ws;
    try {
      ws = new this._WebSocket(this.url);
    } catch (err) {
      this._scheduleReconnect(err);
      return;
    }
    this._ws = ws;
    const connectTimer = setTimeout(() => { if (this._ws === ws && !this._connectedAt) this._teardown('connect timeout'); }, CONNECT_TIMEOUT_MS);

    ws.addEventListener?.('open', () => this._onOpen(ws, connectTimer));
    ws.addEventListener?.('message', (ev) => this._onMessage(ws, ev.data));
    ws.addEventListener?.('close', (ev) => this._onClose(ws, `close ${ev.code}${ev.reason ? ' ' + ev.reason : ''}`));
    ws.addEventListener?.('error', (ev) => { this.log('debug', `socket error: ${ev.message ?? ev.error?.message ?? 'unknown'}`); });
    if (typeof ws.on === 'function') ws.on('pong', () => { this._lastReceived = Date.now(); });
  }

  _onOpen(ws, connectTimer) {
    if (ws !== this._ws) return;
    clearTimeout(connectTimer);
    this._connectedAt = Date.now();
    this._lastReceived = Date.now();
    this.log('debug', 'connected to the connect server');
    this._tickTimer = setInterval(() => this._tick(ws), TICK_MS);
    // The handshake: Login with id 0, exactly as the Rust RP.
    this._send(0, { Login: { domain: this.domain } });
  }

  _onMessage(ws, data) {
    if (ws !== this._ws) return;
    this._lastReceived = Date.now();
    let from;
    try { from = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); }
    catch (err) { this.log('error', `parsing connect server message failed: ${err.message}`); return; }
    this.emit('frame', from);
    if (from.Resp) this._onResp(from.Resp.id, from.Resp.resp);
    else if (from.Error) this._onError(from.Error.id, from.Error.err);
    else if (from.Notif) this._onNotif(from.Notif.notif);
    else this.log('error', `unknown frame: ${JSON.stringify(from).slice(0, 200)}`);
  }

  _onClose(ws, reason) {
    if (ws !== this._ws) return;
    this._teardown(reason);
  }

  _send(id, req) {
    const ws = this._ws;
    if (!ws) return;
    try { ws.send(JSON.stringify({ Req: { id, req } })); }
    catch (err) { this.log('error', `send failed: ${err.message}`); }
  }

  _tick(ws) {
    if (ws !== this._ws) return;
    const idle = Date.now() - this._lastReceived;
    if (idle > DEAD_AFTER_MS) { this._teardown('ping timeout'); return; }
    if (idle > PING_AFTER_MS) {
      if (typeof ws.ping === 'function') {
        // `ws` package: a real ping frame, as sideswap_common::ws_client sends.
        try { ws.ping(); } catch { /* the close handler will follow */ }
      } else if (this.loggedIn) {
        // UNVERIFIED: the WHATWG WebSocket (Node's built-in) cannot send ping
        // frames. Instead a no-op ServerAction is sent: cancelling a request
        // id that does not exist is answered with `Resp{ServerAction:{}}`
        // (connect_server server_requests.rs: unknown id -> nothing happens),
        // which refreshes `_lastReceived` and proves the peer is alive.
        this._send(++this._nextId, { ServerAction: { action: { CancelLoginRequest: { request_id: `keepalive-${randomBytes(4).toString('hex')}` } } } });
      }
    }
  }

  _teardown(reason) {
    const ws = this._ws;
    if (!ws) return;
    this._ws = null;
    clearInterval(this._tickTimer); this._tickTimer = null;
    try { ws.close(); } catch { /* already gone */ }
    if (typeof ws.terminate === 'function') { try { ws.terminate(); } catch { /* */ } }
    const wasLoggedIn = this.loggedIn;
    this.loggedIn = false;
    const lived = this._connectedAt ? Date.now() - this._connectedAt : 0;
    this._connectedAt = 0;
    this.log('debug', `disconnected from the connect server (${reason})`);
    const pending = this._pending; this._pending = new Map();
    for (const { reject } of pending.values()) reject(new LiquidConnectError('Server', 'connect server has been disconnected'));
    if (wasLoggedIn) this.emit('disconnected', { reason, reconnecting: !this._closed });
    if (lived > 60_000) this._retry.reset();
    this._scheduleReconnect(reason, lived > 0);
  }

  _scheduleReconnect(reason, wasConnected = false) {
    if (this._closed) return;
    clearTimeout(this._reconnectTimer);
    // The Rust loop reconnects at once after a connection that was up and
    // waits RetryDelay after a failed connect; a refused Login is retried
    // after the next 5 s tick (see _onError).
    const delay = wasConnected ? 0 : this._retry.next();
    this.log('debug', `reconnect in ${Math.round(delay)} ms (${reason?.message ?? reason})`);
    this._reconnectTimer = setTimeout(() => this._open(), delay);
  }

  // ---- protocol ----------------------------------------------------------

  _onResp(id, resp) {
    if (id === 0) { if (resp.Login) this._onLoggedIn(resp.Login); return; }
    if (this._actions.delete(id)) return;
    const p = this._pending.get(id);
    if (!p) { this.log('error', `ignore unknown pending rp request, req_id: ${id}`); return; }
    this._pending.delete(id);
    p.resolve(resp);
  }

  _onError(id, err) {
    const error = new LiquidConnectError(err?.code ?? 'Unknown', err?.message ?? 'unknown error');
    if (id === 0) {
      // rf-connect refuses a Login while its domain verdict is pending (or
      // failed) without closing the socket; reconnect so the login runs
      // again against the cached verdict. Same 5 s cadence as the Rust tick.
      this.log('error', `rp login failed: ${error.message}`);
      this.emit('loginRefused', error);
      if (!this.loggedIn) {
        clearInterval(this._tickTimer); this._tickTimer = null;
        const ws = this._ws;
        setTimeout(() => { if (this._ws === ws && !this.loggedIn) this._teardown('login refused, retrying'); }, RELOGIN_AFTER_REFUSAL_MS);
      }
      return;
    }
    if (this._actions.has(id)) { this._actions.delete(id); this.log('debug', `server action ${id} failed: ${error.message}`); return; }
    const p = this._pending.get(id);
    if (!p) { this.log('error', `ignore unknown pending rp request, req_id: ${id}`); return; }
    this._pending.delete(id);
    p.reject(error);
  }

  _onLoggedIn(login) {
    this.loggedIn = true;
    this._retry.reset();
    this.log('info', `logged in to the connect server as ${this.domain}: ${login.sessions?.length ?? 0} sessions`);

    // Reconcile: sessions we knew that the server no longer lists are gone.
    const live = new Set((login.sessions ?? []).map((s) => s.session_id));
    for (const sid of [...this.sessions.keys()]) if (!live.has(sid)) this._sessionRemoved(sid);
    for (const s of login.sessions ?? []) this._sessionCreated(s);
    for (const lr of login.login_requests ?? []) this._foldLogin(lr);
    for (const w of login.wallets ?? []) this._walletUpdated(w);

    // Replay actions that were queued or unanswered before the drop.
    for (const [id, action] of this._actions) this._send(id, { ServerAction: { action } });

    this.emit('connected', { sessions: this.sessions.size });
    const waiters = this._readyWaiters; this._readyWaiters = [];
    for (const w of waiters) w();
  }

  _onNotif(notif) {
    const [kind] = Object.keys(notif);
    const body = notif[kind];
    this.emit('notification', kind, body);
    switch (kind) {
      case 'SessionCreated': this._sessionCreated(body.session); break;
      case 'SessionRemoved': this._sessionRemoved(body.session_id); break;
      case 'LoginRequestUpdated': this._foldLogin(body.login_request); break;
      case 'WalletUpdated': this._walletUpdated(body.wallet); break;
      // Request kinds this library never issues (sign, sign-message,
      // receive-address, pay, fund) arrive on a shared domain from other
      // RPs, or from your own request() calls; 'notification' carries them.
      default: break;
    }
  }

  _mine(clientData) { return readEnvelope(this.clientTag, clientData) !== null; }

  _foldLogin(lr) {
    if (!this._mine(lr.client_data)) { this.log('debug', `login request ${lr.request_id} is not ours`); return; }
    const status = readLoginStatus(lr.status);
    const prev = this.logins.get(lr.request_id);
    const rec = {
      request_id: lr.request_id,
      status,
      expires_at: Number(lr.expires_at),
      client_data: readEnvelope(this.clientTag, lr.client_data)?.data ?? null,
      session_id: status.session_id ?? prev?.session_id,
      wallet_id: status.wallet_id ?? prev?.wallet_id,
      updated_at: Date.now(),
    };
    this.logins.set(lr.request_id, rec);
    this._gc();
    this.emit('login', this.status(lr.request_id));
  }

  _sessionCreated(session) {
    if (!this._mine(session.client_data)) { this.log('debug', `session ${session.session_id} is not ours`); return; }
    if (this.sessions.has(session.session_id)) return;
    // `__descriptor` (testnet-only, experimental) is deliberately dropped:
    // the wallet descriptor is not for the web page.
    const s = {
      session_id: session.session_id,
      request_id: session.request_id,
      wallet_id: session.wallet_id,
      client_data: readEnvelope(this.clientTag, session.client_data)?.data ?? null,
    };
    this.sessions.set(s.session_id, s);
    const rec = this.logins.get(s.request_id);
    if (rec) { rec.session_id = s.session_id; rec.wallet_id = s.wallet_id; }
    this.emit('sessionCreated', s);
  }

  _sessionRemoved(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    this.emit('sessionRemoved', s);
  }

  _walletUpdated(wallet) {
    if (!wallet || typeof wallet.wallet_id !== 'string') return;
    // Only wallets that have a session with us matter; on a shared domain
    // the server fans every wallet of the domain to every RP socket.
    this.wallets.set(wallet.wallet_id, wallet);
    this.emit('wallet', wallet);
  }

  /** Forget finished/expired login requests after a grace so the map cannot grow without bound. */
  _gc() {
    const now = Date.now();
    for (const [rid, rec] of this.logins) {
      const final = rec.status.kind === 'Canceled' || rec.status.kind === 'Timeout' || rec.status.kind === 'Succeed';
      if ((final && now - rec.updated_at > LOGIN_TTL_MS) || now > rec.expires_at + 2 * LOGIN_TTL_MS) this.logins.delete(rid);
    }
  }
}

export default LiquidConnectRP;

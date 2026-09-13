# Liquid Connect — web login

Everything a website needs to offer **Connect wallet** with Liquid Connect:

- [`button/`](button/README.md) — `lc-connect.js`, the embeddable connect button and modal (QR, phone hand-off, desktop hand-off, countdown, "Need a wallet?", connected chip). One script tag, no dependencies.
- [`rp/`](rp/README.md) — a dependency-free Node library that makes your backend a Liquid Connect **relying party**: it logs in to the connect server as your domain, starts login requests and learns when a wallet approves one.
- [`example/`](example/server.mjs) — a runnable `node:http` site wiring the two together with a signed cookie session.

Liquid Connect lets a web page use a person's Liquid wallet (SideSwap today) without ever seeing keys or the wallet descriptor. The wallet shows the person your **domain** and they approve; from then on your backend holds a session for that wallet and can ask it to sign, pay, fund or hand out a receive address. This repo covers the login; the protocol beyond it is in the [protocol document](https://github.com/sideswap-io/sideswap_rust/blob/main/docs/connect.md).

## Architecture

```
  browser (your page)              your backend                 connect server                 wallet (phone/desktop)
  ┌──────────────────┐   POST /api/connect/start   ┌────────────┐                           ┌──────────────┐
  │  lc-connect.js   │ ──────────────────────────▶ │            │  StartLogin               │              │
  │  (the button)    │ ◀────────────────────────── │  rp/       │ ────────────▶ ┌────────┐  │  SideSwap    │
  │                  │  {request_id, deep_link}    │  Liquid-   │               │        │  │              │
  │  shows QR /      │                             │  ConnectRP │  one wss to   │ connect│  │  scans QR /  │
  │  opens link ─────┼─ liquidconnect://login/?request_id=… ────┼─────────────────────────┼─▶│  opens link  │
  │                  │                             │  logged in │  /server-     │ .liquid│  │              │
  │  GET /api/connect/status?request_id=… (poll)   │  as your   │  connect      │ connect│◀─│  approves    │
  │ ◀────────────────────────────────────────────  │  domain    │ ◀──────────── │ .io    │  │  the domain  │
  │  {status:'approved', wallet}                   │            │  SessionCreated          │              │
  │  + your session cookie                         └────────────┘  (wallet_id, session_id) └──────────────┘
  └──────────────────┘
```

The browser never talks to Liquid Connect. Your backend does, over one persistent WebSocket, and it alone decides what a login is worth (a cookie, a token, an account). The connect server routes the wallet's answer only to backends that have **proved control of the domain** the person was shown.

## Quick start

1. **Install** — `npm i @liquidconnect/web` (or vendor this repo). Node >= 22 for the built-in WebSocket; on Node 20 add `--experimental-websocket` or `npm i ws`.
2. **Publish your domain proof** (below) for the server you will use. On testnet as on production, a domain without a proof cannot log in.
3. **Run a relying party in your backend:**
   ```js
   import { LiquidConnectRP } from '@liquidconnect/web/rp';
   const rp = new LiquidConnectRP({ domain: 'example.com', network: 'testnet' });
   await rp.connect();
   ```
   and expose two routes: `POST /api/connect/start` → `await rp.startLogin()`, and `GET /api/connect/status?request_id=` → `rp.status(id)`, issuing your own session when the status is `approved` (see `example/server.mjs`).
4. **Put the button on the page:**
   ```html
   <script src="https://test.liquidconnect.io/connect/v0.4/lc-connect.js"></script>
   <div id="lc"></div>
   <script>LiquidConnect.mount('#lc', { onConnected(s) { location.reload(); } });</script>
   ```
5. **Try it:** `LC_DOMAIN=example.com node example/server.mjs`, open `http://127.0.0.1:8080`, press the button, approve in a SideSwap wallet on testnet. The server logs the session; `GET /api/me` shows the wallet id.

## Endpoints

| Network | RP socket | Policy |
|---|---|---|
| testnet | `wss://connect-testnet.liquidconnect.io/server-connect` | domain-verified (`lc1` enforced as of 2026-09-04) |
| production | `wss://connect.liquidconnect.io/server-connect` | domain-verified, `lc1` enforced |

`lc1` is the version string of the domain-control proof scheme (`v=lc1` in the TXT record, `"v":"lc1"` in `rp.json`). "Enforced" means the connect server's `enforce_domain_control` policy is on: a `Login{domain}` is refused unless the server has found a valid `lc1` proof for that domain — the refusal messages are `domain verification in progress, reconnect shortly` (a lookup is running; the class retries every 5 s) and then `domain control not verified` (no proof found; the verdict is re-checked on later logins). Where enforcement is off the verdict is only logged. Testnet was documented as "open" but refuses unverified domains today; publish the proof there too.

The hub lists every relying party and its verdict (Verified / Pending / Unverified) at `https://test.liquidconnect.io/rps`.

## Domain verification

Your backend claims a domain; the wallet shows that domain to the person; the proof is what makes the name worth trusting. Publish **either** form (both are checked, TXT first; either suffices). Each binds your domain to the connect server's hostname, so a proof for one server cannot be replayed on another.

Server hostnames to name: `connect.liquidconnect.io` (production), `connect-testnet.liquidconnect.io` (testnet). One deployment may answer to several names; naming any of them is enough.

### 1. DNS TXT

Record name `_liquidconnect.<your-domain>`, value:

```
v=lc1; server=connect.liquidconnect.io
```

Semicolon-separated `key=value`, whitespace tolerant, hostname case-insensitive. Publish one TXT record per server you use (e.g. a second one with `server=connect-testnet.liquidconnect.io`). The connect server resolves the record over DNS-over-HTTPS (Cloudflare's resolver), so it is visible as soon as public DNS has it. A verified verdict is cached for an hour; a removed record stops working within the hour.

### 2. Well-known JSON

Serve `https://<your-domain>/.well-known/liquid-connect/rp.json` (HTTPS, 200, JSON):

```json
{"v":"lc1","domain":"example.com","servers":["connect.liquidconnect.io","connect-testnet.liquidconnect.io"]}
```

`domain` must equal the domain you log in as (a copied document does not authorize another host); `servers` must include the hostname of the server you connect to. The domain used in `Login` — and in the document — is a lowercase hostname only: no scheme, port, path, or IP literal.

Unknowns: whether a subdomain proof is accepted for its parent (or vice versa) — the check is on the exact domain string; verify the hub's `/rps` page after publishing. Rate limits on the verifier, if any, are not documented.

## Links

- Wallet-side SDK (what a wallet needs to speak Liquid Connect): https://github.com/liquidconnect/liquidconnect-sdk
- Protocol: https://github.com/sideswap-io/sideswap_rust/blob/main/docs/connect.md
- The hub (button CDN, supported wallets, RP directory): https://test.liquidconnect.io — button at `/connect/`, wallets at `/wallets`, relying parties at `/rps`
- Questions: hello@liquidconnect.io

## Layout

```
button/lc-connect.js          the button, v0.4 (verbatim from the hub)
button/vendor/qrcodegen.js    QR encoder (MIT, Project Nayuki)
button/README.md              embed snippet, endpoint contract, options, callbacks, return API
rp/index.mjs                  LiquidConnectRP — the relying-party client
rp/README.md                  API, wire protocol, connection discipline, UNVERIFIED points
example/server.mjs            node:http site: static, /api/connect/start, /api/connect/status, cookie session
example/index.html            the page that embeds the button
```

License: MIT (see LICENSE). `button/vendor/qrcodegen.js` carries its own MIT notice (Project Nayuki).

# `@liquidconnect/web/rp` — the relying-party helper for Node

A dependency-free ESM class that makes your backend a Liquid Connect **relying party** (RP): it holds one WebSocket to the connect server, logs in as your domain, starts login requests, and learns when a wallet approves one. Pair it with the [button](../button/README.md) in the browser; the [example](../example/server.mjs) shows the two together.

Requirements: Node >= 22 (built-in `WebSocket`), or Node 20 with `--experimental-websocket`, or any Node >= 20 with the optional `ws` package installed (`npm i ws`; it is picked up automatically and enables real ping frames).

## Use

```js
import { LiquidConnectRP } from '@liquidconnect/web/rp';

const rp = new LiquidConnectRP({ domain: 'example.com', network: 'testnet' });
await rp.connect();          // starts the connection loop (reconnects forever until close())
await rp.ready();            // resolves once logged in as the domain

const { request_id, deep_link, expires_at } = await rp.startLogin();
// hand these to the button; then on every poll:
rp.status(request_id);       // { status: 'pending' | 'WaitUser' | 'approved' | 'canceled' | 'expired' | 'unknown', wallet_id?, session_id? }

rp.on('sessionCreated', ({ session_id, wallet_id, request_id }) => { /* the wallet approved */ });
rp.on('sessionRemoved', ({ session_id }) => { /* the wallet ended the session */ });
```

### Constructor options

| Option | Meaning |
|---|---|
| `domain` | Required. The domain your site is served from, exactly what the wallet shows the person: a lowercase hostname, no scheme, port, path or IP literal (the server rejects anything else). It must hold a domain-control proof; see the [root README](../README.md#domain-verification). |
| `network` | `'testnet'` (default) → `wss://connect-testnet.liquidconnect.io/server-connect`; `'mainnet'` → `wss://connect.liquidconnect.io/server-connect`. |
| `url` | Override the server URL (a local `rf-connect`, for instance). |
| `clientTag` | Key of the envelope written into each request's `client_data` (default `liquidconnect_js`). The connect server fans every session and request of a domain out to **every** RP socket logged in as that domain, so each RP tags what it created and ignores the rest. Give each distinct backend on one domain its own tag. |
| `WebSocket` | A constructor to use instead of the global one / `ws`. |
| `log(level, message)` | `debug` / `info` / `error` lines, off by default. |

### Methods

| Method | Meaning |
|---|---|
| `connect()` | Start. Resolves once a WebSocket implementation is found, not once logged in. |
| `ready(timeoutMs = 30000)` | Resolves when logged in; rejects on timeout. Call before `startLogin` on a fresh process. |
| `startLogin({ clientData?, serviceChallenge? })` | → `{ request_id, deep_link, expires_at }` (`expires_at` ms since epoch; the server grants five minutes). `clientData` is any JSON of yours, stored inside the envelope and given back on the session (`session.client_data`). `serviceChallenge` asks the wallet to also bind a service key for your domain in the same approval; the resulting `service_key` (x-only pubkey hex) appears on `status()`. |
| `status(request_id)` | See the table below. Synchronous; it reads the state the server has pushed. |
| `sessionFor(request_id)` | The session a request produced, or `null`. |
| `cancelLogin(request_id)` | Cancel a pending request (fire-and-forget; queued and replayed across reconnects). |
| `stopSession(session_id)` | End a wallet session (logout); the wallet stops listing your site. |
| `serverAction(action)` | Any `ServerAction` variant, same queueing. |
| `request(req)` | Any `Req` variant, awaiting its `Resp`; rejects with `LiquidConnectError { code, message }` on an `Error` frame, when not logged in, or when the socket drops first. Use this for `StartSign`, `StartSignMessage`, `StartReceiveAddress`, `StartPay`, `StartFund` (their updates arrive on the `notification` event). |
| `close()` | Close for good. |

Properties: `loggedIn`, `sessions` (Map session_id → `{ session_id, request_id, wallet_id, client_data }`), `logins` (Map request_id → record), `wallets` (Map wallet_id → last `WalletUpdated`: utxos, receive/change address), `domain`, `network`, `url`.

### `status()` mapping

| Server `LoginRequestStatus` | `status()` | Extra fields |
|---|---|---|
| `WaitLink` (request created, nobody has opened it) | `pending` | `expires_at` |
| `WaitUser` (a wallet opened the link; the person is approving) | `WaitUser` | `expires_at` |
| `Succeed { session_id, wallet_id, service_key? }` or a `SessionCreated` for the request | `approved` | `session_id`, `wallet_id`, `service_key?` |
| `Canceled` | `canceled` | |
| `Timeout` | `expired` | |
| not ours / never seen (also after a restart, unless a live session still names the request) | `unknown` | |

The button treats `pending`, `unknown` and `WaitUser` as "keep polling", `approved` as connected, and `canceled` / `expired` as failures.

`wallet_id` is the wallet's Liquid Connect identity key (x-only public key, 64 hex chars) — stable for that wallet, and the thing to key your own accounts on.

### Events

| Event | Payload |
|---|---|
| `connected` | `{ sessions }` — logged in (also after every reconnect). |
| `disconnected` | `{ reason, reconnecting }` — `reconnecting` is `false` only after `close()`. |
| `loginRefused` | `LiquidConnectError` — the server refused `Login{domain}`; see the wire notes. |
| `login` | the `status()` object for a request that changed. |
| `sessionCreated` / `sessionRemoved` | the session record. |
| `wallet` | a `WalletUpdated` body. |
| `notification` | `(kind, body)` for every `Notif` frame, including request kinds this class does not fold. |
| `frame` | every parsed inbound frame (debugging). |

## The wire protocol, as implemented

Everything is JSON text frames over one WebSocket, the shapes of the Rust `rp_api` crate (serde externally-tagged enums):

```
→ {"Req":  {"id": 0, "req": {"Login": {"domain": "example.com"}}}}
← {"Resp": {"id": 0, "resp": {"Login": {"sessions": [...], "login_requests": [...], "sign_requests": [...], "wallets": [...], ...}}}}
   or
← {"Error": {"id": 0, "err": {"code": "InvalidRequest", "message": "protocol error: domain control not verified"}}}

→ {"Req":  {"id": 1, "req": {"StartLogin": {"client_data": "{\"liquidconnect_js\":{\"data\":null}}"}}}}
← {"Resp": {"id": 1, "resp": {"StartLogin": {"login_request": {"request_id": "…32 hex…", "status": "WaitLink", "client_data": "…", "expires_at": 1788497975268}}}}}

← {"Notif": {"notif": {"LoginRequestUpdated": {"login_request": {"request_id": "…", "status": "WaitUser", ...}}}}}
← {"Notif": {"notif": {"LoginRequestUpdated": {"login_request": {"request_id": "…", "status": {"Succeed": {"session_id": "…", "wallet_id": "…64 hex…"}}, ...}}}}}
← {"Notif": {"notif": {"SessionCreated": {"session": {"session_id": "…", "request_id": "…", "client_data": "…", "wallet_id": "…"}}}}}
← {"Notif": {"notif": {"SessionRemoved": {"session_id": "…"}}}}
← {"Notif": {"notif": {"WalletUpdated": {"wallet": {"wallet_id": "…", "utxos": [...], "recv_address": "…", "change_address": "…"}}}}}

→ {"Req":  {"id": 2, "req": {"ServerAction": {"action": {"CancelLoginRequest": {"request_id": "…"}}}}}}
← {"Resp": {"id": 2, "resp": {"ServerAction": {}}}}
→ {"Req":  {"id": 3, "req": {"ServerAction": {"action": {"StopSession": {"session_id": "…"}}}}}}
```

Deep link: `liquidconnect://login/?request_id=<request_id>` (the button appends `&mobile=true` on a phone).

Connection discipline, copied from the reference Rust RP (`sideswap_web_rp`) and the shared Rust websocket client (`sideswap_common::ws_client`):

- `Login` is sent with id 0 on every (re)connect; the id-0 reply is the domain snapshot and means logged in. Known sessions the snapshot no longer lists are dropped; listed ones, pending login requests and wallets are folded in.
- Request ids are increasing i32 from 1. Pending requests are rejected when the socket drops (`connect server has been disconnected`); requests while disconnected are rejected immediately (`connect server is disconnected`).
- Server actions are kept until answered and replayed after every re-login.
- Reconnect after a failed connect uses jittered exponential backoff: 1 s base, ×2, max 15 s, ±30 %, reset once a connection has lived 60 s. A connection that was up reconnects immediately.
- Keepalive tick every 15 s: after 60 s without an inbound message a ping is sent; after 90 s the socket is dropped and reconnected.
- A refused `Login` does not close the socket; the server says `domain verification in progress, reconnect shortly` while it fetches your proof (once per domain, cached an hour), then `domain control not verified` if none was found. The class drops the socket 5 s later and logs in again — the Rust RP's next-tick behaviour — until the verdict is `Verified`.
- Only records whose `client_data` carries this class's envelope are adopted; on a shared domain the rest belong to another RP and are ignored (the `__descriptor` field a testnet session may carry is dropped too — the wallet descriptor is not for a web page).

## UNVERIFIED points

Marked `// UNVERIFIED:` in `index.mjs`; everything else above was exercised against `connect-testnet.liquidconnect.io` on 2026-09-04 (handshake, `startLogin`, `status`, cancel round-trip, refusal cadence, keepalive probe answer).

1. **Keepalive without ping frames.** Node's built-in WebSocket cannot send ping frames. When `ws` is not installed the class instead sends a no-op `ServerAction { CancelLoginRequest { request_id: "keepalive-…" } }` after 60 s idle; the server answers `Resp { ServerAction: {} }` for an unknown id (verified on testnet), which refreshes the idle clock. Whether an idle RP socket is ever closed by the server or a proxy in front of it — and so whether the probe is needed at all — is not established. With `ws` installed the class sends real pings, as the Rust does.
2. **`Timeout` on the RP socket.** The Rust RP handles `LoginRequestStatus::Timeout` on `LoginRequestUpdated`; whether the connect server pushes it to the RP when a request expires unopened (rather than only on the next `Login` snapshot) was not observed. A request stays `pending` until the server says otherwise; the button stops polling 90 s past `expires_at` on its own.
3. **Mainnet.** Nothing here was run against `connect.liquidconnect.io`. The wire protocol is the same binary; only the domain-control policy differs.

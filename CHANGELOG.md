# Changelog

## 0.3.0 — 2026-09-04

First public-ready cut. Versions track the button: `lc-connect.js` is v0.3.

- `button/lc-connect.js` v0.3, verbatim from the hub: "Need a wallet?" on every
  screen (wallet store + supported-wallets list), phone hand-off with
  automatic return (`mobile=true`), QR always carries the bare link, polling
  survives the app hand-off and a reloaded tab and continues 90 s past
  expiry, desktop nudge instead of failure, optional connected chip with
  disconnect, light theme, string overrides.
- `rp/index.mjs`: `LiquidConnectRP` — RP login handshake, reconnect with
  jittered backoff, keepalive, `startLogin()`, `status()`, cancel/stop,
  session events; frames and discipline modelled on the Rust reference RP.
- `example/`: plain `node:http` site with the button, `/api/connect/start`,
  `/api/connect/status`, `/api/me`, `/api/logout`, signed cookie session.
- Docs: embed snippet and endpoint contract, wire protocol, domain
  verification (DNS TXT and `/.well-known/liquid-connect/rp.json`, scheme
  `lc1`).

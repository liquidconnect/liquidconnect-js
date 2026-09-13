# Changelog

## 0.4.0 — 2026-09-13

The page learns when the wallet cannot act on a link. A wallet on the other
network is connected to the other network's connect server, so a login link
names a request it can never reach over its session; the wallet showed the
mismatch, the page spun until the request expired.

- `button/lc-connect.js` v0.4.0: after 45 s still pending the modal says so
  in place, names the site's network (from `network` in the start reply),
  and offers Cancel; polling continues. Renders a `failed` status with its
  `error` text. Pinned path is now `/connect/v0.4/`.
- `rp/index.mjs`: `deepLink(id, path, network)` adds `network=` (`liquid` /
  `liquid-testnet`, from the RP's own `network` option) so a new-enough wallet
  refuses a mismatch at once and declines the request at the connect server
  (`POST /login/decline`); `startLogin()` returns `network`; `status()` maps
  the connect server's `Failed { reason }` to `failed` + `reason`.
- `example/`: `/api/connect/status` forwards `reason` as `error`.


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

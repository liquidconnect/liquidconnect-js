# The connect button (`lc-connect.js` v0.4)

One script tag gives your site the whole "connect a SideSwap wallet" flow, the same on every site that uses Liquid Connect: a button in the house style, a direct hand-off into the wallet on a phone that brings the person back automatically, a desktop-or-mobile choice on a desktop (the flow swaption.io and BetSimply use), a **Need a wallet?** choice that leads to the wallet store and to the supported-wallets list, polling that survives the app hand-off, and an optional connected chip with disconnect.

Your backend keeps talking to Liquid Connect (see [`../rp`](../rp/README.md)); the button only owns the person-facing part. Nothing here talks to Liquid Connect, and nothing here holds a secret.

No dependencies. The QR encoder (`vendor/qrcodegen.js`, MIT, Project Nayuki) is loaded lazily the first time a QR is shown.

## Where to load it from

| URL | Meaning |
|---|---|
| `https://<hub>/connect/lc-connect.js` | latest — follows new releases |
| `https://<hub>/connect/v0.4/lc-connect.js` | immutable — pinned to 0.4.x, never changes behaviour under you |

`<hub>` is the Liquid Connect hub (`test.liquidconnect.io` today). Pin the versioned path in production; use the latest path while developing.

Self-hosting works too (this directory is the whole thing), with one rule about layout: the script resolves its helpers relative to the **parent of its own directory**. Served from `/connect/lc-connect.js` it fetches the QR encoder from `/vendor/qrcodegen.js` and points "See all supported wallets" at `/wallets`. Keep that layout (as `example/server.mjs` does), or pass `walletsUrl` explicitly — a self-hosted copy would otherwise send people to `/wallets` on your own origin.

## Put it on a page

```html
<script src="https://test.liquidconnect.io/connect/lc-connect.js"></script>
<div id="lc"></div>
<script>
  const lc = LiquidConnect.mount('#lc', {
    start:  '/api/connect/start',    // your backend: POST → { request_id, deep_link, expires_at }
    status: '/api/connect/status',   // your backend: GET ?request_id= → { status, ... }
    chip: true,                      // show "Wallet ab12…cd34" with a disconnect menu once connected
    disconnect: '/api/logout',       // optional: POST when the person disconnects from the chip
    onConnected(s) { /* s is your status object: token, wallet, whatever you return */ },
  });
</script>
```

## What your backend answers (the endpoint contract)

| Call | Answer |
|---|---|
| `POST start` | `{ "request_id": "…", "deep_link": "liquidconnect://login/?request_id=…", "expires_at": 1788000000000 }` — `expires_at` in ms or s, optional. Any `{ "error": "…" }` or missing field ends the attempt and calls `onFailed`. |
| `GET status?request_id=` | `{ "status": "pending" }` keeps waiting. `{ "status": "WaitUser" }` (also accepted: `wait_user`, `linked`) means the wallet has the request and the person is approving it — the modal switches to the countdown. `{ "status": "approved", … }` or `{ "connected": true, "token": "…", … }` means connected and calls `onConnected` with the whole object. `unknown` and `WaitLink` keep polling. Anything else goes to `onStatus` first (return `'stop'` to take over, `'continue'` to keep polling); otherwise it is shown as a failure, using `error` if present. |

The request body of `start` is `opts.startBody` (default `{}`), sent as JSON with `credentials: 'same-origin'`. Polling runs every 1.5 s and continues 90 s past `expires_at`.

## Options

| Option | Meaning |
|---|---|
| `start`, `status` | Your endpoints. Defaults `/api/connect/start` and `/api/connect/status`. |
| `startBody`, `disconnectBody` | JSON bodies for the `start` and `disconnect` POSTs. Default `{}`. |
| `walletsUrl`, `installUrl` | Where "Need a wallet?" sends people. Defaults: `/wallets` on the host this script is served from, and the SideSwap downloads page (`https://sideswap.io/downloads/`). |
| `label` | Button text. Default "Connect SideSwap wallet". |
| `note` | The privacy line under the QR. Default: "The site will only be able to see what you approve in your wallet. Private keys never leave the wallet." |
| `strings` | Object overriding any UI string (keys: `button`, `title`, `starting`, `choose`, `desktop`, `desktopHint`, `mobile`, `mobileHintDesktop`, `mobileHintPhone`, `scan`, `scanSuffix`, `note`, `approve`, `expiresIn`, `desktopConnecting`, `desktopNudge`, `openAgain`, `usePhone`, `back`, `retry`, `cancel`, `needWallet`, `needWalletHint`, `needWalletLead`, `getWallet`, `allWallets`, `failedStart`, `unreachable`, `noAnswer`, `connectedChip`, `goneChip`, `goneMenu`, `connectedMenu`, `disconnect`, `reconnect`, `copy`, `copied`). |
| `theme` | `'dark'` (default) or `'light'`. Colours are CSS variables on the mount element (`--lc-accent`, `--lc-bg`, `--lc-bg2`, `--lc-line`, `--lc-text`, `--lc-muted`, `--lc-ink`, `--lc-warn`, `--lc-overlay`) if you want your own. |
| `chip` | Render the connected chip. Off by default; sites with their own header chip keep it and call `setLive(false)` when the wallet's session goes away. |
| `disconnect` | URL to POST when the person chooses Disconnect from the chip. Without it the chip only forgets locally. |
| `button` | `false` to render no button; you call `lc.connect()` from your own control. |
| `storageKey` | Where the pending request is remembered (localStorage) so the flow survives the app hand-off and a reloaded tab. Default `lc_connect_pending`. A pending request older than 5 minutes is forgotten. |
| `resume` | `false` to not resume a remembered pending request on mount (it still resumes on `pageshow` / tab foreground). |

## Callbacks (all optional)

| Callback | When |
|---|---|
| `onConnected(s)` | The status endpoint answered `approved` / `connected`. `s` is that whole object; the chip shows `s.wallet` or `s.wallet_id`. |
| `onStatus(s)` | Any status the button does not know. Return `'stop'` to close the modal and take over, `'continue'` to keep polling, anything else to show it as a failure. |
| `onFailed(text)` | Start failed, site unreachable, or no answer 90 s past expiry. Return `'handled'` to show your own fallback instead of the retry screen. |
| `onCancelled()` | The person closed the modal. |
| `onDisconnected()` | Disconnect chosen from the chip (after the `disconnect` POST, if any). |

## What `mount()` returns

| Member | Meaning |
|---|---|
| `connect()` | Start the flow (what the button does). |
| `cancel()` | Stop polling, forget the pending request, close the modal. |
| `resume()` | Re-attach to a remembered pending request. |
| `disconnect()` | What the chip's Disconnect does. |
| `setConnected({ wallet })` | After a reload when your page already holds a session: hides the button, shows the chip. |
| `setLive(bool)` | The wallet's Liquid Connect session went away (`false`, the chip turns red with a Reconnect) or came back (`true`). |
| `setDisconnected()` | Forget the connection; show the button again. |
| `needWallet()` | Open the "Need a wallet?" screen from your own link. |
| `walletsUrl`, `isPhone`, `version` | The resolved wallets URL, the user-agent verdict, `'0.3.0'`. |

`window.LiquidConnect` also exposes `version` and `walletsUrl`. Mounting twice is safe; loading the script twice is a no-op.

## Rules it enforces

- On a phone browser the wallet is opened directly with `mobile=true` appended to the deep link, so it minimises and returns the person to your page once they approve. No notification to pull down.
- The QR always carries the bare link: a phone scanning it is a different device.
- On a desktop the "Desktop" choice navigates to the `liquidconnect://` link (no popup tab); after 15 s a nudge offers "Open again", "Use phone instead", "Copy link" and "Need a wallet?", while polling continues.
- Polling keeps going 90 seconds past the nominal expiry: an approval given in time is still retrievable after it, and a backgrounded phone tab may only get to ask once it is foregrounded again.
- Every screen offers a way out for someone without a wallet: "Need a wallet?" is the third choice next to Desktop and Mobile, and it is on the retry and desktop-nudge screens too.
- Nothing here holds a secret. Your backend issues whatever session it likes in the status answer.

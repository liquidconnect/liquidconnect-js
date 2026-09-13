/* Liquid Connect — the connect button, v0.4.0
 *
 *   latest:  https://test.liquidconnect.io/connect/lc-connect.js        (no-cache)
 *   pinned:  https://test.liquidconnect.io/connect/v0.4/lc-connect.js   (immutable)
 *
 * One script tag gives a website the whole "connect a SideSwap wallet"
 * flow, the same on every site: a button in the house style and a modal
 * that follows what swaption.io and BetSimply already do — choose
 * desktop or mobile, a QR for the phone, a spinner while the wallet
 * approves, a countdown, retry, a link to install the wallet — with the
 * rules that were learned the hard way built in: a "Need a wallet?"
 * choice on every screen that leads to the wallet store and to the list
 * of supported wallets on liquidconnect.io; a phone browser opens
 * the wallet directly and is returned automatically; the QR never
 * carries the same-device flag; polling survives the app hand-off and a
 * reloaded tab; the desktop hand-off nudges rather than fails while the
 * wallet may still be answering. Optionally a connected chip with
 * disconnect.
 *
 *   <script src="https://test.liquidconnect.io/connect/lc-connect.js"></script>
 *   <div id="lc"></div>
 *   <script>
 *     const lc = LiquidConnect.mount('#lc', {
 *       start:  '/api/connect/start',   // POST → {request_id, deep_link, expires_at}
 *       status: '/api/connect/status',  // GET ?request_id= → {status, ...}
 *       onConnected(s) { ... },          // s: the status object your backend answered with
 *     });
 *   </script>
 *
 * Contract for the two endpoints (what the venue already speaks):
 *   start  → { request_id, deep_link, expires_at? }  or { error }
 *   status → { status: 'pending' }                       keep waiting
 *            { status: 'WaitUser' | 'linked' }           wallet has the request, waiting for the tap
 *            { status: 'approved', ... } or { connected: true, ... }  → onConnected
 *            anything else → onStatus (return 'stop' | 'continue'), else shown as a failure
 *
 * A site whose backend speaks over a websocket rather than two HTTP routes
 * passes functions instead of URLs: start() resolving to the same
 * {request_id, deep_link, expires_at} object, status(request_id) resolving
 * to the same status object. The button does not care where the answer
 * came from; a rejected promise is treated like an unreachable endpoint.
 *
 * Nothing here talks to Liquid Connect: the site's backend does, and it
 * knows its own session. This file owns only the person-facing part, so
 * it can be the same everywhere. No dependencies; the QR encoder is
 * loaded from the same origin as this script (vendor/qrcodegen.js) the
 * first time a QR is shown.
 */
(function () {
  'use strict';
  if (window.LiquidConnect) return;

  var SELF = document.currentScript && document.currentScript.src
    ? new URL('/', document.currentScript.src).href   // site root: vendor/ and wallets live there whatever path this file is served from (e.g. /connect/v0.4/)
    : '/';
  var ON_A_PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  var POLL_MS = 1500;
  var GRACE_MS = 90000;        // keep asking past the nominal expiry: an approval given in time is still retrievable
  var RESUME_MAX_MS = 300000;
  var DESKTOP_NUDGE_MS = 15000; // after opening the desktop wallet, offer alternatives (but keep waiting)
  var STUCK_MS = 45000;         // still pending after this: say so, name the network, offer Cancel (polling continues)
  var INSTALL_URL = 'https://sideswap.io/downloads/';
  // The list of wallets that work with Liquid Connect lives on the hub
  // this script is served from; a copy served elsewhere falls back to it.
  var HUB_URL = 'https://test.liquidconnect.io/';
  var WALLETS_URL = (SELF !== '/' ? SELF : HUB_URL) + 'wallets';

  var STRINGS = {
    button: 'Connect SideSwap wallet',
    title: 'Connect wallet',
    starting: 'Waiting for wallet link…',
    choose: 'Choose how to connect your wallet',
    desktop: 'Desktop',
    desktopHint: 'Opens the SideSwap app on this computer',
    mobile: 'Mobile',
    mobileHintDesktop: 'Scan a QR code with the SideSwap app on your phone',
    mobileHintPhone: 'Opens the SideSwap app on this phone and brings you back',
    scan: 'Scan QR code',
    scanSuffix: 'with your mobile wallet app',
    note: 'The site will only be able to see what you approve in your wallet. Private keys never leave the wallet.',
    approve: 'Approve the connection request in your wallet to continue.',
    expiresIn: 'expires in {s}s',
    desktopConnecting: 'Connecting to SideSwap desktop…',
    desktopNudge: "Nothing happened? Make sure the SideSwap desktop app is running, or use your phone instead.",
    openAgain: 'Open again',
    usePhone: 'Use phone instead',
    back: 'Back',
    retry: 'Try again',
    cancel: 'Cancel',
    needWallet: 'Need a wallet?',
    needWalletHint: 'Get SideSwap — free, takes a minute',
    needWalletLead: 'Liquid Connect works with SideSwap. Install it, create a wallet, then come back here and connect.',
    getWallet: 'Get SideSwap',
    allWallets: 'See all supported wallets',
    failedStart: 'Could not start the connection.',
    unreachable: 'Could not reach the site.',
    noAnswer: 'No answer from the wallet — try again.',
    stuck: 'Still waiting for your wallet. If the wallet showed an error, cancel and try again.',
    stuckNetwork: 'This site is on {n} — the wallet must be on the same network.',
    connectedChip: 'Wallet {w}',
    goneChip: 'Wallet disconnected',
    goneMenu: 'Your wallet disconnected from Liquid Connect. Reconnect it to reach this site again.',
    connectedMenu: 'Wallet {w} is connected through Liquid Connect.',
    disconnect: 'Disconnect',
    reconnect: 'Reconnect',
    copy: 'Copy link',
    copied: 'Copied'
  };

  var CSS = [
    '.lc,.lc-modal{--lc-bg:#121a20;--lc-bg2:#18232b;--lc-line:#24333d;--lc-text:#e8f0f4;--lc-muted:#93a6b2;--lc-accent:#3ee0e8;--lc-ink:#04201a;--lc-warn:#f0716f;--lc-overlay:rgba(3,8,12,.72);',
    '  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--lc-text)}',
    '.lc.lc-light,.lc-modal.lc-light{--lc-bg:#ffffff;--lc-bg2:#f2f6f8;--lc-line:#d6dee4;--lc-text:#10202a;--lc-muted:#5c6f7b;--lc-accent:#0f9f83;--lc-ink:#ffffff;--lc-overlay:rgba(20,30,40,.45)}',
    '.lc *,.lc-modal *{box-sizing:border-box}',
    '.lc-btn{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:10px 20px;border-radius:999px;border:1px solid var(--lc-accent);',
    '  background:var(--lc-accent);color:var(--lc-ink);font:inherit;font-weight:600;cursor:pointer;width:auto;margin:0;transition:box-shadow .2s,filter .2s}',
    '.lc-btn:hover{filter:brightness(1.06);box-shadow:0 0 28px -6px var(--lc-accent)}.lc-btn:disabled{opacity:.6;cursor:default}',
    '.lc-btn svg{width:18px;height:18px;flex:none}',
    '.lc-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:var(--lc-overlay);padding:16px}',
    '.lc-dialog{background:var(--lc-bg);border:1px solid var(--lc-line);border-radius:16px;width:100%;max-width:440px;max-height:calc(100vh - 32px);overflow:auto;box-shadow:0 30px 80px -20px rgba(0,0,0,.6);outline:none}',
    '.lc-dialog button:focus-visible,.lc-dialog a:focus-visible{outline:2px solid var(--lc-accent);outline-offset:2px}',
    '.lc-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--lc-line)}',
    '.lc-head h3{margin:0;font-size:16px;font-weight:600}',
    '.lc-x{background:transparent;border:0;color:var(--lc-muted);font:inherit;font-size:20px;line-height:1;cursor:pointer;padding:4px 6px;margin:0;width:auto}',
    '.lc-body{padding:18px 16px 16px}',
    '.lc-lead{text-align:center;color:var(--lc-muted);margin:0 0 14px;font-weight:500;font-size:15px}',
    '.lc-opt{display:flex;align-items:center;gap:14px;width:100%;text-align:left;padding:14px 16px;margin:0 0 10px;border-radius:12px;border:1px solid var(--lc-line);background:var(--lc-bg2);color:var(--lc-text);font:inherit;cursor:pointer;text-decoration:none;transition:border-color .15s}',
    '.lc-opt:hover{border-color:var(--lc-accent)}.lc-opt svg{width:24px;height:24px;flex:none;color:var(--lc-accent)}',
    '.lc-opt b{display:block;font-weight:600}.lc-opt small{display:block;color:var(--lc-muted);font-size:12px;margin-top:2px}',
    '.lc-opt.lc-alt{background:transparent;border-style:dashed;margin-top:4px}.lc-opt.lc-alt svg{color:var(--lc-muted)}.lc-opt.lc-alt:hover svg{color:var(--lc-accent)}',
    '.lc-title{margin:0;font-size:17px;font-weight:600}',
    '.lc-foot{display:flex;align-items:flex-start;gap:8px;color:var(--lc-muted);font-size:13px;margin:8px 2px 0}.lc-foot a{color:var(--lc-accent);text-decoration:none}.lc-foot a:hover{text-decoration:underline}',
    '.lc-center{display:flex;flex-direction:column;align-items:center;text-align:center;gap:12px;padding:10px 0}',
    '.lc-qr{padding:6px;background:#fff;border-radius:8px;display:inline-block}.lc-qr svg{width:200px;height:200px;display:block}',
    '.lc-note{display:flex;gap:8px;align-items:flex-start;color:var(--lc-muted);font-size:13px;text-align:left;margin:6px 0 0}',
    '.lc-muted{color:var(--lc-muted);margin:0}.lc-err{color:var(--lc-warn);margin:0}',
    '.lc-spin{width:44px;height:44px;border-radius:50%;border:4px solid var(--lc-line);border-top-color:var(--lc-accent);animation:lc-spin .9s linear infinite}',
    '@keyframes lc-spin{to{transform:rotate(360deg)}}',
    '.lc-count{font-variant-numeric:tabular-nums;color:var(--lc-muted);font-size:13px}',
    '.lc-row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px}',
    '.lc-ghost{min-height:38px;padding:8px 14px;border-radius:10px;border:1px solid var(--lc-line);background:transparent;color:var(--lc-text);font:inherit;cursor:pointer;margin:0;width:auto;text-decoration:none;display:inline-flex;align-items:center;gap:6px}',
    '.lc-ghost.lc-primary{border-color:var(--lc-accent);color:var(--lc-accent)}',
    '.lc-linkline{font-size:12px;color:var(--lc-muted);word-break:break-all;margin:6px 0 0;user-select:all}',
    '.lc-chip{display:inline-flex;align-items:center;gap:8px;min-height:38px;padding:6px 14px;border-radius:999px;border:1px solid var(--lc-line);background:var(--lc-bg2);color:var(--lc-text);font:inherit;cursor:pointer;margin:0;width:auto;position:relative}',
    '.lc-chip .lc-dot{width:8px;height:8px;border-radius:50%;background:var(--lc-accent)}.lc-chip.lc-gone .lc-dot{background:var(--lc-warn)}.lc-chip.lc-gone{color:var(--lc-warn);border-color:var(--lc-warn)}',
    '.lc-menu{position:absolute;right:0;top:calc(100% + 6px);background:var(--lc-bg);border:1px solid var(--lc-line);border-radius:12px;padding:12px;min-width:240px;z-index:60;text-align:left;box-shadow:0 20px 50px -20px rgba(0,0,0,.6)}',
    '.lc-menu p{margin:0 0 10px;color:var(--lc-muted);font-size:13px}',
    '.lc-hidden{display:none!important}'
  ].join('\n');

  var ICON_LOGO = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.5 4 7v10l8 4.5 8-4.5V7l-8-4.5Z" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 12.2 11 14.6l4.6-5.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_DESKTOP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/><circle cx="12" cy="10" r="1.5" fill="currentColor" stroke="none"/></svg>';
  var ICON_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M12 9v6M9 12h6"/></svg>';
  var ICON_PHONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/></svg>';

  function ensureCss() {
    if (document.getElementById('lc-connect-css')) return;
    var s = document.createElement('style');
    s.id = 'lc-connect-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  var qrLoading = null;
  function loadQr() {
    if (window.qrcodegen) return Promise.resolve();
    if (qrLoading) return qrLoading;
    qrLoading = new Promise(function (resolve) {
      var s = document.createElement('script');
      s.src = SELF + 'vendor/qrcodegen.js';
      s.onload = resolve;
      s.onerror = resolve; // no QR: the link itself is still shown
      document.head.appendChild(s);
    });
    return qrLoading;
  }

  function qrSvg(text) {
    if (!window.qrcodegen) return null;
    var qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
    var n = qr.size, border = 1, dim = n + border * 2, path = '';
    for (var y = 0; y < n; y++)
      for (var x = 0; x < n; x++)
        if (qr.getModule(x, y)) path += 'M' + (x + border) + ',' + (y + border) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
      '<rect width="100%" height="100%" fill="#fff"/><path d="' + path + '" fill="#0b1014"/></svg>';
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ''; }); }
  function sameDevice(link) { return link + (link.indexOf('?') >= 0 ? '&' : '?') + 'mobile=true'; }
  function shortId(w) { w = String(w || ''); return w.length < 14 ? w : w.slice(0, 6) + '…' + w.slice(-4); }

  function mount(target, opts) {
    opts = opts || {};
    var root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) throw new Error('LiquidConnect.mount: target not found');
    ensureCss();

    var T = {};
    for (var k in STRINGS) T[k] = (opts.strings && opts.strings[k]) || STRINGS[k];
    if (opts.label) T.button = opts.label;
    if (opts.note) T.note = opts.note;
    var startUrl = opts.start || '/api/connect/start';
    var statusUrl = opts.status || '/api/connect/status';
    // Each transport is a URL (fetched) or a function (called); both
    // resolve to the same JSON shape. A function that throws is the same
    // as an endpoint that could not be reached.
    function callStart() {
      if (typeof startUrl === 'function') return Promise.resolve().then(function () { return startUrl(opts.startBody || {}); });
      return fetch(startUrl, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.startBody || {}) })
        .then(function (r) { return r.json(); });
    }
    function callStatus(rid) {
      if (typeof statusUrl === 'function') return Promise.resolve().then(function () { return statusUrl(rid); });
      return fetch(statusUrl + (statusUrl.indexOf('?') >= 0 ? '&' : '?') + 'request_id=' + encodeURIComponent(rid), { credentials: 'same-origin' })
        .then(function (r) { return r.json(); });
    }
    function callDisconnect() {
      if (typeof opts.disconnect === 'function') return Promise.resolve().then(function () { return opts.disconnect(); });
      return fetch(opts.disconnect, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(opts.disconnectBody || {}) });
    }
    var storageKey = opts.storageKey || 'lc_connect_pending';
    var walletsUrl = opts.walletsUrl || WALLETS_URL;
    var installUrl = opts.installUrl || INSTALL_URL;
    var theme = opts.theme === 'light' ? ' lc-light' : '';

    var pollTimer = null, countTimer = null, nudgeTimer = null, stuckTimer = null;
    var polling = false, currentRid = null, connected = null;
    var current = null; // {rid, link, deadline}

    root.classList.add('lc');
    if (theme) root.classList.add('lc-light');

    var button = el('button', 'lc-btn', ICON_LOGO + '<span>' + esc(T.button) + '</span>');
    button.type = 'button';
    var chip = el('button', 'lc-chip lc-hidden', '<span class="lc-dot"></span><span class="lc-chip-text"></span>');
    chip.type = 'button';
    var menu = el('div', 'lc-menu lc-hidden');
    chip.appendChild(menu);
    if (opts.button !== false) root.appendChild(button);
    if (opts.chip) root.appendChild(chip);

    // ---- the modal ------------------------------------------------------
    // The modal is a real dialog: named by its heading, focus moves into it
    // when it opens, Tab cycles inside it, Escape closes it, and focus
    // returns to whatever opened it when it closes.
    var modal = null, body = null, dialog = null, opener = null;
    var titleId = 'lc-title-' + Math.random().toString(36).slice(2, 8);
    function focusables() {
      if (!dialog) return [];
      var all = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      var out = [];
      for (var i = 0; i < all.length; i++) if (!all[i].disabled && all[i].offsetParent !== null) out.push(all[i]);
      return out;
    }
    function focusFirst() {
      if (!dialog) return;
      var f = focusables();
      // the first choice, not the close button, is where a keyboard user starts
      var target = null;
      for (var i = 0; i < f.length; i++) if (!f[i].classList.contains('lc-x')) { target = f[i]; break; }
      (target || f[0] || dialog).focus();
    }
    function openModal() {
      if (modal) return;
      if (!opener) opener = document.activeElement;
      modal = el('div', 'lc-modal' + theme);
      dialog = el('div', 'lc-dialog');
      dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-labelledby', titleId);
      dialog.tabIndex = -1;
      var head = el('div', 'lc-head', '<h3 id="' + titleId + '">' + esc(T.title) + '</h3>');
      var x = el('button', 'lc-x', '&times;'); x.type = 'button'; x.setAttribute('aria-label', T.cancel);
      x.onclick = cancelFlow;
      head.appendChild(x);
      body = el('div', 'lc-body');
      dialog.appendChild(head); dialog.appendChild(body);
      modal.appendChild(dialog);
      modal.addEventListener('click', function (ev) { if (ev.target === modal) cancelFlow(); });
      document.addEventListener('keydown', modalKeys);
      document.body.appendChild(modal);
    }
    function modalKeys(ev) {
      if (ev.key === 'Escape') { cancelFlow(); return; }
      if (ev.key !== 'Tab' || !dialog) return;
      var f = focusables();
      if (!f.length) { ev.preventDefault(); dialog.focus(); return; }
      var first = f[0], last = f[f.length - 1], cur = document.activeElement;
      var inside = dialog.contains(cur);
      if (ev.shiftKey) {
        if (!inside || cur === first) { ev.preventDefault(); last.focus(); }
      } else if (!inside || cur === last) { ev.preventDefault(); first.focus(); }
    }
    function closeModal() {
      if (!modal) return;
      document.removeEventListener('keydown', modalKeys);
      modal.remove(); modal = null; body = null; dialog = null;
      clearTimers();
      // after the caller has re-enabled its button (a disabled control cannot take focus)
      var back = opener; opener = null;
      setTimeout(function () { if (back && typeof back.focus === 'function' && document.contains(back) && !back.disabled) back.focus(); }, 0);
    }
    function clearTimers() {
      if (countTimer) { clearInterval(countTimer); countTimer = null; }
      if (nudgeTimer) { clearTimeout(nudgeTimer); nudgeTimer = null; }
      if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    }
    function render(html) {
      openModal(); clearTimers(); body.innerHTML = html;
      // after the screen is built by the caller; a tick lets it attach its buttons
      setTimeout(function () { if (dialog) focusFirst(); }, 0);
      return body;
    }

    function footer() {
      return '<div class="lc-foot"><span>•</span><p style="margin:0">' + esc(T.needWallet) + ' <a href="' + esc(installUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(T.getWallet) + '</a> · <a href="' + esc(walletsUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(T.allWallets) + '</a></p></div>';
    }

    // Someone without a wallet is the one person the flow must not
    // strand: the store link and the supported-wallets page, one screen,
    // and Back. Polling keeps running underneath — a person who installs
    // the wallet and returns can still finish this same request.
    function viewNeedWallet() {
      var b = render('<div class="lc-center"><p class="lc-title">' + esc(T.needWallet) + '</p><p class="lc-muted">' + esc(T.needWalletLead) + '</p>' +
        '<div class="lc-row"><a class="lc-btn" href="' + esc(installUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(T.getWallet) + '</a></div>' +
        '<p style="margin:0"><a class="lc-foot-link" style="color:var(--lc-accent);text-decoration:none" href="' + esc(walletsUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(T.allWallets) + ' →</a></p>' +
        '<div class="lc-row"><button type="button" class="lc-ghost lc-back">' + esc(T.back) + '</button></div></div>');
      b.querySelector('.lc-back').onclick = function () { if (current) viewChoose(); else cancelFlow(); };
    }
    function needWalletOption() {
      var n = el('button', 'lc-opt lc-alt', ICON_PLUS + '<span><b>' + esc(T.needWallet) + '</b><small>' + esc(T.needWalletHint) + '</small></span>');
      n.type = 'button';
      n.onclick = function () { viewNeedWallet(); };
      return n;
    }

    function viewStarting() {
      render('<div class="lc-center"><div class="lc-spin"></div><p class="lc-muted">' + esc(T.starting) + '</p></div>');
    }

    function viewChoose() {
      var link = current.link;
      var b = render('<p class="lc-lead">' + esc(T.choose) + '</p><div class="lc-opts"></div>');
      var opts_ = b.querySelector('.lc-opts');
      if (ON_A_PHONE) {
        // Same-device rule: a browser on the phone that holds the wallet
        // opens it directly, and mobile=true makes the wallet hand back.
        var a = el('a', 'lc-opt', ICON_PHONE + '<span><b>' + esc(T.mobile) + '</b><small>' + esc(T.mobileHintPhone) + '</small></span>');
        a.href = sameDevice(link);
        a.onclick = function () { viewWaiting(); };
        opts_.appendChild(a);
      } else {
        var d = el('button', 'lc-opt', ICON_DESKTOP + '<span><b>' + esc(T.desktop) + '</b><small>' + esc(T.desktopHint) + '</small></span>');
        d.type = 'button';
        d.onclick = function () { viewDesktop(); };
        var m = el('button', 'lc-opt', ICON_PHONE + '<span><b>' + esc(T.mobile) + '</b><small>' + esc(T.mobileHintDesktop) + '</small></span>');
        m.type = 'button';
        m.onclick = function () { viewQr(); };
        opts_.appendChild(d); opts_.appendChild(m);
      }
      opts_.appendChild(needWalletOption());
    }

    function viewQr() {
      var link = current.link; // the bare link: a phone scanning it is another device
      var b = render('<div class="lc-center"><p class="lc-muted"><b style="color:var(--lc-text)">' + esc(T.scan) + '</b> ' + esc(T.scanSuffix) + '</p>' +
        '<div class="lc-qr"><div class="lc-qr-in"></div></div><p class="lc-linkline lc-hidden"></p>' +
        '<div class="lc-note"><span>•</span><p style="margin:0">' + esc(T.note) + '</p></div>' +
        '<div class="lc-row"><button type="button" class="lc-ghost lc-back">' + esc(T.back) + '</button></div></div>');
      b.querySelector('.lc-back').onclick = viewChoose;
      loadQr().then(function () {
        if (!body || !body.querySelector('.lc-qr-in')) return;
        var svg = qrSvg(link);
        if (svg) body.querySelector('.lc-qr-in').innerHTML = svg;
        else { var l = body.querySelector('.lc-linkline'); l.classList.remove('lc-hidden'); l.textContent = link; }
      });
    }

    function viewDesktop() {
      var link = current.link;
      var b = render('<div class="lc-center"><div class="lc-spin"></div><p class="lc-muted">' + esc(T.desktopConnecting) + '</p>' +
        '<p class="lc-muted lc-nudge lc-hidden">' + esc(T.desktopNudge) + '</p>' +
        '<div class="lc-row lc-nudge lc-hidden"><a class="lc-ghost lc-primary lc-again" href="' + esc(link) + '">' + esc(T.openAgain) + '</a>' +
        '<button type="button" class="lc-ghost lc-phone">' + esc(T.usePhone) + '</button>' +
        '<button type="button" class="lc-ghost lc-copy">' + esc(T.copy) + '</button>' +
        '<button type="button" class="lc-ghost lc-need">' + esc(T.needWallet) + '</button></div></div>');
      // href, not window.open: an opened blank tab is what the reference
      // implementation found ugly, and a navigation to a custom scheme
      // leaves the page where it is.
      window.location.href = link;
      b.querySelector('.lc-phone').onclick = viewQr;
      b.querySelector('.lc-need').onclick = viewNeedWallet;
      b.querySelector('.lc-copy').onclick = function (ev) {
        var btn = ev.currentTarget;
        if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { btn.textContent = T.copied; setTimeout(function () { btn.textContent = T.copy; }, 1500); });
      };
      // Nudge rather than fail: the wallet may simply be slow to open, or
      // the person may be reading its consent screen. Polling continues.
      nudgeTimer = setTimeout(function () {
        if (!body) return;
        var n = body.querySelectorAll('.lc-nudge');
        for (var i = 0; i < n.length; i++) n[i].classList.remove('lc-hidden');
      }, DESKTOP_NUDGE_MS);
    }

    function viewWaiting() {
      var b = render('<div class="lc-center"><div class="lc-spin"></div><p class="lc-muted">' + esc(T.approve) + '</p><p class="lc-count"></p></div>');
      var c = b.querySelector('.lc-count');
      function tickCount() {
        if (!body || !current) return;
        var s = Math.max(0, Math.floor((current.deadline - Date.now()) / 1000));
        c.textContent = fmt(T.expiresIn, { s: s });
      }
      tickCount();
      countTimer = setInterval(tickCount, 1000);
    }

    function viewFailed(text) {
      var b = render('<div class="lc-center"><p class="lc-err">' + esc(text) + '</p><div class="lc-row"><button type="button" class="lc-ghost lc-primary lc-retry">' + esc(T.retry) + '</button></div></div>' + footer());
      b.querySelector('.lc-retry').onclick = function () { connect(); };
    }

    // ---- flow ------------------------------------------------------------
    function stopPolling() {
      polling = false;
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
      if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
    }
    function clearPending() { try { localStorage.removeItem(storageKey); } catch (e) {} }
    function savePending(p) { try { localStorage.setItem(storageKey, JSON.stringify(p)); } catch (e) {} }
    function readPending() { try { return JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (e) { return null; } }

    function cancelFlow() {
      stopPolling(); clearPending(); current = null; currentRid = null;
      closeModal();
      button.disabled = false;
      if (opts.onCancelled) opts.onCancelled();
    }

    function fail(text) {
      clearPending(); stopPolling();
      button.disabled = false;
      if (opts.onFailed && opts.onFailed(text) === 'handled') { closeModal(); return; }
      viewFailed(text);
    }

    function becomeConnected(s) {
      clearPending(); stopPolling();
      connected = s || {};
      closeModal();
      button.disabled = false;
      button.classList.add('lc-hidden');
      if (opts.chip) setChip(true, connected.wallet || connected.wallet_id || '', false);
      if (opts.onConnected) opts.onConnected(connected);
    }

    function setChip(on, wallet, gone) {
      if (!opts.chip) return;
      chip.classList[on ? 'remove' : 'add']('lc-hidden');
      chip.classList[gone ? 'add' : 'remove']('lc-gone');
      chip.querySelector('.lc-chip-text').textContent = gone ? T.goneChip : fmt(T.connectedChip, { w: shortId(wallet) });
      chip.setAttribute('data-wallet', wallet || '');
    }

    function poll(rid, deadline) {
      if (polling) return;
      polling = true; currentRid = rid;
      if (stuckTimer) clearTimeout(stuckTimer);
      stuckTimer = setTimeout(showStuck, STUCK_MS);
      function step() {
        if (!polling || currentRid !== rid) return;
        if (Date.now() > deadline + GRACE_MS) { fail(T.noAnswer); return; }
        callStatus(rid)
          .then(function (s) {
            if (!polling || currentRid !== rid) return;
            if ((s.connected && s.token) || s.status === 'approved') { becomeConnected(s); return; }
            var st = String(s.status || '').toLowerCase();
            if (st === 'waituser' || st === 'wait_user' || st === 'linked') {
              if (body && !body.querySelector('.lc-count')) viewWaiting();
              pollTimer = setTimeout(step, POLL_MS); return;
            }
            if (st === 'pending' || st === 'unknown' || st === 'waitlink' || (!s.status && !s.error)) { pollTimer = setTimeout(step, POLL_MS); return; }
            var verdict = opts.onStatus ? opts.onStatus(s) : undefined;
            if (verdict === 'stop') { stopPolling(); clearPending(); closeModal(); button.disabled = false; return; }
            if (verdict === 'continue') { pollTimer = setTimeout(step, POLL_MS); return; }
            fail(s.error ? ('Login failed: ' + s.error) : ('Login ' + s.status + ' — try again.'));
          })
          .catch(function () { pollTimer = setTimeout(step, POLL_MS); });
      }
      pollTimer = setTimeout(step, POLL_MS);
    }

    // Still pending well past the time a wallet needs to pick a link up.
    // Say so in place (whatever screen is showing), name the network this
    // site is on — a wallet on the other network is the commonest reason,
    // and it cannot reach our server to say so itself unless it is new
    // enough to decline over HTTP — and offer a way out. Polling continues:
    // a slow approval still lands.
    function showStuck() {
      stuckTimer = null;
      if (!body || !polling || body.querySelector('.lc-stuck')) return;
      var net = current && current.network ? networkName(current.network) : '';
      var s = el('div', 'lc-stuck lc-center', '<p class="lc-muted">' + esc(T.stuck) + (net ? ' ' + esc(fmt(T.stuckNetwork, { n: net })) : '') + '</p>' +
        '<div class="lc-row"><button type="button" class="lc-ghost lc-cancel">' + esc(T.cancel) + '</button></div>');
      body.appendChild(s);
      s.querySelector('.lc-cancel').onclick = cancelWait;
    }
    function cancelWait() { clearPending(); stopPolling(); closeModal(); button.disabled = false; }
    function networkName(n) {
      n = String(n || '').toLowerCase();
      if (n === 'liquid' || n === 'mainnet') return 'Liquid mainnet';
      if (n === 'liquid-testnet' || n === 'testnet') return 'Liquid testnet';
      if (n === 'liquid-regtest' || n === 'regtest') return 'Liquid regtest';
      return n;
    }

    function connect() {
      if (polling) { openModal(); return; }
      // remember who opened us before disabling the button drops focus to body
      opener = document.activeElement;
      button.disabled = true;
      viewStarting();
      callStart()
        .then(function (j) {
          if (!j || j.error || !j.request_id || !j.deep_link) { fail((j && j.error) ? j.error : T.failedStart); return; }
          var deadline = Number(j.expires_at) || (Date.now() + 120000);
          if (deadline < 1e12) deadline = deadline * 1000; // seconds → ms
          current = { rid: j.request_id, link: j.deep_link, deadline: deadline, network: j.network || '' };
          savePending({ rid: j.request_id, link: j.deep_link, deadline: deadline, network: j.network || '', t: Date.now() });
          viewChoose();
          poll(j.request_id, deadline);
        })
        .catch(function () { fail(T.unreachable); });
    }

    function resume() {
      if (connected || polling) return;
      var p = readPending();
      if (!p || !p.rid || Date.now() - (p.t || 0) > RESUME_MAX_MS) { clearPending(); return; }
      current = { rid: p.rid, link: p.link || '', deadline: p.deadline || Date.now(), network: p.network || '' };
      viewWaiting();
      poll(p.rid, current.deadline);
    }

    function disconnect() {
      function done() {
        connected = null; clearPending();
        setChip(false, '', false);
        menu.classList.add('lc-hidden');
        if (opts.button !== false) button.classList.remove('lc-hidden');
        if (opts.onDisconnected) opts.onDisconnected();
      }
      if (opts.disconnect) {
        callDisconnect().then(done, done);
      } else done();
    }

    button.onclick = function () { connect(); };
    chip.onclick = function (ev) {
      ev.stopPropagation();
      if (!menu.classList.contains('lc-hidden')) { menu.classList.add('lc-hidden'); return; }
      var w = chip.getAttribute('data-wallet') || '';
      var gone = chip.classList.contains('lc-gone');
      menu.innerHTML = '<p>' + esc(gone ? T.goneMenu : fmt(T.connectedMenu, { w: shortId(w) })) + '</p>';
      var b = el('button', 'lc-ghost' + (gone ? ' lc-primary' : ''), esc(gone ? T.reconnect : T.disconnect)); b.type = 'button';
      b.onclick = function (e) { e.stopPropagation(); menu.classList.add('lc-hidden'); if (gone) connect(); else disconnect(); };
      menu.appendChild(b);
      menu.classList.remove('lc-hidden');
    };
    document.addEventListener('click', function () { menu.classList.add('lc-hidden'); });

    window.addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) resume(); });
    if (opts.resume !== false) resume();

    return {
      connect: connect,
      cancel: cancelFlow,
      resume: resume,
      disconnect: disconnect,
      /** The page already holds a connection (after a reload). */
      setConnected: function (info) { connected = info || {}; button.classList.add('lc-hidden'); closeModal(); setChip(true, connected.wallet || '', false); },
      /** The wallet's Liquid Connect session went away (false) or came back (true). */
      setLive: function (live) { if (!connected) return; setChip(true, connected.wallet || '', !live); },
      setDisconnected: function () { connected = null; setChip(false, '', false); if (opts.button !== false) button.classList.remove('lc-hidden'); },
      /** Open the "Need a wallet?" screen directly, e.g. from your own link. */
      needWallet: function () { viewNeedWallet(); },
      walletsUrl: walletsUrl,
      isPhone: ON_A_PHONE,
      version: '0.3.2'
    };
  }

  window.LiquidConnect = { mount: mount, version: '0.3.0', walletsUrl: WALLETS_URL };
})();

// Locale following — the project side of the App's locale bridge
// (network reference "Locale Following", App ≥ v1.3.0).
//
// PNDS App pushes its current UI language into the monitor iframe
// over cross-origin postMessage:
//
//   { type: 'pnds:locale', version: 1, locale: 'en' | 'zh-CN' }
//
// Delivery is best-effort, latest-value-wins: the App re-pushes on
// iframe load, language switches and window focus regain — the same
// machinery as the theme bridge (lib/theme-follow.js). Applying a
// message must be idempotent: the locale is simply held as the page's
// current language and every subscriber re-renders through it. Unknown
// or malformed messages are ignored silently; the page never errors.
//
// This is a copy-style reference implementation, meant to be copied
// between PNDS projects (no shared package: performances run offline
// and the App never installs dependencies). UMD-shaped like the
// template family's shared.js: a browser global (window.PNDS_LOCALE)
// that self-wires on load, and a Node module for tests. It lives in
// lib/ (reusable core) and is served to the browser by the score
// server at GET /__pnds/locale-follow.js — the App-contract namespace
// it shares with /__pnds/theme-follow.js. Load it in the monitor page
// only; performer-facing pages never load it.
//
//   <script src='/__pnds/locale-follow.js'></script>
//
// The page holds its locale until a message changes it:
//
//   PNDS_LOCALE.current()            // 'en' | 'zh-CN'
//   PNDS_LOCALE.subscribe(fn)        // fn(locale) on every switch

(function (root, factory) {
  const api = factory()

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
    return
  }

  root.PNDS_LOCALE = api

  // Self-wiring (monitor page): the current locale starts at the page
  // default (this project's historical Chinese UI), optionally seeded
  // by ?lang=<code> for the first frame, then follows every locale
  // message. One listener, state applied idempotently — re-delivery
  // lands on the same value and notifies nobody.
  let current = api.DEFAULT_LOCALE
  const listeners = []

  api.current = () => current

  api.subscribe = (listener) => {
    listeners.push(listener)
    return () => {
      listeners.splice(listeners.indexOf(listener), 1)
    }
  }

  const apply = (locale) => {
    if (locale === current) {
      return
    }

    current = locale
    root.document.documentElement.lang = locale

    for (const listener of [...listeners]) {
      listener(locale)
    }
  }

  const initial = api.initialLocale(root.location.search)
  if (initial) {
    apply(initial)
  }

  root.addEventListener('message', (event) => {
    const locale = api.localeFromMessage(event.data)
    if (locale) {
      apply(locale)
    }
  })
})(typeof self !== 'undefined' ? self : this, () => {
  // The message protocol (network reference "Locale Following").
  const MESSAGE_TYPE = 'pnds:locale'
  const MESSAGE_VERSION = 1

  // The languages this page ships copy tables for (public/shared.js).
  // Anything else — on the wire or in ?lang= — is ignored, so an App
  // language the page has no table for keeps the default UI.
  const SUPPORTED_LOCALES = ['en', 'zh-CN']

  // The page's own language before any bridge traffic — this project's
  // historical Chinese UI. A standalone browser session, or an App
  // that never sends the bridge, leaves the page exactly as it always
  // was.
  const DEFAULT_LOCALE = 'zh-CN'

  // The locale of a locale message, or null for anything the page must
  // ignore (unknown type, unknown version, malformed shape, codes the
  // page has no copy table for). Codes compare exactly — the App sends
  // canonical BCP 47 ('zh-CN', not 'zh-cn').
  function localeFromMessage(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    if (data.type !== MESSAGE_TYPE || data.version !== MESSAGE_VERSION) {
      return null
    }
    if (typeof data.locale !== 'string') {
      return null
    }

    return SUPPORTED_LOCALES.includes(data.locale) ? data.locale : null
  }

  // ?lang=<code> first-frame initial locale; null keeps the default.
  function initialLocale(search) {
    const match = /[?&]lang=([A-Za-z-]+)/.exec(search || '')
    return match && SUPPORTED_LOCALES.includes(match[1]) ? match[1] : null
  }

  return {
    localeFromMessage,
    initialLocale,
    SUPPORTED_LOCALES,
    DEFAULT_LOCALE,
  }
})

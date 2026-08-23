// Theme following — the project side of the App's theme bridge
// (score project spec §5.3).
//
// PNDS App ≥ v1.2.3 pushes its current theme into the monitor iframe
// over cross-origin postMessage:
//
//   { type: 'pnds:theme', version: 1, theme: '<name>', palette: { … } }
//
// Delivery is best-effort, latest-value-wins: the App re-pushes on
// iframe load, theme switches and window focus regain, so applying a
// message must be idempotent — values are simply written into the
// page's own CSS variables. Unknown or malformed messages are ignored
// silently; the page never errors.
//
// This is the reference implementation of that contract, meant to be
// copied between PNDS projects (no shared package: performances run
// offline and the App never installs dependencies). UMD-shaped like
// the template family's shared.js: a browser global
// (window.PNDS_THEME) that self-wires on load, and a Node module for
// tests. It lives in lib/ (reusable core) and is served to the browser
// by the score server at GET /__pnds/theme-follow.js — the App-contract
// namespace it shares with /__pnds/health. Load it in the monitor page
// only; performer-facing pages never load it.
//
//   <script src='/__pnds/theme-follow.js'></script>
//
// Zero-config: the default palette→variable mapping below recolors the
// page. Advanced pages set window.PNDS_THEME_OPTIONS *before* the
// script tag:
//
//   {
//     variables: { bg: '--surface', … },  // merged over the defaults
//     derive: (palette) => ({ … }),       // extra CSS variables per palette
//                                         // (statusVariables below is one)
//     onTheme: (name, palette) => { … },  // whole-design forks (p5 etc.)
//     applyVariables: false,              // skip CSS writes, onTheme only
//   }

(function (root, factory) {
  const api = factory()

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
    return
  }

  root.PNDS_THEME = api

  // Self-wiring (monitor page): paint the first frame from ?theme=<name>
  // when present, then follow every theme message. One listener, values
  // applied idempotently — re-delivery lands on the same state.
  const options = root.PNDS_THEME_OPTIONS || {}
  const applyVariables = options.applyVariables !== false

  const deliver = (name, palette) => {
    if (applyVariables) {
      const variables = api.variablesFromPalette(palette, options)
      for (const key of Object.keys(variables)) {
        root.document.documentElement.style.setProperty(key, variables[key])
      }
    }
    if (typeof options.onTheme === 'function') {
      options.onTheme(name, palette)
    }
  }

  const initialName = api.initialTheme(root.location.search)
  if (initialName) {
    deliver(initialName, api.THEME_PALETTES[initialName])
  }

  root.addEventListener('message', (event) => {
    const received = api.themeFromMessage(event.data)
    if (received) {
      deliver(received.theme, received.palette)
    }
  })
})(typeof self !== 'undefined' ? self : this, () => {
  // The message protocol (spec §5.3).
  const MESSAGE_TYPE = 'pnds:theme'
  const MESSAGE_VERSION = 1

  // App palette keys (kebab-case semantic tokens) → the CSS variables
  // they drive by default. pill (the recessed fill) → --accent-soft for
  // active-tile fills; sidebar-bg (the panel surface) → --track for
  // borders, empty dots and dividers. Palette keys with no default page
  // counterpart (the *-hover / *-foreground fills, warning) are not
  // consumed — pages painting status as text want statusVariables()
  // instead of the App's fill tokens.
  const DEFAULT_VARIABLES = {
    bg: '--bg',
    'sidebar-bg': '--track',
    card: '--card',
    pill: '--accent-soft',
    text: '--text',
    'text-secondary': '--muted',
    accent: '--accent',
    danger: '--danger',
  }

  // Status colors have no App counterpart: the App's warning/danger
  // tokens are FILL colors paired with their own label tokens, while
  // consuming pages paint status as text directly on cards. One
  // light-tuned and one dark-tuned set, each ≥4.5:1 on its theme's card
  // surface (asserted by test/theme-follow.test.js).
  const STATUS_LIGHT = { green: '#15803d', yellow: '#b45309', gray: '#6b7186' }
  const STATUS_DARK = { green: '#86efac', yellow: '#fcd34d', gray: '#d8d3c4' }

  // WCAG relative luminance of a #rrggbb value; null when unparseable
  // (future themes may ship colors in other notations — those fall back
  // to the light status set, matching the pages' default look).
  function relativeLuminance(hex) {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) {
      return null
    }

    const COEFFICIENTS = [0.2126, 0.7152, 0.0722]
    let total = 0

    for (let channel = 0; channel < 3; channel += 1) {
      const value = parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16) / 255
      const linear = value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      total += COEFFICIENTS[channel] * linear
    }

    return total
  }

  // The light/dark fork for the derived status set. Sand (#5c5344 ≈ 0.09)
  // and Stage (#16181f ≈ 0.01) cards fall below the threshold; Lavender
  // and Brutal cards are white.
  function hasDarkCard(palette) {
    const luminance = relativeLuminance(palette.card)
    return luminance !== null && luminance < 0.2
  }

  // The theme carried by a message, or null for anything the page must
  // ignore (unknown type, unknown version, malformed shape).
  function themeFromMessage(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return null
    }
    if (data.type !== MESSAGE_TYPE || data.version !== MESSAGE_VERSION) {
      return null
    }
    if (data.palette === null || typeof data.palette !== 'object' || Array.isArray(data.palette)) {
      return null
    }

    return {
      theme: typeof data.theme === 'string' ? data.theme : '',
      palette: data.palette,
    }
  }

  // The CSS variables for one palette. A pure function of its input —
  // applying it any number of times leaves the same values in place.
  function variablesFromPalette(palette, options) {
    const mapping = Object.assign({}, DEFAULT_VARIABLES, (options && options.variables) || {})
    const variables = {}

    for (const key of Object.keys(mapping)) {
      const value = palette[key]
      if (typeof value === 'string' && value !== '') {
        variables[mapping[key]] = value
      }
    }

    if (options && typeof options.derive === 'function') {
      Object.assign(variables, options.derive(palette))
    }

    return variables
  }

  function variablesFromMessage(data, options) {
    const received = themeFromMessage(data)
    return received ? variablesFromPalette(received.palette, options) : null
  }

  // Status colors as ready-made CSS variables for pages that paint
  // Green/Yellow/Gray status as text on cards. Red is the exception —
  // the App guarantees its danger token already reads ≥4.5:1 as text on
  // the card, so it maps directly (and only when present).
  function statusVariables(palette) {
    const status = hasDarkCard(palette) ? STATUS_DARK : STATUS_LIGHT
    const variables = {
      '--green': status.green,
      '--yellow': status.yellow,
      '--gray': status.gray,
    }

    if (typeof palette.danger === 'string' && palette.danger !== '') {
      variables['--red'] = palette.danger
    }

    return variables
  }

  // ?theme=<name> first-frame initial values (spec §5.3 — the App does
  // not send the parameter yet; its absence keeps the page's own
  // colors). Values copied from the App's theme set
  // (theme-variables.css); when the App's message arrives it
  // overwrites them verbatim.
  const THEME_PALETTES = {
    lavender: {
      bg: '#eef0f8',
      'sidebar-bg': '#e2e5f3',
      card: '#ffffff',
      pill: '#e8ebf7',
      accent: '#5a4ff3',
      'accent-hover': '#4a3fe0',
      'accent-foreground': '#ffffff',
      text: '#171a2b',
      'text-secondary': '#5d6484',
      danger: '#e11d48',
      'danger-hover': '#c2143c',
      'danger-foreground': '#ffffff',
      warning: '#ffb020',
      'warning-hover': '#f0a20c',
      'warning-foreground': '#171a2b',
    },
    sand: {
      bg: '#474036',
      'sidebar-bg': '#4e463b',
      card: '#5c5344',
      pill: '#544a3e',
      accent: '#d97706',
      'accent-hover': '#e8871a',
      'accent-foreground': '#241d12',
      text: '#fff8ec',
      'text-secondary': '#e5dcca',
      danger: '#ffbcc0',
      'danger-hover': '#ffada1',
      'danger-foreground': '#2b1210',
      warning: '#ffc46b',
      'warning-hover': '#f5b455',
      'warning-foreground': '#241d12',
    },
    stage: {
      bg: '#0b0c10',
      'sidebar-bg': '#101218',
      card: '#16181f',
      pill: '#12151d',
      accent: '#34d399',
      'accent-hover': '#10b981',
      'accent-foreground': '#06281a',
      text: '#eceef5',
      'text-secondary': '#99a1b5',
      danger: '#f43f5e',
      'danger-hover': '#fb7185',
      'danger-foreground': '#2b0a12',
      warning: '#fcd34d',
      'warning-hover': '#fde68a',
      'warning-foreground': '#241c06',
    },
    brutal: {
      bg: '#fff1c9',
      'sidebar-bg': '#ffc107',
      card: '#ffffff',
      pill: '#ffe58f',
      accent: '#ff5722',
      'accent-hover': '#e64a19',
      'accent-foreground': '#000000',
      text: '#000000',
      'text-secondary': '#4a4028',
      danger: '#c2103c',
      'danger-hover': '#a80d33',
      'danger-foreground': '#ffffff',
      warning: '#ffb020',
      'warning-hover': '#f0a20c',
      'warning-foreground': '#000000',
    },
  }

  function initialTheme(search) {
    const match = /[?&]theme=([a-z0-9-]+)/i.exec(search || '')
    // Theme names are lowercase; tolerate any casing a future sender
    // might carry.
    const name = match && match[1].toLowerCase()
    return name && THEME_PALETTES[name] ? name : null
  }

  function initialVariables(search, options) {
    const name = initialTheme(search)
    return name ? variablesFromPalette(THEME_PALETTES[name], options) : null
  }

  return {
    THEME_PALETTES,
    DEFAULT_VARIABLES,
    themeFromMessage,
    variablesFromMessage,
    variablesFromPalette,
    statusVariables,
    initialTheme,
    initialVariables,
  }
})

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
// tests. The original lives in lib/; this release lives in modules/ (reusable core) and is served to the browser
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

  if (root.PNDS_THEME && typeof root.PNDS_THEME.dispose === 'function') {
    root.PNDS_THEME.dispose()
  }
  root.PNDS_THEME = Object.assign({}, api)
  root.PNDS_THEME.dispose = api.attach(root, root.PNDS_THEME_OPTIONS || {})
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

    if (!Object.keys(data.palette).length || Object.values(data.palette).some(value => typeof value !== 'string' || !value.trim())) {
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
  // Utility status ink must read on the actual card, selected fill and page
  // surfaces. New light Sand needs slightly stronger ink than the old set.
  function readableStatus(ink, palette) {
    const inkL = relativeLuminance(ink), textL = relativeLuminance(palette.text)
    const surfaces = [palette.card, palette.pill, palette.bg].map(relativeLuminance).filter(value => value !== null)
    if (inkL === null || textL === null || !surfaces.length) return ink
    for (let step = 0; step <= 20; step++) {
      const t = step / 20
      const mixed = '#' + [0, 1, 2].map(index => Math.round(parseInt(ink.slice(1 + index * 2, 3 + index * 2), 16) * (1 - t) + parseInt(palette.text.slice(1 + index * 2, 3 + index * 2), 16) * t).toString(16).padStart(2, '0')).join('')
      const luminance = relativeLuminance(mixed)
      if (surfaces.every(surface => (Math.max(luminance, surface) + .05) / (Math.min(luminance, surface) + .05) >= 4.5)) return mixed
    }
    return palette.text
  }

  function statusVariables(palette) {
    const status = hasDarkCard(palette) ? STATUS_DARK : STATUS_LIGHT
    const variables = {
      '--green': readableStatus(status.green, palette),
      '--yellow': readableStatus(status.yellow, palette),
      '--gray': readableStatus(palette['text-secondary'] || status.gray, palette),
    }

    if (typeof palette.danger === 'string' && palette.danger !== '') {
      variables['--red'] = readableStatus(palette.danger, palette)
    }

    return variables
  }

  // ?theme=<name> first-frame initial values (spec §5.3 — the App does
  // not send the parameter yet; its absence keeps the page's own
  // colors). Values copied from the App's theme set
  // (theme-variables.css); when the App's message arrives it
  // overwrites them verbatim. The default theme's key is `pond` — the
  // App renamed the id from `lavender` (v1.3.3 #91); the legacy key
  // stays as an alias below so pages follow Apps of either vintage.
  const THEME_PALETTES = {
  "pond": {
    "bg": "#f1f5f8",
    "sidebar-bg": "#d2d8de",
    "card": "#fcfdff",
    "pill": "#e6edf3",
    "accent": "#1476cc",
    "accent-hover": "#1065b5",
    "accent-foreground": "#ffffff",
    "text": "#293541",
    "text-secondary": "#495b68",
    "danger": "#9d3043",
    "danger-hover": "#962e3f",
    "danger-foreground": "#ffffff",
    "warning": "#ebd098",
    "warning-hover": "#dfbf80",
    "warning-foreground": "#4c3818"
  },
  "sand": {
    "bg": "#e6ddcd",
    "sidebar-bg": "#d8cfbf",
    "card": "#f1eadf",
    "pill": "#e5daca",
    "accent": "#93622e",
    "accent-hover": "#7e5124",
    "accent-foreground": "#ffffff",
    "text": "#352e24",
    "text-secondary": "#60523f",
    "danger": "#93332b",
    "danger-hover": "#852c24",
    "danger-foreground": "#ffffff",
    "warning": "#e7c181",
    "warning-hover": "#dbb26d",
    "warning-foreground": "#4c3517"
  },
  "stage": {
    "bg": "#171b1c",
    "sidebar-bg": "#1c2222",
    "card": "#232a29",
    "pill": "#2c3432",
    "accent": "#a5c8b6",
    "accent-hover": "#b7d8c6",
    "accent-foreground": "#15231b",
    "text": "#e7ece9",
    "text-secondary": "#adbbb4",
    "danger": "#f4a3ac",
    "danger-hover": "#f5b0b7",
    "danger-foreground": "#31141a",
    "warning": "#dfbd7d",
    "warning-hover": "#ebcc93",
    "warning-foreground": "#2c2211"
  },
  "brutal": {
    "bg": "#ebb847",
    "sidebar-bg": "#ffc107",
    "card": "#ffffff",
    "pill": "#ffe58f",
    "accent": "#ff5722",
    "accent-hover": "#e64a19",
    "accent-foreground": "#000000",
    "text": "#000000",
    "text-secondary": "#4a4028",
    "danger": "#8e1530",
    "danger-hover": "#790f28",
    "danger-foreground": "#ffffff",
    "warning": "#ffb020",
    "warning-hover": "#f0a20c",
    "warning-foreground": "#000000"
  }
}
  // #91: the pre-rename id stays resolvable — an App of the older
  // vintage still pushes `lavender` and pages must keep following.
  THEME_PALETTES.lavender = THEME_PALETTES.pond

  function initialTheme(search) {
    const match = /[?&]theme=([a-z0-9-]+)(?=&|$)/i.exec(search || '')
    // Theme names are lowercase; tolerate any casing a future sender
    // might carry.
    const name = match && match[1].toLowerCase()
    return name && THEME_PALETTES[name] ? name : null
  }

  function initialVariables(search, options) {
    const name = initialTheme(search)
    return name ? variablesFromPalette(THEME_PALETTES[name], options) : null
  }

  // Returns an idempotent disposer; callbacks receive each changed value once.
  function attach(root, options = {}) {
    let last = null
    const deliver = (name, palette) => {
      const key = JSON.stringify([name, Object.keys(palette).sort().map(key => [key, palette[key]])])
      if (key === last) return
      last = key
      if (options.applyVariables !== false) {
        const variables = variablesFromPalette(palette, options)
        for (const key of Object.keys(variables)) {
          root.document.documentElement.style.setProperty(key, variables[key])
        }
      }
      if (typeof options.onTheme === 'function') options.onTheme(name, palette)
    }
    const receive = (event) => {
      const received = themeFromMessage(event && event.data)
      if (received) deliver(received.theme, received.palette)
    }
    const initial = initialTheme(root.location.search)
    if (initial) deliver(initial, THEME_PALETTES[initial])
    root.addEventListener('message', receive)
    return () => root.removeEventListener('message', receive)
  }

  return {
    attach,
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

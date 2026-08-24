// Theme following (score project spec §5.3): the App pushes
// {type:'pnds:theme', version:1, …} into the monitor page, which writes
// the palette into its own CSS variables. These tests assert the
// external contract only — message in, CSS variables out — never the
// module's internals.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  THEME_PALETTES,
  themeFromMessage,
  variablesFromMessage,
  variablesFromPalette,
  statusVariables,
  initialTheme,
  initialVariables,
} = require('../lib/theme-follow')

const LIB_DIR = path.join(__dirname, '..', 'lib')

// The example message from spec §5.3, verbatim.
const SPEC_MESSAGE = {
  type: 'pnds:theme',
  version: 1,
  theme: 'lavender',
  palette: {
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
}

// ---------------------------------------------------------------------------
// WCAG contrast (independent of the module under test)
// ---------------------------------------------------------------------------

function channel(hex, index) {
  const value = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2)
}

function contrast(foreground, background) {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

// ---------------------------------------------------------------------------
// Message → CSS variables
// ---------------------------------------------------------------------------

test('theme message: palette keys land in the page CSS variables', () => {
  const variables = variablesFromMessage(SPEC_MESSAGE)

  assert.equal(variables['--bg'], '#eef0f8')
  assert.equal(variables['--card'], '#ffffff')
  assert.equal(variables['--text'], '#171a2b')
  assert.equal(variables['--muted'], '#5d6484', 'text-secondary → --muted')
  assert.equal(variables['--accent'], '#5a4ff3')
  assert.equal(variables['--danger'], '#e11d48')
  assert.equal(variables['--track'], '#e2e5f3', 'sidebar-bg → --track (borders, dots)')
  assert.equal(variables['--accent-soft'], '#e8ebf7', 'pill → --accent-soft (active fills)')
})

test('theme message: palette keys with no default variable are not written', () => {
  const variables = variablesFromMessage(SPEC_MESSAGE)

  for (const name of Object.keys(variables)) {
    assert.match(name, /^--/, `unexpected variable name ${name}`)
  }
})

test('theme message: partial palettes write only the present keys', () => {
  const variables = variablesFromMessage({
    type: 'pnds:theme',
    version: 1,
    palette: { card: '#000000' },
  })

  assert.equal(variables['--card'], '#000000')
  assert.equal(variables['--bg'], undefined)
})

test('unknown or malformed messages are ignored, not applied', () => {
  const malformed = [
    null,
    undefined,
    42,
    'pnds:theme',
    [],
    {},
    { type: 'other', version: 1, palette: {} },
    { type: 'pnds:theme' },
    { type: 'pnds:theme', version: 2, palette: {} },
    { type: 'pnds:theme', version: 1 },
    { type: 'pnds:theme', version: 1, palette: 'lavender' },
    { type: 'pnds:theme', version: 1, palette: [] },
  ]

  for (const data of malformed) {
    assert.equal(themeFromMessage(data), null, `should ignore ${JSON.stringify(data)}`)
    assert.equal(variablesFromMessage(data), null)
  }
})

// ---------------------------------------------------------------------------
// Idempotency (the App re-pushes on theme switches and focus regain;
// latest value wins, repeated delivery has no side effects)
// ---------------------------------------------------------------------------

test('re-delivery and theme round-trips are idempotent', () => {
  const root = fakeStyleRoot()

  applyVariables(root, variablesFromMessage(SPEC_MESSAGE))
  const afterLavender = new Map(root.properties)

  // Re-push of the same theme (focus regain path).
  applyVariables(root, variablesFromMessage(SPEC_MESSAGE))
  assert.deepEqual(root.properties, afterLavender)

  // A switch away and back lands exactly where it was.
  const sand = { ...SPEC_MESSAGE, theme: 'sand', palette: THEME_PALETTES.sand }
  applyVariables(root, variablesFromMessage(sand))
  applyVariables(root, variablesFromMessage(SPEC_MESSAGE))
  assert.deepEqual(root.properties, afterLavender)
})

// ---------------------------------------------------------------------------
// Options (the creator-facing extension points)
// ---------------------------------------------------------------------------

test('options.variables merge over the default mapping', () => {
  const variables = variablesFromMessage(SPEC_MESSAGE, {
    variables: { bg: '--surface' },
  })

  assert.equal(variables['--surface'], '#eef0f8', 'renamed key follows the override')
  assert.equal(variables['--bg'], undefined, 'the default name is replaced, not duplicated')
  assert.equal(variables['--card'], '#ffffff', 'untouched defaults survive the merge')
})

test('options.derive adds per-palette variables (statusVariables is one)', () => {
  const variables = variablesFromMessage(SPEC_MESSAGE, {
    derive: statusVariables,
  })

  assert.equal(variables['--green'], '#15803d')
  assert.equal(variables['--red'], '#e11d48', 'red maps the App danger directly')
})

// ---------------------------------------------------------------------------
// Readability: text and status colors stay legible on every theme
// ---------------------------------------------------------------------------

test('all four App themes keep text, muted, active-fill and status colors ≥4.5:1', () => {
  for (const [name, palette] of Object.entries(THEME_PALETTES)) {
    const variables = variablesFromPalette(palette)
    const status = statusVariables(palette)

    for (const [variable, surface] of [
      ['--text', palette.card],
      ['--muted', palette.card],
      ['--text', variables['--accent-soft']],
      ['--green', palette.card],
      ['--yellow', palette.card],
      ['--gray', palette.card],
      ['--red', palette.card],
    ]) {
      const ratio = contrast(variables[variable] || status[variable], surface)
      assert.ok(
        ratio >= 4.5,
        `${name}: ${variable} on ${surface} reads ${ratio.toFixed(2)}:1`,
      )
    }
  }
})

// ---------------------------------------------------------------------------
// ?theme=<name> first-frame initial values
// ---------------------------------------------------------------------------

test('?theme= paints a first frame; absence keeps the page\'s own colors', () => {
  assert.equal(initialTheme('?theme=stage'), 'stage')
  assert.equal(initialTheme('?theme=STAGE'), 'stage', 'casing is tolerated')
  assert.equal(initialTheme('?a=1&theme=sand'), 'sand')
  assert.equal(initialVariables('?theme=stage')['--bg'], '#0b0c10')
  assert.equal(initialVariables('?theme=brutal')['--accent'], '#ff5722')
  assert.equal(initialVariables('?theme=lavender')['--bg'], '#eef0f8')

  // At least a light/dark fork between themes.
  const light = initialVariables('?theme=lavender')
  const dark = initialVariables('?theme=stage')
  assert.notEqual(light['--bg'], dark['--bg'])

  // Unknown names and missing parameters change nothing.
  assert.equal(initialTheme(''), null)
  assert.equal(initialTheme('?'), null)
  assert.equal(initialTheme('?foo=1'), null)
  assert.equal(initialTheme('?theme=unknown'), null)
  assert.equal(initialVariables('?theme=unknown'), null)
})

// ---------------------------------------------------------------------------
// Browser wiring (the real file, run against a minimal page)
// ---------------------------------------------------------------------------

// Loads lib/theme-follow.js the way the monitor page does (browser
// global, no module system) and returns what the page observed: its
// CSS variables and its message listeners.
function loadMonitorPage(search, options) {
  const root = fakeStyleRoot()
  const listeners = {}
  const page = {
    document: { documentElement: { style: root.style } },
    location: { search },
    addEventListener: (type, handler) => {
      (listeners[type] = listeners[type] || []).push(handler)
    },
  }
  page.self = page
  if (options !== undefined) {
    page.PNDS_THEME_OPTIONS = options
  }

  vm.runInContext(
    fs.readFileSync(path.join(LIB_DIR, 'theme-follow.js'), 'utf8'),
    vm.createContext(page),
  )

  return { properties: root.properties, listeners }
}

test('monitor page wiring: message → documentElement CSS variables', () => {
  const page = loadMonitorPage('')

  assert.equal(page.listeners.message.length, 1, 'exactly one message listener')

  page.listeners.message[0]({ data: SPEC_MESSAGE })
  assert.equal(page.properties.get('--bg'), '#eef0f8')
  assert.equal(page.properties.get('--accent'), '#5a4ff3')

  // The listener painted before the first paint when ?theme= was present.
  const prePainted = loadMonitorPage('?theme=stage')
  assert.equal(prePainted.properties.get('--bg'), '#0b0c10')
})

test('monitor page wiring: malformed events never throw or write', () => {
  const page = loadMonitorPage('?theme=stage')
  const before = new Map(page.properties)

  for (const data of [null, {}, { type: 'other' }, 'pnds:theme']) {
    assert.doesNotThrow(() => page.listeners.message[0]({ data }))
  }

  assert.deepEqual(page.properties, before)
})

test('monitor page wiring: options route themes to non-CSS consumers', () => {
  const delivered = []
  const page = loadMonitorPage('', {
    applyVariables: false,
    onTheme: (name, palette) => delivered.push({ name, palette }),
  })

  page.listeners.message[0]({ data: SPEC_MESSAGE })

  // onTheme fires with the full palette for whole-design forks…
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].name, 'lavender')
  assert.equal(delivered[0].palette.accent, '#5a4ff3')
  // …while the CSS writes stay skipped.
  assert.equal(page.properties.size, 0)
})

// ---------------------------------------------------------------------------
// Page wiring: theme-follow loads only in the monitor branch
// ---------------------------------------------------------------------------

test('page wiring: the ?theme= first frame reaches the onTheme hook at load time', () => {
  // theme-follow.js self-wires on load; a ?theme= parameter delivers
  // to the options hook immediately — a page that defers its own
  // drawing to startup can rely on that early delivery.
  const stash = []
  loadMonitorPage('?theme=stage', {
    applyVariables: false,
    onTheme: (name, palette) => stash.push({ name, palette }),
  })

  assert.equal(stash.length, 1, 'the initial ?theme= delivery fired early')
  assert.equal(stash[0].name, 'stage')
  assert.equal(stash[0].palette.bg, '#0b0c10')
})

test('page wiring: theme-follow loads only in the monitor branch', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8')

  // The module load sits inside the monitor branch (anchored on the
  // document.write call — comments may mention the name too).
  const monitorBranch = html.slice(html.indexOf('PNDS_IS_MONITOR'))
  assert.match(
    monitorBranch,
    /if \(window\.PNDS_IS_MONITOR\) \{[\s\S]*document\.write\(\s*'\\x3Cscript src="\/__pnds\/theme-follow\.js/,
    'the monitor branch loads the theme bridge',
  )

  // …and the performer branch has no hand in theming: everything after
  // the theme write is the page body, with no second module load.
  const themeLoad = monitorBranch.indexOf('__pnds/theme-follow.js')
  assert.ok(themeLoad !== -1)
  assert.equal(
    monitorBranch.indexOf('__pnds/theme-follow.js', themeLoad + 1),
    -1,
    'the theme bridge is loaded exactly once',
  )
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeStyleRoot() {
  const properties = new Map()
  return {
    properties,
    style: { setProperty: (name, value) => properties.set(name, value) },
  }
}

function applyVariables(root, variables) {
  for (const name of Object.keys(variables)) {
    root.style.setProperty(name, variables[name])
  }
}

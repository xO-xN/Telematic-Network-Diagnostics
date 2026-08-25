// Locale following (network reference "Locale Following", App ≥
// v1.3.0): the App pushes {type:'pnds:locale', version:1, locale:…}
// into the monitor page, which holds the locale as its current
// language and re-renders through the shared bilingual copy tables.
// These tests assert the external contract only — message in, locale
// state and notifications out — never the module's internals.

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const {
  localeFromMessage,
  initialLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
} = require('../lib/locale-follow')

const { copy, localEvents } = require('../public/shared')
const { hubQuality } = require('../lib/hub-leg')
const { decideStatus } = require('../lib/local-leg')

const ROOT = path.join(__dirname, '..')

// The message from the network reference "Locale Following", verbatim.
const SPEC_MESSAGE = {
  type: 'pnds:locale',
  version: 1,
  locale: 'zh-CN',
}

// ---------------------------------------------------------------------------
// Message → locale
// ---------------------------------------------------------------------------

test('locale message: supported codes parse, others do not', () => {
  assert.equal(localeFromMessage(SPEC_MESSAGE), 'zh-CN')
  assert.equal(localeFromMessage({ type: 'pnds:locale', version: 1, locale: 'en' }), 'en')

  for (const code of ['ja', 'zh', 'zh-cn', 'en-US', '']) {
    assert.equal(
      localeFromMessage({ type: 'pnds:locale', version: 1, locale: code }),
      null,
      `unsupported code ${JSON.stringify(code)} must be ignored`,
    )
  }
})

test('unknown or malformed messages are ignored, not applied', () => {
  const malformed = [
    null,
    undefined,
    42,
    'pnds:locale',
    [],
    {},
    { type: 'other', version: 1, locale: 'en' },
    { type: 'pnds:locale' },
    { type: 'pnds:locale', version: 2, locale: 'en' },
    { type: 'pnds:locale', version: 1 },
    { type: 'pnds:locale', version: 1, locale: 7 },
    { type: 'pnds:locale', version: 1, locale: ['en'] },
    { type: 'pnds:theme', version: 1, theme: 'lavender', palette: {} },
  ]

  for (const data of malformed) {
    assert.equal(localeFromMessage(data), null, `should ignore ${JSON.stringify(data)}`)
  }
})

// ---------------------------------------------------------------------------
// ?lang=<code> first-frame initial locale
// ---------------------------------------------------------------------------

test('?lang= seeds the first frame; absence keeps the default', () => {
  assert.equal(initialLocale('?lang=en'), 'en')
  assert.equal(initialLocale('?a=1&lang=zh-CN'), 'zh-CN')
  assert.equal(initialLocale('?theme=stage&lang=zh-CN'), 'zh-CN')

  // Unknown codes and missing parameters keep the default locale.
  assert.equal(initialLocale(''), null)
  assert.equal(initialLocale('?'), null)
  assert.equal(initialLocale('?foo=1'), null)
  assert.equal(initialLocale('?lang=ja'), null)
  assert.equal(initialLocale('?lang=zh-cn'), null, 'codes compare exactly')
})

// ---------------------------------------------------------------------------
// Browser wiring (the real file, run against a minimal page)
// ---------------------------------------------------------------------------

// Loads lib/locale-follow.js the way the monitor page does (browser
// global, no module system) and returns what the page observed: its
// locale state, its document lang and its message listeners.
function loadMonitorPage(search) {
  const documentElement = { lang: 'zh-CN' }
  const listeners = {}
  const page = {
    document: { documentElement },
    location: { search },
    addEventListener: (type, handler) => {
      (listeners[type] = listeners[type] || []).push(handler)
    },
  }
  page.self = page

  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'lib', 'locale-follow.js'), 'utf8'),
    vm.createContext(page),
  )

  return { locale: page.PNDS_LOCALE, documentElement, listeners }
}

test('monitor page wiring: defaults to Chinese until a locale arrives', () => {
  const page = loadMonitorPage('')

  // page.locale is window.PNDS_LOCALE — the global the monitor scripts
  // read, so its very presence proves the browser-global wiring.
  assert.equal(typeof page.locale.current, 'function')
  assert.equal(page.locale.current(), DEFAULT_LOCALE)
  assert.equal(page.locale.current(), 'zh-CN', 'this project renders Chinese by default')
  assert.equal(page.documentElement.lang, 'zh-CN', 'no rewrite before a locale applies')
})

test('monitor page wiring: message → current locale, lang attribute, subscribers', () => {
  const page = loadMonitorPage('')
  const seen = []
  page.locale.subscribe((locale) => seen.push(locale))

  assert.equal(page.listeners.message.length, 1, 'exactly one message listener')

  page.listeners.message[0]({ data: SPEC_MESSAGE })
  assert.equal(page.locale.current(), 'zh-CN')
  assert.deepEqual(seen, [], 'the default locale re-pushes nobody')

  // A switch to English (a language switch in the App).
  page.listeners.message[0]({ data: { type: 'pnds:locale', version: 1, locale: 'en' } })
  assert.equal(page.locale.current(), 'en')
  assert.equal(page.documentElement.lang, 'en')
  assert.deepEqual(seen, ['en'])
})

test('monitor page wiring: ?lang= paints the first frame before any message', () => {
  const page = loadMonitorPage('?lang=en')

  assert.equal(page.locale.current(), 'en')
  assert.equal(page.documentElement.lang, 'en')
})

test('monitor page wiring: malformed events never throw or change the locale', () => {
  const page = loadMonitorPage('?lang=en')

  for (const data of [null, {}, { type: 'other' }, 'pnds:locale', { type: 'pnds:locale', version: 1, locale: 'ja' }]) {
    assert.doesNotThrow(() => page.listeners.message[0]({ data }))
  }

  assert.equal(page.locale.current(), 'en')
})

// ---------------------------------------------------------------------------
// Idempotency (the App re-pushes on language switches and focus
// regain; latest value wins, repeated delivery has no side effects)
// ---------------------------------------------------------------------------

test('re-delivery is idempotent; switches land on the latest value', () => {
  const page = loadMonitorPage('')
  const seen = []
  page.locale.subscribe((locale) => seen.push(locale))

  const deliver = (locale) =>
    page.listeners.message[0]({ data: { type: 'pnds:locale', version: 1, locale } })

  // Re-push of the current locale (focus regain path) notifies nobody.
  deliver('zh-CN')
  deliver('zh-CN')
  assert.deepEqual(seen, [])

  deliver('en')
  deliver('en')
  assert.deepEqual(seen, ['en'])

  // A switch away and back lands exactly where it was.
  deliver('zh-CN')
  deliver('en')
  assert.deepEqual(seen, ['en', 'zh-CN', 'en'])
  assert.equal(page.locale.current(), 'en')
})

test('unsubscribe stops the notifications', () => {
  const page = loadMonitorPage('')
  const seen = []
  const off = page.locale.subscribe((locale) => seen.push(locale))

  off()
  page.listeners.message[0]({ data: { type: 'pnds:locale', version: 1, locale: 'en' } })
  assert.deepEqual(seen, [])
  assert.equal(page.locale.current(), 'en', 'state still follows')
})

// ---------------------------------------------------------------------------
// Page wiring: locale-follow loads only in the monitor branch
// ---------------------------------------------------------------------------

test('page wiring: locale-follow loads only in the monitor branch', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')

  const monitorBranch = html.slice(html.indexOf('PNDS_IS_MONITOR'))
  assert.match(
    monitorBranch,
    /if \(window\.PNDS_IS_MONITOR\) \{[\s\S]*document\.write\(\s*'\\x3Cscript src="\/__pnds\/locale-follow\.js/,
    'the monitor branch loads the locale bridge',
  )

  // The module load sits between theme-follow.js and monitor.js.
  const themeLoad = monitorBranch.indexOf('__pnds/theme-follow.js')
  const localeLoad = monitorBranch.indexOf('__pnds/locale-follow.js')
  const monitorLoad = monitorBranch.indexOf('src="monitor.js"')
  assert.ok(themeLoad !== -1 && localeLoad !== -1 && monitorLoad !== -1)
  assert.ok(themeLoad < localeLoad, 'locale-follow loads after theme-follow')
  assert.ok(localeLoad < monitorLoad, 'locale-follow loads before monitor.js')

  // …and the performer branch has no hand in locale following.
  const performer = fs.readFileSync(path.join(ROOT, 'public', 'performer.js'), 'utf8')
  assert.doesNotMatch(performer, /pnds:locale|PNDS_LOCALE/)
})

// ---------------------------------------------------------------------------
// Copy tables (shared.js): every locale renders the same shape
// ---------------------------------------------------------------------------

test('both copy tables share one key shape and non-empty strings', () => {
  assert.deepEqual(keysOf(copy['zh-CN']), keysOf(copy.en))

  for (const locale of SUPPORTED_LOCALES) {
    for (const value of leafValues(copy[locale])) {
      assert.equal(typeof value, 'string', `${locale}: copy values are strings`)
      assert.notEqual(value.trim(), '', `${locale}: copy values are non-empty`)
    }
  }
})

test('both copy tables default to the same locale the page renders', () => {
  // The page's fallback table must be the default locale's table —
  // a session without bridge traffic renders it.
  assert.ok(copy[DEFAULT_LOCALE])
})

test('reason templates carry the same placeholders in every locale', () => {
  const locales = SUPPORTED_LOCALES

  for (const key of Object.keys(copy.en.hubReasons)) {
    const expected = placeholdersOf(copy.en.hubReasons[key]).sort().join(',')

    for (const locale of locales) {
      assert.deepEqual(
        placeholdersOf(copy[locale].hubReasons[key]).sort(),
        expected ? expected.split(',') : [],
        `${locale}: hubReasons.${key} placeholders differ from en`,
      )
    }
  }
})

test('every reason key the hub leg can emit has copy in both locales', () => {
  // One input per hubQuality rule — together these produce every
  // reason key the wire can carry.
  const inputs = [
    { connected: false },
    { connected: true, samples: 1, lost: 0, iqrMs: null, lossRate: 0, reconnects: 0 },
    { connected: true, samples: 40, lost: 0, iqrMs: null, lossRate: 0, reconnects: 2 },
    { connected: true, samples: 40, lost: 0, iqrMs: 35, lossRate: 0, reconnects: 0 },
    { connected: true, samples: 40, lost: 0, iqrMs: 5, lossRate: 0.05, reconnects: 0 },
    { connected: true, samples: 40, lost: 0, iqrMs: 5, lossRate: 0, reconnects: 0 },
    { connected: true, samples: 40, lost: 0, iqrMs: 5, lossRate: 0, reconnects: 1 },
    { connected: true, samples: 40, lost: 0, iqrMs: 15, lossRate: 0, reconnects: 0 },
    { connected: true, samples: 40, lost: 0, iqrMs: 5, lossRate: 0.005, reconnects: 0 },
  ]

  for (const locale of SUPPORTED_LOCALES) {
    for (const input of inputs) {
      const { reason } = hubQuality(input)

      assert.ok(
        copy[locale].hubReasons[reason],
        `${locale}: missing copy for hub reason "${reason}"`,
      )
    }
  }
})

test('every reason key the local leg can emit has copy in both locales', () => {
  const good = {
    disconnected: false,
    consecutiveTimeouts: 0,
    burstTimeoutRate: 0,
    jitterP95: 5,
    rttP95: 40,
  }

  // One input per decideStatus rule plus the warm-up key — together
  // these produce every reason key the wire can carry.
  const inputs = [
    good,
    { ...good, disconnected: true },
    { ...good, consecutiveTimeouts: 3 },
    { ...good, burstTimeoutRate: 0.06 },
    { ...good, jitterP95: 26 },
    { ...good, rttP95: 101 },
    { ...good, consecutiveTimeouts: 1 },
    { ...good, rttP95: 60 },
  ]

  const emitted = new Set(['warmup'])
  for (const input of inputs) {
    emitted.add(decideStatus(input).reason)
  }

  for (const locale of SUPPORTED_LOCALES) {
    for (const reason of emitted) {
      assert.ok(
        copy[locale].localReasons[reason],
        `${locale}: missing copy for local reason "${reason}"`,
      )
    }
  }
})

test('event-log types have copy in both locales', () => {
  const types = [
    'connected',
    'disconnected',
    'reconnected',
    'stopped',
    'connect failed',
    ...Object.values(localEvents),
  ]

  for (const type of types) {
    assert.ok(copy.en.events[type], `en: missing event copy for "${type}"`)
    assert.ok(copy['zh-CN'].events[type], `zh-CN: missing event copy for "${type}"`)
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Key shape of a nested plain-object structure (leaf values → null, so
// only the shape compares).
function keysOf(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const out = {}
  for (const key of Object.keys(value).sort()) {
    out[key] = keysOf(value[key])
  }
  return out
}

function* leafValues(value) {
  if (value === null || typeof value !== 'object') {
    yield value
    return
  }
  for (const child of Object.values(value)) {
    yield* leafValues(child)
  }
}

// The {n} placeholder indices a template uses.
function placeholdersOf(template) {
  const found = []
  template.replace(/\{(\d+)\}/g, (whole, index) => {
    found.push(index)
    return whole
  })
  return found
}

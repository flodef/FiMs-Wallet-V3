import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const localesDir = join(root, 'packages', 'i18n', 'locales')
const locales = readdirSync(localesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
const namespaces = readdirSync(join(localesDir, 'en'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''))

function load(locale: string): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  for (const ns of namespaces) {
    result[ns] = JSON.parse(readFileSync(join(localesDir, locale, `${ns}.json`), 'utf-8'))
  }
  return result
}

function errorCodes(): Set<string> {
  const codes = new Set<string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') && !entry.name.includes('test')) {
        const text = readFileSync(path, 'utf-8')
        for (const m of text.matchAll(/new AppError\(\s*'([a-z][a-zA-Z0-9]*)'/g)) {
          codes.add(`error${m[1][0].toUpperCase()}${m[1].slice(1)}`)
        }
        // AppError subclasses set the code via super('code', …)
        for (const m of text.matchAll(/extends AppError[\s\S]*?super\('([a-z][a-zA-Z0-9]*)'/g)) {
          codes.add(`error${m[1][0].toUpperCase()}${m[1].slice(1)}`)
        }
      }
    }
  }
  // Every package's src — feature packages throw AppError codes too, and the
  // guard only helps if it sees them all.
  for (const pkg of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const src = join(root, 'packages', pkg.name, 'src')
    if (existsSync(src)) walk(src)
  }
  return codes
}

describe('locales', () => {
  describe('expected behavior', () => {
    it('should have no empty or untranslated values in any locale', () => {
      // ARRANGE
      expect.assertions(locales.length)
      const en = load('en')

      // ACT & ASSERT
      for (const locale of locales) {
        const data = load(locale)
        const bad: string[] = []
        for (const ns of namespaces) {
          for (const [key, value] of Object.entries(data[ns])) {
            const base = key.replace(/_(one|other|many|few|zero|two)$/, '')
            const known =
              en[ns][key] !== undefined ||
              en[ns][base] !== undefined ||
              Object.keys(en[ns]).some((k) => k.startsWith(`${base}_`))
            if (value === '' || value === key || value === base || !known) {
              bad.push(`${ns}:${key}`)
            }
          }
        }
        expect(bad, `${locale}: ${bad.join(', ')}`).toHaveLength(0)
      }
    })

    it('should have a translation for every app error code in every locale', () => {
      // ARRANGE
      expect.assertions(locales.length)
      const codes = errorCodes()

      // ACT & ASSERT
      for (const locale of locales) {
        const ui = load(locale)['ui']
        const missing = [...codes].filter((key) => !ui[key])
        expect(missing, `${locale}: ${missing.join(', ')}`).toHaveLength(0)
      }
    })
  })
})

import { defineConfig } from 'i18next-cli'

export default defineConfig({
  extract: {
    ignore: [
      '../**/node_modules/**',
      '../../**/node_modules/**',
      'node_modules/**',

      '../**/dist/**',
      '../../**/dist/**',
      'dist/**',
    ],
    ignoredAttributes: [
      'autoComplete',
      'autoCorrect',
      'icon',
      'rel',
      'orientation',
      'provider',
      'role',
      'size',
      'spellCheck',
      'step',
      'to',
      'variant',
    ],
    input: '../../**/src/**/*.{js,jsx,ts,tsx}',
    output: 'locales/{{language}}/{{namespace}}.json',
    // Error codes are resolved dynamically (`error${AppError.name}` in
    // localized-error.ts) — the extractor cannot see them, and without this
    // it silently deletes every translated error message.
    preservePatterns: ['ui:error*'],
  },
  locales: ['en', 'es', 'fr'],
  types: {
    enableSelector: true,
    input: ['locales/en/*.json'],
    output: 'src/i18next.d.ts',
    resourcesFile: 'src/resources.d.ts',
  },
})

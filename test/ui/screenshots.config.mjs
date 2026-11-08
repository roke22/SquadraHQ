// The dashboard's screenshots (npm run screenshots), apart from the tests.
import { defineConfig } from '@playwright/test'
import base from './playwright.config.mjs'

export default defineConfig({ ...base, testMatch: /screenshots\.shots\.mjs$/, timeout: 300_000, reporter: 'line' })

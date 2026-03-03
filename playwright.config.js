const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 8000 },
  use: {
    baseURL: 'http://127.0.0.1:3003',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  reporter: [['list']],
});

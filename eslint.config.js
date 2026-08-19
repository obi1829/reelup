'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const html = require('eslint-plugin-html');
const noUnsanitized = require('eslint-plugin-no-unsanitized');

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', 'assets/**']
  },
  // Main process + build scripts: CommonJS/Node.
  {
    files: ['src/main.js', 'src/preload.js', 'src/upload-orchestrator.js', 'src/backends/**/*.js', 'src/lib/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: globals.node
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
    }
  },
  // Renderer: inline <script> block inside index.html plus src/renderer/*.js —
  // all classic (non-module) scripts sharing one global scope, no bundler.
  // Each renderer/*.js freely references functions/vars declared in the
  // others (load order in index.html matters), so no-undef can't be modeled
  // per-file without listing every cross-file symbol as a "global"; it's
  // off here and relied on being caught by actually running the app instead.
  {
    files: ['src/index.html', 'src/renderer/**/*.js'],
    plugins: { html, 'no-unsanitized': noUnsanitized },
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 2022,
      globals: globals.browser
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // Flags innerHTML/outerHTML/insertAdjacentHTML assigned anything other
      // than a string literal — exactly the pattern that would turn a file
      // name or server error message into stored XSS if a future edit
      // interpolated it into markup instead of using .textContent.
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error'
    }
  }
];

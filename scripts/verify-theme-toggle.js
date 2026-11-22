#!/usr/bin/env node
/**
 * Smoke: soft Matrix theme switcher markers in public HTML/CSS/JS.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const scriptJs = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');

const checks = [
  ['index theme toggle', /data-theme-choice="default"/, indexHtml],
  ['index matrix choice', /data-theme-choice="matrix"/, indexHtml],
  ['index rain canvas', /id="matrix-rain"/, indexHtml],
  ['index FOUC key', /nutrikod_theme/, indexHtml],
  ['index metrika preserved', /114157729/, indexHtml],
  ['css matrix vars', /html\[data-theme='matrix'\]/, styleCss],
  ['css first-order matrix', /cart-block-first-order[\s\S]*#0f2418/, styleCss],
  ['js theme storage', /THEME_STORAGE_KEY\s*=\s*'nutrikod_theme'/, scriptJs],
  ['js setTheme', /function setTheme\(/, scriptJs],
  ['js matrix rain', /function startMatrixRain\(/, scriptJs],
];

let failed = 0;
for (const [name, re, src] of checks) {
  if (!re.test(src)) {
    console.error(`FAIL: ${name}`);
    failed += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

if (failed) {
  process.exit(1);
}
console.log('verify-theme-toggle: all ok');

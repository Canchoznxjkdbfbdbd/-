#!/usr/bin/env node
/**
 * Smoke: soft Terminal theme switcher markers in public HTML/CSS/JS.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const scriptJs = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');

/** @type {[string, RegExp, string][]} */
const checks = [
  ['index theme toggle', /data-theme-choice="default"/, indexHtml],
  ['index terminal choice', /data-theme-choice="terminal"/, indexHtml],
  ['index terminal label', />\s*Терминал\s*</, indexHtml],
  ['index no matrix rain canvas', /^(?![\s\S]*id="matrix-rain")[\s\S]*$/, indexHtml],
  ['index terminal idle zone', /id="terminal-idle"/, indexHtml],
  ['index FOUC key', /nutrikod_theme/, indexHtml],
  ['index FOUC migrate matrix', /t === 'matrix' \|\| t === 'terminal'/, indexHtml],
  ['index metrika preserved', /114157729/, indexHtml],
  ['css terminal vars', /html\[data-theme='terminal'\]/, styleCss],
  ['css soft leaf not acid', /--leaf:\s*#3fb950/, styleCss],
  ['css soft muted', /--muted:\s*#8b9a8b/, styleCss],
  ['css idle mask', /mask-image:\s*linear-gradient/, styleCss],
  ['css first-order terminal', /cart-block-first-order[\s\S]*#0f2418/, styleCss],
  ['js theme storage', /THEME_STORAGE_KEY\s*=\s*'nutrikod_theme'/, scriptJs],
  ['js setTheme', /function setTheme\(/, scriptJs],
  ['js migrate matrix', /matrix.*terminal|normalizeTheme/, scriptJs],
  ['js terminal idle', /function startTerminalIdle\(/, scriptJs],
  ['js no digital rain', /^(?![\s\S]*startMatrixRain)[\s\S]*$/, scriptJs],
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

if (/#00ff41|#00FF41/.test(styleCss)) {
  console.error('FAIL: css still has acid #00FF41');
  failed += 1;
} else {
  console.log('ok: css no acid accent');
}

if (/data-theme-choice="matrix"|Матрица|startMatrixRain|matrix-rain/.test(indexHtml + scriptJs)) {
  console.error('FAIL: leftover Matrix UI / rain markers');
  failed += 1;
} else {
  console.log('ok: no leftover Matrix UI/rain');
}

if (failed) {
  process.exit(1);
}
console.log('verify-theme-toggle: all ok');

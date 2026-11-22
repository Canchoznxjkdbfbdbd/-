#!/usr/bin/env node
/**
 * Smoke: Terminal = header + LTR cyan type-in + block caret + shell transcript (1+4).
 * Default theme paths stay card/chip based.
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
  ['index term-field wrap', /class="term-field"/, indexHtml],
  ['index term-caret', /id="term-caret"/, indexHtml],
  ['index no idle zone', /^(?![\s\S]*id="terminal-idle")[\s\S]*$/, indexHtml],
  ['index no idle phrase', /^(?![\s\S]*id="terminal-idle-phrase")[\s\S]*$/, indexHtml],
  ['index no matrix rain canvas', /^(?![\s\S]*id="matrix-rain")[\s\S]*$/, indexHtml],
  ['index FOUC key', /nutrikod_theme/, indexHtml],
  ['index FOUC migrate matrix', /t === 'matrix' \|\| t === 'terminal'/, indexHtml],
  ['index metrika preserved', /114157729/, indexHtml],
  ['index cache bust', /style\.css\?v=20261122-terminal-crt/, indexHtml],
  ['css terminal vars', /html\[data-theme='terminal'\]/, styleCss],
  ['css soft leaf not acid', /--leaf:\s*#3fb950/, styleCss],
  ['css soft muted', /--muted:\s*#8b9a8b/, styleCss],
  ['css hide hero on terminal', /body:not\(\.page-privacy\) \.hero/, styleCss],
  ['css hide empty-start on terminal', /body:not\(\.page-privacy\) \.empty-start/, styleCss],
  ['css hide mode-bar on terminal', /body:not\(\.page-privacy\) \.mode-bar/, styleCss],
  ['css hide legal on terminal', /body:not\(\.page-privacy\) \.legal/, styleCss],
  ['css hide clear-chat on terminal', /html\[data-theme='terminal'\] \.clear-chat/, styleCss],
  ['css hide cart cards on terminal', /html\[data-theme='terminal'\] \.cart-block/, styleCss],
  ['css hide partner cards on terminal', /html\[data-theme='terminal'\] \.partner/, styleCss],
  ['css shell prompt prefix', /content:\s*'nutrikod:~\$ '/, styleCss],
  ['css messages visible terminal', /body:not\(\.page-privacy\) \.messages \{/, styleCss],
  ['css crt composer bezel', /html\[data-theme='terminal'\] body:not\(\.page-privacy\) \.composer/, styleCss],
  ['css crt inset shadow', /inset 0 0 18px rgba\(0, 0, 0, 0\.35\)/, styleCss],
  ['css cyan phosphor text', /color:\s*#7ef0e4/, styleCss],
  ['css native caret hidden', /caret-color:\s*transparent/, styleCss],
  ['css block caret', /\.term-caret/, styleCss],
  ['css caret blink', /term-caret-blink/, styleCss],
  ['css left-edged shell', /margin-inline:\s*0/, styleCss],
  ['js theme storage', /THEME_STORAGE_KEY\s*=\s*'nutrikod_theme'/, scriptJs],
  ['js setTheme', /function setTheme\(/, scriptJs],
  ['js syncTermCaret', /function syncTermCaret\(/, scriptJs],
  ['js formatTerminalPlain', /function formatTerminalPlain\(/, scriptJs],
  ['js terminal dash lists', /– /, scriptJs],
  ['js migrate matrix', /matrix.*terminal|normalizeTheme/, scriptJs],
  ['js no terminal idle', /^(?![\s\S]*startTerminalIdle)[\s\S]*$/, scriptJs],
  ['js no scramble', /^(?![\s\S]*TERMINAL_SCRAMBLE_CHARS)[\s\S]*$/, scriptJs],
  ['js no paint scramble', /^(?![\s\S]*paintScrambleText)[\s\S]*$/, scriptJs],
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

if (/terminal-idle|TERMINAL_IDLE|terminalIdle|paintScrambleText|translate3d\(/.test(scriptJs + indexHtml)) {
  console.error('FAIL: leftover idle ticker / scramble markers');
  failed += 1;
} else {
  console.log('ok: no idle ticker leftovers');
}

const terminalCss = styleCss.slice(styleCss.indexOf("html[data-theme='terminal']"));
if (/repeating-linear-gradient|scanline|vignette/i.test(terminalCss)) {
  console.error('FAIL: terminal theme has scanline/vignette patterns');
  failed += 1;
} else {
  console.log('ok: terminal theme no scanline/vignette patterns');
}

// Messages must NOT be in the global terminal hide list anymore.
const hideBlock = terminalCss.match(
  /html\[data-theme='terminal'\] body:not\(\.page-privacy\) \.atmosphere[\s\S]*?\{[\s\S]*?display:\s*none/
);
if (hideBlock && /html\[data-theme='terminal'\][^\n]*\.messages/.test(hideBlock[0])) {
  console.error('FAIL: terminal still hides .messages');
  failed += 1;
} else {
  console.log('ok: terminal does not hide .messages');
}

if (failed) {
  process.exit(1);
}
console.log('verify-theme-toggle: all ok');

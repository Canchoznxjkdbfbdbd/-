#!/usr/bin/env node
/**
 * Smoke: Terminal = header + inline shell type-in (no composer box) + block caret + 1+4.
 * Default theme paths stay card/chip + composer based.
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
  ['index term-live', /id="term-live"/, indexHtml],
  ['index term-live-text', /id="term-live-text"/, indexHtml],
  ['index term-capture', /id="term-capture"/, indexHtml],
  ['index term-caret', /id="term-caret"/, indexHtml],
  ['index no term-field', /^(?![\s\S]*class="term-field")[\s\S]*$/, indexHtml],
  ['index no idle zone', /^(?![\s\S]*id="terminal-idle")[\s\S]*$/, indexHtml],
  ['index no idle phrase', /^(?![\s\S]*id="terminal-idle-phrase")[\s\S]*$/, indexHtml],
  ['index no matrix rain canvas', /^(?![\s\S]*id="matrix-rain")[\s\S]*$/, indexHtml],
  ['index FOUC key', /nutrikod_theme/, indexHtml],
  ['index FOUC migrate matrix', /t === 'matrix' \|\| t === 'terminal'/, indexHtml],
  ['index metrika preserved', /114157729/, indexHtml],
  ['index cache bust', /style\.css\?v=20261122-terminal-midwrap/, indexHtml],
  ['css no bubble border terminal', /msg\.assistant \.bubble \{[\s\S]*?border:\s*0/, styleCss],
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
  ['css hide composer on terminal', /body:not\(\.page-privacy\) \.composer \{[\s\S]*?display:\s*none\s*!important/, styleCss],
  ['css term-live shell line', /\.term-live/, styleCss],
  ['css term-live wrap', /overflow-wrap:\s*anywhere/, styleCss],
  ['css mid-screen wrap', /max-width:\s*min\(50vw,\s*36rem\)/, styleCss],
  ['css term-live mid width', /\.term-live \{[\s\S]*?width:\s*min\(50vw,\s*36rem\)/, styleCss],
  ['css shell prompt prefix', /content:\s*'nutrikod:~\$ '/, styleCss],
  ['css messages visible terminal', /body:not\(\.page-privacy\) \.messages \{/, styleCss],
  ['css cyan phosphor text', /color:\s*#7ef0e4/, styleCss],
  ['css block caret', /\.term-caret/, styleCss],
  ['css caret inline', /display:\s*inline-block/, styleCss],
  ['css caret blink', /term-caret-blink/, styleCss],
  ['css caret typing solid', /\.term-caret\.is-typing/, styleCss],
  ['css caret dim not gone', /opacity:\s*0\.28/, styleCss],
  ['css left-edged shell', /margin-inline:\s*0/, styleCss],
  ['js theme storage', /THEME_STORAGE_KEY\s*=\s*'nutrikod_theme'/, scriptJs],
  ['js setTheme', /function setTheme\(/, scriptJs],
  ['js syncTermLive', /function syncTermLive\(/, scriptJs],
  ['js markTermCaretTyping', /function markTermCaretTyping\(/, scriptJs],
  ['js focusActiveTypeIn', /function focusActiveTypeIn\(/, scriptJs],
  ['js formatTerminalPlain', /function formatTerminalPlain\(/, scriptJs],
  ['js terminal dash lists', /– /, scriptJs],
  ['js migrate matrix', /matrix.*terminal|normalizeTheme/, scriptJs],
  ['js no terminal idle', /^(?![\s\S]*startTerminalIdle)[\s\S]*$/, scriptJs],
  ['js no scramble', /^(?![\s\S]*TERMINAL_SCRAMBLE_CHARS)[\s\S]*$/, scriptJs],
  ['js no paint scramble', /^(?![\s\S]*paintScrambleText)[\s\S]*$/, scriptJs],
  ['js no digital rain', /^(?![\s\S]*startMatrixRain)[\s\S]*$/, scriptJs],
  ['js no syncTermCaret', /^(?![\s\S]*syncTermCaret)[\s\S]*$/, scriptJs],
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

// Composer must be fully hidden in Terminal (no box top or bottom).
if (!/body:not\(\.page-privacy\) \.composer \{[\s\S]*?display:\s*none\s*!important/.test(styleCss)) {
  console.error('FAIL: terminal composer not fully hidden');
  failed += 1;
} else {
  console.log('ok: terminal composer fully hidden');
}

if (failed) {
  process.exit(1);
}
console.log('verify-theme-toggle: all ok');

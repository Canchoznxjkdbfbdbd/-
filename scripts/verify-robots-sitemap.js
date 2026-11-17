#!/usr/bin/env node
/**
 * Offline + optional live checks: robots.txt / sitemap.xml must be 200 text,
 * never SPA HTML and never rely on a redirect to be "ok" for Yandex.
 * Run: node scripts/verify-robots-sitemap.js [baseUrl]
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const root = path.join(__dirname, '..');
const robotsPath = path.join(root, 'public', 'robots.txt');
const sitemapPath = path.join(root, 'public', 'sitemap.xml');
const serverSrc = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const nginxConf = fs.readFileSync(path.join(root, 'deploy', 'nginx-nutricode.conf'), 'utf8');

const robots = fs.readFileSync(robotsPath, 'utf8');
const sitemap = fs.readFileSync(sitemapPath, 'utf8');

assert.match(robots, /User-agent:\s*\*/i);
assert.match(robots, /Sitemap:\s*https:\/\/nutricode\.online\/sitemap\.xml/);
assert.doesNotMatch(robots, /<\/?html/i);

assert.match(sitemap, /<urlset[\s>]/);
assert.match(sitemap, /https:\/\/nutricode\.online\//);
assert.doesNotMatch(sitemap, /<\/?html/i);

assert.match(
  serverSrc,
  /app\.get\(\s*['"]\/robots\.txt['"]/
);
assert.match(
  serverSrc,
  /app\.get\(\s*['"]\/sitemap\.xml['"]/
);
const robotsIdx = serverSrc.indexOf("app.get('/robots.txt'");
const sitemapIdx = serverSrc.indexOf("app.get('/sitemap.xml'");
const staticIdx = serverSrc.indexOf('app.use(express.static');
const catchAllIdx = serverSrc.indexOf("app.get('*'");
assert.ok(robotsIdx > -1 && sitemapIdx > -1 && staticIdx > -1 && catchAllIdx > -1);
assert.ok(robotsIdx < staticIdx, 'robots route must be before express.static');
assert.ok(sitemapIdx < staticIdx, 'sitemap route must be before express.static');
assert.ok(robotsIdx < catchAllIdx, 'robots route must be before SPA catch-all');
assert.ok(sitemapIdx < catchAllIdx, 'sitemap route must be before SPA catch-all');

assert.match(nginxConf, /location = \/robots\.txt/);
assert.match(nginxConf, /location = \/sitemap\.xml/);
assert.match(
  nginxConf,
  /listen 80;[\s\S]*location = \/robots\.txt[\s\S]*location = \/sitemap\.xml[\s\S]*location \/ \{\s*return 301 https/
);

console.log('ok: static files + Express order + nginx HTTP exceptions');

const baseUrl = process.argv[2];
if (!baseUrl) {
  process.exit(0);
}

function fetchHeaders(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(
      url,
      { method: 'HEAD', timeout: 15000 },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode,
          location: res.headers.location || null,
          type: res.headers['content-type'] || '',
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.end();
  });
}

(async () => {
  const base = baseUrl.replace(/\/$/, '');
  const httpsRobots = await fetchHeaders(`${base}/robots.txt`);
  const httpsSitemap = await fetchHeaders(`${base}/sitemap.xml`);
  assert.strictEqual(httpsRobots.status, 200, `HTTPS robots status ${httpsRobots.status}`);
  assert.ok(/text\/plain/i.test(httpsRobots.type), `HTTPS robots type ${httpsRobots.type}`);
  assert.strictEqual(httpsSitemap.status, 200, `HTTPS sitemap status ${httpsSitemap.status}`);
  assert.ok(/xml/i.test(httpsSitemap.type), `HTTPS sitemap type ${httpsSitemap.type}`);

  if (base.startsWith('https://')) {
    const httpBase = base.replace(/^https:/, 'http:');
    const httpRobots = await fetchHeaders(`${httpBase}/robots.txt`);
    const httpSitemap = await fetchHeaders(`${httpBase}/sitemap.xml`);
    assert.strictEqual(
      httpRobots.status,
      200,
      `HTTP robots must be 200 for Yandex (got ${httpRobots.status} → ${httpRobots.location})`
    );
    assert.ok(/text\/plain/i.test(httpRobots.type), `HTTP robots type ${httpRobots.type}`);
    assert.strictEqual(
      httpSitemap.status,
      200,
      `HTTP sitemap must be 200 (got ${httpSitemap.status} → ${httpSitemap.location})`
    );
  }

  console.log(`ok: live ${base} robots/sitemap 200 (HTTP+HTTPS)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

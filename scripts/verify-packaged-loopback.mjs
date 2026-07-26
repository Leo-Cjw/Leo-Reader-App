import assert from 'node:assert/strict';
import http from 'node:http';
import { launchPackagedReader, packagedReaderApp } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
process.env.READER_HOST = '0.0.0.0';

async function requestJSON(url, { method = 'GET', headers = {}, body = '' } = {}) {
  return await new Promise((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

let session;
try {
  session = await launchPackagedReader({ appPath, prefix: 'reader-packaged-loopback-' });
  const origin = await session.client.value('location.origin');
  const localURL = new URL(origin);
  assert.equal(localURL.hostname, '127.0.0.1');
  const authority = localURL.host;
  const initialStats = await requestJSON(`${origin}/api/stats`);
  assert.equal(initialStats.headers['content-security-policy'], "frame-ancestors 'self'");
  assert.equal(initialStats.headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(initialStats.headers['cross-origin-resource-policy'], 'same-origin');
  assert.equal(initialStats.headers['permissions-policy'], 'camera=(), geolocation=(), microphone=()');
  assert.equal(initialStats.headers['referrer-policy'], 'no-referrer');
  assert.equal(initialStats.headers['x-content-type-options'], 'nosniff');
  assert.equal(initialStats.headers['x-frame-options'], 'SAMEORIGIN');
  const before = initialStats.body.stats.total;
  const payload = JSON.stringify({ mode: 'markdown', title: 'Blocked cross-site write', content: 'Must not persist.' });

  assert.equal((await requestJSON(`${origin}/api/health`, {
    headers: { host: 'reader.attacker.invalid' }
  })).status, 403);
  assert.equal((await requestJSON(`${origin}/api/articles`, {
    method: 'POST',
    headers: { host: authority, origin: 'https://attacker.invalid', 'content-type': 'application/json' },
    body: payload
  })).status, 403);
  assert.equal((await requestJSON(`${origin}/api/articles`, {
    headers: { host: authority, 'sec-fetch-site': 'cross-site' }
  })).status, 403);
  assert.equal((await requestJSON(`${origin}/api/stats`)).body.stats.total, before);

  const trusted = await requestJSON(`${origin}/api/articles`, {
    method: 'POST',
    headers: { host: authority, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'markdown', title: 'Trusted packaged write', content: 'Exact packaged origin remains usable.' })
  });
  assert.equal(trusted.status, 201);
  assert.equal((await requestJSON(`${origin}/api/stats`)).body.stats.total, before + 1);

  console.log('Reader 最终包回环来源门禁通过');
  console.log('non-loopback listener override=blocked');
  console.log('response security headers=passed');
  console.log('dns rebinding host=blocked');
  console.log('cross-origin write=blocked');
  console.log('cross-site read=blocked');
  console.log('rejected request writes=0');
  console.log('exact origin write=passed');
} finally {
  await session?.close().catch(() => {});
}

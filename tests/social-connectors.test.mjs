import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIService } from '../src/server/ai.mjs';
import { ReaderDatabase } from '../src/server/db.mjs';
import { createReaderServer } from '../src/server/server.mjs';
import { createSourceSyncService } from '../src/server/source-sync.mjs';
import {
  normalizeSocialSourceURL,
  SocialConnectorManager,
  weiboStatusesToItems,
  xPostsToItems
} from '../src/server/social-connectors.mjs';

class MemoryCredentialStore {
  constructor(value = null) { this.value = value; }
  describe() { return { backend: 'memory-test', writable: true }; }
  async get() { return this.value; }
  async set(value) { this.value = value; }
  async delete() { const existed = Boolean(this.value); this.value = null; return existed; }
}

async function temporaryDatabase(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-social-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

test('social source addresses are canonical and reject unrelated pages', () => {
  assert.equal(normalizeSocialSourceURL('x', '@XDevelopers'), 'https://x.com/XDevelopers');
  assert.equal(normalizeSocialSourceURL('x', 'https://twitter.com/XDevelopers/'), 'https://x.com/XDevelopers');
  assert.equal(normalizeSocialSourceURL('weibo', '1234567890'), 'https://weibo.com/u/1234567890');
  assert.equal(normalizeSocialSourceURL('weibo', 'https://weibo.com/u/1234567890'), 'https://weibo.com/u/1234567890');
  assert.throws(() => normalizeSocialSourceURL('x', 'https://x.com/XDevelopers/status/1'), /只支持用户主页/);
  assert.throws(() => normalizeSocialSourceURL('weibo', 'https://weibo.com/hot/search'), /数字 UID/);
});

test('X and Weibo payloads become traceable local articles with image descriptors', () => {
  const source = { id: 'source-social', title: '设计账号', url: 'https://weibo.com/u/1234567890' };
  const xItems = xPostsToItems({
    data: [{
      id: '1900000000000000001',
      text: 'A local-first update https://t.co/link',
      created_at: '2026-07-23T00:00:00.000Z',
      lang: 'en',
      entities: { urls: [{ url: 'https://t.co/link', expanded_url: 'https://example.com/reader' }] },
      attachments: { media_keys: ['3_media'] },
      public_metrics: { like_count: 8 }
    }],
    includes: { media: [{ media_key: '3_media', type: 'photo', url: 'https://pbs.twimg.com/media/test.jpg' }] }
  }, { id: '42', username: 'readerapp', name: 'Reader' }, source);
  assert.equal(xItems[0].id, 'x-1900000000000000001');
  assert.match(xItems[0].content, /https:\/\/example\.com\/reader/);
  assert.equal(xItems[0].metadata.inlineImages.length, 1);
  assert.doesNotMatch(xItems[0].content, /pbs\.twimg\.com/);

  const weiboItems = weiboStatusesToItems({
    statuses: [{
      idstr: '5100000000000001',
      bid: 'Preader',
      created_at: 'Thu Jul 23 08:00:00 +0800 2026',
      text_raw: '本地优先的阅读工作流',
      user: { idstr: '1234567890', screen_name: 'Reader设计' },
      pics: [{ large: { url: 'https://wx1.sinaimg.cn/large/test.jpg' } }],
      attitudes_count: 12
    }]
  }, source);
  assert.equal(weiboItems[0].id, 'weibo-5100000000000001');
  assert.equal(weiboItems[0].author, 'Reader设计');
  assert.equal(weiboItems[0].metadata.inlineImages.length, 1);
  assert.equal(weiboItems[0].metadata.attitudesCount, 12);
});

test('X credential stays in the credential store and official API sync advances since_id', async () => {
  const credentialStore = new MemoryCredentialStore();
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), authorization: init.headers.authorization });
    if (String(url).includes('/by/username/')) {
      return new Response(JSON.stringify({ data: { id: '2244994945', username: 'XDevelopers', name: 'X Developers', protected: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '299', 'x-rate-limit-reset': '1900000000' }
      });
    }
    return new Response(JSON.stringify({
      data: [{ id: '1900000000000000002', text: 'Reader connector is online.', created_at: '2026-07-23T00:00:00.000Z', lang: 'en' }],
      meta: { newest_id: '1900000000000000002' }
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '298' } });
  };
  const manager = new SocialConnectorManager({
    xCredentialStore: credentialStore,
    fetchImpl,
    weiboRunner: async () => ({ screen_name: '本机微博账号' }),
    environment: {}
  });

  const secret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const status = await manager.saveXToken(secret);
  assert.equal(status.x.configured, true);
  assert.equal(status.x.credentialSource, 'keychain');
  assert.equal(credentialStore.value, secret);
  assert.doesNotMatch(JSON.stringify(status), /AAAAAAAAAA/);

  const source = { id: 'x-source', kind: 'x', title: 'X Developers', url: 'https://x.com/XDevelopers', sync_cursor: null, external_id: null };
  const feed = await manager.fetchSource(source);
  assert.equal(feed.externalId, '2244994945');
  assert.equal(feed.cursor, '1900000000000000002');
  assert.equal(feed.items[0].type, 'x');
  assert.ok(requests.every((request) => request.authorization === `Bearer ${secret}`));

  await manager.fetchSource({ ...source, external_id: feed.externalId, sync_cursor: feed.cursor });
  assert.ok(requests.some((request) => request.url.includes('since_id=1900000000000000002')));
});

test('Weibo connector uses the official CLI session and never requests a token', async () => {
  const calls = [];
  const manager = new SocialConnectorManager({
    xCredentialStore: new MemoryCredentialStore(),
    fetchImpl: async () => { throw new Error('unexpected X request'); },
    weiboRunner: async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return { screen_name: 'Reader用户' };
      return { statuses: [{ idstr: '5100000000000002', text_raw: '来自官方 CLI 的微博', user: { idstr: '1234567890', screen_name: 'Reader用户' } }] };
    },
    environment: {}
  });
  assert.equal((await manager.testWeibo()).account, 'Reader用户');
  const feed = await manager.fetchSource({ id: 'wb', kind: 'weibo', title: 'Reader用户', url: 'https://weibo.com/u/1234567890', sync_cursor: '5100000000000001' });
  assert.equal(feed.cursor, '5100000000000002');
  assert.equal(feed.items[0].type, 'weibo');
  assert.deepEqual(calls[1].slice(0, 6), ['statuses', 'user_timeline', '--uid', '1234567890', '--count', '100']);
  assert.ok(calls[1].includes('--since_id'));
  assert.ok(calls[1].includes('--output'));
});

test('social feeds participate in durable scheduling and update connector state', async (t) => {
  const db = await temporaryDatabase(t);
  const source = await db.createSource({ kind: 'x', title: 'Reader X', url: 'https://x.com/readerapp', syncIntervalMinutes: 60 });
  const socialConnectors = {
    async fetchSource() {
      return {
        items: [{ id: 'x-1900000000000000003', url: 'https://x.com/readerapp/status/1900000000000000003', title: '自动订阅已工作', source: '@readerapp · X', author: 'Reader', type: 'x', language: 'zh', content: '自动订阅已工作。', excerpt: '自动订阅已工作。', metadata: {} }],
        cursor: '1900000000000000003',
        externalId: '9001',
        notModified: false,
        response: { status: 200, remaining: 297, resetAt: '2030-03-17T17:46:40.000Z' }
      };
    }
  };
  const service = createSourceSyncService(db, { socialConnectors });
  const result = await service.syncSource(source.id);
  assert.equal(result.imported, 1);
  const updated = await db.getSource(source.id);
  assert.equal(updated.sync_cursor, '1900000000000000003');
  assert.equal(updated.external_id, '9001');
  assert.equal(updated.rate_limit_remaining, 297);
  assert.equal(updated.last_status, 'ok');
  assert.ok((await db.listDueSources('2099-01-01T00:00:00.000Z')).some((item) => item.id === source.id));
  assert.equal((await db.getArticle('x-1900000000000000003')).type, 'x');
});

test('social connector HTTP API never returns secrets and drives an X source end to end', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-social-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialStore = new MemoryCredentialStore();
  const fetchImpl = async (url) => {
    if (String(url).includes('/by/username/')) {
      const handle = decodeURIComponent(String(url).match(/\/by\/username\/([^?]+)/)?.[1] || 'XDevelopers');
      return new Response(JSON.stringify({ data: { id: handle === 'XDevelopers' ? '2244994945' : '9001', username: handle, name: handle === 'XDevelopers' ? 'X Developers' : 'Reader App', protected: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '299' }
      });
    }
    return new Response(JSON.stringify({
      data: [{ id: '1900000000000000004', text: 'The Reader API route is working.', created_at: '2026-07-23T09:00:00.000Z', lang: 'en' }],
      meta: { newest_id: '1900000000000000004' }
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-rate-limit-remaining': '298' } });
  };
  const manager = new SocialConnectorManager({
    xCredentialStore: credentialStore,
    fetchImpl,
    weiboRunner: async (args) => args[1] === 'logout' ? {} : { screen_name: '本机微博账号' },
    environment: {}
  });
  const app = await createReaderServer({
    rootDir: dir,
    dbPath: path.join(dir, 'reader.sqlite3'),
    port: 0,
    aiService: new AIService({ endpoint: '', apiKey: '' }),
    socialConnectors: manager
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const secret = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  const saved = await json(`${base}/api/settings/connectors/x`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bearer_token: secret })
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.connectors.x.configured, true);
  assert.equal(credentialStore.value, secret);
  assert.doesNotMatch(JSON.stringify(saved.body), /BBBBBBBBBB/);

  const status = await json(`${base}/api/settings/connectors`);
  assert.equal(status.body.connectors.weibo.authenticated, true);
  assert.doesNotMatch(JSON.stringify(status.body), /BBBBBBBBBB/);
  const tested = await json(`${base}/api/settings/connectors/x/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(tested.body.result.account, 'XDevelopers');

  const created = await json(`${base}/api/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'x', title: 'Reader App', url: '@readerapp', sync_interval_minutes: 60 })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.source.url, 'https://x.com/readerapp');
  const synced = await json(`${base}/api/sources/${created.body.source.id}/sync`, { method: 'POST' });
  assert.equal(synced.response.status, 200);
  assert.equal(synced.body.imported, 1);
  const articles = await json(`${base}/api/articles?types=x`);
  assert.equal(articles.body.articles[0].id, 'x-1900000000000000004');

  const cleared = await json(`${base}/api/settings/connectors/x`, { method: 'DELETE' });
  assert.equal(cleared.body.connectors.x.configured, false);
  assert.equal(credentialStore.value, null);
});

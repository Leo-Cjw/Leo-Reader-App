import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { ReaderDatabase } from '../src/server/db.mjs';
import {
  cosineSimilarity,
  createSemanticSearchService,
  embeddingBuckets,
  embeddingVectorFromHex,
  embeddingVectorHex,
  fuseHybridResults,
  normalizeEmbeddingVector,
  OllamaEmbeddingClient,
  SEMANTIC_SEARCH_ENDPOINT,
  SEMANTIC_SEARCH_HASH_BANDS
} from '../src/server/semantic-search.mjs';
import { SettingsStore } from '../src/server/settings.mjs';
import { createReaderServer } from '../src/server/server.mjs';

function axis(index) {
  return Array.from({ length: 8 }, (_, current) => current === index ? 1 : 0);
}

class SemanticFixtureClient {
  constructor() {
    this.requests = [];
    this.fail = false;
    this.dimensions = 8;
  }

  async embed(inputs, model) {
    this.requests.push({ inputs: [...inputs], model });
    if (this.fail) throw new Error('fixture unavailable');
    const vectors = inputs.map((input) => {
      const text = String(input);
      const vector = Array.from({ length: this.dimensions }, () => 0);
      vector[/窗台|felines|nap/i.test(text) ? 0 : /壁炉|warm resting/i.test(text) ? 2 : 1] = 1;
      return normalizeEmbeddingVector(vector);
    });
    return { model, dimensions: this.dimensions, vectors };
  }
}

async function drainAll(service) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await service.drain();
    const status = await service.status();
    if (status.pendingChunks === 0) return status;
  }
  throw new Error('semantic fixture did not drain');
}

async function json(url, init) {
  const response = await fetch(url, init);
  return { response, body: await response.json() };
}

test('embedding vectors are normalized, binary-safe and deterministically bucketed', () => {
  const vector = normalizeEmbeddingVector([3, 4, 0, 0, 0, 0, 0, 0]);
  assert.ok(Math.abs(cosineSimilarity(vector, vector) - 1) < 1e-6);
  const hex = embeddingVectorHex(vector);
  assert.equal(hex.length, vector.length * 8);
  const restored = embeddingVectorFromHex(hex, vector.length);
  assert.ok(Math.abs(cosineSimilarity(vector, restored) - 1) < 1e-6);
  assert.deepEqual(embeddingBuckets(vector), embeddingBuckets(restored));
  assert.equal(embeddingBuckets(vector).length, SEMANTIC_SEARCH_HASH_BANDS);
  const fused = fuseHybridResults(
    Array.from({ length: 8 }, (_, index) => ({ id: `lexical-${index}`, chunkIndex: index })),
    [{ id: 'semantic-only', chunkIndex: 9, semanticScore: 0.8 }],
    6
  );
  assert.ok(fused.some((item) => item.id === 'semantic-only'));
  assert.throws(() => normalizeEmbeddingVector([1, 2]), /维度/);
  assert.throws(() => normalizeEmbeddingVector([1, 0, 0, 0, 0, 0, 0, Number.NaN]), /无效向量/);
});

test('Ollama embedding requests stay on the fixed loopback endpoint and reject redirects', async (t) => {
  const calls = [];
  const client = new OllamaEmbeddingClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ model: 'embeddinggemma', embeddings: [axis(0), axis(1)] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await client.embed(['first', 'second'], 'embeddinggemma');
  assert.equal(result.dimensions, 8);
  assert.equal(calls[0].url, SEMANTIC_SEARCH_ENDPOINT);
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(calls[0].body, {
    model: 'embeddinggemma',
    input: ['first', 'second'],
    truncate: false
  });
  assert.throws(() => new OllamaEmbeddingClient({ endpoint: 'http://localhost:11434/api/embed' }), /不可修改/);

  const targetRequests = [];
  const target = http.createServer((_request, response) => {
    targetRequests.push(true);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ embeddings: [axis(0)] }));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));
  const redirect = http.createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/embed` });
    response.end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => redirect.close(resolve)));
  const redirectingClient = new OllamaEmbeddingClient({
    fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${redirect.address().port}/api/embed`, init)
  });
  await assert.rejects(() => redirectingClient.embed(['safe test'], 'embeddinggemma'), /无法连接/);
  assert.deepEqual(targetRequests, []);

  const oversizedClient = new OllamaEmbeddingClient({
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      }
    }), { status: 200 })
  });
  await assert.rejects(() => oversizedClient.embed(['bounded test'], 'embeddinggemma'), /响应过大/);
});

test('optional semantic index follows chunk edits, mixes vector retrieval and deletes derived data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-semantic-'));
  const database = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const settingsStore = await new SettingsStore(path.join(root, 'settings.json')).initialize();
  const article = await database.createArticle({
    title: '安静的午后',
    source: '本地笔记',
    content: '# 休息\n\n小动物喜欢在洒满阳光的窗台蜷缩休息。'
  });
  const client = new SemanticFixtureClient();
  const service = createSemanticSearchService({ database, settingsStore, client, pollIntervalMs: 60_000 });
  await service.start();
  t.after(async () => {
    await service.stop();
    await rm(root, { recursive: true, force: true });
  });

  const lexicalOnly = await service.search('where do felines nap', { articleId: article.id });
  assert.deepEqual(lexicalOnly.citations, []);
  assert.equal(lexicalOnly.mode, 'local-lexical-v1');

  const enabled = await service.update({ enabled: true, model: 'embeddinggemma' });
  assert.equal(enabled.enabled, true);
  const ready = await drainAll(service);
  assert.equal(ready.pendingChunks, 0);
  assert.equal(ready.dimensions, 8);
  const hybrid = await service.search('where do felines nap', { articleId: article.id });
  assert.equal(hybrid.mode, 'local-hybrid-v1');
  assert.equal(hybrid.citations[0].articleId, article.id);
  assert.match(hybrid.citations[0].quote, /窗台/);
  const persisted = await database.one('SELECT count(*) AS vectors,(SELECT count(*) FROM chunk_embedding_buckets) AS buckets FROM chunk_embeddings;');
  assert.ok(Number(persisted.vectors) > 0);
  assert.equal(Number(persisted.buckets), Number(persisted.vectors) * SEMANTIC_SEARCH_HASH_BANDS);
  await database.execute('DELETE FROM chunk_embedding_buckets WHERE rowid=(SELECT min(rowid) FROM chunk_embedding_buckets);');
  assert.equal((await database.getChunkIndexStatus()).consistent, false);
  const rebuilt = await database.rebuildDerivedSearchIndexes();
  assert.equal(rebuilt.consistent, true);
  assert.equal(rebuilt.embeddingRows, 0);
  await drainAll(service);

  await database.updateArticle(article.id, { content: '# 休息\n\n小动物现在喜欢靠着温暖的壁炉打盹。' });
  assert.ok((await service.status()).pendingChunks > 0);
  await drainAll(service);
  const edited = await service.search('warm resting spot', { articleId: article.id });
  assert.match(edited.citations[0].quote, /壁炉/);
  assert.doesNotMatch(edited.citations[0].quote, /窗台/);

  client.fail = true;
  const fallback = await service.search('温暖的壁炉', { articleId: article.id });
  assert.equal(fallback.mode, 'local-lexical-fallback-v1');
  assert.match(fallback.citations[0].quote, /壁炉/);
  client.fail = false;

  await service.pause();
  client.dimensions = 10;
  const changedModel = await service.search('温暖的壁炉', { articleId: article.id });
  assert.equal(changedModel.mode, 'local-lexical-fallback-v1');
  assert.equal((await database.one('SELECT count(*) AS count FROM chunk_embeddings;')).count, 0);
  service.resume();
  await drainAll(service);
  assert.equal((await service.status()).dimensions, 10);

  const disabled = await service.update({ enabled: false, model: 'invalid model may not block deletion' });
  assert.equal(disabled.enabled, false);
  assert.equal((await database.one('SELECT count(*) AS count FROM chunk_embeddings;')).count, 0);
  assert.equal((await database.one('SELECT count(*) AS count FROM chunk_embedding_buckets;')).count, 0);
});

test('semantic settings API is opt-in, validates models and never needs an API key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-semantic-api-'));
  const client = new SemanticFixtureClient();
  const app = await createReaderServer({
    rootDir: root,
    dbPath: path.join(root, 'reader.sqlite3'),
    port: 0,
    embeddingClient: client,
    aiEnvironment: {}
  });
  const address = await app.listen();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}`;

  const initial = await json(`${base}/api/settings/semantic-search`);
  assert.equal(initial.body.settings.enabled, false);
  assert.equal(initial.body.settings.model, 'embeddinggemma');
  const tested = await json(`${base}/api/settings/semantic-search/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embeddinggemma' })
  });
  assert.deepEqual(tested.body.result, { ok: true, model: 'embeddinggemma', dimensions: 8 });
  const invalid = await json(`${base}/api/settings/semantic-search`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'true', model: 'embeddinggemma' })
  });
  assert.equal(invalid.response.status, 400);
  const enabled = await json(`${base}/api/settings/semantic-search`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, model: 'embeddinggemma' })
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.settings.enabled, true);
  assert.ok(client.requests.every((request) => request.model === 'embeddinggemma'));
  assert.doesNotMatch(JSON.stringify(client.requests), /api.?key|authorization/i);
});

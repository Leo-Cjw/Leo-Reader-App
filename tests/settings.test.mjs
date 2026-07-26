import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { AIService } from '../src/server/ai.mjs';
import { AI_PROVIDER_PRESETS, normalizeAIConfiguration } from '../src/server/ai-providers.mjs';
import { AISettingsManager } from '../src/server/ai-settings.mjs';
import { MacOSKeychainCredentialStore } from '../src/server/credentials.mjs';
import { createReaderServer } from '../src/server/server.mjs';
import { normalizeAIEndpoint, SettingsStore } from '../src/server/settings.mjs';

class MemoryCredentialStore {
  constructor() { this.value = null; }
  describe() { return { backend: 'memory-test', writable: true }; }
  async get() { return this.value; }
  async set(value) { this.value = value; }
  async delete() { const existed = Boolean(this.value); this.value = null; return existed; }
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

async function createGateway(t) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ summary: 'Reader gateway connection is healthy.', points: [], model: 'settings-contract-model' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${server.address().port}/gateway`, requests };
}

async function createCompatibleProvider(t, modelId) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: modelId, owned_by: 'test-provider' }] }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1/`, requests };
}

test('AI provider presets preserve legacy gateways and constrain direct-provider configuration', () => {
  assert.deepEqual(AI_PROVIDER_PRESETS.map((item) => item.id), [
    'reader-gateway', 'openai', 'ollama', 'openai-compatible'
  ]);
  assert.deepEqual(
    normalizeAIConfiguration({ enabled: true, endpoint: 'https://gateway.example/respond' }),
    { enabled: true, provider: 'reader-gateway', endpoint: 'https://gateway.example/respond', model: '' }
  );
  assert.deepEqual(
    normalizeAIConfiguration({ enabled: true, provider: 'openai', endpoint: '', model: 'account-model-1' }),
    { enabled: true, provider: 'openai', endpoint: 'https://api.openai.com/v1/', model: 'account-model-1' }
  );
  assert.deepEqual(
    normalizeAIConfiguration({ enabled: true, provider: 'openai', endpoint: 'https://api.openai.com/v1', model: 'account-model-1' }),
    { enabled: true, provider: 'openai', endpoint: 'https://api.openai.com/v1/', model: 'account-model-1' }
  );
  assert.deepEqual(
    normalizeAIConfiguration({ enabled: true, provider: 'ollama', endpoint: '', model: 'local/model:latest' }),
    { enabled: true, provider: 'ollama', endpoint: 'http://127.0.0.1:11434/v1/', model: 'local/model:latest' }
  );
  assert.throws(
    () => normalizeAIConfiguration({ enabled: true, provider: 'openai', endpoint: 'https://proxy.example/v1', model: 'model' }),
    /预设服务地址不可修改/
  );
  assert.throws(
    () => normalizeAIConfiguration({ enabled: true, provider: 'openai-compatible', endpoint: 'http://example.com/v1', model: 'model' }),
    /必须使用 HTTPS/
  );
  assert.throws(
    () => normalizeAIConfiguration({ enabled: true, provider: 'openai-compatible', endpoint: 'https://models.example/v1', model: 'bad model' }),
    /模型 ID/
  );
});

test('AI settings keep secrets out of the local settings file and enforce secure endpoints', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'data', 'settings.json');
  const settingsStore = await new SettingsStore(filePath).initialize();
  assert.deepEqual(settingsStore.getNotifications(), { enabled: false, sourceSyncEnabled: false, updatedAt: null });
  assert.deepEqual(settingsStore.getSpotlight(), { enabled: false, updatedAt: null });
  await settingsStore.saveImportQueue(true);
  await settingsStore.saveNotifications(true);
  await settingsStore.saveNotifications({ sourceSyncEnabled: true });
  const credentialStore = new MemoryCredentialStore();
  const aiService = new AIService({ endpoint: '', apiKey: '' });
  const manager = await new AISettingsManager({ settingsStore, credentialStore, aiService, environment: {} }).initialize();
  const gateway = await createGateway(t);

  const saved = await manager.update({ enabled: true, provider: 'reader-gateway', endpoint: gateway.endpoint, model: '', apiKey: 'keychain-only-secret' });
  assert.equal(saved.apiKeyStored, true);
  assert.equal(saved.apiKeySource, 'keychain');
  assert.equal(saved.provider, 'reader-gateway');
  assert.equal(saved.model, '');
  assert.equal(saved.providers.length, 4);
  assert.equal(aiService.status().remoteConfigured, true);
  assert.equal(credentialStore.value, 'keychain-only-secret');
  assert.equal(settingsStore.getImportQueue().paused, true);
  assert.equal(settingsStore.getNotifications().enabled, true);
  assert.equal(settingsStore.getNotifications().sourceSyncEnabled, true);
  assert.equal(settingsStore.getSpotlight().enabled, false);
  const disk = await readFile(filePath, 'utf8');
  assert.doesNotMatch(disk, /keychain-only-secret/);
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);

  const tested = await manager.test({ provider: 'reader-gateway', endpoint: gateway.endpoint, model: '' });
  assert.equal(tested.ok, true);
  assert.equal(tested.model, 'settings-contract-model');
  assert.equal(gateway.requests[0].body.action, 'summarize');
  assert.match(gateway.requests[0].body.article.content, /connection test/i);
  assert.equal(gateway.requests[0].authorization, 'Bearer keychain-only-secret');
  const switched = await manager.update({
    enabled: true,
    provider: 'ollama',
    endpoint: '',
    model: 'local/model:latest'
  });
  assert.equal(switched.provider, 'ollama');
  assert.equal(switched.apiKeyStored, false);
  assert.equal(credentialStore.value, null);
  assert.throws(() => normalizeAIEndpoint('http://example.com/ai'), /必须使用 HTTPS/);
  assert.throws(() => normalizeAIEndpoint('https://example.com/ai?api_key=secret'), /不能在查询参数中包含密钥/);
  assert.equal(normalizeAIEndpoint('http://localhost:1234/ai'), 'http://localhost:1234/ai');

  const unavailableKeychain = new MacOSKeychainCredentialStore({ platform: 'linux' });
  assert.deepEqual(unavailableKeychain.describe(), { backend: 'environment-only', writable: false });
  assert.equal(await unavailableKeychain.get(), null);
  await assert.rejects(() => unavailableKeychain.set('secret'), (error) => error.status === 501);

  const reset = await manager.reset();
  assert.equal(reset.configured, false);
  assert.equal(credentialStore.value, null);
  assert.equal(aiService.status().remoteConfigured, false);
  assert.equal(settingsStore.getImportQueue().paused, true);
  assert.equal(settingsStore.getNotifications().enabled, true);
  assert.equal(settingsStore.getNotifications().sourceSyncEnabled, true);
});

test('AI settings HTTP API updates runtime configuration without exposing the API key', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-settings-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialStore = new MemoryCredentialStore();
  const gateway = await createGateway(t);
  const app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0, credentialStore, aiEnvironment: {} });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const initial = await json(`${base}/api/settings/ai`);
  assert.equal(initial.body.settings.enabled, false);
  assert.equal(initial.body.settings.credentialBackend, 'memory-test');
  const updated = await json(`${base}/api/settings/ai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, provider: 'reader-gateway', endpoint: gateway.endpoint, model: '', api_key: 'route-secret' }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.settings.apiKeyStored, true);
  assert.equal(updated.body.status.remoteConfigured, true);
  assert.doesNotMatch(JSON.stringify(updated.body), /route-secret/);
  const invalidType = await json(`${base}/api/settings/ai`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: 'true', endpoint: gateway.endpoint }) });
  assert.equal(invalidType.response.status, 400);

  const connection = await json(`${base}/api/settings/ai/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'reader-gateway', endpoint: gateway.endpoint, model: '' }) });
  assert.equal(connection.body.result.ok, true);
  assert.equal(connection.body.result.model, 'settings-contract-model');
  const status = await json(`${base}/api/ai/status`);
  assert.equal(status.body.remoteConfigured, true);
  assert.equal(status.body.credentialBackend, 'memory-test');

  const publicSettings = await json(`${base}/api/settings/ai`);
  assert.equal(publicSettings.body.settings.endpoint, `${gateway.endpoint}`);
  assert.doesNotMatch(JSON.stringify(publicSettings.body), /route-secret/);
  const reset = await json(`${base}/api/settings/ai`, { method: 'DELETE' });
  assert.equal(reset.body.settings.configured, false);
  assert.equal(reset.body.status.remoteConfigured, false);
  assert.equal(credentialStore.value, null);
});

test('AI model catalog reuses a key only for the exact saved provider scope', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-model-catalog-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const savedProvider = await createCompatibleProvider(t, 'saved-model');
  const candidateProvider = await createCompatibleProvider(t, 'candidate-model');
  const credentialStore = new MemoryCredentialStore();
  const app = await createReaderServer({ rootDir: dir, dbPath: path.join(dir, 'reader.sqlite3'), port: 0, credentialStore, aiEnvironment: {} });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const saved = await json(`${base}/api/settings/ai`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      provider: 'openai-compatible',
      endpoint: savedProvider.endpoint,
      model: 'saved-model',
      api_key: 'scope-bound-secret'
    })
  });
  assert.equal(saved.response.status, 200);

  const catalog = await json(`${base}/api/settings/ai/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai-compatible', endpoint: savedProvider.endpoint, model: 'saved-model' })
  });
  assert.deepEqual(catalog.body.models, [{ id: 'saved-model', ownedBy: 'test-provider' }]);
  assert.equal(savedProvider.requests[0].authorization, 'Bearer scope-bound-secret');
  assert.doesNotMatch(JSON.stringify(catalog.body), /scope-bound-secret/);

  const candidate = await json(`${base}/api/settings/ai/models`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai-compatible', endpoint: candidateProvider.endpoint, model: 'candidate-model' })
  });
  assert.deepEqual(candidate.body.models, [{ id: 'candidate-model', ownedBy: 'test-provider' }]);
  assert.equal(candidateProvider.requests[0].authorization, undefined);
  assert.equal(credentialStore.value, 'scope-bound-secret');
});

test('legacy settings remain compatible and malformed values cannot opt into notifications', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-settings-compatibility-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'data', 'settings.json');
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    version: 1,
    ai: { configured: false, enabled: false, endpoint: '', hasApiKey: false, updatedAt: null },
    imports: { paused: true, updatedAt: '2026-07-24T00:00:00.000Z' }
  }));
  const legacy = await new SettingsStore(filePath).initialize();
  assert.equal(legacy.getImportQueue().paused, true);
  assert.deepEqual(legacy.getNotifications(), { enabled: false, sourceSyncEnabled: false, updatedAt: null });
  assert.deepEqual(legacy.getSpotlight(), { enabled: false, updatedAt: null });

  await writeFile(filePath, JSON.stringify({
    version: 1,
    ai: { configured: false, enabled: false, endpoint: '', hasApiKey: false, updatedAt: null },
    imports: { paused: false, updatedAt: null },
    notifications: { enabled: 'true', sourceSyncEnabled: 'true', updatedAt: 123 }
  }));
  const malformed = await new SettingsStore(filePath).initialize();
  assert.deepEqual(malformed.getNotifications(), { enabled: false, sourceSyncEnabled: false, updatedAt: null });
  assert.deepEqual(malformed.getSpotlight(), { enabled: false, updatedAt: null });
});

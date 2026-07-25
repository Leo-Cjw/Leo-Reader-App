import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnosticErrorCategory, diagnosticRoute, LocalDiagnosticsStore } from '../src/server/diagnostics.mjs';
import { ReaderDatabase } from '../src/server/db.mjs';
import { createReaderServer } from '../src/server/server.mjs';

test('local diagnostics are permission-restricted, bounded and strip all non-allowlisted fields', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-diagnostics-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await new LocalDiagnosticsStore(root, { maxBytes: 1024, maxFiles: 3 }).initialize();
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  assert.equal(await store.record('unknown_event', { secret: 'must not persist' }), false);
  await store.record('app_started', {
    version: '0.20.0',
    schemaVersion: 9,
    restored: false,
    title: 'Private article title',
    path: '/Users/private/Reader',
    apiKey: 'sk-private'
  });
  for (let index = 0; index < 30; index += 1) {
    await store.record('api_error', {
      method: 'POST',
      route: 'articles',
      status: 500,
      category: 'database',
      message: `private content ${index}`
    });
  }
  await store.record('restore_scheduled', {
    source: 'migration_snapshot',
    encrypted: false,
    snapshotId: 'private-snapshot-id',
    path: '/private/migration.sqlite3'
  });
  await store.record('renderer_gone', {
    reason: 'oom',
    exitCode: 137,
    path: '/Users/private/renderer'
  });
  await appendFile(store.filePath, `${JSON.stringify({
    id: '00000000-0000-4000-8000-000000000000',
    timestamp: new Date().toISOString(),
    level: 'error',
    event: 'api_error',
    details: { method: 'POST', route: 'articles', status: 500, category: 'internal', path: '/private/tampered', title: 'secret title' }
  })}\n`);

  const result = await store.list(500);
  const serialized = JSON.stringify(result);
  assert.equal(result.available, true);
  assert.ok(result.file_count <= 3);
  assert.ok(result.byte_size <= result.max_bytes);
  assert.ok(result.entries.length > 0);
  assert.doesNotMatch(serialized, /Private article|Users\/private|sk-private|private content|private\/tampered|secret title/);
  assert.deepEqual(
    Object.keys(result.entries.find((entry) => entry.id === '00000000-0000-4000-8000-000000000000').details).sort(),
    ['category', 'method', 'route', 'status']
  );
  assert.deepEqual(result.entries.find((entry) => entry.event === 'restore_scheduled').details, { source: 'migration_snapshot', encrypted: false });
  assert.deepEqual(result.entries.find((entry) => entry.event === 'renderer_gone').details, { reason: 'oom' });
  assert.doesNotMatch((await store.exportJSONL()).toString('utf8'), /private|secret|apiKey/i);

  assert.equal(await store.clear(), true);
  const cleared = await store.list();
  assert.equal(cleared.entries.length, 0);
  assert.equal(cleared.byte_size, 0);
  assert.equal(cleared.file_count, 1);
});

test('diagnostic categories never retain raw paths, ids or error text', () => {
  assert.equal(diagnosticRoute('/api/articles/private-record-id/revisions'), 'articles');
  assert.equal(diagnosticRoute('/api/stats'), 'stats');
  assert.equal(diagnosticRoute('/api/diagnostics/logs'), 'diagnostics');
  assert.equal(diagnosticRoute('/private/path'), 'static');
  assert.equal(diagnosticErrorCategory(Object.assign(new Error('SQLITE_BUSY private title'), { code: 'SQLITE_BUSY' })), 'database');
  assert.equal(diagnosticErrorCategory(Object.assign(new Error('/Users/private missing'), { code: 'ENOENT' })), 'filesystem');
  assert.equal(diagnosticErrorCategory(Object.assign(new Error('secret'), { status: 400 })), 'request');
});

test('diagnostics API exposes sanitized local events, downloadable JSONL and a real clear operation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-diagnostics-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createReaderServer({ rootDir: root, dbPath: path.join(root, 'data', 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const originalStats = app.database.stats.bind(app.database);
  app.database.stats = async () => { throw new Error('Private article title at /Users/private/reader.sqlite3 with sk-secret'); };

  const failed = await fetch(`${base}/api/stats`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: '无法完成请求' });
  app.database.stats = originalStats;
  const backup = await fetch(`${base}/api/backups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted: false })
  });
  assert.equal(backup.status, 201);

  const listed = await fetch(`${base}/api/diagnostics/logs`);
  const body = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(body.diagnostics.available, true);
  assert.ok(body.diagnostics.entries.some((entry) => entry.event === 'app_started'));
  assert.ok(body.diagnostics.entries.some((entry) => entry.event === 'backup_created'));
  const apiError = body.diagnostics.entries.find((entry) => entry.event === 'api_error');
  assert.deepEqual(apiError.details, { method: 'GET', route: 'stats', status: 500, category: 'database' });
  assert.doesNotMatch(JSON.stringify(body), /Private article|Users\/private|sk-secret/);

  const download = await fetch(`${base}/api/diagnostics/logs/download`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  assert.match(download.headers.get('content-disposition') || '', /reader-diagnostics-/);
  assert.doesNotMatch(await download.text(), /Private article|Users\/private|sk-secret/);

  const cleared = await fetch(`${base}/api/diagnostics/logs`, { method: 'DELETE' });
  assert.deepEqual(await cleared.json(), { cleared: true });
  const after = await (await fetch(`${base}/api/diagnostics/logs`)).json();
  assert.equal(after.diagnostics.entries.length, 0);
});

test('startup failures leave a sanitized local diagnostic even when the server cannot open', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-diagnostics-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'data', 'reader.sqlite3');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const future = new ReaderDatabase(dbPath);
  await future.execute(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version,applied_at) VALUES (999,'2026-01-01');`);

  await assert.rejects(createReaderServer({ rootDir: root, dbPath, port: 0 }), /高于当前 Reader 支持/);

  const diagnostics = await new LocalDiagnosticsStore(root).initialize();
  const result = await diagnostics.list();
  const failure = result.entries.find((entry) => entry.event === 'startup_failed');
  assert.deepEqual(failure.details, { phase: 'database', category: 'database' });
  assert.doesNotMatch(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

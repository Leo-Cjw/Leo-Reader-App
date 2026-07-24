import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listMigrationSnapshots, ReaderDatabase, resolveMigrationSnapshot } from '../src/server/db.mjs';
import { createSourceScheduler, createSourceSyncService } from '../src/server/source-sync.mjs';

async function temporaryDatabase(t, prefix = 'reader-source-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
}

test('schema v8 migrates legacy source rows, builds chunks and schedules every connector safely', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-source-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new ReaderDatabase(path.join(dir, 'reader.sqlite3'));
  await db.execute(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version,applied_at) VALUES (7,'2026-01-01');
  CREATE TABLE sources (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, last_fetched_at TEXT, last_error TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  INSERT INTO sources(id,kind,title,url,created_at,updated_at) VALUES ('legacy','rss','旧订阅','https://example.com/feed.xml','2026-01-01','2026-01-01');`);
  await db.initialize();
  assert.deepEqual(
    { fromVersion: db.lastMigrationSnapshot.fromVersion, toVersion: db.lastMigrationSnapshot.toVersion },
    { fromVersion: 7, toVersion: 8 }
  );
  assert.equal((await stat(path.dirname(db.lastMigrationSnapshot.path))).mode & 0o777, 0o700);
  assert.equal((await stat(db.lastMigrationSnapshot.path)).mode & 0o777, 0o600);
  const listedSnapshots = await listMigrationSnapshots(db.path);
  assert.equal(listedSnapshots.length, 1);
  assert.deepEqual(
    { from: listedSnapshots[0].from_schema_version, to: listedSnapshots[0].to_schema_version, bytes: listedSnapshots[0].byte_size > 0 },
    { from: 7, to: 8, bytes: true }
  );
  assert.equal((await resolveMigrationSnapshot(db.path, listedSnapshots[0].id)).path, db.lastMigrationSnapshot.path);
  assert.equal(await resolveMigrationSnapshot(db.path, '../reader.sqlite3'), null);
  const snapshot = new ReaderDatabase(db.lastMigrationSnapshot.path);
  assert.equal((await snapshot.one('SELECT max(version) AS version FROM schema_migrations;')).version, 7);
  assert.equal((await snapshot.one("SELECT title FROM sources WHERE id='legacy';")).title, '旧订阅');
  assert.equal((await snapshot.query('PRAGMA table_info(sources);')).some((column) => column.name === 'sync_cursor'), false);
  const source = await db.getSource('legacy');
  assert.equal(source.sync_interval_minutes, 60);
  assert.equal(source.last_status, 'idle');
  assert.ok(source.next_fetch_at);
  assert.ok((await db.listDueSources(new Date(Date.now() + 60_000).toISOString())).some((item) => item.id === 'legacy'));
  assert.equal((await db.one('SELECT max(version) AS version FROM schema_migrations;')).version, 8);
  assert.equal((await db.getChunkIndexStatus()).pendingArticles, 0);
});

test('database refuses to open a newer schema without modifying it', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-source-downgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new ReaderDatabase(path.join(dir, 'reader.sqlite3'));
  await db.execute(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version,applied_at) VALUES (9,'2026-01-01');
  CREATE TABLE future_data (value TEXT NOT NULL);
  INSERT INTO future_data(value) VALUES ('preserve-me');`);

  await assert.rejects(db.initialize(), /schema v9.*v8.*拒绝降级/);
  assert.equal((await db.one('SELECT value FROM future_data;')).value, 'preserve-me');
  assert.equal((await db.one('SELECT max(version) AS version FROM schema_migrations;')).version, 9);
});

test('source sync imports once, honors HTTP 304 and resets health state', async (t) => {
  const db = await temporaryDatabase(t);
  const source = await db.createSource({ kind: 'rss', title: '产品博客', url: 'https://example.com/feed.xml', syncIntervalMinutes: 30 });
  let request = 0;
  const service = createSourceSyncService(db, {
    fetchFeed: async (_url, cache) => {
      request += 1;
      if (request === 1) {
        assert.deepEqual(cache, { etag: '', lastModified: '' });
        return {
          title: '产品博客', notModified: false,
          items: [{ id: 'feed-entry-1', url: 'https://example.com/one', title: '第一篇', source: '产品博客', type: 'rss', content: '第一篇正文' }],
          response: { status: 200, etag: '"v1"', lastModified: 'Wed, 22 Jul 2026 00:00:00 GMT' }
        };
      }
      assert.equal(cache.etag, '"v1"');
      return { title: '', items: [], notModified: true, response: { status: 304, etag: '"v1"' } };
    }
  });
  const first = await service.syncSource(source.id);
  assert.deepEqual({ imported: first.imported, total: first.total, notModified: first.notModified }, { imported: 1, total: 1, notModified: false });
  assert.equal((await db.getSource(source.id)).last_status, 'ok');
  const second = await service.syncSource(source.id);
  assert.equal(second.notModified, true);
  const updated = await db.getSource(source.id);
  assert.equal(updated.last_status, 'not_modified');
  assert.equal(updated.last_http_status, 304);
  assert.equal((await db.listArticles()).filter((article) => article.url === 'https://example.com/one').length, 1);
});

test('source failures are observable and back off without changing the configured interval', async (t) => {
  const db = await temporaryDatabase(t);
  const source = await db.createSource({ kind: 'rss', title: '暂时离线', url: 'https://example.com/offline.xml', syncIntervalMinutes: 15 });
  const service = createSourceSyncService(db, { fetchFeed: async () => { const error = new Error('远程服务器返回 503'); error.httpStatus = 503; throw error; } });
  await assert.rejects(service.syncSource(source.id), /503/);
  const failed = await db.getSource(source.id);
  assert.equal(failed.last_status, 'error');
  assert.equal(failed.consecutive_failures, 1);
  assert.equal(failed.last_http_status, 503);
  assert.equal(failed.sync_interval_minutes, 15);
  assert.ok(new Date(failed.next_fetch_at).getTime() >= Date.now() + 14 * 60_000);
});

test('scheduler only runs enabled sources that are due', async (t) => {
  const db = await temporaryDatabase(t);
  const due = await db.createSource({ kind: 'rss', title: '到期', url: 'https://example.com/due.xml' });
  const disabled = await db.createSource({ kind: 'rss', title: '暂停', url: 'https://example.com/disabled.xml' });
  await db.updateSource(disabled.id, { enabled: false, next_fetch_at: null });
  const seen = [];
  const scheduler = createSourceScheduler(db, { syncSource: async (source) => { seen.push(source.id); await db.updateSource(source.id, { next_fetch_at: '2099-01-01T00:00:00.000Z', last_status: 'ok' }); } });
  t.after(() => scheduler.stop());
  const result = await scheduler.runDueSources();
  assert.equal(result.synced, 1);
  assert.deepEqual(seen, [due.id]);
});

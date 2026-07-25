import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listMigrationSnapshots, ReaderDatabase, resolveMigrationSnapshot } from '../src/server/db.mjs';
import { schemaSQL } from '../src/server/schema.mjs';
import { createSourceScheduler, createSourceSyncService } from '../src/server/source-sync.mjs';

async function temporaryDatabase(t, prefix = 'reader-source-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
}

test('sequential migrations preserve a v7 snapshot, audit v8-v11 and remain idempotent', async (t) => {
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
    { fromVersion: 7, toVersion: 11 }
  );
  assert.equal((await stat(path.dirname(db.lastMigrationSnapshot.path))).mode & 0o777, 0o700);
  assert.equal((await stat(db.lastMigrationSnapshot.path)).mode & 0o777, 0o600);
  const listedSnapshots = await listMigrationSnapshots(db.path);
  assert.equal(listedSnapshots.length, 1);
  assert.deepEqual(
    { from: listedSnapshots[0].from_schema_version, to: listedSnapshots[0].to_schema_version, bytes: listedSnapshots[0].byte_size > 0 },
    { from: 7, to: 11, bytes: true }
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
  assert.equal((await db.one('SELECT max(version) AS version FROM schema_migrations;')).version, 11);
  assert.deepEqual(db.appliedMigrations.map((migration) => migration.version), [8, 9, 10, 11]);
  const audit = await db.query('SELECT version,name,checksum FROM schema_migration_audit ORDER BY version;');
  assert.deepEqual(audit.map(({ version, name }) => ({ version, name })), [
    { version: 8, name: 'v8-smart-collections-and-source-state' },
    { version: 9, name: 'v9-migration-audit' },
    { version: 10, name: 'v10-library-pagination-indexes' },
    { version: 11, name: 'v11-spotlight-index-outbox' }
  ]);
  assert.ok(audit.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum)));
  assert.equal((await db.getChunkIndexStatus()).pendingArticles, 0);

  const reopened = await new ReaderDatabase(db.path).initialize();
  assert.equal(reopened.lastMigrationSnapshot, null);
  assert.deepEqual(reopened.appliedMigrations, []);
  assert.equal((await reopened.one('SELECT count(*) AS count FROM schema_migration_audit;')).count, 4);
});

test('database refuses to open a newer schema without modifying it', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-source-downgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new ReaderDatabase(path.join(dir, 'reader.sqlite3'));
  await db.execute(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  INSERT INTO schema_migrations(version,applied_at) VALUES (12,'2026-01-01');
  CREATE TABLE future_data (value TEXT NOT NULL);
  INSERT INTO future_data(value) VALUES ('preserve-me');`);

  await assert.rejects(db.initialize(), /schema v12.*v11.*拒绝降级/);
  assert.equal((await db.one('SELECT value FROM future_data;')).value, 'preserve-me');
  assert.equal((await db.one('SELECT max(version) AS version FROM schema_migrations;')).version, 12);
});

test('schema v8 upgrades to v11 without changing user data', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-source-v8-to-v11-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new ReaderDatabase(path.join(dir, 'reader.sqlite3'));
  await db.execute(schemaSQL);
  await db.execute(`INSERT INTO schema_migrations(version,applied_at) VALUES (8,'2026-01-01');
  INSERT INTO collections(id,name,position,created_at,updated_at) VALUES ('kept','保留资料夹',0,'2026-01-01','2026-01-01');
  INSERT INTO articles(id,title,content,collection_id,created_at,updated_at)
  VALUES ('kept-article','升级前文章','不可丢失的正文','kept','2026-01-01','2026-01-01');`);

  await db.initialize();
  assert.deepEqual(
    { fromVersion: db.lastMigrationSnapshot.fromVersion, toVersion: db.lastMigrationSnapshot.toVersion },
    { fromVersion: 8, toVersion: 11 }
  );
  assert.deepEqual(db.appliedMigrations.map((migration) => migration.version), [9, 10, 11]);
  assert.equal((await db.one("SELECT content FROM articles WHERE id='kept-article';")).content, '不可丢失的正文');
  assert.equal((await db.one('SELECT max(version) AS version FROM schema_migrations;')).version, 11);
  assert.deepEqual((await db.query('SELECT version FROM schema_migration_audit ORDER BY version;')).map((row) => row.version), [8, 9, 10, 11]);
  const snapshot = new ReaderDatabase(db.lastMigrationSnapshot.path);
  assert.equal((await snapshot.one('SELECT max(version) AS version FROM schema_migrations;')).version, 8);
  assert.equal((await snapshot.one("SELECT content FROM articles WHERE id='kept-article';")).content, '不可丢失的正文');
});

test('a failed v9 migration rolls back its schema version and audit writes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-source-v9-rollback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = new ReaderDatabase(path.join(dir, 'reader.sqlite3'));
  await db.execute(schemaSQL);
  await db.execute(`INSERT INTO schema_migrations(version,applied_at) VALUES (8,'2026-01-01');
  CREATE TABLE schema_migration_audit (wrong_column TEXT NOT NULL);
  INSERT INTO schema_migration_audit(wrong_column) VALUES ('preserve-me');`);

  await assert.rejects(db.initialize(), /schema_migration_audit already exists/);
  assert.equal((await db.one('SELECT max(version) AS version FROM schema_migrations;')).version, 8);
  assert.equal((await db.one('SELECT wrong_column FROM schema_migration_audit;')).wrong_column, 'preserve-me');
  assert.deepEqual(await db.query('SELECT version FROM schema_migrations ORDER BY version;'), [{ version: 8 }]);
  assert.deepEqual(
    { fromVersion: db.lastMigrationSnapshot.fromVersion, toVersion: db.lastMigrationSnapshot.toVersion },
    { fromVersion: 8, toVersion: 11 }
  );
});

test('a modified migration audit fails closed before changing a current database', async (t) => {
  const db = await temporaryDatabase(t, 'reader-source-audit-tamper-');
  await db.execute(`UPDATE schema_migration_audit SET checksum='${'0'.repeat(64)}' WHERE version=8;`);
  const before = await stat(db.path);
  const reopened = new ReaderDatabase(db.path);

  await assert.rejects(reopened.initialize(), /schema v8.*审计记录不匹配/);
  assert.equal(reopened.lastMigrationSnapshot, null);
  assert.equal((await reopened.one('SELECT max(version) AS version FROM schema_migrations;')).version, 11);
  assert.equal((await reopened.one('SELECT checksum FROM schema_migration_audit WHERE version=8;')).checksum, '0'.repeat(64));
  assert.equal((await stat(db.path)).size, before.size);
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
  await scheduler.pause();
  await db.updateSource(due.id, { next_fetch_at: new Date().toISOString(), last_status: 'idle' });
  assert.deepEqual(await scheduler.runDueSources(), { synced: 0 });
  assert.deepEqual(seen, [due.id]);
  scheduler.resume();
  assert.equal((await scheduler.runDueSources()).synced, 1);
  assert.deepEqual(seen, [due.id, due.id]);
});

test('scheduler reports one aggregate-only summary for automatic source batches', async (t) => {
  const db = await temporaryDatabase(t);
  await db.createSource({ kind: 'rss', title: 'Private Product Feed', url: 'https://private.example/product.xml' });
  await db.createSource({ kind: 'rss', title: 'Private News Feed', url: 'https://private.example/news.xml' });
  await db.createSource({ kind: 'rss', title: 'Private Failed Feed', url: 'https://private.example/failed.xml' });
  const summaries = [];
  let call = 0;
  const scheduler = createSourceScheduler(db, {
    syncSource: async (source) => {
      call += 1;
      await db.updateSource(source.id, { next_fetch_at: '2099-01-01T00:00:00.000Z' });
      if (call === 3) throw new Error(`credential failed for ${source.title}`);
      return {
        imported: call === 1 ? 2 : 0,
        title: source.title,
        url: source.url,
        error: '/Users/private/source.xml'
      };
    }
  }, {
    onBatchFinished: (summary) => summaries.push(summary)
  });
  t.after(() => scheduler.stop());

  assert.deepEqual(await scheduler.runDueSources(), { synced: 3 });
  assert.deepEqual(summaries, [{ imported: 2, failed: 1 }]);
  assert.doesNotMatch(JSON.stringify(summaries), /Private|private|example|credential|Users|title|url|error|id/i);
  assert.deepEqual(await scheduler.runDueSources(), { synced: 0 });
  assert.equal(summaries.length, 1);
});

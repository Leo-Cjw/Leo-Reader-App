import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { listMigrationSnapshots, ReaderDatabase, resolveMigrationSnapshot } from '../src/server/db.mjs';
import { schemaSQL } from '../src/server/schema.mjs';
import { applyPendingRestore, createBackup, getPendingRestore, listBackups, resolveBackup, scheduleMigrationSnapshotRestore, scheduleRestore, validateBackupEntryPath, validateBackupPassphrase } from '../src/server/backup.mjs';

test('backup entry paths reject traversal, absolute paths and unknown files', () => {
  assert.equal(validateBackupEntryPath('files/image.png'), 'files/image.png');
  assert.throws(() => validateBackupEntryPath('../outside.txt'), /不安全路径/);
  assert.throws(() => validateBackupEntryPath('/etc/passwd'), /不安全路径/);
  assert.throws(() => validateBackupEntryPath('unexpected.js'), /未知文件/);
});

test('backup passphrases require a durable minimum length', () => {
  assert.throws(() => validateBackupPassphrase('short'), /至少需要 12 个字符/);
  assert.equal(validateBackupPassphrase('correct horse battery staple'), 'correct horse battery staple');
});

test('complete backup is validated and restored on the next startup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'data', 'reader.sqlite3');
  const db = await new ReaderDatabase(dbPath).initialize();
  const original = await db.createArticle({ id: 'backup-original', title: 'Before backup', content: 'Durable content before backup.' });
  const originalHighlight = await db.createHighlight({ articleId: original.id, quote: 'Durable content', note: 'Keep this interpretation', color: 'green', startOffset: 0, endOffset: 15 });
  const originalSmartCollection = await db.createSmartCollection({ name: '耐久内容', rule: { query: 'Durable content before backup.' } });
  const filesDir = path.join(root, 'data', 'files');
  await mkdir(filesDir, { recursive: true });
  await writeFile(path.join(filesDir, 'sample.bin'), 'attachment-before-backup');
  const backup = await createBackup({ database: db, rootDir: root, appVersion: '0.3.0' });
  assert.equal(backup.manifest.counts.articles, 4);
  assert.equal((await listBackups(root)).length, 1);
  const resolved = await resolveBackup(root, backup.id);
  assert.ok(resolved?.path);

  await db.createArticle({ id: 'after-backup', title: 'After backup', content: 'This record must disappear after restore.' });
  const archive = await readFile(resolved.path);
  const request = Readable.from([archive]);
  request.headers = { 'content-length': String(archive.length) };
  const marker = await scheduleRestore({ request, database: db, rootDir: root, appVersion: '0.3.0' });
  assert.ok(marker.safetyBackupId);
  assert.ok(await getPendingRestore(root));
  assert.equal((await listBackups(root)).length, 2);

  const applied = await applyPendingRestore({ rootDir: root, dbPath });
  assert.equal(applied.manifest.format, 'reader-local-backup');
  const restored = await new ReaderDatabase(dbPath).initialize();
  assert.equal((await restored.getArticle(original.id)).title, 'Before backup');
  assert.deepEqual((await restored.listHighlights(original.id)).map((highlight) => ({ id: highlight.id, note: highlight.note, color: highlight.color })), [{ id: originalHighlight.id, note: 'Keep this interpretation', color: 'green' }]);
  assert.deepEqual((await restored.listSmartCollections()).map((collection) => ({ id: collection.id, name: collection.name, query: collection.rule.query, count: collection.article_count })), [{ id: originalSmartCollection.id, name: '耐久内容', query: 'Durable content before backup.', count: 1 }]);
  assert.equal(await restored.getArticle('after-backup'), null);
  assert.equal(await getPendingRestore(root), null);
  assert.equal(await readFile(path.join(filesDir, 'sample.bin'), 'utf8'), 'attachment-before-backup');
});

test('migration snapshot restore preserves files, backs up current data and remigrates on restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-migration-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'data', 'reader.sqlite3');
  await mkdir(path.dirname(dbPath), { recursive: true });
  const legacy = new ReaderDatabase(dbPath);
  await legacy.execute(schemaSQL);
  await legacy.execute(`INSERT INTO schema_migrations(version,applied_at) VALUES (8,'2026-01-01');
  INSERT INTO collections(id,name,position,created_at,updated_at) VALUES ('legacy','升级前资料',0,'2026-01-01','2026-01-01');
  INSERT INTO articles(id,title,content,collection_id,created_at,updated_at)
  VALUES ('before-upgrade','升级前文章','需要从迁移快照保留的正文','legacy','2026-01-01','2026-01-01');`);
  const database = await legacy.initialize();
  await database.createArticle({ id: 'after-upgrade', title: '升级后文章', content: '安排回滚前仍须进入安全备份。' });
  const filesDir = path.join(root, 'data', 'files');
  await mkdir(filesDir, { recursive: true });
  await writeFile(path.join(filesDir, 'preserved.bin'), 'attachment-bytes-stay-in-place');

  const snapshot = await resolveMigrationSnapshot(dbPath, (await listMigrationSnapshots(dbPath))[0].id);
  const marker = await scheduleMigrationSnapshotRestore({ database, snapshot, rootDir: root, appVersion: '0.21.0' });
  assert.deepEqual(
    {
      kind: marker.kind,
      snapshotId: marker.snapshotId,
      from: marker.fromSchemaVersion,
      to: marker.toSchemaVersion,
      hasPrivatePath: Boolean(marker.pendingDir),
      hash: /^[0-9a-f]{64}$/.test(marker.databaseSha256)
    },
    { kind: 'migration_snapshot', snapshotId: snapshot.id, from: 8, to: 9, hasPrivatePath: true, hash: true }
  );
  assert.equal((await stat(path.join(marker.pendingDir, 'migration-snapshot.sqlite3'))).mode & 0o777, 0o600);
  const safetyBackup = await resolveBackup(root, marker.safetyBackupId);
  assert.ok(safetyBackup?.path);
  assert.equal((await listBackups(root)).length, 1);

  const applied = await applyPendingRestore({ rootDir: root, dbPath });
  assert.deepEqual(
    { kind: applied.kind, snapshotId: applied.snapshotId, from: applied.fromSchemaVersion, safetyBackupId: applied.safetyBackupId },
    { kind: 'migration_snapshot', snapshotId: snapshot.id, from: 8, safetyBackupId: marker.safetyBackupId }
  );
  const restored = await new ReaderDatabase(dbPath).initialize();
  assert.equal((await restored.one('SELECT max(version) AS version FROM schema_migrations;')).version, 9);
  assert.equal((await restored.getArticle('before-upgrade')).content, '需要从迁移快照保留的正文');
  assert.equal(await restored.getArticle('after-upgrade'), null);
  assert.equal(await readFile(path.join(filesDir, 'preserved.bin'), 'utf8'), 'attachment-bytes-stay-in-place');
  assert.equal(await getPendingRestore(root), null);

  const safetyArchive = await readFile(safetyBackup.path);
  const request = Readable.from([safetyArchive]);
  request.headers = { 'content-length': String(safetyArchive.length) };
  await scheduleRestore({ request, database: restored, rootDir: root, appVersion: '0.21.0' });
  await applyPendingRestore({ rootDir: root, dbPath });
  const recoveredCurrent = await new ReaderDatabase(dbPath).initialize();
  assert.equal((await recoveredCurrent.getArticle('after-upgrade')).content, '安排回滚前仍须进入安全备份。');
  assert.equal(await readFile(path.join(filesDir, 'preserved.bin'), 'utf8'), 'attachment-bytes-stay-in-place');
});

test('migration snapshot restore rejects incompatible or changed snapshots before replacement', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-migration-restore-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'data', 'reader.sqlite3');
  const database = await new ReaderDatabase(dbPath).initialize();
  const snapshotPath = path.join(root, 'reader-before-schema-v8-to-v10-2026-01-01T00-00-00-000Z-00000000-0000-4000-8000-000000000000.sqlite3');
  await writeFile(snapshotPath, 'not sqlite');
  await assert.rejects(
    scheduleMigrationSnapshotRestore({
      database,
      rootDir: root,
      appVersion: '0.21.0',
      snapshot: {
        id: '00000000-0000-4000-8000-000000000000',
        path: snapshotPath,
        from_schema_version: 8,
        to_schema_version: 10
      }
    }),
    /更新版本|schema v10/
  );
  assert.equal(await getPendingRestore(root), null);
  assert.equal((await listBackups(root)).length, 0);

  await database.createArticle({ id: 'current-safe', title: '当前资料', content: '快照损坏时不得替换。' });
  const migrationDirectory = path.join(path.dirname(dbPath), 'migration-backups');
  await mkdir(migrationDirectory, { recursive: true });
  const compatiblePath = path.join(migrationDirectory, 'reader-before-schema-v8-to-v9-2026-01-01T00-00-00-000Z-11111111-1111-4111-8111-111111111111.sqlite3');
  const compatible = new ReaderDatabase(compatiblePath);
  await compatible.execute(schemaSQL);
  await compatible.execute("INSERT INTO schema_migrations(version,applied_at) VALUES (8,'2026-01-01');");
  const marker = await scheduleMigrationSnapshotRestore({
    database,
    rootDir: root,
    appVersion: '0.21.0',
    snapshot: {
      id: '11111111-1111-4111-8111-111111111111',
      path: compatiblePath,
      from_schema_version: 8,
      to_schema_version: 9
    }
  });
  await writeFile(path.join(marker.pendingDir, 'migration-snapshot.sqlite3'), 'changed after validation');
  await assert.rejects(applyPendingRestore({ rootDir: root, dbPath }), /校验值不一致|完整性检查失败/);
  assert.equal((await database.getArticle('current-safe')).content, '快照损坏时不得替换。');
  assert.equal((await getPendingRestore(root)).kind, 'migration_snapshot');
});

test('encrypted backup authenticates the full archive and restores only with the correct passphrase', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-encrypted-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, 'data', 'reader.sqlite3');
  const db = await new ReaderDatabase(dbPath).initialize();
  await db.createArticle({ id: 'encrypted-original', title: 'Private backup content', content: 'This plaintext must not be visible in the encrypted archive.' });
  const passphrase = 'correct horse battery staple';
  const backup = await createBackup({ database: db, rootDir: root, appVersion: '0.5.0', passphrase });
  assert.equal(backup.encrypted, true);
  assert.match(backup.file_name, /\.readerbackup\.enc$/);
  assert.equal((await listBackups(root))[0].encrypted, true);
  const resolved = await resolveBackup(root, backup.id);
  const encrypted = await readFile(resolved.path);
  assert.equal(encrypted.subarray(0, 8).toString('ascii'), 'RDRBKENC');
  assert.equal(encrypted.includes(Buffer.from('Private backup content')), false);

  const wrongRequest = Readable.from([encrypted]);
  wrongRequest.headers = { 'content-length': String(encrypted.length) };
  await assert.rejects(scheduleRestore({ request: wrongRequest, database: db, rootDir: root, appVersion: '0.5.0', passphrase: 'this is the wrong passphrase' }), /口令错误或加密文件已损坏/);
  assert.equal(await getPendingRestore(root), null);

  const tampered = Buffer.from(encrypted);
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  const tamperedRequest = Readable.from([tampered]);
  tamperedRequest.headers = { 'content-length': String(tampered.length) };
  await assert.rejects(scheduleRestore({ request: tamperedRequest, database: db, rootDir: root, appVersion: '0.5.0', passphrase }), /口令错误或加密文件已损坏/);
  assert.equal(await getPendingRestore(root), null);

  await db.createArticle({ id: 'encrypted-after', title: 'Created after backup', content: 'This record should be removed by restore.' });
  const correctRequest = Readable.from([encrypted]);
  correctRequest.headers = { 'content-length': String(encrypted.length) };
  const marker = await scheduleRestore({ request: correctRequest, database: db, rootDir: root, appVersion: '0.5.0', passphrase });
  assert.equal(marker.encrypted, true);
  await applyPendingRestore({ rootDir: root, dbPath });
  const restored = await new ReaderDatabase(dbPath).initialize();
  assert.equal((await restored.getArticle('encrypted-original')).title, 'Private backup content');
  assert.equal(await restored.getArticle('encrypted-after'), null);
});

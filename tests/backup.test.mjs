import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { ReaderDatabase } from '../src/server/db.mjs';
import { applyPendingRestore, createBackup, getPendingRestore, listBackups, resolveBackup, scheduleRestore, validateBackupEntryPath, validateBackupPassphrase } from '../src/server/backup.mjs';

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

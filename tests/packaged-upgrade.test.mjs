import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReaderDatabase } from '../src/server/db.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fixtureRoot = path.join(projectRoot, 'tests', 'fixtures', 'upgrade-0.43');
const manifest = JSON.parse(await readFile(path.join(fixtureRoot, 'manifest.json'), 'utf8'));

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sqliteJSON(databasePath, sql) {
  const output = execFileSync('/usr/bin/sqlite3', ['-json', databasePath, sql], { encoding: 'utf8' }).trim();
  return output ? JSON.parse(output) : [];
}

async function fixtureFiles(directory = fixtureRoot) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await fixtureFiles(absolute));
    else if (entry.isFile()) files.push(path.relative(fixtureRoot, absolute).split(path.sep).join('/'));
  }
  return files;
}

test('frozen 0.43 packaged database remains self-consistent and auditable', async (t) => {
  assert.equal(manifest.format, 'reader-packaged-upgrade-fixture');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.createdBy.appVersion, '0.43.0');
  assert.equal(manifest.createdBy.schemaVersion, 11);
  assert.equal(manifest.createdBy.sourceCommit, 'c829243c41aec2910dcd1f01809ed65db1ef9ec0');
  assert.deepEqual(
    (await fixtureFiles()).filter((file) => file !== 'manifest.json').sort(),
    manifest.fixtureFiles.map((file) => file.path).sort()
  );

  for (const file of manifest.fixtureFiles) {
    const bytes = await readFile(path.join(fixtureRoot, file.path));
    assert.equal(bytes.length, file.byteSize, file.path);
    assert.equal(sha256(bytes), file.sha256, file.path);
  }

  const sqliteRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-upgrade-fixture-test-'));
  t.after(() => rm(sqliteRoot, { recursive: true, force: true }));
  const databasePath = path.join(sqliteRoot, 'reader.sqlite3');
  await copyFile(path.join(fixtureRoot, 'data', 'reader.sqlite3'), databasePath);
  assert.equal(execFileSync('/usr/bin/sqlite3', [
    databasePath,
    'PRAGMA integrity_check; PRAGMA foreign_key_check;'
  ], { encoding: 'utf8' }).trim(), 'ok');
  assert.deepEqual(
    sqliteJSON(databasePath, 'SELECT version FROM schema_migrations ORDER BY version;').map((row) => row.version),
    [8, 9, 10, 11]
  );

  const article = sqliteJSON(databasePath, `SELECT id,title,excerpt,content,collection_id,is_favorite,is_read,reading_progress
    FROM articles WHERE id='${manifest.expected.article.id}';`)[0];
  assert.deepEqual(article, {
    id: manifest.expected.article.id,
    title: manifest.expected.article.title,
    excerpt: manifest.expected.article.excerpt,
    content: manifest.expected.article.content,
    collection_id: manifest.expected.article.collectionId,
    is_favorite: 1,
    is_read: 1,
    reading_progress: manifest.expected.article.readingProgress
  });
  assert.deepEqual(
    sqliteJSON(databasePath, `SELECT t.name FROM article_tags at JOIN tags t ON t.id=at.tag_id
      WHERE at.article_id='${manifest.expected.article.id}' ORDER BY t.name;`).map((row) => row.name),
    manifest.expected.article.tags
  );
  assert.equal(
    sqliteJSON(databasePath, `SELECT count(*) AS count FROM highlights WHERE id='${manifest.expected.highlight.id}';`)[0].count,
    1
  );
  assert.deepEqual(
    sqliteJSON(databasePath, `SELECT version,title,content FROM article_revisions
      WHERE article_id='${manifest.expected.article.id}' ORDER BY version DESC;`),
    manifest.expected.revisions
  );
  const job = sqliteJSON(databasePath, `SELECT status,payload_json FROM import_jobs
    WHERE id='${manifest.expected.importQueue.jobId}';`)[0];
  assert.equal(job.status, 'pending');
  assert.equal(JSON.parse(job.payload_json).url, manifest.expected.importQueue.url);

  const settings = JSON.parse(await readFile(path.join(fixtureRoot, 'data', 'settings.json'), 'utf8'));
  assert.equal(settings.imports.paused, true);
  assert.equal(settings.notifications.enabled, true);
  assert.equal(settings.notifications.sourceSyncEnabled, true);
  assert.equal(settings.ai.endpoint, '');
  assert.equal(settings.ai.hasApiKey, false);
  assert.doesNotMatch(JSON.stringify(settings), /"apiKey"\s*:|"bearer_token"\s*:|"password"\s*:|"secret"\s*:/i);
});

test('current Reader migrates the frozen schema v11 database to v12 without creating opt-in vectors', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-upgrade-v11-v12-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'reader.sqlite3');
  await copyFile(path.join(fixtureRoot, 'data', 'reader.sqlite3'), databasePath);
  const database = await new ReaderDatabase(databasePath).initialize();
  assert.deepEqual(
    { from: database.lastMigrationSnapshot?.fromVersion, to: database.lastMigrationSnapshot?.toVersion },
    { from: 11, to: 12 }
  );
  assert.equal((await database.one('SELECT max(version) AS version FROM schema_migrations;')).version, 12);
  assert.equal((await database.one('SELECT count(*) AS count FROM schema_migration_audit;')).count, 5);
  assert.equal((await database.getArticle(manifest.expected.article.id)).content, manifest.expected.article.content);
  assert.equal((await database.one('SELECT count(*) AS count FROM chunk_embeddings;')).count, 0);
  assert.equal((await database.one('SELECT count(*) AS count FROM chunk_embedding_buckets;')).count, 0);
});

test('macOS release runs loopback, accessibility, Share and upgrade gates before producing the DMG', async () => {
  for (const script of [
    'verify-packaged-loopback.mjs',
    'verify-packaged-accessibility.mjs',
    'verify-packaged-share.mjs',
    'verify-packaged-upgrade.mjs'
  ]) execFileSync(process.execPath, ['--check', path.join(projectRoot, 'scripts', script)]);
  const releaseScript = await readFile(path.join(projectRoot, 'scripts', 'build-mac-release.mjs'), 'utf8');
  const loopback = releaseScript.indexOf('verify-packaged-loopback.mjs');
  const accessibility = releaseScript.indexOf('verify-packaged-accessibility.mjs');
  const share = releaseScript.indexOf('verify-packaged-share.mjs');
  const upgrade = releaseScript.indexOf('verify-packaged-upgrade.mjs');
  const formalPreflight = releaseScript.indexOf('readGitSourceState(projectRoot).trackedChanges');
  const applicationBuild = releaseScript.indexOf("run('npm', ['run', 'build'])");
  const dmg = releaseScript.indexOf('build-mac-dmg.mjs');
  const update = releaseScript.indexOf('build-mac-update.mjs');
  const manifest = releaseScript.lastIndexOf('writeMacReleaseManifest({');
  assert.ok(loopback >= 0);
  assert.ok(accessibility > loopback);
  assert.ok(share > accessibility);
  assert.ok(upgrade > share);
  assert.ok(formalPreflight >= 0 && applicationBuild > formalPreflight);
  assert.ok(dmg > upgrade);
  assert.ok(update > dmg);
  assert.ok(manifest > update);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { ReaderDatabase } from '../src/server/db.mjs';
import { SettingsStore } from '../src/server/settings.mjs';
import { createSpotlightService, runSpotlightHelper } from '../src/server/spotlight.mjs';
import { createReaderServer } from '../src/server/server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-spotlight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const database = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const settingsStore = await new SettingsStore(path.join(root, 'settings.json')).initialize();
  return { root, database, settingsStore };
}

test('Spotlight outbox keeps newer revisions and represents archives and deletes safely', async (t) => {
  const { database } = await fixture(t);
  await database.clearSpotlightOutbox();
  const article = await database.createArticle({
    id: 'spotlight-outbox',
    title: 'Spotlight queue',
    content: 'Original local content.'
  });
  await database.addTags(article.id, ['本地索引']);
  const [stale] = await database.listSpotlightChanges();
  assert.equal(stale.operation, 'upsert');
  assert.deepEqual(stale.tags, ['本地索引']);

  await database.updateArticle(article.id, { title: 'Newer title' });
  await database.acknowledgeSpotlightChanges([{ id: stale.id, revision: stale.revision }]);
  const [newer] = await database.listSpotlightChanges();
  assert.equal(newer.title, 'Newer title');
  assert.ok(newer.revision > stale.revision);

  await database.updateArticle(article.id, { archived: true });
  assert.equal((await database.listSpotlightChanges())[0].operation, 'delete');
  await database.execute("DELETE FROM articles WHERE id='spotlight-outbox';");
  assert.equal((await database.listSpotlightChanges())[0].operation, 'delete');
});

test('Spotlight service is opt-in, sends bounded batches, retries and deletes its system index on disable', async (t) => {
  const { database, settingsStore } = await fixture(t);
  await database.clearSpotlightOutbox();
  const article = await database.createArticle({
    id: 'spotlight-service',
    title: 'Local system search',
    excerpt: 'A private excerpt',
    content: 'x'.repeat(25_000)
  });
  const calls = [];
  let failApply = false;
  const service = createSpotlightService({
    database,
    settingsStore,
    platform: 'darwin',
    helperPath: '/Applications/Reader Spotlight Helper',
    pollIntervalMs: 60_000,
    runHelper: async (payload) => {
      calls.push(payload);
      if (payload.command === 'apply' && failApply) throw new Error('private helper failure');
      if (payload.command === 'apply') {
        return {
          ok: true,
          available: true,
          applied: payload.items.filter((item) => item.operation === 'upsert').length,
          deleted: payload.items.filter((item) => item.operation === 'delete').length
        };
      }
      if (payload.command === 'delete-all') return { ok: true, available: true, deleted: 1 };
      return { ok: true, available: true };
    }
  });
  t.after(() => service.stop());
  const initial = await service.start();
  assert.equal(initial.enabled, false);
  assert.deepEqual(calls, []);

  const enabled = await service.update(true);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.state, 'ready');
  const indexed = calls.find((call) => call.command === 'apply' && call.items.some((item) => item.id === article.id));
  assert.equal(indexed.items.find((item) => item.id === article.id).content.length, 20_000);
  assert.equal(await database.countSpotlightChanges(), 0);

  failApply = true;
  await database.updateArticle(article.id, { title: 'Retry me' });
  await service.drain();
  assert.equal((await service.status()).state, 'error');
  assert.equal(await database.countSpotlightChanges(), 1);
  failApply = false;
  await service.drain();
  assert.equal(await database.countSpotlightChanges(), 0);

  const disabled = await service.update(false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.state, 'disabled');
  assert.equal(calls.at(-1).command, 'delete-all');
  assert.equal((await readFile(path.join(path.dirname(settingsStore.filePath), 'settings.json'), 'utf8')).includes('"enabled": false'), true);
});

test('an existing Spotlight opt-in resumes without delaying Reader startup', async (t) => {
  const { database, settingsStore } = await fixture(t);
  await settingsStore.saveSpotlight(true);
  let releaseAvailability;
  let finishApply;
  const availability = new Promise((resolve) => { releaseAvailability = resolve; });
  const applied = new Promise((resolve) => { finishApply = resolve; });
  const service = createSpotlightService({
    database,
    settingsStore,
    platform: 'darwin',
    helperPath: '/Applications/Reader Spotlight Helper',
    pollIntervalMs: 60_000,
    runHelper: async (payload) => {
      if (payload.command === 'availability') {
        await availability;
        return { ok: true, available: true };
      }
      if (payload.command === 'apply') {
        finishApply();
        return {
          ok: true,
          applied: payload.items.filter((item) => item.operation === 'upsert').length,
          deleted: payload.items.filter((item) => item.operation === 'delete').length
        };
      }
      return { ok: true, deleted: 1 };
    }
  });
  t.after(() => service.stop());

  const started = await service.start();
  assert.equal(started.state, 'starting');
  releaseAvailability();
  await applied;
  await service.drain();
  assert.equal((await service.status()).state, 'ready');
  assert.equal(await database.countSpotlightChanges(), 0);
});

test('Spotlight HTTP settings fail closed when the signed helper is unavailable', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-spotlight-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = await createReaderServer({ rootDir: root, dbPath: path.join(root, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const initial = await fetch(`${base}/api/settings/spotlight`).then((response) => response.json());
  assert.equal(initial.settings.enabled, false);
  assert.equal(initial.settings.available, false);
  const invalid = await fetch(`${base}/api/settings/spotlight`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'true' })
  });
  assert.equal(invalid.status, 400);
  const unavailable = await fetch(`${base}/api/settings/spotlight`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await app.spotlight.status()).enabled, false);
});

test('Spotlight helper runner keeps content off argv and bounds failures, output and runtime', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-spotlight-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const makeHelper = async (name, source) => {
    const helper = path.join(root, name);
    await writeFile(helper, `#!/bin/sh\n${source}\n`);
    await chmod(helper, 0o700);
    return helper;
  };
  const valid = await makeHelper('valid', `[ "$#" -eq 0 ] || exit 9
payload=$(/bin/cat)
case "$payload" in *private-content-only-on-stdin*) /usr/bin/printf '{"ok":true}\\n';; *) exit 8;; esac`);
  assert.deepEqual(
    await runSpotlightHelper(valid, { command: 'apply', content: 'private-content-only-on-stdin' }, { platform: 'darwin' }),
    { ok: true }
  );

  const failed = await makeHelper('failed', `/usr/bin/printf 'private title and path' >&2
exit 7`);
  await assert.rejects(
    runSpotlightHelper(failed, { command: 'availability' }, { platform: 'darwin' }),
    (error) => /Spotlight 索引操作失败/.test(error.message) && !/private title|path/.test(error.message)
  );

  const oversized = await makeHelper('oversized', `/usr/bin/yes x | /usr/bin/head -c 70000`);
  await assert.rejects(
    runSpotlightHelper(oversized, { command: 'availability' }, { platform: 'darwin' }),
    /超过安全限制/
  );

  const hanging = await makeHelper('hanging', `/bin/sleep 2`);
  await assert.rejects(
    runSpotlightHelper(hanging, { command: 'availability' }, { platform: 'darwin', timeoutMs: 20 }),
    /操作超时/
  );
});

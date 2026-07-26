import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createImportNotificationController, createSourceSyncNotificationController } from '../desktop/notifications.mjs';
import { createReaderServer } from '../src/server/server.mjs';

class FakeNotification extends EventEmitter {
  static instances = [];
  static supported = true;

  static isSupported() {
    return FakeNotification.supported;
  }

  constructor(options) {
    super();
    this.options = options;
    this.shown = false;
    this.closed = false;
    FakeNotification.instances.push(this);
  }

  show() {
    this.shown = true;
  }

  close() {
    if (this.throwOnClose) throw new Error('native close failed');
    this.closed = true;
    this.emit('close');
  }
}

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

async function waitForJob(base, id) {
  const deadline = Date.now() + 5_000;
  let job;
  do {
    job = (await json(`${base}/api/import-jobs/${id}`)).body.job;
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() < deadline);
  assert.fail(`import job ${id} did not finish`);
}

async function waitFor(condition, message, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(message);
}

test('desktop notifications aggregate counts, omit content and open the import queue on click', () => {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  const actions = [];
  const controller = createImportNotificationController({
    Notification: FakeNotification,
    shouldNotify: () => true,
    onClick: () => actions.push('queue')
  });

  assert.equal(controller.show({
    completed: 2,
    failed: 1,
    title: 'Private article title',
    url: 'https://private.example/article',
    error: '/Users/private/Reader/file.md'
  }), true);
  assert.equal(FakeNotification.instances.length, 1);
  const first = FakeNotification.instances[0];
  assert.equal(first.shown, true);
  assert.deepEqual(first.options, {
    title: 'Reader 导入任务已处理',
    body: '已保存 2 项，1 项失败；可打开导入队列查看详情。',
    silent: true
  });
  assert.doesNotMatch(JSON.stringify(first.options), /Private|private|example|Users|file\.md/);

  assert.equal(controller.show({ completed: 1, failed: 0 }), true);
  assert.equal(first.closed, true);
  const second = FakeNotification.instances[1];
  second.throwOnClose = true;
  second.emit('click');
  assert.deepEqual(actions, ['queue']);
  assert.equal(second.closed, false);
  assert.equal(controller.show({ completed: 1, failed: 0 }), true);
  assert.equal(FakeNotification.instances.length, 3);

  FakeNotification.supported = false;
  assert.equal(controller.show({ completed: 1, failed: 0 }), false);
  assert.equal(FakeNotification.instances.length, 3);
  assert.equal(createImportNotificationController({
    Notification: FakeNotification,
    shouldNotify: () => false,
    onClick() { assert.fail('foreground notification must not open the queue'); }
  }).show({ completed: 1, failed: 0 }), false);
});

test('source sync notifications omit source details, ignore empty batches and open Sources on click', () => {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  const actions = [];
  const controller = createSourceSyncNotificationController({
    Notification: FakeNotification,
    shouldNotify: () => true,
    onClick: () => actions.push('sources')
  });

  assert.equal(controller.show({
    imported: 3,
    failed: 1,
    sourceId: 'private-source-id',
    title: 'Private Feed',
    url: 'https://private.example/feed.xml',
    error: 'secret credential failed'
  }), true);
  assert.deepEqual(FakeNotification.instances[0].options, {
    title: 'Reader 订阅已更新',
    body: '已保存 3 条新内容，1 个订阅同步失败；可打开内容来源查看详情。',
    silent: true
  });
  assert.doesNotMatch(JSON.stringify(FakeNotification.instances[0].options), /Private|private|example|credential|source-id/);
  FakeNotification.instances[0].emit('click');
  assert.deepEqual(actions, ['sources']);

  assert.equal(controller.show({ imported: 0, failed: 0 }), false);
  assert.equal(FakeNotification.instances.length, 1);
  assert.equal(controller.show({ imported: 1000, failed: 500 }), true);
  assert.match(FakeNotification.instances[1].options.body, /99 条.*99 个/);
  assert.equal(createSourceSyncNotificationController({
    Notification: FakeNotification,
    shouldNotify: () => false
  }).show({ imported: 1, failed: 0 }), false);
  assert.equal(FakeNotification.instances.length, 2);
});

test('import notifications are off by default, persist explicit opt-in and expose only batch counts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-notifications-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const app = await createReaderServer({
    rootDir: root,
    dbPath: path.join(root, 'reader.sqlite3'),
    port: 0,
    onImportBatchFinished: (summary) => events.push(summary)
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const initial = await json(`${base}/api/settings/notifications`);
  assert.deepEqual(initial.body.settings, { enabled: false, sourceSyncEnabled: false, updatedAt: null });
  const firstUpload = await json(`${base}/api/import-jobs/upload`, {
    method: 'POST',
    headers: { 'content-type': 'text/markdown', 'x-reader-filename': encodeURIComponent('Private First Note.md') },
    body: '# Private first note\n\nDefault-off notifications must not receive this content.'
  });
  assert.equal((await waitForJob(base, firstUpload.body.job.id)).status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, []);

  const invalid = await json(`${base}/api/settings/notifications`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'true' })
  });
  assert.equal(invalid.response.status, 400);

  const enabled = await json(`${base}/api/settings/notifications`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.settings.enabled, true);
  assert.equal(enabled.body.settings.sourceSyncEnabled, false);
  assert.match(enabled.body.settings.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const sourceEnabled = await json(`${base}/api/settings/notifications`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceSyncEnabled: true })
  });
  assert.equal(sourceEnabled.response.status, 200);
  assert.equal(sourceEnabled.body.settings.enabled, true);
  assert.equal(sourceEnabled.body.settings.sourceSyncEnabled, true);

  await json(`${base}/api/import-jobs/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true })
  });
  const completedUpload = await json(`${base}/api/import-jobs/upload`, {
    method: 'POST',
    headers: { 'content-type': 'text/markdown', 'x-reader-filename': encodeURIComponent('Private Completed Note.md') },
    body: '# Private completed note\n\nOnly an aggregate count may leave the server.'
  });
  const failedJob = await app.database.createImportJob('attachment', {
    stagingFile: path.join(root, 'missing-private-input.md'),
    fileName: 'Private Failed Note.md',
    mimeType: 'text/markdown',
    byteSize: 123,
    collectionId: 'notes'
  });
  await json(`${base}/api/import-jobs/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: false })
  });

  assert.equal((await waitForJob(base, completedUpload.body.job.id)).status, 'completed');
  assert.equal((await waitForJob(base, failedJob.id)).status, 'failed');
  const deadline = Date.now() + 2_000;
  while (!events.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(events, [{ completed: 1, failed: 1 }]);
  assert.doesNotMatch(JSON.stringify(events), /Private|missing|input|title|url|error|id/i);

  const disk = JSON.parse(await readFile(path.join(root, 'data', 'settings.json'), 'utf8'));
  assert.equal(disk.notifications.enabled, true);
  assert.equal(disk.notifications.sourceSyncEnabled, true);
  assert.doesNotMatch(JSON.stringify(disk.notifications), /Private|missing|input/);
});

test('source notifications require their own opt-in and exclude manual syncs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-source-notifications-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let fetchCount = 0;
  const socialConnectors = {
    async fetchSource(source) {
      fetchCount += 1;
      return {
        title: source.title,
        items: [{
          id: `private-source-entry-${fetchCount}`,
          url: `https://private.example/entry-${fetchCount}`,
          title: `Private source entry ${fetchCount}`,
          source: source.title,
          type: 'x',
          content: `Private source content ${fetchCount}`
        }],
        response: { status: 200 }
      };
    }
  };
  const app = await createReaderServer({
    rootDir: root,
    dbPath: path.join(root, 'reader.sqlite3'),
    port: 0,
    socialConnectors,
    onSourceSyncBatchFinished: (summary) => events.push(summary)
  });
  const source = await app.database.createSource({
    kind: 'x',
    title: 'Private source account',
    url: 'https://x.com/private-account'
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  await waitFor(async () => (await app.database.getSource(source.id))?.last_status === 'ok', 'default-off source sync did not finish');
  await app.setBackgroundWorkState({ suspended: true });
  assert.equal(fetchCount, 1);
  assert.deepEqual(events, []);

  const enabled = await json(`${base}/api/settings/notifications`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceSyncEnabled: true })
  });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.body.settings.enabled, false);
  assert.equal(enabled.body.settings.sourceSyncEnabled, true);

  await app.database.updateSource(source.id, { next_fetch_at: new Date().toISOString() });
  await app.close();

  const optedInApp = await createReaderServer({
    rootDir: root,
    dbPath: path.join(root, 'reader.sqlite3'),
    port: 0,
    socialConnectors,
    onSourceSyncBatchFinished: (summary) => events.push(summary)
  });
  const optedInAddress = await optedInApp.listen();
  t.after(() => optedInApp.close());
  const optedInBase = `http://127.0.0.1:${optedInAddress.port}`;
  await waitFor(() => fetchCount >= 2 && events.length >= 1, 'opted-in source notification did not arrive');
  await optedInApp.setBackgroundWorkState({ suspended: true });
  assert.equal(fetchCount, 2);
  assert.deepEqual(events, [{ imported: 1, failed: 0 }]);

  const beforeManualFetchCount = fetchCount;
  const manual = await json(`${optedInBase}/api/sources/${source.id}/sync`, { method: 'POST' });
  assert.equal(manual.response.status, 200);
  assert.equal(manual.body.imported, 1);
  assert.equal(fetchCount, beforeManualFetchCount + 1);
  assert.deepEqual(events, [{ imported: 1, failed: 0 }]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReaderServer } from '../src/server/server.mjs';

async function json(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return { response, body };
}

async function startReader(rootDir) {
  const app = await createReaderServer({ rootDir, dbPath: path.join(rootDir, 'reader.sqlite3'), port: 0 });
  const address = await app.listen();
  return { app, base: `http://127.0.0.1:${address.port}` };
}

test('manual import pause persists across restart and pending work resumes safely', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-import-pause-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let running = await startReader(root);
  t.after(async () => { await running?.app.close().catch(() => {}); });

  const paused = await json(`${running.base}/api/import-jobs/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: true })
  });
  assert.equal(paused.response.status, 200);
  assert.equal(paused.body.background.importUserPaused, true);
  assert.equal(paused.body.background.importsPaused, true);
  assert.deepEqual(paused.body.background.importPauseReasons, ['user']);
  assert.equal(paused.body.background.sourceSyncPaused, false);

  const invalid = await json(`${running.base}/api/import-jobs/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: 'true' })
  });
  assert.equal(invalid.response.status, 400);

  const upload = await json(`${running.base}/api/import-jobs/upload`, {
    method: 'POST',
    headers: { 'content-type': 'text/markdown', 'x-reader-filename': encodeURIComponent('Paused Note.md') },
    body: '# Paused Note\n\nThis import must remain pending until the user resumes the queue.'
  });
  assert.equal(upload.response.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal((await json(`${running.base}/api/import-jobs/${upload.body.job.id}`)).body.job.status, 'pending');

  await running.app.close();
  running = null;
  running = await startReader(root);
  const restoredHealth = await json(`${running.base}/api/health`);
  assert.equal(restoredHealth.body.background.importUserPaused, true);
  assert.equal(restoredHealth.body.background.importsPaused, true);
  assert.equal((await json(`${running.base}/api/import-jobs/${upload.body.job.id}`)).body.job.status, 'pending');

  const resumed = await json(`${running.base}/api/import-jobs/state`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paused: false })
  });
  assert.equal(resumed.response.status, 200);
  assert.equal(resumed.body.background.importUserPaused, false);
  assert.equal(resumed.body.background.importsPaused, false);

  let job = upload.body.job;
  const deadline = Date.now() + 5_000;
  while (job.status !== 'completed' && job.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = (await json(`${running.base}/api/import-jobs/${job.id}`)).body.job;
  }
  assert.equal(job.status, 'completed', job.error || 'resumed import did not complete');
  const article = (await json(`${running.base}/api/articles/${job.result_article_id}`)).body.article;
  assert.match(article.content, /remain pending until the user resumes/);

  const settingsPath = path.join(root, 'data', 'settings.json');
  const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
  assert.equal(settings.imports.paused, false);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

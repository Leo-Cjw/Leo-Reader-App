import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createSharedFileManager, SHARED_FILE_TTL_MS, standardShareStagingRoot } from '../desktop/shared-files.mjs';

async function stageFixture(root, bytes, {
  token = randomUUID(),
  fileName = 'Reader 分享.md',
  mimeType = 'text/markdown',
  sha256 = createHash('sha256').update(bytes).digest('hex'),
  createdAt = new Date().toISOString()
} = {}) {
  const payload = path.join(root, `${token}.payload`);
  const manifest = path.join(root, `${token}.json`);
  await writeFile(payload, bytes, { mode: 0o600 });
  await writeFile(manifest, JSON.stringify({
    version: 1,
    token,
    fileName,
    mimeType,
    byteSize: bytes.length,
    sha256,
    createdAt
  }), { mode: 0o600 });
  await chmod(payload, 0o600);
  await chmod(manifest, 0o600);
  return { token, payload, manifest };
}

test('shared file manager verifies a private staged file and consumes it through the existing upload endpoint', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-shared-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('# Reader 分享\n\n确认后导入。');
  const staged = await stageFixture(root, bytes);
  let request;
  const manager = createSharedFileManager({
    stagingRoot: root,
    appOrigin: 'http://127.0.0.1:43123',
    fetchImpl: async (url, init) => {
      const chunks = [];
      for await (const chunk of init.body) chunks.push(chunk);
      request = { url, init, body: Buffer.concat(chunks) };
      return new Response(JSON.stringify({
        job: { id: 'shared-job', kind: 'attachment', status: 'pending' }
      }), { status: 202, headers: { 'content-type': 'application/json' } });
    }
  });

  assert.deepEqual(await manager.inspect(staged.token), {
    token: staged.token,
    name: 'Reader 分享.md',
    size: bytes.length,
    mimeType: 'text/markdown'
  });
  assert.equal((await lstat(root)).mode & 0o777, 0o700);

  const job = await manager.upload(staged.token, 'notes');
  assert.equal(job.id, 'shared-job');
  assert.equal(request.url, 'http://127.0.0.1:43123/api/import-jobs/upload?collection=notes');
  assert.equal(request.init.headers['content-length'], String(bytes.length));
  assert.equal(request.init.headers['content-type'], 'text/markdown');
  assert.equal(decodeURIComponent(request.init.headers['x-reader-filename']), 'Reader 分享.md');
  assert.deepEqual(request.body, bytes);
  await assert.rejects(readFile(staged.payload));
  await assert.rejects(readFile(staged.manifest));
});

test('shared file manager rejects malformed, tampered, public or linked staging entries', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-shared-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = createSharedFileManager({
    stagingRoot: root,
    appOrigin: 'http://127.0.0.1:43124',
    fetchImpl: async () => { throw new Error('不应上传'); }
  });

  await assert.rejects(() => manager.inspect('../escape'), /标识无效/);
  const missing = randomUUID();
  await assert.rejects(
    () => manager.inspect(missing),
    (error) => error.message === '分享文件不可用或已经过期' && !error.message.includes(root)
  );
  const tampered = await stageFixture(root, Buffer.from('actual'), { sha256: '0'.repeat(64) });
  await assert.rejects(() => manager.inspect(tampered.token), /完整性校验失败/);

  const publicFile = await stageFixture(root, Buffer.from('private'));
  await chmod(publicFile.payload, 0o644);
  await assert.rejects(() => manager.inspect(publicFile.token), /暂存状态无效/);

  const linked = await stageFixture(root, Buffer.from('linked'));
  await rm(linked.payload);
  await symlink(publicFile.payload, linked.payload);
  await assert.rejects(() => manager.inspect(linked.token));

  const expired = await stageFixture(root, Buffer.from('expired'), {
    createdAt: new Date(Date.now() - SHARED_FILE_TTL_MS - 1).toISOString()
  });
  await assert.rejects(() => manager.inspect(expired.token), /已过期/);

  const targetRoot = path.join(root, 'target-root');
  const linkedRoot = path.join(root, 'linked-root');
  await writeFile(targetRoot, 'not-a-directory', { mode: 0o644 });
  await symlink(targetRoot, linkedRoot);
  const linkedRootManager = createSharedFileManager({
    stagingRoot: linkedRoot,
    appOrigin: 'http://127.0.0.1:43124'
  });
  await assert.rejects(() => linkedRootManager.cleanupExpired());
  assert.equal((await lstat(targetRoot)).mode & 0o777, 0o644);
});

test('failed uploads remain retryable while explicit discard and TTL cleanup remove both staged files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-shared-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const failed = await stageFixture(root, Buffer.from('retry'));
  const manager = createSharedFileManager({
    stagingRoot: root,
    appOrigin: 'http://127.0.0.1:43125',
    now: () => now,
    fetchImpl: async () => new Response(JSON.stringify({ error: '队列暂时不可用' }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })
  });
  await assert.rejects(() => manager.upload(failed.token), /分享文件导入失败/);
  assert.equal((await readFile(failed.payload, 'utf8')), 'retry');
  assert.equal(await manager.discard(failed.token), true);
  await assert.rejects(readFile(failed.payload));
  await assert.rejects(readFile(failed.manifest));

  const expired = await stageFixture(root, Buffer.from('expired'));
  const old = new Date(now - SHARED_FILE_TTL_MS - 1);
  await utimes(expired.payload, old, old);
  await utimes(expired.manifest, old, old);
  assert.equal(await manager.cleanupExpired(), 1);
  await assert.rejects(readFile(expired.payload));
  await assert.rejects(readFile(expired.manifest));
});

test('standard staging root is confined to the Share Extension cache container', () => {
  assert.equal(
    standardShareStagingRoot('/Users/reader'),
    '/Users/reader/Library/Containers/com.reader.localfirst.share-extension/Data/Library/Caches/ReaderShareStaging'
  );
});

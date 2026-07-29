import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TranscriptionService, WHISPER_MODEL } from '../desktop/transcription-service.mjs';

test('native transcription helper uses the stable CPU backend and emits bounded progress events', async () => {
  const source = await readFile(new URL('../native/transcription-helper/main.swift', import.meta.url), 'utf8');
  assert.match(source, /contextParameters\.use_gpu = false/);
  assert.match(source, /parameters\.progress_callback =/);
  assert.match(source, /ProgressResponse\(version: 1, event: "progress"/);
  assert.match(source, /Response\(version: 1, event: "result"/);
});

test('transcription model is explicit, fixed and unavailable before download', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-transcription-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, 'Reader Transcription Helper');
  await writeFile(helper, '#!/bin/sh\nexit 0\n');
  await chmod(helper, 0o700);
  const service = new TranscriptionService({ rootDir: root, helperPath: helper, systemVersion: '14.0' });
  const status = await service.status();
  assert.equal(status.available, true);
  assert.equal(status.installed, false);
  assert.equal(status.model, 'whisper-small-multilingual');
  assert.equal(status.byteSize, WHISPER_MODEL.byteSize);
  assert.match(WHISPER_MODEL.source, /c521a4b02f422512d734391fdf08bb08c0862f68/);
  assert.match(WHISPER_MODEL.sha256, /^[0-9a-f]{64}$/);
});

test('transcription model rejects unsupported macOS and hash failures without leaving partial files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-transcription-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, 'Reader Transcription Helper');
  await writeFile(helper, '#!/bin/sh\nexit 0\n');
  await chmod(helper, 0o700);
  let fetches = 0;
  const oldSystem = new TranscriptionService({
    rootDir: root,
    helperPath: helper,
    systemVersion: '13.2',
    fetchImpl: async () => { fetches += 1; return new Response('bad'); }
  });
  assert.equal((await oldSystem.status()).systemSupported, false);
  await assert.rejects(oldSystem.downloadModel(), /macOS 13\.3/);
  assert.equal(fetches, 0);

  const service = new TranscriptionService({
    rootDir: root,
    helperPath: helper,
    systemVersion: '14.0',
    fetchImpl: async () => new Response('not-the-model', {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '13' }
    })
  });
  await assert.rejects(service.downloadModel(), /SHA-256/);
  const modelDir = path.join(root, 'models', 'transcription');
  await mkdir(modelDir, { recursive: true });
  assert.deepEqual((await readdir(modelDir)).filter((name) => name.endsWith('.partial')), []);
  assert.equal((await service.status()).installed, false);
});

test('transcription helper streams bounded progress before returning timestamped segments', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-transcription-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, 'Reader Transcription Helper');
  await writeFile(helper, `#!/bin/sh
printf '%s\\n' '{"version":1,"event":"progress","progress":5}'
printf '%s\\n' '{"version":1,"event":"progress","progress":67}'
printf '%s\\n' '{"version":1,"event":"result","segments":[{"startMs":1000,"endMs":3250,"text":"本地转写进度"}]}'
`);
  await chmod(helper, 0o700);
  const filesDir = path.join(root, 'data', 'files');
  const modelDir = path.join(root, 'models', 'transcription');
  await mkdir(filesDir, { recursive: true });
  await mkdir(modelDir, { recursive: true });
  const mediaPath = path.join(filesDir, 'media.mp4');
  await writeFile(mediaPath, 'verified media');
  const service = new TranscriptionService({ rootDir: root, helperPath: helper, systemVersion: '14.0' });
  service.verifyInstalledModel = async () => {};
  const progress = [];
  const segments = await service.transcribe(mediaPath, {
    onProgress(value) { progress.push(value); }
  });
  assert.deepEqual(progress, [5, 67]);
  assert.deepEqual(segments, [{ startMs: 1000, endMs: 3250, text: '本地转写进度' }]);
});

test('transcription helper rejects unknown events and duplicate results', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-transcription-protocol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesDir = path.join(root, 'data', 'files');
  await mkdir(filesDir, { recursive: true });
  const mediaPath = path.join(filesDir, 'media.mp4');
  await writeFile(mediaPath, 'verified media');

  const run = async (lines) => {
    const helper = path.join(root, `helper-${Math.random()}`);
    await writeFile(helper, `#!/bin/sh\n${lines.map((line) => `printf '%s\\n' '${line}'`).join('\n')}\n`);
    await chmod(helper, 0o700);
    const service = new TranscriptionService({ rootDir: root, helperPath: helper, systemVersion: '14.0' });
    service.verifyInstalledModel = async () => {};
    return await service.transcribe(mediaPath);
  };

  await assert.rejects(run(['{"version":1,"event":"network","progress":10}']), /未知事件/);
  await assert.rejects(run([
    '{"version":1,"event":"result","segments":[]}',
    '{"version":1,"event":"result","segments":[]}'
  ]), /重复结果/);
});

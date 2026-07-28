import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TranscriptionService, WHISPER_MODEL } from '../desktop/transcription-service.mjs';

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

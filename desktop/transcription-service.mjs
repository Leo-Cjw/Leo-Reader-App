import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';

export const WHISPER_MODEL = Object.freeze({
  id: 'whisper-small-multilingual',
  fileName: 'ggml-small.bin',
  source: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-small.bin?download=true',
  sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  byteSize: 487_601_967
});

const MAX_MODEL_BYTES = 500 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 8 * 1024 * 1024;
const MINIMUM_SYSTEM_VERSION = '13.3';

function supportsTranscription(systemVersion) {
  if (!systemVersion) return true;
  const [major, minor] = String(systemVersion).split('.').map((part) => Number(part) || 0);
  return major > 13 || major === 13 && minor >= 3;
}

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

async function hashFile(filePath) {
  const handle = await open(filePath, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function safeContainedPath(root, candidate, label) {
  const base = path.resolve(root);
  const resolved = path.resolve(String(candidate || ''));
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) throw new Error(`${label}路径无效`);
  return resolved;
}

export class TranscriptionService {
  constructor({ rootDir, helperPath, systemVersion = null, fetchImpl = globalThis.fetch } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.modelDir = path.join(this.rootDir, 'models', 'transcription');
    this.modelPath = path.join(this.modelDir, WHISPER_MODEL.fileName);
    this.receiptPath = path.join(this.modelDir, 'model-receipt.json');
    this.helperPath = path.resolve(String(helperPath || ''));
    this.systemVersion = systemVersion;
    this.fetchImpl = fetchImpl;
    this.downloadPromise = null;
    this.downloadProgress = 0;
  }

  async status() {
    const installed = await exists(this.modelPath) && await exists(this.receiptPath);
    const supported = supportsTranscription(this.systemVersion);
    return {
      available: supported && Boolean(this.helperPath) && await exists(this.helperPath),
      installed,
      downloading: Boolean(this.downloadPromise),
      progress: this.downloadPromise ? this.downloadProgress : installed ? 100 : 0,
      model: WHISPER_MODEL.id,
      byteSize: WHISPER_MODEL.byteSize,
      minimumSystemVersion: MINIMUM_SYSTEM_VERSION,
      systemSupported: supported
    };
  }

  async downloadModel() {
    if (!supportsTranscription(this.systemVersion)) {
      throw Object.assign(new Error(`本地转写需要 macOS ${MINIMUM_SYSTEM_VERSION} 或更高版本`), { status: 409, expected: true });
    }
    if (this.downloadPromise) return await this.downloadPromise;
    this.downloadPromise = this.performDownload().finally(() => {
      this.downloadPromise = null;
      this.downloadProgress = 0;
    });
    return await this.downloadPromise;
  }

  async performDownload() {
    await mkdir(this.modelDir, { recursive: true, mode: 0o700 });
    await chmod(this.modelDir, 0o700);
    const response = await this.fetchImpl(WHISPER_MODEL.source, {
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/octet-stream' }
    });
    if (!response.ok || !response.body) throw new Error(`转写模型下载失败 (${response.status})`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_MODEL_BYTES) throw new Error('转写模型超过固定大小上限');
    const tempPath = path.join(this.modelDir, `${WHISPER_MODEL.fileName}.${randomUUID()}.partial`);
    const handle = await open(tempPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_MODEL_BYTES) throw new Error('转写模型超过固定大小上限');
        hash.update(chunk);
        await handle.write(chunk);
        this.downloadProgress = Math.min(99, Math.round(total / WHISPER_MODEL.byteSize * 100));
      }
      await handle.sync();
      await handle.close();
      const digest = hash.digest('hex');
      if (digest !== WHISPER_MODEL.sha256) throw new Error('转写模型 SHA-256 校验失败');
      if (total !== WHISPER_MODEL.byteSize) throw new Error('转写模型大小与固定清单不一致');
      await rename(tempPath, this.modelPath);
      await chmod(this.modelPath, 0o600);
      await writeFile(this.receiptPath, `${JSON.stringify({
        version: 1,
        model: WHISPER_MODEL.id,
        sha256: digest,
        byteSize: total,
        sourceRevision: 'c521a4b02f422512d734391fdf08bb08c0862f68',
        installedAt: new Date().toISOString()
      }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw error;
    }
    return await this.status();
  }

  async removeModel() {
    if (this.downloadPromise) throw Object.assign(new Error('模型正在下载，暂不能删除'), { status: 409 });
    await unlink(this.modelPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    await unlink(this.receiptPath).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
    return await this.status();
  }

  async verifyInstalledModel() {
    const info = await stat(this.modelPath);
    if (!info.isFile() || info.size !== WHISPER_MODEL.byteSize) throw new Error('本地转写模型大小无效，请重新安装');
    const receipt = JSON.parse(await readFile(this.receiptPath, 'utf8'));
    if (receipt.sha256 !== WHISPER_MODEL.sha256 || receipt.byteSize !== WHISPER_MODEL.byteSize) throw new Error('本地转写模型收据无效，请重新安装');
    if (await hashFile(this.modelPath) !== WHISPER_MODEL.sha256) throw new Error('本地转写模型校验失败，请重新安装');
  }

  async transcribe(mediaPath, { language = 'auto', onProgress = null } = {}) {
    if (!supportsTranscription(this.systemVersion)) throw new Error(`本地转写需要 macOS ${MINIMUM_SYSTEM_VERSION} 或更高版本`);
    if (!this.helperPath || !(await exists(this.helperPath))) throw new Error('Reader Transcription Helper 不可用');
    const verifiedMediaPath = safeContainedPath(path.join(this.rootDir, 'data', 'files'), mediaPath, '媒体');
    await this.verifyInstalledModel();
    const request = JSON.stringify({
      version: 1,
      operation: 'transcribe',
      mediaPath: verifiedMediaPath,
      modelPath: safeContainedPath(this.modelDir, this.modelPath, '模型'),
      language: /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language) ? language : 'auto'
    });
    return await new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
      let stdout = '';
      let outputBytes = 0;
      let resultPayload = null;
      let stderr = '';
      let timer;
      const handleMessage = (line) => {
        if (!line.trim()) return;
        const payload = JSON.parse(line);
        if (payload.version !== 1) throw new Error('转写 Helper 返回格式无效');
        if (payload.event === 'progress') {
          const progress = Number(payload.progress);
          if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new Error('转写 Helper 进度无效');
          if (typeof onProgress === 'function') onProgress(progress);
          return;
        }
        if (payload.event === 'result' || Array.isArray(payload.segments)) {
          if (resultPayload) throw new Error('转写 Helper 返回了重复结果');
          resultPayload = payload;
          return;
        }
        throw new Error('转写 Helper 返回了未知事件');
      };
      const fail = (error) => {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(error);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_HELPER_OUTPUT_BYTES) return fail(new Error('转写 Helper 输出超过限制'));
        stdout += chunk;
        const lines = stdout.split('\n');
        stdout = lines.pop() || '';
        try {
          for (const line of lines) handleMessage(line);
        } catch (error) {
          fail(error);
        }
      });
      child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
      child.once('error', fail);
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr.trim() || '本地转写失败'));
        try {
          if (stdout.trim()) handleMessage(stdout);
          const payload = resultPayload;
          if (!payload || payload.version !== 1 || !Array.isArray(payload.segments) || payload.segments.length > 100_000) throw new Error('转写 Helper 返回格式无效');
          const segments = payload.segments.map((segment) => ({
            startMs: Number(segment.startMs),
            endMs: Number(segment.endMs),
            text: String(segment.text || '').trim()
          })).filter((segment) => Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs && segment.text);
          resolve(segments);
        } catch (error) { reject(error); }
      });
      timer = setTimeout(() => fail(new Error('本地转写超时')), 2 * 60 * 60 * 1000);
      timer.unref?.();
      child.stdin.end(request);
    });
  }
}

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_WORKER_PATH = fileURLToPath(new URL('./parser-worker.mjs', import.meta.url));
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_CONCURRENT_PARSERS = 2;
const MAX_PENDING_PARSERS = 32;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

let activeParsers = 0;
const pendingParsers = [];

function parserError(message, status = 422) {
  return Object.assign(new Error(message), { status });
}

function enqueueParser(operation) {
  if (activeParsers < MAX_CONCURRENT_PARSERS) {
    activeParsers += 1;
    return Promise.resolve().then(operation).finally(releaseParser);
  }
  if (pendingParsers.length >= MAX_PENDING_PARSERS) {
    return Promise.reject(parserError('解析队列繁忙，请稍后重试', 503));
  }
  return new Promise((resolve, reject) => pendingParsers.push({ operation, resolve, reject }));
}

function releaseParser() {
  activeParsers -= 1;
  const next = pendingParsers.shift();
  if (!next) return;
  activeParsers += 1;
  Promise.resolve().then(next.operation).then(next.resolve, next.reject).finally(releaseParser);
}

function runChildParser(request, {
  workerPath = DEFAULT_WORKER_PATH,
  timeoutMs = 30_000,
  maxInputBytes = MAX_INPUT_BYTES,
  maxOutputBytes = MAX_OUTPUT_BYTES
} = {}) {
  const nonce = randomUUID().replaceAll('-', '');
  const responseMarker = `__READER_PARSER_RESPONSE_${nonce}__`;
  const input = Buffer.from(JSON.stringify({ ...request, version: 1, nonce }));
  if (input.length > maxInputBytes) return Promise.reject(parserError('解析输入超过安全限制', 413));

  return new Promise((resolve, reject) => {
    const childEnvironment = {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '',
      READER_PARSER_WORKER: '1'
    };
    for (const name of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ']) {
      if (typeof process.env[name] === 'string') childEnvironment[name] = process.env[name];
    }
    const parserRoot = path.resolve(path.dirname(workerPath), '..', '..');
    const parserReadRoot = parserRoot.endsWith('.asar') ? path.dirname(parserRoot) : parserRoot;
    const permissionFlag = process.allowedNodeEnvironmentFlags.has('--permission')
      ? '--permission'
      : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : '';
    const childArguments = ['--max-old-space-size=256'];
    if (permissionFlag) {
      childArguments.push(permissionFlag, `--allow-fs-read=${parserReadRoot}`);
      if (typeof request.sourcePath === 'string' && path.isAbsolute(request.sourcePath)) childArguments.push(`--allow-fs-read=${request.sourcePath}`);
      if (request.task === 'thumbnail') childArguments.push('--allow-addons');
    }
    childArguments.push(workerPath);
    const child = spawn(process.execPath, childArguments, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnvironment
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const fail = (error) => {
      child.kill('SIGKILL');
      finish(reject, error);
    };
    const timer = setTimeout(() => fail(parserError('内容解析超时', 504)), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(parserError('解析结果超过安全限制', 413));
        return;
      }
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= MAX_STDERR_BYTES) return;
      const remaining = MAX_STDERR_BYTES - stderrBytes;
      const accepted = chunk.subarray(0, remaining);
      stderr.push(Buffer.from(accepted));
      stderrBytes += accepted.length;
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') fail(parserError('无法提交解析任务'));
    });
    child.once('error', () => finish(reject, parserError('无法启动内容解析进程', 503)));
    child.once('close', (code, signal) => {
      if (settled) return;
      let response;
      try {
        const raw = Buffer.concat(stdout).toString('utf8');
        const markerIndex = raw.lastIndexOf(responseMarker);
        if (markerIndex < 0) throw new Error('missing response marker');
        response = JSON.parse(raw.slice(markerIndex + responseMarker.length).trim());
      }
      catch {
        finish(reject, parserError(`内容解析进程异常退出（${signal || (code ?? 'unknown')}）`));
        return;
      }
      if (!response || response.version !== 1 || typeof response.ok !== 'boolean') {
        finish(reject, parserError('内容解析进程返回了无效结果'));
        return;
      }
      if (!response.ok) {
        const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? response.status : 422;
        finish(reject, parserError(String(response.error || '内容解析失败').slice(0, 500), status));
        return;
      }
      finish(resolve, response.result);
    });
    child.stdin.end(input);
  });
}

export function runParserTask(request, options) {
  return enqueueParser(() => runChildParser(request, options));
}

export async function parseArticleInProcess(html, canonicalURL, options) {
  if (typeof html !== 'string' || !html) throw parserError('网页正文为空');
  if (typeof canonicalURL !== 'string' || canonicalURL.length > 2048) throw parserError('网页地址无效');
  const result = await runParserTask({ task: 'html', html, canonicalURL }, { timeoutMs: 15_000, ...options });
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw parserError('网页解析结果无效');
  if (typeof result.title !== 'string' || typeof result.content !== 'string' || !result.content) throw parserError('网页解析结果缺少正文');
  if (result.title.length > 500 || result.content.length > 4_000_000 || JSON.stringify(result.metadata || {}).length > 1_000_000) {
    throw parserError('网页解析结果超过安全限制', 413);
  }
  return result;
}

export async function extractPDFTextInProcess(sourcePath, options) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw parserError('解析文件路径无效', 400);
  const canonicalSourcePath = await realpath(sourcePath);
  const result = await runParserTask({ task: 'pdf-text', sourcePath: canonicalSourcePath }, options);
  if (typeof result !== 'string' || result.length > 1_000_000) throw parserError('PDF 解析结果无效');
  return result;
}

export async function renderThumbnailInProcess(sourcePath, mimeType, options) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) throw parserError('解析文件路径无效', 400);
  const canonicalSourcePath = await realpath(sourcePath);
  const result = await runParserTask({ task: 'thumbnail', sourcePath: canonicalSourcePath, mimeType }, options);
  if (!result || typeof result.base64 !== 'string') throw parserError('缩略图解析结果无效');
  const output = Buffer.from(result.base64, 'base64');
  if (!output.length || output.length > MAX_THUMBNAIL_BYTES || output.subarray(0, 4).toString('ascii') !== 'RIFF' || output.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw parserError('缩略图解析结果无效');
  }
  return output;
}

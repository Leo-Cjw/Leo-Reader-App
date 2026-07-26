import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export const projectRoot = path.resolve(import.meta.dirname, '..', '..');

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitFor(label, operation, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  let lastResult;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      lastResult = result;
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label}超时${lastError ? `：${lastError.message}` : lastResult !== undefined ? `；最终状态 ${JSON.stringify(lastResult)}` : ''}`);
}

export class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CDPClient(socket);
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextID;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async value(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
    }
    return result.result.value;
  }

  async tree() {
    const result = await this.call('Accessibility.getFullAXTree', { depth: -1 });
    return result.nodes.filter((node) => !node.ignored);
  }

  close() {
    this.socket.close();
  }
}

export function packagedReaderApp(candidate) {
  return path.resolve(candidate || path.join(projectRoot, 'release', 'mac-universal', 'Reader.app'));
}

export async function launchPackagedReader({
  appPath = packagedReaderApp(),
  readerRoot,
  prefix = 'reader-packaged-qa-',
  forceRendererAccessibility = false
} = {}) {
  if (process.platform !== 'darwin') throw new Error('打包 App QA 仅支持 macOS');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Reader');
  await access(executable);

  const sessionRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const chromiumRoot = path.join(sessionRoot, 'chromium');
  const resolvedReaderRoot = readerRoot || path.join(sessionRoot, 'reader-data');
  const shareStagingRoot = path.join(sessionRoot, 'share-staging');
  await mkdir(chromiumRoot, { recursive: true });
  await mkdir(resolvedReaderRoot, { recursive: true });
  await mkdir(shareStagingRoot, { recursive: true, mode: 0o700 });

  let stderr = '';
  let spawnError;
  const child = spawn(executable, [
    `--user-data-dir=${chromiumRoot}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    ...(forceRendererAccessibility ? ['--force-renderer-accessibility'] : [])
  ], {
    env: {
      ...process.env,
      READER_DESKTOP_DATA_ROOT: resolvedReaderRoot,
      READER_SHARE_STAGING_ROOT: shareStagingRoot,
      READER_RELEASE_QA: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  child.once('error', (error) => {
    spawnError = error;
  });

  let client;
  try {
    const activePortPath = path.join(chromiumRoot, 'DevToolsActivePort');
    const port = await waitFor('DevTools 端口', async () => {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null) throw new Error(`Reader 提前退出（${child.exitCode}）\n${stderr}`);
      const value = Number(String(await readFile(activePortPath, 'utf8')).split(/\r?\n/, 1)[0]);
      return Number.isInteger(value) && value > 0 ? value : null;
    });
    const target = await waitFor('Reader 页面', async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) return null;
      const targets = await response.json();
      return targets.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
    });
    client = await CDPClient.connect(target.webSocketDebuggerUrl);
    await waitFor('Reader 工作区', async () => client.value(
      "document.readyState === 'complete' && document.querySelector('.app-window') !== null && document.querySelector('[aria-busy=\"true\"]') === null"
    ));
    await client.value("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(sessionRoot, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  return {
    appPath,
    client,
    chromiumRoot,
    executable,
    readerRoot: resolvedReaderRoot,
    shareStagingRoot,
    async close() {
      if (closed) return;
      closed = true;
      client.close();
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
        if (!graceful && child.exitCode === null) {
          child.kill('SIGKILL');
          await Promise.race([exited, delay(2_000)]);
        }
      }
      await rm(sessionRoot, { recursive: true, force: true });
    }
  };
}

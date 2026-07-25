import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 2_000;
const HELPER_TIMEOUT_MS = 15_000;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;

function serviceError(message, status = 503) {
  return Object.assign(new Error(message), { status, expected: true });
}

function bounded(value, max) {
  return String(value || '').slice(0, max);
}

function publicItem(change) {
  if (change.operation === 'delete') return { id: change.id, operation: 'delete' };
  return {
    id: change.id,
    operation: 'upsert',
    title: bounded(change.title, 500),
    excerpt: bounded(change.excerpt, 2_000),
    content: bounded(change.content, 20_000),
    author: bounded(change.author, 500),
    source: bounded(change.source, 500),
    type: bounded(change.type, 100),
    language: bounded(change.language, 50),
    publishedAt: change.publishedAt,
    createdAt: change.createdAt,
    updatedAt: change.updatedAt,
    tags: (Array.isArray(change.tags) ? change.tags : []).map((tag) => bounded(tag, 100)).filter(Boolean).slice(0, 50)
  };
}

export async function runSpotlightHelper(helperPath, payload, {
  timeoutMs = HELPER_TIMEOUT_MS,
  platform = process.platform
} = {}) {
  if (platform !== 'darwin' || !helperPath) throw serviceError('此设备上的 Reader 不支持 Spotlight 索引');
  await access(helperPath).catch(() => { throw serviceError('Reader Spotlight 组件不可用'); });
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > 3 * 1024 * 1024) throw serviceError('Spotlight 索引批次超过安全限制', 400);
  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
    });
    let stdout = '';
    let stderrBytes = 0;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, serviceError('Spotlight 索引操作超时'));
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(reject, serviceError('Spotlight 组件返回内容超过安全限制'));
      }
    });
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
    child.once('error', () => finish(reject, serviceError('Reader Spotlight 组件无法启动')));
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0 || stderrBytes > MAX_HELPER_OUTPUT_BYTES) {
        return finish(reject, serviceError('Spotlight 索引操作失败'));
      }
      try {
        const result = JSON.parse(stdout);
        if (!result || result.ok !== true) throw new Error('invalid result');
        finish(resolve, result);
      } catch {
        finish(reject, serviceError('Spotlight 组件返回无效结果'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function createSpotlightService({
  database,
  settingsStore,
  helperPath = '',
  platform = process.platform,
  runHelper = (payload) => runSpotlightHelper(helperPath, payload, { platform }),
  pollIntervalMs = POLL_INTERVAL_MS
}) {
  let timer = null;
  let active = null;
  let startup = null;
  let stopped = false;
  let disabling = false;
  let available = platform === 'darwin' && Boolean(helperPath);
  let state = settingsStore.getSpotlight().enabled ? 'starting' : 'disabled';
  let warning = null;
  let indexedAt = null;

  async function refreshAvailability() {
    if (platform !== 'darwin' || !helperPath) {
      available = false;
      return false;
    }
    try {
      const result = await runHelper({ command: 'availability' });
      available = result?.available === true;
      return available;
    } catch {
      available = false;
      return false;
    }
  }

  async function drain() {
    if (stopped || disabling || startup || !settingsStore.getSpotlight().enabled) return;
    if (active) return active;
    active = (async () => {
      state = 'indexing';
      warning = null;
      try {
        if (!(await refreshAvailability())) throw serviceError('Reader Spotlight 组件当前不可用');
        for (;;) {
          if (stopped || disabling || !settingsStore.getSpotlight().enabled) break;
          const changes = await database.listSpotlightChanges(BATCH_SIZE);
          if (!changes.length) break;
          const result = await runHelper({ command: 'apply', items: changes.map(publicItem) });
          const applied = Number(result?.applied);
          const deleted = Number(result?.deleted);
          if (!Number.isSafeInteger(applied) || !Number.isSafeInteger(deleted) || applied + deleted !== changes.length) {
            throw serviceError('Spotlight 组件未确认完整批次');
          }
          await database.acknowledgeSpotlightChanges(changes.map(({ id, revision }) => ({ id, revision })));
        }
        indexedAt = new Date().toISOString();
        state = settingsStore.getSpotlight().enabled ? 'ready' : 'disabled';
      } catch {
        state = 'error';
        warning = 'Spotlight 索引暂时不可用；Reader 会在本机稍后重试。';
      } finally {
        active = null;
      }
    })();
    return active;
  }

  async function status() {
    return {
      ...settingsStore.getSpotlight(),
      available,
      state,
      pending: await database.countSpotlightChanges(),
      indexedAt,
      warning
    };
  }

  async function update(enabled) {
    if (startup) await startup;
    if (enabled) {
      if (!(await refreshAvailability())) throw serviceError('Reader Spotlight 组件当前不可用');
      await database.enqueueAllSpotlightArticles();
      await settingsStore.saveSpotlight(true);
      await drain();
      return await status();
    }
    disabling = true;
    try {
      if (active) await active;
      const current = settingsStore.getSpotlight();
      if (current.enabled) {
        if (!(await refreshAvailability())) throw serviceError('无法确认 Spotlight 索引已删除；设置未更改');
        const result = await runHelper({ command: 'delete-all' });
        if (result?.deleted !== 1) throw serviceError('Spotlight 组件未确认索引删除');
      }
      await database.clearSpotlightOutbox();
      await settingsStore.saveSpotlight(false);
      state = 'disabled';
      warning = null;
      indexedAt = null;
      return await status();
    } finally {
      disabling = false;
    }
  }

  async function start() {
    stopped = false;
    if (settingsStore.getSpotlight().enabled) {
      state = 'starting';
      startup = (async () => {
        try {
          if (!(await refreshAvailability())) throw serviceError('Reader Spotlight 组件当前不可用');
          if (stopped) return;
          await database.enqueueAllSpotlightArticles();
          startup = null;
          await drain();
        } catch {
          state = 'error';
          warning = 'Spotlight 索引暂时不可用；Reader 会在本机稍后重试。';
        } finally {
          startup = null;
        }
      })();
    } else {
      state = 'disabled';
    }
    timer = setInterval(() => { void drain(); }, pollIntervalMs);
    timer.unref?.();
    return await status();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (startup) await startup;
    if (active) await active;
  }

  return { start, stop, status, update, drain };
}

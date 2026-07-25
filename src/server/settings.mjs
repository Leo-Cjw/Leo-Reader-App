import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  ai: { configured: false, enabled: false, endpoint: '', hasApiKey: false, updatedAt: null },
  imports: { paused: false, updatedAt: null },
  notifications: { enabled: false, updatedAt: null }
});

function settingsError(message, status = 400) {
  return Object.assign(new Error(message), { status, expected: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function normalizeAIEndpoint(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.length > 2048) throw settingsError('AI 服务地址长度超过限制');
  let url;
  try { url = new URL(input); }
  catch { throw settingsError('AI 服务地址不是有效 URL'); }
  if (url.username || url.password) throw settingsError('AI 服务地址不能包含用户名或密码');
  if (url.hash) throw settingsError('AI 服务地址不能包含片段');
  for (const name of url.searchParams.keys()) {
    if (/(?:api.?key|token|secret|signature|credential|password|^sig$)/i.test(name)) throw settingsError('AI 服务地址不能在查询参数中包含密钥；请使用 API 密钥字段');
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw settingsError('远程 AI 服务必须使用 HTTPS；HTTP 仅允许 localhost 或 127.0.0.1');
  }
  return url.toString();
}

export class SettingsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.value = clone(DEFAULT_SETTINGS);
    this.loadError = null;
  }

  async initialize() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      const ai = parsed?.ai && typeof parsed.ai === 'object' ? parsed.ai : {};
      const endpoint = normalizeAIEndpoint(ai.endpoint);
      if (ai.enabled && !endpoint) throw new Error('enabled AI endpoint is missing');
      const imports = parsed?.imports && typeof parsed.imports === 'object' ? parsed.imports : {};
      const notifications = parsed?.notifications && typeof parsed.notifications === 'object' ? parsed.notifications : {};
      this.value = {
        version: 1,
        ai: {
          configured: Boolean(ai.configured), enabled: Boolean(ai.enabled), endpoint,
          hasApiKey: Boolean(ai.hasApiKey), updatedAt: typeof ai.updatedAt === 'string' ? ai.updatedAt : null
        },
        imports: {
          paused: Boolean(imports.paused), updatedAt: typeof imports.updatedAt === 'string' ? imports.updatedAt : null
        },
        notifications: {
          enabled: notifications.enabled === true, updatedAt: typeof notifications.updatedAt === 'string' ? notifications.updatedAt : null
        }
      };
      await chmod(this.filePath, 0o600).catch(() => {});
    } catch (error) {
      if (error.code !== 'ENOENT') this.loadError = '本地设置文件无法读取，将使用安全默认值；保存新设置后会重建。';
    }
    return this;
  }

  getAI() { return clone(this.value.ai); }
  getImportQueue() { return clone(this.value.imports); }
  getNotifications() { return clone(this.value.notifications); }

  async saveAI(input) {
    const next = {
      ...clone(this.value),
      ai: {
        configured: true, enabled: Boolean(input.enabled), endpoint: String(input.endpoint || ''),
        hasApiKey: Boolean(input.hasApiKey), updatedAt: new Date().toISOString()
      }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getAI();
  }

  async resetAI() {
    const next = { ...clone(this.value), ai: clone(DEFAULT_SETTINGS.ai) };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getAI();
  }

  async saveImportQueue(paused) {
    const next = {
      ...clone(this.value),
      imports: { paused: Boolean(paused), updatedAt: new Date().toISOString() }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getImportQueue();
  }

  async saveNotifications(enabled) {
    const next = {
      ...clone(this.value),
      notifications: { enabled: Boolean(enabled), updatedAt: new Date().toISOString() }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getNotifications();
  }

  async persist(value = this.value) {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.filePath);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw settingsError(`设置保存失败：${error.message || '未知错误'}`, 500);
    }
  }
}

export function defaultSettingsPath(rootDir) {
  return path.join(rootDir, 'data', 'settings.json');
}

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { normalizeAIConfiguration } from './ai-providers.mjs';
import { normalizeEmbeddingModel, SEMANTIC_SEARCH_DEFAULT_MODEL } from './semantic-search.mjs';

export { normalizeAIEndpoint } from './ai-providers.mjs';

const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  ai: { configured: false, enabled: false, provider: 'reader-gateway', endpoint: '', model: '', hasApiKey: false, updatedAt: null },
  imports: { paused: false, updatedAt: null },
  notifications: { enabled: false, sourceSyncEnabled: false, updatedAt: null },
  automaticBackups: { enabled: false, updatedAt: null },
  spotlight: { enabled: false, updatedAt: null },
  semanticSearch: { enabled: false, model: SEMANTIC_SEARCH_DEFAULT_MODEL, updatedAt: null }
});

function settingsError(message, status = 400) {
  return Object.assign(new Error(message), { status, expected: true });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
      const configuration = normalizeAIConfiguration({
        enabled: Boolean(ai.enabled),
        provider: ai.provider,
        endpoint: ai.endpoint,
        model: ai.model
      });
      const imports = parsed?.imports && typeof parsed.imports === 'object' ? parsed.imports : {};
      const notifications = parsed?.notifications && typeof parsed.notifications === 'object' ? parsed.notifications : {};
      const automaticBackups = parsed?.automaticBackups && typeof parsed.automaticBackups === 'object' ? parsed.automaticBackups : {};
      const spotlight = parsed?.spotlight && typeof parsed.spotlight === 'object' ? parsed.spotlight : {};
      const semanticSearch = parsed?.semanticSearch && typeof parsed.semanticSearch === 'object' ? parsed.semanticSearch : {};
      let semanticModel = SEMANTIC_SEARCH_DEFAULT_MODEL;
      let semanticEnabled = false;
      try {
        semanticModel = normalizeEmbeddingModel(semanticSearch.model || SEMANTIC_SEARCH_DEFAULT_MODEL);
        semanticEnabled = semanticSearch.enabled === true;
      } catch {}
      this.value = {
        version: 1,
        ai: {
          configured: Boolean(ai.configured), ...configuration,
          hasApiKey: Boolean(ai.hasApiKey), updatedAt: typeof ai.updatedAt === 'string' ? ai.updatedAt : null
        },
        imports: {
          paused: Boolean(imports.paused), updatedAt: typeof imports.updatedAt === 'string' ? imports.updatedAt : null
        },
        notifications: {
          enabled: notifications.enabled === true,
          sourceSyncEnabled: notifications.sourceSyncEnabled === true,
          updatedAt: typeof notifications.updatedAt === 'string' ? notifications.updatedAt : null
        },
        automaticBackups: {
          enabled: automaticBackups.enabled === true,
          updatedAt: typeof automaticBackups.updatedAt === 'string' ? automaticBackups.updatedAt : null
        },
        spotlight: {
          enabled: spotlight.enabled === true,
          updatedAt: typeof spotlight.updatedAt === 'string' ? spotlight.updatedAt : null
        },
        semanticSearch: {
          enabled: semanticEnabled,
          model: semanticModel,
          updatedAt: typeof semanticSearch.updatedAt === 'string' ? semanticSearch.updatedAt : null
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
  getAutomaticBackups() { return clone(this.value.automaticBackups); }
  getSpotlight() { return clone(this.value.spotlight); }
  getSemanticSearch() { return clone(this.value.semanticSearch); }

  async saveAI(input) {
    const next = {
      ...clone(this.value),
      ai: {
        configured: true, enabled: Boolean(input.enabled), provider: String(input.provider || 'reader-gateway'),
        endpoint: String(input.endpoint || ''), model: String(input.model || ''),
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

  async saveNotifications(input) {
    const patch = typeof input === 'boolean' ? { enabled: input } : input || {};
    const current = this.value.notifications;
    const next = {
      ...clone(this.value),
      notifications: {
        enabled: 'enabled' in patch ? Boolean(patch.enabled) : current.enabled,
        sourceSyncEnabled: 'sourceSyncEnabled' in patch ? Boolean(patch.sourceSyncEnabled) : current.sourceSyncEnabled,
        updatedAt: new Date().toISOString()
      }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getNotifications();
  }

  async saveAutomaticBackups(enabled) {
    const next = {
      ...clone(this.value),
      automaticBackups: { enabled: enabled === true, updatedAt: new Date().toISOString() }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getAutomaticBackups();
  }

  async saveSpotlight(enabled) {
    const next = {
      ...clone(this.value),
      spotlight: { enabled: enabled === true, updatedAt: new Date().toISOString() }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getSpotlight();
  }

  async saveSemanticSearch(enabled, model = SEMANTIC_SEARCH_DEFAULT_MODEL) {
    const next = {
      ...clone(this.value),
      semanticSearch: {
        enabled: enabled === true,
        model: normalizeEmbeddingModel(model),
        updatedAt: new Date().toISOString()
      }
    };
    await this.persist(next);
    this.value = next;
    this.loadError = null;
    return this.getSemanticSearch();
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

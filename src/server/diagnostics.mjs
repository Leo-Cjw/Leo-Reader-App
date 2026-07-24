import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';

const MAX_LOG_BYTES = 512 * 1024;
const MAX_LOG_FILES = 3;
const MAX_LIST_ENTRIES = 500;
const LOG_FILE_NAMES = ['reader.jsonl', 'reader.1.jsonl', 'reader.2.jsonl'];
const LEVELS = new Set(['info', 'warning', 'error']);
const ACTIONS = new Set(['storage_permissions', 'search_index']);
const ERROR_CATEGORIES = new Set(['request', 'database', 'filesystem', 'network', 'network_timeout', 'internal']);
const ROUTES = new Set(['health', 'stats', 'articles', 'imports', 'ai', 'sources', 'backups', 'data_health', 'migration_snapshots', 'attachments', 'settings', 'collections', 'smart_collections', 'duplicates', 'export', 'diagnostics', 'static', 'unknown']);

const EVENT_LEVELS = Object.freeze({
  app_started: 'info',
  app_stopped: 'info',
  startup_failed: 'error',
  api_error: 'error',
  backup_created: 'info',
  restore_scheduled: 'warning',
  restore_cancelled: 'info',
  data_repair_completed: 'warning'
});

function boundedInteger(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.min(max, Math.max(min, number)) : null;
}

function boundedVersion(value) {
  const version = String(value || '');
  return /^[0-9]+(?:\.[0-9]+){1,3}$/.test(version) ? version.slice(0, 24) : '';
}

function sanitizeDetails(event, source = {}) {
  const input = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  if (event === 'app_started') return {
    version: boundedVersion(input.version),
    schemaVersion: boundedInteger(input.schemaVersion, 0, 10_000),
    restored: Boolean(input.restored)
  };
  if (event === 'startup_failed') return {
    phase: ['restore', 'database', 'server'].includes(input.phase) ? input.phase : 'server',
    category: ERROR_CATEGORIES.has(input.category) ? input.category : 'internal'
  };
  if (event === 'api_error') return {
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(input.method) ? input.method : 'GET',
    route: ROUTES.has(input.route) ? input.route : 'unknown',
    status: boundedInteger(input.status, 500, 599) || 500,
    category: ERROR_CATEGORIES.has(input.category) ? input.category : 'internal'
  };
  if (event === 'backup_created') return {
    encrypted: Boolean(input.encrypted),
    byteSize: boundedInteger(input.byteSize, 0)
  };
  if (event === 'restore_scheduled') return { encrypted: Boolean(input.encrypted) };
  if (event === 'data_repair_completed') return {
    actions: [...new Set((Array.isArray(input.actions) ? input.actions : []).filter((action) => ACTIONS.has(action)))],
    backupCreated: Boolean(input.backupCreated)
  };
  return {};
}

export function diagnosticRoute(pathname) {
  const value = String(pathname || '');
  if (value === '/api/health') return 'health';
  if (value === '/api/stats') return 'stats';
  if (/^\/api\/articles(?:\/|$)/.test(value)) return 'articles';
  if (/^\/api\/import-jobs(?:\/|$)/.test(value) || /^\/api\/portable-import(?:\/|$)/.test(value)) return 'imports';
  if (/^\/api\/ai(?:\/|$)/.test(value)) return 'ai';
  if (/^\/api\/sources(?:\/|$)/.test(value)) return 'sources';
  if (/^\/api\/backups(?:\/|$)/.test(value)) return 'backups';
  if (/^\/api\/data-health(?:\/|$)/.test(value)) return 'data_health';
  if (/^\/api\/migration-snapshots(?:\/|$)/.test(value)) return 'migration_snapshots';
  if (/^\/api\/attachments(?:\/|$)/.test(value)) return 'attachments';
  if (/^\/api\/settings(?:\/|$)/.test(value)) return 'settings';
  if (/^\/api\/collections(?:\/|$)/.test(value)) return 'collections';
  if (/^\/api\/smart-collections(?:\/|$)/.test(value)) return 'smart_collections';
  if (/^\/api\/duplicates(?:\/|$)/.test(value)) return 'duplicates';
  if (/^\/api\/export(?:\/|$)/.test(value)) return 'export';
  if (/^\/api\/diagnostics(?:\/|$)/.test(value)) return 'diagnostics';
  return value.startsWith('/api/') ? 'unknown' : 'static';
}

export function diagnosticErrorCategory(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  const status = Number(error?.status || 0);
  if (status >= 400 && status < 500) return 'request';
  if (['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS'].includes(code)) return 'filesystem';
  if (/sqlite|database|schema|constraint|busy|locked|数据库|资料库/.test(message)) return 'database';
  if (code === 'ETIMEDOUT' || /timeout|timed out|aborted/.test(message)) return 'network_timeout';
  if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN'].includes(code) || /fetch failed|network/.test(message)) return 'network';
  return 'internal';
}

async function optionalStat(filePath) {
  try { return await stat(filePath); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export class LocalDiagnosticsStore {
  constructor(rootDir, { maxBytes = MAX_LOG_BYTES, maxFiles = MAX_LOG_FILES } = {}) {
    this.directory = path.join(rootDir, 'data', 'logs');
    this.filePath = path.join(this.directory, LOG_FILE_NAMES[0]);
    this.maxBytes = Math.min(Math.max(Number(maxBytes) || MAX_LOG_BYTES, 1024), MAX_LOG_BYTES);
    this.maxFiles = Math.min(Math.max(Number(maxFiles) || MAX_LOG_FILES, 1), MAX_LOG_FILES);
    this.available = false;
    this.queue = Promise.resolve();
  }

  async initialize() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      await appendFile(this.filePath, '', { mode: 0o600 });
      await chmod(this.filePath, 0o600);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this;
  }

  record(event, details = {}) {
    if (!(event in EVENT_LEVELS)) return Promise.resolve(false);
    const entry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      level: EVENT_LEVELS[event],
      event,
      details: sanitizeDetails(event, details)
    };
    const line = `${JSON.stringify(entry)}\n`;
    const task = this.queue.then(async () => {
      if (!this.available) return false;
      try {
        await this.rotateIfNeeded(Buffer.byteLength(line));
        await appendFile(this.filePath, line, { mode: 0o600 });
        await chmod(this.filePath, 0o600);
        return true;
      } catch {
        this.available = false;
        return false;
      }
    });
    this.queue = task.then(() => undefined);
    return task;
  }

  async rotateIfNeeded(incomingBytes) {
    const current = await optionalStat(this.filePath);
    if (!current || current.size + incomingBytes <= this.maxBytes) return;
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const destination = path.join(this.directory, LOG_FILE_NAMES[index]);
      await unlink(destination).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      const source = path.join(this.directory, LOG_FILE_NAMES[index - 1]);
      await rename(source, destination).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    await unlink(this.filePath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    await appendFile(this.filePath, '', { mode: 0o600 });
  }

  async readEntries() {
    await this.queue;
    const entries = [];
    let byteSize = 0;
    let fileCount = 0;
    const names = LOG_FILE_NAMES.slice(0, this.maxFiles).reverse();
    for (const name of names) {
      const filePath = path.join(this.directory, name);
      const info = await optionalStat(filePath).catch(() => null);
      if (!info) continue;
      byteSize += info.size;
      fileCount += 1;
      const content = await readFile(filePath, 'utf8').catch(() => '');
      for (const line of content.split('\n')) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (!(parsed.event in EVENT_LEVELS) || !LEVELS.has(parsed.level) || parsed.level !== EVENT_LEVELS[parsed.event]) continue;
          const timestamp = new Date(parsed.timestamp);
          if (Number.isNaN(timestamp.getTime())) continue;
          entries.push({
            id: /^[0-9a-f-]{36}$/i.test(String(parsed.id || '')) ? parsed.id : randomUUID(),
            timestamp: timestamp.toISOString(),
            level: parsed.level,
            event: parsed.event,
            details: sanitizeDetails(parsed.event, parsed.details)
          });
        } catch {}
      }
    }
    return { entries, byteSize, fileCount };
  }

  async list(limit = 200) {
    const result = await this.readEntries();
    const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), MAX_LIST_ENTRIES);
    return {
      available: this.available,
      entries: result.entries.slice(-safeLimit).reverse(),
      byte_size: result.byteSize,
      file_count: result.fileCount,
      max_bytes: this.maxBytes * this.maxFiles
    };
  }

  async exportJSONL() {
    const result = await this.readEntries();
    return Buffer.from(result.entries.map((entry) => JSON.stringify(entry)).join('\n') + (result.entries.length ? '\n' : ''));
  }

  async clear() {
    await this.queue;
    for (const name of LOG_FILE_NAMES.slice(0, this.maxFiles)) {
      await unlink(path.join(this.directory, name)).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    await appendFile(this.filePath, '', { mode: 0o600 });
    await chmod(this.filePath, 0o600);
    this.available = true;
    return true;
  }

  async flush() {
    await this.queue;
  }
}

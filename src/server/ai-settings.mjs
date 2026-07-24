import { AIService } from './ai.mjs';
import { normalizeAIEndpoint } from './settings.mjs';

function configurationError(message, status = 400) {
  return Object.assign(new Error(message), { status, expected: true });
}

export class AISettingsManager {
  constructor({ settingsStore, credentialStore, aiService, environment = process.env } = {}) {
    this.settingsStore = settingsStore;
    this.credentialStore = credentialStore;
    this.aiService = aiService;
    this.environment = environment || {};
    this.effective = { enabled: false, endpoint: '', apiKey: '', source: 'local' };
  }

  async initialize() {
    await this.apply();
    return this;
  }

  async resolve() {
    const stored = this.settingsStore.getAI();
    if (!stored.configured) {
      const endpoint = String(this.environment.READER_AI_ENDPOINT || '').trim();
      const apiKey = String(this.environment.READER_AI_API_KEY || '');
      return { stored, enabled: Boolean(endpoint), endpoint, apiKey, source: endpoint ? 'environment' : 'local', apiKeySource: apiKey ? 'environment' : 'none' };
    }
    let apiKey = '';
    if (stored.hasApiKey) apiKey = String(await this.credentialStore.get() || '');
    return { stored, enabled: stored.enabled, endpoint: stored.endpoint, apiKey, source: 'settings', apiKeySource: apiKey ? 'keychain' : 'none' };
  }

  async apply() {
    this.effective = await this.resolve();
    this.aiService.configure({
      enabled: this.effective.enabled, endpoint: this.effective.endpoint, apiKey: this.effective.apiKey,
      source: this.effective.source, credentialBackend: this.credentialStore.describe().backend
    });
    return this.publicSettings();
  }

  async publicSettings() {
    const current = await this.resolve();
    const credential = this.credentialStore.describe();
    return {
      configured: current.stored.configured,
      enabled: current.enabled,
      endpoint: current.endpoint,
      apiKeyStored: current.apiKeySource !== 'none',
      apiKeySource: current.apiKeySource,
      credentialBackend: credential.backend,
      credentialWritable: credential.writable,
      environmentAvailable: Boolean(this.environment.READER_AI_ENDPOINT),
      updatedAt: current.stored.updatedAt,
      warning: this.settingsStore.loadError
    };
  }

  async update(input = {}) {
    const endpoint = normalizeAIEndpoint(input.endpoint);
    const enabled = Boolean(input.enabled);
    if (enabled && !endpoint) throw configurationError('启用远程 AI 前需要填写服务地址');
    const previous = await this.resolve();
    const wantsNewKey = typeof input.apiKey === 'string' && input.apiKey.length > 0;
    const clearKey = Boolean(input.clearApiKey);
    let hasApiKey = previous.stored.configured ? previous.stored.hasApiKey : false;
    let credentialChanged = false;
    try {
      if (wantsNewKey) {
        if (input.apiKey.length > 8192) throw configurationError('AI API 密钥长度超过限制');
        await this.credentialStore.set(input.apiKey);
        hasApiKey = true; credentialChanged = true;
      } else if (clearKey) {
        await this.credentialStore.delete();
        hasApiKey = false; credentialChanged = true;
      }
      await this.settingsStore.saveAI({ enabled, endpoint, hasApiKey });
    } catch (error) {
      if (credentialChanged) {
        if (previous.apiKey) await this.credentialStore.set(previous.apiKey).catch(() => {});
        else await this.credentialStore.delete().catch(() => {});
      }
      throw error;
    }
    return await this.apply();
  }

  async reset() {
    const stored = this.settingsStore.getAI();
    if (stored.hasApiKey) await this.credentialStore.delete();
    await this.settingsStore.resetAI();
    return await this.apply();
  }

  async test(input = {}) {
    const current = await this.resolve();
    const endpoint = normalizeAIEndpoint(input.endpoint || current.endpoint);
    if (!endpoint) throw configurationError('请先填写 AI 服务地址');
    const apiKey = typeof input.apiKey === 'string' && input.apiKey ? input.apiKey : current.apiKey;
    const tester = new AIService({ endpoint, apiKey });
    return await tester.testConnection();
  }
}

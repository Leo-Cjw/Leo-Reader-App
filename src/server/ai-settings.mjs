import { AIService } from './ai.mjs';
import { normalizeAIConfiguration, publicAIProviderPresets } from './ai-providers.mjs';

function configurationError(message, status = 400) {
  return Object.assign(new Error(message), { status, expected: true });
}

function candidateApiKey(input, current, configuration) {
  if (typeof input.apiKey === 'string' && input.apiKey) return input.apiKey;
  const sameScope = configuration.provider === current.provider && configuration.endpoint === current.endpoint;
  return sameScope ? current.apiKey : '';
}

export class AISettingsManager {
  constructor({ settingsStore, credentialStore, aiService, environment = process.env } = {}) {
    this.settingsStore = settingsStore;
    this.credentialStore = credentialStore;
    this.aiService = aiService;
    this.environment = environment || {};
    this.effective = { enabled: false, provider: 'reader-gateway', endpoint: '', model: '', apiKey: '', source: 'local' };
    this.mutationQueue = Promise.resolve();
  }

  async initialize() {
    await this.apply();
    return this;
  }

  async resolve() {
    const stored = this.settingsStore.getAI();
    if (!stored.configured) {
      const provider = String(this.environment.READER_AI_PROVIDER || 'reader-gateway').trim();
      const endpoint = String(this.environment.READER_AI_ENDPOINT || '').trim();
      const model = String(this.environment.READER_AI_MODEL || '').trim();
      const apiKey = String(this.environment.READER_AI_API_KEY || '');
      const environmentAvailable = Boolean(
        this.environment.READER_AI_PROVIDER || this.environment.READER_AI_ENDPOINT || this.environment.READER_AI_MODEL
      );
      const configuration = normalizeAIConfiguration({ enabled: environmentAvailable, provider, endpoint, model });
      return {
        stored, ...configuration, apiKey,
        source: environmentAvailable ? 'environment' : 'local',
        apiKeySource: apiKey ? 'environment' : 'none',
        environmentAvailable
      };
    }
    let apiKey = '';
    if (stored.hasApiKey) apiKey = String(await this.credentialStore.get() || '');
    const configuration = normalizeAIConfiguration(stored);
    return {
      stored, ...configuration, apiKey, source: 'settings',
      apiKeySource: apiKey ? 'keychain' : 'none',
      environmentAvailable: Boolean(
        this.environment.READER_AI_PROVIDER || this.environment.READER_AI_ENDPOINT || this.environment.READER_AI_MODEL
      )
    };
  }

  async apply() {
    this.effective = await this.resolve();
    this.aiService.configure({
      enabled: this.effective.enabled, provider: this.effective.provider, endpoint: this.effective.endpoint,
      model: this.effective.model, apiKey: this.effective.apiKey,
      source: this.effective.source, credentialBackend: this.credentialStore.describe().backend
    });
    return this.publicSettingsSnapshot();
  }

  async publicSettings() {
    await this.mutationQueue;
    return await this.publicSettingsSnapshot();
  }

  async publicSettingsSnapshot() {
    const current = await this.resolve();
    const credential = this.credentialStore.describe();
    return {
      configured: current.stored.configured,
      enabled: current.enabled,
      provider: current.provider,
      endpoint: current.endpoint,
      model: current.model,
      providers: publicAIProviderPresets(),
      apiKeyStored: current.apiKeySource !== 'none',
      apiKeySource: current.apiKeySource,
      credentialBackend: credential.backend,
      credentialWritable: credential.writable,
      environmentAvailable: current.environmentAvailable,
      updatedAt: current.stored.updatedAt,
      warning: this.settingsStore.loadError
    };
  }

  enqueueMutation(mutation) {
    const operation = this.mutationQueue.then(mutation);
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  update(input = {}) {
    return this.enqueueMutation(() => this.performUpdate(input));
  }

  async performUpdate(input = {}) {
    const configuration = normalizeAIConfiguration(input);
    const previous = await this.resolve();
    const wantsNewKey = typeof input.apiKey === 'string' && input.apiKey.length > 0;
    const credentialScopeChanged = configuration.provider !== previous.provider || configuration.endpoint !== previous.endpoint;
    const clearKey = Boolean(input.clearApiKey) || (credentialScopeChanged && !wantsNewKey);
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
      await this.settingsStore.saveAI({ ...configuration, hasApiKey });
    } catch (error) {
      if (credentialChanged) {
        if (previous.apiKey) await this.credentialStore.set(previous.apiKey).catch(() => {});
        else await this.credentialStore.delete().catch(() => {});
      }
      throw error;
    }
    return await this.apply();
  }

  reset() {
    return this.enqueueMutation(() => this.performReset());
  }

  async performReset() {
    const previous = await this.resolve();
    let credentialDeleted = false;
    try {
      if (previous.stored.hasApiKey) credentialDeleted = await this.credentialStore.delete();
      await this.settingsStore.resetAI();
    } catch (error) {
      if (credentialDeleted && previous.apiKey) {
        await this.credentialStore.set(previous.apiKey).catch(() => {});
      }
      throw error;
    }
    return await this.apply();
  }

  async test(input = {}) {
    await this.mutationQueue;
    const current = await this.resolve();
    const configuration = normalizeAIConfiguration({
      enabled: true,
      provider: typeof input.provider === 'string' ? input.provider : current.provider,
      endpoint: typeof input.endpoint === 'string' ? input.endpoint : current.endpoint,
      model: typeof input.model === 'string' ? input.model : current.model
    });
    const apiKey = candidateApiKey(input, current, configuration);
    const tester = new AIService({ ...configuration, apiKey });
    return await tester.testConnection();
  }

  async models(input = {}) {
    await this.mutationQueue;
    const current = await this.resolve();
    const configuration = normalizeAIConfiguration({
      enabled: true,
      provider: typeof input.provider === 'string' ? input.provider : current.provider,
      endpoint: typeof input.endpoint === 'string' ? input.endpoint : current.endpoint,
      model: typeof input.model === 'string' && input.model.trim() ? input.model : 'catalog-placeholder'
    });
    const apiKey = candidateApiKey(input, current, configuration);
    return await new AIService({ ...configuration, apiKey }).listModels();
  }
}

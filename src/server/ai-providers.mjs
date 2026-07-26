const PROVIDERS = [
  {
    id: 'reader-gateway',
    name: 'Reader Gateway',
    kind: 'reader-gateway',
    defaultEndpoint: '',
    endpointLocked: false,
    modelRequired: false,
    modelCatalog: false,
    apiKeyRecommended: false
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    defaultEndpoint: 'https://api.openai.com/v1/',
    endpointLocked: true,
    modelRequired: true,
    modelCatalog: true,
    apiKeyRecommended: true
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    kind: 'openai-compatible',
    defaultEndpoint: 'http://127.0.0.1:11434/v1/',
    endpointLocked: true,
    modelRequired: true,
    modelCatalog: true,
    apiKeyRecommended: false
  },
  {
    id: 'openai-compatible',
    name: '其他 OpenAI-compatible 服务',
    kind: 'openai-compatible',
    defaultEndpoint: '',
    endpointLocked: false,
    modelRequired: true,
    modelCatalog: true,
    apiKeyRecommended: false
  }
];

export const AI_PROVIDER_PRESETS = Object.freeze(PROVIDERS.map((provider) => Object.freeze({ ...provider })));

function configurationError(message, status = 400) {
  return Object.assign(new Error(message), { status, expected: true });
}

export function getAIProviderPreset(value) {
  const id = String(value || 'reader-gateway').trim();
  const preset = AI_PROVIDER_PRESETS.find((provider) => provider.id === id);
  if (!preset) throw configurationError('不支持的 AI 提供商');
  return preset;
}

export function normalizeAIEndpoint(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (input.length > 2048) throw configurationError('AI 服务地址长度超过限制');
  let url;
  try { url = new URL(input); }
  catch { throw configurationError('AI 服务地址不是有效 URL'); }
  if (url.username || url.password) throw configurationError('AI 服务地址不能包含用户名或密码');
  if (url.hash) throw configurationError('AI 服务地址不能包含片段');
  for (const name of url.searchParams.keys()) {
    if (/(?:api.?key|token|secret|signature|credential|password|^sig$)/i.test(name)) {
      throw configurationError('AI 服务地址不能在查询参数中包含密钥；请使用 API 密钥字段');
    }
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw configurationError('远程 AI 服务必须使用 HTTPS；HTTP 仅允许 localhost 或 127.0.0.1');
  }
  return url.toString();
}

export function normalizeAIModel(value, { required = false } = {}) {
  const model = String(value || '').trim();
  if (!model) {
    if (required) throw configurationError('请选择或填写模型 ID');
    return '';
  }
  if (model.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw configurationError('模型 ID 只能包含字母、数字、点、下划线、冒号、斜杠或连字符，且最长 200 个字符');
  }
  return model;
}

function normalizeCompatibleBase(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

export function normalizeAIConfiguration(input = {}) {
  const enabled = Boolean(input.enabled);
  const preset = getAIProviderPreset(input.provider);
  const normalizedEndpoint = normalizeAIEndpoint(input.endpoint);
  const normalizedDefault = normalizeAIEndpoint(preset.defaultEndpoint);
  const suppliedEndpoint = preset.kind === 'openai-compatible' ? normalizeCompatibleBase(normalizedEndpoint) : normalizedEndpoint;
  const defaultEndpoint = preset.kind === 'openai-compatible' ? normalizeCompatibleBase(normalizedDefault) : normalizedDefault;
  if (preset.endpointLocked && suppliedEndpoint && suppliedEndpoint !== defaultEndpoint) {
    throw configurationError('该 AI 提供商预设服务地址不可修改');
  }
  const endpoint = preset.endpointLocked ? defaultEndpoint : suppliedEndpoint;
  if (enabled && !endpoint) throw configurationError('启用远程 AI 前需要填写服务地址');
  if (preset.kind === 'openai-compatible' && endpoint && new URL(endpoint).search) {
    throw configurationError('OpenAI-compatible 基础地址不能包含查询参数');
  }
  const model = preset.kind === 'reader-gateway'
    ? ''
    : normalizeAIModel(input.model, { required: enabled && preset.modelRequired });
  return { enabled, provider: preset.id, endpoint, model };
}

export function publicAIProviderPresets() {
  return AI_PROVIDER_PRESETS.map((provider) => ({
    id: provider.id,
    name: provider.name,
    defaultEndpoint: provider.defaultEndpoint,
    endpointLocked: provider.endpointLocked,
    modelRequired: provider.modelRequired,
    modelCatalog: provider.modelCatalog,
    apiKeyRecommended: provider.apiKeyRecommended
  }));
}

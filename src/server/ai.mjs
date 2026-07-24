function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[。！？!?])\s*|(?<=\.)\s+/).map((item) => item.trim()).filter((item) => item.length >= 18);
}

function terms(text) {
  const english = String(text || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || [];
  const cjk = String(text || '').match(/[\u3400-\u9fff]{2,6}/g) || [];
  const stop = new Set(['this','that','with','from','have','will','about','their','into','when','where','一个','我们','可以','以及','这个','因为','不是','文章','作者']);
  return [...english, ...cjk].filter((term) => !stop.has(term));
}

export function extractiveSummary(article, maxSentences = 3) {
  const list = sentences(article.content);
  if (!list.length) return article.excerpt || article.title;
  const frequency = new Map();
  for (const term of terms(article.content)) frequency.set(term, (frequency.get(term) || 0) + 1);
  const scored = list.map((sentence, index) => ({
    sentence,
    index,
    score: terms(sentence).reduce((total, term) => total + (frequency.get(term) || 0), 0) / Math.max(sentence.length, 1) + (index === 0 ? 0.4 : 0)
  }));
  return scored.sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.index - b.index).map((item) => item.sentence).join(' ');
}

export function keyPoints(article, count = 3) {
  const list = sentences(article.content);
  return list.slice(0, count).map((sentence) => sentence.replace(/^[-•\s]+/, '').slice(0, 120));
}

const AI_TIMEOUT_MS = 60_000;
const MAX_AI_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_AI_SOURCE_CHARS = 240_000;

function aiError(message, status = 502, expected = false) {
  return Object.assign(new Error(message), { status, expected });
}

function cleanResultText(value, name, maxLength = 500_000) {
  const result = String(value || '').trim();
  if (!result) throw aiError(`AI 服务没有返回${name}`);
  if (result.length > maxLength) throw aiError(`AI 服务返回的${name}超过限制`);
  return result;
}

function plainSourceText(value) {
  return String(value || '')
    .replace(/!\[([^\]]*)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/gm, '')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function compactRagContext(context) {
  return (Array.isArray(context) ? context : []).slice(0, 8).map((item, index) => ({
    id: String(item.id || `citation-${index + 1}`).slice(0, 240),
    articleId: String(item.articleId || '').slice(0, 240),
    articleTitle: String(item.articleTitle || '').slice(0, 500),
    articleSource: String(item.articleSource || '').slice(0, 500),
    heading: String(item.heading || '').slice(0, 500),
    quote: String(item.quote || '').slice(0, 2_000)
  })).filter((item) => item.quote);
}

function localRagAnswer(prompt, context, scope) {
  if (!context.length) return `Reader 没有在${scope === 'library' ? '本地资料库' : '当前文章'}中找到能直接支持回答的片段。可以换一个更具体的关键词，或切换检索范围。`;
  const excerpts = context.slice(0, 3).map((item, index) => {
    const text = plainSourceText(item.quote).replace(/\s+/g, ' ').trim();
    return `${text.slice(0, 420)}${text.length > 420 ? '…' : ''} [${index + 1}]`;
  });
  return `我在${scope === 'library' ? '本地资料库' : '当前文章'}中检索到以下直接相关的原文：\n\n${excerpts.join('\n\n')}\n\n这是提取式回答，只复述命中的原文片段；下方引用可以回到来源核对。`;
}

function localComposition(articles, { prompt = '', format = 'brief', language = 'zh' } = {}) {
  const labels = { brief: '资料综述', outline: '写作提纲', essay: '长文草稿', social: '社交媒体草稿' };
  const title = `${labels[format] || labels.brief} · ${articles.length} 篇来源`;
  const sourceSections = articles.map((article, index) => {
    const summary = extractiveSummary({ ...article, content: plainSourceText(article.content) }, format === 'outline' ? 2 : 3);
    return `## ${index + 1}. ${article.title}\n\n${summary}\n\n> Reader 来源 ID：${article.id}`;
  });
  const instruction = prompt ? `> 写作目标：${prompt.replaceAll('\n', ' ')}` : '> 本草稿只整理来源中的明确内容，不生成来源之外的事实。';
  const content = `# ${title}\n\n${instruction}\n\n${sourceSections.join('\n\n')}\n\n## 下一步\n\n在编辑器中重组段落、补充观点，并保留需要引用的来源。`;
  return { provider: 'local-structured', model: null, title, excerpt: `基于 ${articles.length} 篇本地资料生成的可追溯整理草稿。`, content, language };
}

export class AIService {
  constructor({ endpoint = process.env.READER_AI_ENDPOINT, apiKey = process.env.READER_AI_API_KEY, enabled = Boolean(endpoint) } = {}) {
    this.configure({ endpoint, apiKey, enabled, source: endpoint ? 'environment' : 'local', credentialBackend: apiKey ? 'environment' : 'none' });
  }

  configure({ endpoint = '', apiKey = '', enabled = Boolean(endpoint), source = 'settings', credentialBackend = 'none' } = {}) {
    this.endpoint = enabled ? String(endpoint || '') : '';
    this.apiKey = String(apiKey || '');
    this.configuration = { source, credentialBackend };
    return this.status();
  }

  status() {
    return {
      provider: this.endpoint ? 'configured' : 'local', remoteConfigured: Boolean(this.endpoint),
      configurationSource: this.configuration.source, credentialBackend: this.configuration.credentialBackend,
      capabilities: { summary: true, chat: true, rag: true, compose: true, translate: Boolean(this.endpoint) }
    };
  }

  async testConnection() {
    const result = await this.callRemote('summarize', { article: { title: 'Reader 连接测试', content: 'This is a connection test from Reader. It does not contain library content.', language: 'en' } });
    return { ok: true, provider: 'configured', model: result.model || null, summary: cleanResultText(result.summary, '测试摘要', 2_000) };
  }

  async callRemote(action, payload) {
    if (!this.endpoint) throw aiError('翻译需要先配置 AI 服务；Reader 不会用不可靠的本地替换冒充翻译。', 503, true);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({ action, ...payload })
      });
    } catch (error) {
      if (error.name === 'AbortError') throw aiError('AI 服务请求超时', 504);
      throw aiError(`AI 服务连接失败：${error.message || '未知错误'}`);
    } finally { clearTimeout(timer); }
    if (!response.ok) throw aiError(`AI 服务返回 ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_AI_RESPONSE_BYTES) throw aiError('AI 服务响应过大');
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_AI_RESPONSE_BYTES) throw aiError('AI 服务响应过大');
    try {
      const result = JSON.parse(text);
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid result');
      return result;
    } catch { throw aiError('AI 服务返回了无效 JSON'); }
  }

  async summarize(article) {
    if (!this.endpoint) return { provider: 'local-extractive', summary: extractiveSummary(article), points: keyPoints(article) };
    const result = await this.callRemote('summarize', { article: { title: article.title, content: article.content, language: article.language } });
    return { provider: 'configured', model: result.model || null, summary: cleanResultText(result.summary, '摘要', 20_000), points: Array.isArray(result.points || result.keyPoints) ? (result.points || result.keyPoints).map((point) => String(point).slice(0, 500)).slice(0, 12) : [] };
  }

  async chat(article, prompt, { context = [], scope = 'article' } = {}) {
    const retrieved = compactRagContext(context);
    if (!retrieved.length) return { provider: 'local-rag', answer: localRagAnswer(prompt, [], scope), citationIds: [] };
    if (!this.endpoint) {
      return { provider: 'local-rag', answer: localRagAnswer(prompt, retrieved, scope), citationIds: retrieved.slice(0, 3).map((item) => item.id) };
    }
    const result = await this.callRemote('chat', {
      prompt,
      scope,
      context: retrieved,
      instructions: 'Answer only from the supplied Reader context. Cite supporting context with [1], [2], etc. Say when evidence is insufficient.'
    });
    const allowedIds = new Set(retrieved.map((item) => item.id));
    const requestedIds = Array.isArray(result.citationIds) ? result.citationIds.map(String).filter((id) => allowedIds.has(id)) : [];
    return { provider: 'configured', model: result.model || null, answer: cleanResultText(result.answer, '回答', 100_000), citationIds: requestedIds.length ? requestedIds : retrieved.map((item) => item.id) };
  }

  async translate(article, targetLanguage) {
    const result = await this.callRemote('translate', { targetLanguage, article: { title: article.title, excerpt: article.excerpt, content: article.content, language: article.language } });
    return {
      provider: 'configured', model: result.model || null, language: String(result.language || targetLanguage).slice(0, 40),
      title: cleanResultText(result.title || `${article.title} · ${targetLanguage}`, '标题', 500),
      excerpt: String(result.excerpt || '').trim().slice(0, 2_000), content: cleanResultText(result.content, '译文')
    };
  }

  async compose(articles, options = {}) {
    if (!this.endpoint) return localComposition(articles, options);
    let remaining = MAX_AI_SOURCE_CHARS;
    const sources = articles.map((article) => {
      const content = String(article.content || '').slice(0, Math.min(80_000, remaining));
      remaining = Math.max(0, remaining - content.length);
      return { id: article.id, title: article.title, excerpt: article.excerpt, content, language: article.language, source: article.source };
    });
    const result = await this.callRemote('compose', { prompt: options.prompt || '', format: options.format || 'brief', language: options.language || 'zh', articles: sources });
    return {
      provider: 'configured', model: result.model || null, language: String(result.language || options.language || 'zh').slice(0, 40),
      title: cleanResultText(result.title || '跨资料创作草稿', '标题', 500), excerpt: String(result.excerpt || '').trim().slice(0, 2_000),
      content: cleanResultText(result.content, '创作内容')
    };
  }
}

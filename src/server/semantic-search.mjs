import { normalizeAIModel } from './ai-providers.mjs';

const OLLAMA_EMBED_ENDPOINT = 'http://127.0.0.1:11434/api/embed';
const EMBED_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_BATCH_SIZE = 16;
const MAX_INPUT_CHARS = 2_000;
const MIN_DIMENSIONS = 8;
const MAX_DIMENSIONS = 4_096;
const HASH_BANDS = 16;
const HASH_BITS = 8;
const HASH_SAMPLES = 8;
const BUCKET_PROBES_PER_BAND = 3;
const POLL_INTERVAL_MS = 2_000;
const QUALITY_MARGIN = 0.05;
const QUALITY_PROBES = Object.freeze([
  Object.freeze({
    locale: 'zh',
    anchor: '小猫喜欢在温暖的窗边晒太阳和睡觉。',
    positive: '猫咪常常蜷缩在有阳光的窗台上打盹。',
    negative: '数据库备份需要校验文件完整性。'
  }),
  Object.freeze({
    locale: 'en',
    anchor: 'Healthy plants need sunlight and regular watering.',
    positive: 'Flowers grow well with enough light and water.',
    negative: 'A database backup should verify file integrity.'
  }),
  Object.freeze({
    locale: 'cross-language',
    anchor: 'Local-first software keeps the primary copy on the user device.',
    positive: '本地优先软件把主要数据副本保存在用户设备上。',
    negative: '酸面包需要经过长时间发酵。'
  })
]);

function semanticError(message, status = 503) {
  return Object.assign(new Error(message), { status, expected: true });
}

function hash32(value) {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
}

export function normalizeEmbeddingModel(value, { required = true } = {}) {
  return normalizeAIModel(value, { required });
}

export function normalizeEmbeddingVector(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) throw semanticError('本地嵌入模型返回了无效向量');
  if (value.length < MIN_DIMENSIONS || value.length > MAX_DIMENSIONS) throw semanticError('本地嵌入向量维度超过限制');
  const vector = new Float32Array(value.length);
  let magnitudeSquared = 0;
  for (let index = 0; index < value.length; index += 1) {
    const number = Number(value[index]);
    if (!Number.isFinite(number) || Math.abs(number) > 1_000_000) throw semanticError('本地嵌入模型返回了无效向量');
    vector[index] = number;
    magnitudeSquared += number * number;
  }
  if (!Number.isFinite(magnitudeSquared) || magnitudeSquared <= 1e-12) throw semanticError('本地嵌入模型返回了空向量');
  const magnitude = Math.sqrt(magnitudeSquared);
  for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
  return vector;
}

export function embeddingVectorHex(value) {
  const vector = normalizeEmbeddingVector(value);
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index += 1) buffer.writeFloatLE(vector[index], index * 4);
  return buffer.toString('hex');
}

export function embeddingVectorFromHex(value, dimensions) {
  const size = Number(dimensions);
  if (!Number.isSafeInteger(size) || size < MIN_DIMENSIONS || size > MAX_DIMENSIONS) throw semanticError('本地向量索引维度无效');
  const hex = String(value || '');
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length !== size * 8) throw semanticError('本地向量索引内容无效');
  const buffer = Buffer.from(hex, 'hex');
  const vector = new Float32Array(size);
  for (let index = 0; index < size; index += 1) vector[index] = buffer.readFloatLE(index * 4);
  return vector;
}

function embeddingBucketAnalysis(value) {
  const vector = normalizeEmbeddingVector(value);
  const bands = [];
  for (let band = 0; band < HASH_BANDS; band += 1) {
    let bucket = 0;
    const margins = [];
    for (let bit = 0; bit < HASH_BITS; bit += 1) {
      let projection = 0;
      for (let sample = 0; sample < HASH_SAMPLES; sample += 1) {
        const seed = hash32(0x9e3779b9 ^ (band * 131 + bit * 17 + sample));
        const index = seed % vector.length;
        projection += vector[index] * (seed & 0x80000000 ? 1 : -1);
      }
      if (projection >= 0) bucket |= 1 << bit;
      margins.push({ bit, magnitude: Math.abs(projection) });
    }
    bands.push({ band, bucket, margins });
  }
  return bands;
}

export function embeddingBuckets(value) {
  return embeddingBucketAnalysis(value).map(({ band, bucket }) => ({ band, bucket }));
}

export function embeddingBucketProbes(value) {
  return embeddingBucketAnalysis(value).flatMap(({ band, bucket, margins }) => {
    const weakestBits = [...margins]
      .sort((left, right) => left.magnitude - right.magnitude || left.bit - right.bit)
      .slice(0, BUCKET_PROBES_PER_BAND - 1);
    return [
      { band, bucket, exact: true },
      ...weakestBits.map(({ bit }) => ({ band, bucket: bucket ^ (1 << bit), exact: false }))
    ];
  });
}

export function cosineSimilarity(leftValue, rightValue) {
  const left = normalizeEmbeddingVector(leftValue);
  const right = normalizeEmbeddingVector(rightValue);
  if (left.length !== right.length) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return Math.max(-1, Math.min(1, score));
}

export function evaluateEmbeddingQuality(vectors) {
  if (!Array.isArray(vectors) || vectors.length !== QUALITY_PROBES.length * 3) {
    throw semanticError('本地嵌入质量探针返回不完整');
  }
  const probes = QUALITY_PROBES.map((probe, index) => {
    const offset = index * 3;
    const positiveSimilarity = cosineSimilarity(vectors[offset], vectors[offset + 1]);
    const negativeSimilarity = cosineSimilarity(vectors[offset], vectors[offset + 2]);
    const margin = positiveSimilarity - negativeSimilarity;
    return {
      locale: probe.locale,
      passed: margin >= QUALITY_MARGIN,
      margin: Number(margin.toFixed(4))
    };
  });
  const passed = probes.filter((probe) => probe.passed).length;
  const averageMargin = probes.reduce((sum, probe) => sum + probe.margin, 0) / probes.length;
  return {
    version: 1,
    passed,
    total: probes.length,
    averageMargin: Number(averageMargin.toFixed(4)),
    assessment: passed === probes.length ? 'strong' : passed >= 2 ? 'partial' : 'poor'
  };
}

async function boundedResponseJSON(response) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_RESPONSE_BYTES) throw semanticError('本地嵌入服务响应过大');
  const reader = response.body?.getReader?.();
  if (!reader) throw semanticError('本地嵌入服务返回了无效响应');
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw semanticError('本地嵌入服务响应过大');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks, totalBytes).toString('utf8');
  try {
    const result = JSON.parse(text);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid response');
    return result;
  } catch {
    throw semanticError('本地嵌入服务返回了无效 JSON');
  }
}

export class OllamaEmbeddingClient {
  constructor({ fetchImpl = fetch, endpoint = OLLAMA_EMBED_ENDPOINT } = {}) {
    if (endpoint !== OLLAMA_EMBED_ENDPOINT) throw semanticError('本地嵌入服务地址不可修改', 400);
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
  }

  async embed(inputs, model) {
    const normalizedModel = normalizeEmbeddingModel(model);
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_BATCH_SIZE) {
      throw semanticError(`本地嵌入每批必须包含 1–${MAX_BATCH_SIZE} 段文本`, 400);
    }
    const normalizedInputs = inputs.map((value) => {
      const text = String(value || '').trim();
      if (!text || text.length > MAX_INPUT_CHARS) throw semanticError('本地嵌入文本长度超过限制', 400);
      return text;
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: normalizedModel, input: normalizedInputs, truncate: false })
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw semanticError('本地嵌入服务请求超时', 504);
      throw semanticError(`无法连接本机 Ollama：${error?.message || '未知错误'}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw semanticError(`本机 Ollama 返回 ${response.status}`);
    const result = await boundedResponseJSON(response);
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== normalizedInputs.length) {
      throw semanticError('本地嵌入服务没有返回完整批次');
    }
    const vectors = result.embeddings.map(normalizeEmbeddingVector);
    const dimensions = vectors[0].length;
    if (vectors.some((vector) => vector.length !== dimensions)) throw semanticError('本地嵌入服务返回了不一致的向量维度');
    return { model: normalizedModel, dimensions, vectors };
  }
}

export function fuseHybridResults(lexical, semantic, limit = 6) {
  const rows = new Map();
  const add = (item, rank, weight, kind) => {
    const current = rows.get(item.id) || { item, score: 0, lexicalRank: null, semanticRank: null };
    current.score += weight / (60 + rank);
    current[`${kind}Rank`] = rank;
    if (kind === 'semantic' && Number(item.semanticScore) > Number(current.item.semanticScore || -1)) current.item = item;
    rows.set(item.id, current);
  };
  lexical.forEach((item, index) => add(item, index + 1, 0.5, 'lexical'));
  semantic.filter((item) => Number(item.semanticScore) >= 0.1).forEach((item, index) => add(item, index + 1, 0.5, 'semantic'));
  return [...rows.values()]
    .sort((left, right) => right.score - left.score
      || Number(right.lexicalRank !== null && right.semanticRank !== null) - Number(left.lexicalRank !== null && left.semanticRank !== null)
      || Number(left.lexicalRank ?? Number.POSITIVE_INFINITY) - Number(right.lexicalRank ?? Number.POSITIVE_INFINITY)
      || Number(right.item.semanticScore || -1) - Number(left.item.semanticScore || -1)
      || Number(left.item.chunkIndex || 0) - Number(right.item.chunkIndex || 0))
    .slice(0, Math.min(Math.max(Number(limit) || 6, 1), 12))
    .map(({ item, score }) => ({ ...item, score: Number((score * 10_000).toFixed(4)) }));
}

export function createSemanticSearchService({
  database,
  settingsStore,
  client = new OllamaEmbeddingClient(),
  pollIntervalMs = POLL_INTERVAL_MS
}) {
  let timer = null;
  let active = null;
  let stopped = false;
  let paused = false;
  let state = settingsStore.getSemanticSearch().enabled ? 'starting' : 'disabled';
  let warning = null;
  let indexedAt = null;
  let quality = null;
  let qualityModel = null;

  async function status() {
    const settings = settingsStore.getSemanticSearch();
    const index = await database.getEmbeddingIndexStatus(settings.model);
    if (settings.enabled && !paused && !active && index.pendingChunks === 0 && state !== 'error') state = 'ready';
    return {
      ...settings,
      ...index,
      state: settings.enabled ? (paused ? 'paused' : state) : 'disabled',
      indexedAt,
      warning,
      quality: qualityModel === settings.model ? quality : null
    };
  }

  async function drain() {
    const settings = settingsStore.getSemanticSearch();
    if (stopped || paused || !settings.enabled) return;
    if (active) return active;
    active = (async () => {
      state = 'indexing';
      warning = null;
      try {
        const chunks = await database.listPendingEmbeddingChunks(settings.model, MAX_BATCH_SIZE);
        if (!chunks.length) {
          state = 'ready';
          indexedAt = new Date().toISOString();
          return;
        }
        const embedded = await client.embed(chunks.map((chunk) => `${chunk.heading ? `${chunk.heading}\n` : ''}${chunk.content}`), settings.model);
        const current = await database.getEmbeddingIndexStatus(settings.model);
        if (current.embeddedChunks > 0 && current.dimensions !== embedded.dimensions) await database.clearChunkEmbeddings();
        await database.saveChunkEmbeddings(settings.model, chunks.map((chunk, index) => ({
          chunkId: chunk.id,
          contentHash: chunk.content_sha256,
          vector: embedded.vectors[index]
        })));
        const next = await database.getEmbeddingIndexStatus(settings.model);
        if (next.pendingChunks === 0) {
          state = 'ready';
          indexedAt = new Date().toISOString();
        }
      } catch {
        state = 'error';
        warning = '本地语义索引暂时不可用；Reader 已保留全文检索，并会稍后重试。';
      } finally {
        active = null;
      }
    })();
    return active;
  }

  async function test(model) {
    const result = await client.embed(
      QUALITY_PROBES.flatMap((probe) => [probe.anchor, probe.positive, probe.negative]),
      normalizeEmbeddingModel(model)
    );
    quality = evaluateEmbeddingQuality(result.vectors);
    qualityModel = result.model;
    return { ok: true, model: result.model, dimensions: result.dimensions, quality };
  }

  async function update({ enabled, model }) {
    if (typeof enabled !== 'boolean') throw semanticError('enabled 必须是布尔值', 400);
    if (!enabled) {
      paused = true;
      if (active) await active;
      await database.clearChunkEmbeddings();
      await settingsStore.saveSemanticSearch(false, settingsStore.getSemanticSearch().model);
      state = 'disabled';
      warning = null;
      indexedAt = null;
      quality = null;
      qualityModel = null;
      paused = false;
      return await status();
    }
    const normalizedModel = normalizeEmbeddingModel(model);
    const tested = await test(normalizedModel);
    const previous = settingsStore.getSemanticSearch();
    const current = await database.getEmbeddingIndexStatus(normalizedModel);
    if (previous.model !== normalizedModel || (current.embeddedChunks > 0 && current.dimensions !== tested.dimensions)) {
      await database.clearChunkEmbeddings();
    }
    await settingsStore.saveSemanticSearch(true, normalizedModel);
    state = 'indexing';
    warning = null;
    void drain();
    return await status();
  }

  async function search(query, { articleId = null, limit = 6 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 12);
    const lexical = await database.searchArticleChunks(query, { articleId, limit: 12 });
    const settings = settingsStore.getSemanticSearch();
    if (!settings.enabled) return { citations: lexical.slice(0, safeLimit), mode: 'local-lexical-v1' };
    try {
      const result = await client.embed([String(query || '').trim().slice(0, MAX_INPUT_CHARS)], settings.model);
      const current = await database.getEmbeddingIndexStatus(settings.model);
      if (current.embeddedChunks > 0 && current.dimensions !== result.dimensions) {
        await database.clearChunkEmbeddings();
        state = 'indexing';
        warning = '本地嵌入模型已变化；Reader 正在重建派生向量，本次结果使用全文检索。';
        void drain();
        return { citations: lexical.slice(0, safeLimit), mode: 'local-lexical-fallback-v1' };
      }
      const semantic = await database.searchChunkEmbeddings(settings.model, result.vectors[0], { articleId, limit: 36 });
      warning = null;
      return { citations: fuseHybridResults(lexical, semantic, safeLimit), mode: 'local-hybrid-v1' };
    } catch {
      warning = '本地语义查询暂时不可用；本次结果已安全退回全文检索。';
      return { citations: lexical.slice(0, safeLimit), mode: 'local-lexical-fallback-v1' };
    }
  }

  async function start() {
    stopped = false;
    if (settingsStore.getSemanticSearch().enabled) void drain();
    timer = setInterval(() => { void drain(); }, pollIntervalMs);
    timer.unref?.();
    return await status();
  }

  async function pause() {
    paused = true;
    if (active) await active;
  }

  function resume() {
    paused = false;
    if (settingsStore.getSemanticSearch().enabled) void drain();
  }

  async function stop() {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (active) await active;
  }

  return { start, stop, pause, resume, drain, status, test, update, search };
}

export const SEMANTIC_SEARCH_DEFAULT_MODEL = 'embeddinggemma';
export const SEMANTIC_SEARCH_ENDPOINT = OLLAMA_EMBED_ENDPOINT;
export const SEMANTIC_SEARCH_HASH_BANDS = HASH_BANDS;
export const SEMANTIC_SEARCH_BUCKET_PROBES_PER_BAND = BUCKET_PROBES_PER_BAND;

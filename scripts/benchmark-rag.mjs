import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ReaderDatabase, sqlValue } from '../src/server/db.mjs';
import { embeddingBuckets, embeddingVectorHex, normalizeEmbeddingVector } from '../src/server/semantic-search.mjs';

const ARTICLE_COUNT = 2_000;
const CHUNKS_PER_ARTICLE = 5;
const QUERY_RUNS = 30;
const MAX_P95_MS = 250;
const EMBEDDING_MODEL = 'reader-benchmark-embedding';

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'reader-rag-benchmark-'));
try {
  const db = await new ReaderDatabase(path.join(dir, 'reader.sqlite3')).initialize();
  const timestamp = new Date().toISOString();
  const batchSize = 100;
  const indexStarted = performance.now();
  for (let start = 0; start < ARTICLE_COUNT; start += batchSize) {
    const statements = ['BEGIN IMMEDIATE;'];
    for (let articleIndex = start; articleIndex < Math.min(start + batchSize, ARTICLE_COUNT); articleIndex += 1) {
      const articleId = `bench-${articleIndex}`;
      const title = articleIndex % 100 === 0 ? `Reader 本地检索基准 ${articleIndex}` : `Benchmark article ${articleIndex}`;
      const excerpt = articleIndex % 100 === 0 ? '本地资料库使用分块索引定位可靠原文。' : 'Synthetic benchmark content.';
      statements.push(`INSERT INTO articles(id,title,excerpt,content,created_at,updated_at) VALUES (${[articleId,title,excerpt,'benchmark',timestamp,timestamp].map(sqlValue).join(',')});`);
      for (let chunkIndex = 0; chunkIndex < CHUNKS_PER_ARTICLE; chunkIndex += 1) {
        const relevant = articleIndex % 100 === 0 && chunkIndex === 2;
        const content = relevant
          ? `Reader 将文章 ${articleIndex} 的本地数据写入 SQLite，并用分块索引返回可以核对的原文引用。`
          : `Synthetic document ${articleIndex}, section ${chunkIndex}. Offline reading remains available and durable.`;
        statements.push(`INSERT INTO article_chunks(id,article_id,chunk_index,heading,content,start_offset,end_offset,content_sha256,created_at,updated_at) VALUES (${[
          `${articleId}:${chunkIndex}`, articleId, chunkIndex, `Section ${chunkIndex}`, content, chunkIndex * 100, chunkIndex * 100 + content.length, `${articleId}-${chunkIndex}`, timestamp, timestamp
        ].map(sqlValue).join(',')});`);
      }
    }
    statements.push('COMMIT;');
    await db.execute(statements.join('\n'));
  }
  const indexMs = performance.now() - indexStarted;
  const timings = [];
  let lastResults = [];
  for (let run = 0; run < QUERY_RUNS; run += 1) {
    const started = performance.now();
    lastResults = await db.searchArticleChunks(run % 2 ? 'local data offline reading' : '本地数据 SQLite 原文引用', { limit: 6 });
    timings.push(performance.now() - started);
  }
  const p50 = percentile(timings, 0.5);
  const p95 = percentile(timings, 0.95);
  const semanticIndexStarted = performance.now();
  for (let start = 0; start < ARTICLE_COUNT * CHUNKS_PER_ARTICLE; start += batchSize) {
    const statements = ['BEGIN IMMEDIATE;'];
    for (let flatIndex = start; flatIndex < Math.min(start + batchSize, ARTICLE_COUNT * CHUNKS_PER_ARTICLE); flatIndex += 1) {
      const articleIndex = Math.floor(flatIndex / CHUNKS_PER_ARTICLE);
      const chunkIndex = flatIndex % CHUNKS_PER_ARTICLE;
      const chunkId = `bench-${articleIndex}:${chunkIndex}`;
      const relevant = articleIndex % 100 === 0 && chunkIndex === 2;
      const vector = normalizeEmbeddingVector(relevant ? [1,0,0,0,0,0,0,0] : [0,1,0,0,0,0,0,0]);
      statements.push(`INSERT INTO chunk_embeddings(chunk_id,model,dimensions,vector,created_at) VALUES (${sqlValue(chunkId)},${sqlValue(EMBEDDING_MODEL)},8,X'${embeddingVectorHex(vector)}',${sqlValue(timestamp)});`);
      for (const { band, bucket } of embeddingBuckets(vector)) {
        statements.push(`INSERT INTO chunk_embedding_buckets(chunk_id,model,band,bucket) VALUES (${sqlValue(chunkId)},${sqlValue(EMBEDDING_MODEL)},${band},${bucket});`);
      }
    }
    statements.push('COMMIT;');
    await db.execute(statements.join('\n'));
  }
  const semanticIndexMs = performance.now() - semanticIndexStarted;
  const semanticTimings = [];
  let semanticResults = [];
  const semanticQuery = normalizeEmbeddingVector([1,0,0,0,0,0,0,0]);
  for (let run = 0; run < QUERY_RUNS; run += 1) {
    const started = performance.now();
    semanticResults = await db.searchChunkEmbeddings(EMBEDDING_MODEL, semanticQuery, { limit: 36 });
    semanticTimings.push(performance.now() - started);
  }
  const semanticP50 = percentile(semanticTimings, 0.5);
  const semanticP95 = percentile(semanticTimings, 0.95);
  const status = await db.getChunkIndexStatus();
  console.log(JSON.stringify({
    articles: status.articleCount,
    chunks: status.chunkCount,
    lexical: { indexMs: Number(indexMs.toFixed(1)), queryRuns: QUERY_RUNS, p50Ms: Number(p50.toFixed(2)), p95Ms: Number(p95.toFixed(2)), resultCount: lastResults.length },
    semantic: { indexMs: Number(semanticIndexMs.toFixed(1)), queryRuns: QUERY_RUNS, p50Ms: Number(semanticP50.toFixed(2)), p95Ms: Number(semanticP95.toFixed(2)), resultCount: semanticResults.length },
    gateMs: MAX_P95_MS
  }, null, 2));
  if (status.chunkCount < ARTICLE_COUNT * CHUNKS_PER_ARTICLE || !lastResults.length || !semanticResults.length
    || !status.embeddingConsistent || p95 > MAX_P95_MS || semanticP95 > MAX_P95_MS) process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}

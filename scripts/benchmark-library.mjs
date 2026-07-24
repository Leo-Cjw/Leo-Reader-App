import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { encodeArticleCursor, ReaderDatabase, sqlValue } from '../src/server/db.mjs';

const ARTICLE_COUNT = Math.max(1, Number(process.env.READER_BENCHMARK_ARTICLES) || 100_000);
const QUERY_RUNS = Math.max(1, Number(process.env.READER_BENCHMARK_RUNS) || 12);
const BATCH_SIZE = 500;
const MAX_INTERACTION_P95_MS = 250;

function articleTimestamp(index) {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function measure(run) {
  const timings = [];
  let value;
  for (let index = 0; index < QUERY_RUNS; index += 1) {
    const started = performance.now();
    value = await run(index);
    timings.push(performance.now() - started);
  }
  return {
    p50Ms: Number(percentile(timings, 0.5).toFixed(2)),
    p95Ms: Number(percentile(timings, 0.95).toFixed(2)),
    value
  };
}

const directory = await mkdtemp(path.join(os.tmpdir(), 'reader-library-benchmark-'));
try {
  const database = await new ReaderDatabase(path.join(directory, 'reader.sqlite3')).initialize();
  const seedStarted = performance.now();
  for (let start = 0; start < ARTICLE_COUNT; start += BATCH_SIZE) {
    const statements = ['BEGIN IMMEDIATE;'];
    for (let index = start; index < Math.min(start + BATCH_SIZE, ARTICLE_COUNT); index += 1) {
      const timestamp = articleTimestamp(index);
      const marked = index % 1_000 === 0;
      statements.push(`INSERT INTO articles(id,title,source,author,type,language,created_at,updated_at,excerpt,content,is_favorite,is_read,collection_id) VALUES (${[
        `library-benchmark-${String(index).padStart(6, '0')}`,
        marked ? `Library benchmark needle ${index} 性能标记` : `Library benchmark article ${index}`,
        `Synthetic source ${index % 25}`,
        `Author ${index % 100}`,
        index % 20 === 0 ? 'markdown' : 'article',
        marked ? 'zh' : 'en',
        timestamp,
        timestamp,
        marked ? 'Reader 本地资料库十万条性能标记' : 'Synthetic content for repeatable local-library measurement.',
        marked ? 'Reader benchmark needle 性能标记，可验证全文检索。' : 'Offline content remains available in the local SQLite library.',
        index % 20 === 0,
        index % 3 !== 0,
        index % 5 === 0 ? 'development' : 'inbox'
      ].map(sqlValue).join(',')});`);
    }
    statements.push('COMMIT;');
    await database.execute(statements.join('\n'));
  }
  const seedMs = performance.now() - seedStarted;

  const stats = await measure(() => database.stats());
  const firstPage = await measure(() => database.listArticlePage({ limit: 100 }));
  const secondPage = await measure(() => database.listArticlePage({ limit: 100, cursor: firstPage.value.nextCursor, includeTotal: false }));
  const middleCursor = encodeArticleCursor({
    created_at: articleTimestamp(Math.floor(ARTICLE_COUNT / 2)),
    id: `library-benchmark-${String(Math.floor(ARTICLE_COUNT / 2)).padStart(6, '0')}`
  });
  const middlePage = await measure(() => database.listArticlePage({ limit: 100, cursor: middleCursor, includeTotal: false }));
  const unreadPage = await measure(() => database.listArticlePage({ view: 'unread', limit: 100 }));
  const englishSearch = await measure(() => database.listArticlePage({ query: 'benchmark needle', limit: 100 }));
  const chineseSearch = await measure(() => database.listArticlePage({ query: '性能标记', limit: 100 }));

  const report = {
    requestedArticles: ARTICLE_COUNT,
    totalArticles: Number(stats.value.total),
    seedMs: Number(seedMs.toFixed(1)),
    runs: QUERY_RUNS,
    gateMs: MAX_INTERACTION_P95_MS,
    stats: { p50Ms: stats.p50Ms, p95Ms: stats.p95Ms },
    firstPage: { count: firstPage.value.articles.length, total: firstPage.value.total, p50Ms: firstPage.p50Ms, p95Ms: firstPage.p95Ms },
    secondPage: { count: secondPage.value.articles.length, p50Ms: secondPage.p50Ms, p95Ms: secondPage.p95Ms },
    middlePage: { count: middlePage.value.articles.length, p50Ms: middlePage.p50Ms, p95Ms: middlePage.p95Ms },
    unreadPage: { count: unreadPage.value.articles.length, p50Ms: unreadPage.p50Ms, p95Ms: unreadPage.p95Ms },
    englishSearch: { count: englishSearch.value.articles.length, p50Ms: englishSearch.p50Ms, p95Ms: englishSearch.p95Ms },
    chineseSearch: { count: chineseSearch.value.articles.length, p50Ms: chineseSearch.p50Ms, p95Ms: chineseSearch.p95Ms }
  };
  console.log(JSON.stringify(report, null, 2));

  const firstIds = new Set(firstPage.value.articles.map((article) => article.id));
  const interactionP95s = [stats, firstPage, secondPage, middlePage, unreadPage, englishSearch, chineseSearch].map((result) => result.p95Ms);
  const valid = report.totalArticles >= ARTICLE_COUNT
    && firstPage.value.total === report.totalArticles
    && [firstPage, secondPage, middlePage, unreadPage, englishSearch, chineseSearch].every((result) => result.value.articles.length === 100)
    && secondPage.value.articles.every((article) => !firstIds.has(article.id))
    && interactionP95s.every((value) => value <= MAX_INTERACTION_P95_MS);
  if (!valid) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}

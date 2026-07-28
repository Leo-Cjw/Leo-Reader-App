import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, schemaSQL } from './schema.mjs';
import { applyPendingMigrations } from './migrations.mjs';
import { chunkArticleMarkdown, ragQueryTerms, scoreRagChunk } from './chunks.mjs';
import {
  cosineSimilarity,
  embeddingBucketProbes,
  embeddingBuckets,
  embeddingVectorFromHex,
  embeddingVectorHex,
  normalizeEmbeddingModel,
  normalizeEmbeddingVector,
  SEMANTIC_SEARCH_HASH_BANDS
} from './semantic-search.mjs';

const SQLITE_BINARY = process.env.READER_SQLITE_BINARY || '/usr/bin/sqlite3';
const HIGHLIGHT_COLORS = new Set(['amber', 'green', 'blue', 'pink']);
const SMART_COLLECTION_TYPES = new Set(['article', 'rss', 'youtube', 'x', 'weibo', 'markdown', 'pdf', 'image', 'video', 'audio', 'douyin', 'attachment']);
const MIGRATION_SNAPSHOT_PATTERN = /^reader-before-schema-v(\d+)-to-v(\d+)-(\d{4}-\d{2}-\d{2}T[0-9-]+Z)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.sqlite3$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite numeric SQL value');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function encodeArticleCursor(article) {
  return Buffer.from(JSON.stringify([article.created_at, article.id])).toString('base64url');
}

export function decodeArticleCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    const [createdAt, id] = parsed.map(String);
    if (!createdAt || createdAt.length > 64 || !id || id.length > 200) throw new Error();
    return { createdAt, id };
  } catch {
    throw new TypeError('分页游标无效');
  }
}

function now() {
  return new Date().toISOString();
}

function timestampSlug(value = new Date()) {
  return value.toISOString().replace(/[:.]/g, '-');
}

function migrationSnapshotDirectory(dbPath) {
  return path.join(path.dirname(path.resolve(dbPath)), 'migration-backups');
}

export async function listMigrationSnapshots(dbPath) {
  const directory = migrationSnapshotDirectory(dbPath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const snapshots = [];
  for (const entry of entries) {
    const match = entry.isFile() && entry.name.match(MIGRATION_SNAPSHOT_PATTERN);
    if (!match) continue;
    const info = await stat(path.join(directory, entry.name));
    const createdAt = info.birthtimeMs > 0 ? info.birthtime : info.mtime;
    snapshots.push({
      id: match[4].toLowerCase(),
      file_name: entry.name,
      byte_size: info.size,
      created_at: createdAt.toISOString(),
      from_schema_version: Number(match[1]),
      to_schema_version: Number(match[2])
    });
  }
  return snapshots.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function resolveMigrationSnapshot(dbPath, id) {
  if (!UUID_PATTERN.test(String(id || ''))) return null;
  const snapshot = (await listMigrationSnapshots(dbPath)).find((item) => item.id === String(id).toLowerCase());
  if (!snapshot) return null;
  return { ...snapshot, path: path.join(migrationSnapshotDirectory(dbPath), snapshot.file_name) };
}

function boundedString(value, max) {
  return String(value || '').trim().slice(0, max);
}

export function normalizeSmartCollectionRule(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const rule = {
    match: source.match === 'any' ? 'any' : 'all',
    query: boundedString(source.query, 200),
    types: [...new Set((Array.isArray(source.types) ? source.types : []).map((value) => boundedString(value, 40)).filter((value) => SMART_COLLECTION_TYPES.has(value)))].slice(0, 10),
    tags: [...new Set((Array.isArray(source.tags) ? source.tags : []).map((value) => boundedString(value, 80)).filter(Boolean))].slice(0, 10),
    tag_match: source.tag_match === 'all' ? 'all' : 'any',
    source: boundedString(source.source, 120),
    collection_id: boundedString(source.collection_id, 200) || null,
    unread: source.unread === true ? true : source.unread === false ? false : null,
    favorite: source.favorite === true ? true : source.favorite === false ? false : null,
    has_highlights: source.has_highlights === true ? true : source.has_highlights === false ? false : null,
    has_attachments: source.has_attachments === true ? true : source.has_attachments === false ? false : null,
    created_within_days: source.created_within_days === null || source.created_within_days === undefined || source.created_within_days === ''
      ? null
      : Math.min(3650, Math.max(1, Math.trunc(Number(source.created_within_days) || 0)))
  };
  const active = rule.query || rule.types.length || rule.tags.length || rule.source || rule.collection_id
    || rule.unread !== null || rule.favorite !== null || rule.has_highlights !== null || rule.has_attachments !== null || rule.created_within_days !== null;
  if (!active) throw new Error('智能资料夹至少需要一条规则');
  return rule;
}

function smartCollectionPredicates(rule) {
  const predicates = [];
  if (rule.query) {
    const pattern = `%${rule.query}%`;
    predicates.push(`(a.title LIKE ${sqlValue(pattern)} OR a.excerpt LIKE ${sqlValue(pattern)} OR a.content LIKE ${sqlValue(pattern)} OR a.author LIKE ${sqlValue(pattern)} OR a.source LIKE ${sqlValue(pattern)})`);
  }
  if (rule.types.length) predicates.push(`a.type IN (${rule.types.map(sqlValue).join(',')})`);
  if (rule.tags.length) {
    if (rule.tag_match === 'all') {
      predicates.push(`(SELECT count(DISTINCT smart_tag.name) FROM article_tags smart_at JOIN tags smart_tag ON smart_tag.id=smart_at.tag_id WHERE smart_at.article_id=a.id AND smart_tag.name IN (${rule.tags.map(sqlValue).join(',')}))=${rule.tags.length}`);
    } else {
      predicates.push(`EXISTS (SELECT 1 FROM article_tags smart_at JOIN tags smart_tag ON smart_tag.id=smart_at.tag_id WHERE smart_at.article_id=a.id AND smart_tag.name IN (${rule.tags.map(sqlValue).join(',')}))`);
    }
  }
  if (rule.source) predicates.push(`a.source LIKE ${sqlValue(`%${rule.source}%`)}`);
  if (rule.collection_id) predicates.push(`a.collection_id IN (WITH RECURSIVE smart_descendants(id) AS (SELECT ${sqlValue(rule.collection_id)} UNION ALL SELECT c.id FROM collections c JOIN smart_descendants d ON c.parent_id=d.id) SELECT id FROM smart_descendants)`);
  if (rule.unread !== null) predicates.push(`a.is_read=${rule.unread ? 0 : 1}`);
  if (rule.favorite !== null) predicates.push(`a.is_favorite=${rule.favorite ? 1 : 0}`);
  if (rule.has_highlights !== null) predicates.push(`${rule.has_highlights ? '' : 'NOT '}EXISTS (SELECT 1 FROM highlights smart_h WHERE smart_h.article_id=a.id)`);
  if (rule.has_attachments !== null) predicates.push(`${rule.has_attachments ? '' : 'NOT '}EXISTS (SELECT 1 FROM attachments smart_f WHERE smart_f.article_id=a.id)`);
  if (rule.created_within_days !== null) predicates.push(`a.created_at >= datetime('now', ${sqlValue(`-${rule.created_within_days} days`)})`);
  return predicates;
}

function smartCollectionWhere(rule) {
  const predicates = smartCollectionPredicates(rule);
  return predicates.length ? `(${predicates.join(rule.match === 'any' ? ' OR ' : ' AND ')})` : '0';
}

function chunkIndexSQL(article, timestamp = now()) {
  const chunks = chunkArticleMarkdown(article);
  return [
    `DELETE FROM article_chunks WHERE article_id=${sqlValue(article.id)};`,
    ...chunks.map((chunk) => `INSERT INTO article_chunks(id,article_id,chunk_index,heading,content,start_offset,end_offset,content_sha256,created_at,updated_at) VALUES (${[
      chunk.id, article.id, chunk.index, chunk.heading, chunk.content, chunk.startOffset, chunk.endOffset, chunk.contentHash, timestamp, timestamp
    ].map(sqlValue).join(',')});`)
  ].join('\n');
}

function normalizedDuplicateText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[`*_>#\[\](){}|]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function canonicalDuplicateURL(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|feature$|fbclid$|gclid$|igshid$|share_)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch { return ''; }
}

function duplicateHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function legacyWeChatTarget(value) {
  try {
    const captureURL = new URL(value);
    if (captureURL.hostname.toLowerCase() !== 'mp.weixin.qq.com' || !captureURL.pathname.includes('wappoc_appmsgcaptcha')) return null;
    const target = captureURL.searchParams.get('target_url');
    if (!target) return null;
    const targetURL = new URL(target);
    targetURL.hash = '';
    if (targetURL.hostname.toLowerCase() !== 'mp.weixin.qq.com') return null;
    if (/^\/s\/[^/]+\/?$/.test(targetURL.pathname)) {
      targetURL.pathname = targetURL.pathname.replace(/\/$/, '');
      targetURL.search = '';
    }
    return targetURL.toString();
  } catch {
    return null;
  }
}

function normalizeRow(row) {
  if (!row) return row;
  const booleanFields = ['is_favorite', 'is_read', 'archived', 'enabled', 'is_system'];
  for (const field of booleanFields) {
    if (field in row) row[field] = Boolean(row[field]);
  }
  if ('metadata_json' in row) {
    try { row.metadata = JSON.parse(row.metadata_json || '{}'); }
    catch { row.metadata = {}; }
    delete row.metadata_json;
  }
  if ('tags_json' in row) {
    try { row.tags = JSON.parse(row.tags_json || '[]'); }
    catch { row.tags = []; }
    delete row.tags_json;
  }
  if ('attachments_json' in row) {
    try { row.attachments = JSON.parse(row.attachments_json || '[]'); }
    catch { row.attachments = []; }
    delete row.attachments_json;
  }
  if ('highlights_json' in row) {
    try { row.highlights = JSON.parse(row.highlights_json || '[]'); }
    catch { row.highlights = []; }
    delete row.highlights_json;
  }
  if ('payload_json' in row) {
    try { row.payload = JSON.parse(row.payload_json || '{}'); }
    catch { row.payload = {}; }
    delete row.payload_json;
  }
  if ('rule_json' in row) {
    try { row.rule = JSON.parse(row.rule_json || '{}'); }
    catch { row.rule = {}; }
    delete row.rule_json;
  }
  return row;
}

export class ReaderDatabase {
  constructor(dbPath) {
    this.path = path.resolve(dbPath);
    this.lastMigrationSnapshot = null;
    this.appliedMigrations = [];
  }

  async initialize() {
    await this.hardenDatabasePermissions();
    const migration = await this.prepareMigration();
    this.lastMigrationSnapshot = migration.snapshot;
    if (migration.fromVersion < SCHEMA_VERSION) await this.execute(schemaSQL);
    this.appliedMigrations = await applyPendingMigrations(this, migration.fromVersion);
    await this.execute("UPDATE import_jobs SET status='pending', phase=CASE WHEN platform='douyin' THEN 'parsing' ELSE phase END, progress=0, updated_at=datetime('now') WHERE status='running';");
    await this.seed();
    await this.backfillArticleRevisions();
    await this.backfillArticleChunks();
    await this.repairLegacyWeChatCaptures();
    await this.hardenDatabasePermissions();
    return this;
  }

  async hardenDatabasePermissions() {
    const directory = path.dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(this.path, 'a', 0o600);
    await handle.close();
    for (const filePath of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      await chmod(filePath, 0o600).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async existingSchemaVersion() {
    const tables = await this.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';");
    if (!tables.length) return null;
    if (!tables.some((table) => table.name === 'schema_migrations')) return 0;
    const row = await this.one('SELECT max(version) AS version FROM schema_migrations;');
    if (row?.version === null || row?.version === undefined) return 0;
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('资料库 schema 版本记录无效；为避免数据损坏，已停止打开');
    return version;
  }

  async prepareMigration() {
    let info;
    try {
      info = await stat(this.path);
    } catch (error) {
      if (error?.code === 'ENOENT') return { fromVersion: 0, snapshot: null };
      throw error;
    }
    if (!info.isFile() || info.size === 0) return { fromVersion: 0, snapshot: null };

    const fromVersion = await this.existingSchemaVersion();
    if (fromVersion === null) return { fromVersion: 0, snapshot: null };
    if (fromVersion > SCHEMA_VERSION) {
      throw new Error(`资料库 schema v${fromVersion} 高于当前 Reader 支持的 v${SCHEMA_VERSION}；为避免数据损坏，已拒绝降级打开`);
    }
    if (fromVersion === SCHEMA_VERSION) return { fromVersion, snapshot: null };

    const backupDirectory = migrationSnapshotDirectory(this.path);
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await chmod(backupDirectory, 0o700);
    const snapshotPath = path.join(
      backupDirectory,
      `reader-before-schema-v${fromVersion}-to-v${SCHEMA_VERSION}-${timestampSlug()}-${randomUUID()}.sqlite3`
    );
    try {
      await this.execute(`VACUUM INTO ${sqlValue(snapshotPath)};`);
      await chmod(snapshotPath, 0o600);
      const snapshot = new ReaderDatabase(snapshotPath);
      const integrity = await snapshot.one('PRAGMA integrity_check;');
      if (integrity?.integrity_check !== 'ok') throw new Error('升级前数据库快照完整性校验失败');
      return {
        fromVersion,
        snapshot: {
          path: snapshotPath,
          fromVersion,
          toVersion: SCHEMA_VERSION,
          createdAt: new Date().toISOString()
        }
      };
    } catch (error) {
      await rm(snapshotPath, { force: true });
      throw error;
    }
  }

  async raw(sql, { json = false } = {}) {
    return await new Promise((resolve, reject) => {
      const args = json ? ['-json', this.path] : [this.path];
      const child = spawn(SQLITE_BINARY, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) return reject(new Error(stderr.trim() || `sqlite3 exited with ${code}`));
        if (!json) return resolve(stdout.trim());
        if (!stdout.trim()) return resolve([]);
        try { resolve(JSON.parse(stdout)); }
        catch (error) { reject(new Error(`Invalid sqlite JSON output: ${error.message}`)); }
      });
      child.stdin.end(`.bail on\n.timeout 5000\nPRAGMA foreign_keys = ON;\nPRAGMA trusted_schema = ON;\n${sql}\n`);
    });
  }

  async execute(sql) {
    await this.raw(sql);
  }

  async query(sql) {
    return (await this.raw(sql, { json: true })).map(normalizeRow);
  }

  async one(sql) {
    const rows = await this.query(sql);
    return rows[0] ?? null;
  }

  async seed() {
    const timestamp = now();
    const collections = [
      ['inbox', '稍后阅读', 0],
      ['development', '开发资料', 1],
      ['design', '设计研究', 2],
      ['papers', '论文', 3],
      ['notes', '个人笔记', 4]
    ];
    await this.execute(`BEGIN IMMEDIATE;\n${collections.map(([id, name, position]) => `INSERT OR IGNORE INTO collections(id,name,position,created_at,updated_at) VALUES (${sqlValue(id)},${sqlValue(name)},${position},${sqlValue(timestamp)},${sqlValue(timestamp)});`).join('\n')}\nCOMMIT;`);
    const count = await this.one('SELECT count(*) AS count FROM articles;');
    if (Number(count?.count || 0) > 0) return;
    const examples = [
      {
        id: 'local-first-reading', title: 'Local-first，让阅读重新成为一件私人的事', source: 'Reader 编辑部', author: '林默', type: 'article', language: 'zh', collection_id: 'inbox', read_time_minutes: 8,
        excerpt: '当收藏、批注和阅读轨迹都留在本地，工具才真正退回到工具的位置。',
        content: '过去几年，我们习惯把“随时随地访问”视为阅读工具的默认前提。代价也悄悄发生了：收藏夹、阅读进度、批注，乃至我们如何理解一篇文章，都逐渐依附于某个账号和服务。\n\nLocal-first 的思路恰好反过来。数据先写入设备上的数据库，界面永远优先响应本地状态；云端同步只是多个设备之间的传递层，而不是应用能够工作的前提。断网时，你仍然可以阅读、整理和写作。\n\n真正值得长期使用的阅读器，应该允许我们带着全部资料离开。它不是知识的房东，而是一张足够可靠的书桌。'
      },
      {
        id: 'swift-sync', title: 'Designing an Offline-First Sync Engine in Swift', source: 'Swift Notes', author: 'Maya Chen', type: 'article', language: 'en', collection_id: 'development', read_time_minutes: 12,
        excerpt: 'A practical model for durable local writes, conflict resolution, and observable sync state.',
        content: 'An offline-first system treats connectivity as an optimization rather than a requirement. Every user action should be durable before a request leaves the device.\n\nThe simplest useful model combines a local store with an operation log. The UI observes the local store, while a background worker uploads pending operations and merges remote changes.\n\nConflict handling becomes predictable when every data type has an explicit rule. Notes may merge by field, while reading progress can safely keep the furthest position.'
      },
      {
        id: 'rss-quiet-web', title: 'RSS 与一个更安静的互联网', source: '独立博客', author: '陈屿', type: 'rss', language: 'zh', collection_id: 'design', read_time_minutes: 6,
        excerpt: '没有推荐算法的订阅流，反而让选择重新变得清晰。',
        content: 'RSS 最珍贵的部分并不是复古，而是它把决定权交还给读者。订阅谁、什么时候读、读到哪里，都不需要平台猜测。\n\n时间顺序并不完美，却足够诚实。一个好的阅读器可以进一步把订阅流变成可整理的资料库。'
      }
    ];
    for (const article of examples) await this.createArticle(article);
  }

  async backfillArticleRevisions() {
    const articles = await this.query('SELECT * FROM articles a WHERE NOT EXISTS (SELECT 1 FROM article_revisions r WHERE r.article_id=a.id);');
    for (const article of articles) {
      await this.execute(`INSERT INTO article_revisions(id,article_id,version,title,excerpt,content,author,source,language,reason,created_at) VALUES (${[
        randomUUID(), article.id, 1, article.title, article.excerpt, article.content, article.author, article.source, article.language, 'baseline', article.created_at || now()
      ].map(sqlValue).join(',')});`);
    }
  }

  async backfillArticleChunks() {
    const articles = await this.query(`SELECT id,title,excerpt,content FROM articles a WHERE NOT EXISTS (SELECT 1 FROM article_chunks c WHERE c.article_id=a.id);`);
    for (const article of articles) await this.execute(`BEGIN IMMEDIATE;\n${chunkIndexSQL(article)}\nCOMMIT;`);
    const counts = await this.one(`SELECT (SELECT count(*) FROM article_chunks) AS chunks,(SELECT count(*) FROM chunk_search_docsize) AS search_rows;`);
    const rebuiltSearch = Number(counts?.chunks || 0) !== Number(counts?.search_rows || 0);
    if (rebuiltSearch) await this.execute(`INSERT INTO chunk_search(chunk_search) VALUES ('rebuild');`);
    return { indexedArticles: articles.length, rebuiltSearch };
  }

  async rebuildDerivedSearchIndexes() {
    const articles = await this.query('SELECT id,title,excerpt,content FROM articles ORDER BY rowid;');
    for (const article of articles) {
      await this.execute(`BEGIN IMMEDIATE;\n${chunkIndexSQL(article)}\nCOMMIT;`);
    }
    await this.execute(`BEGIN IMMEDIATE;
      INSERT INTO article_search(article_search) VALUES ('rebuild');
      INSERT INTO article_search_trigram(article_search_trigram) VALUES ('rebuild');
      INSERT INTO chunk_search(chunk_search) VALUES ('rebuild');
      COMMIT;
      PRAGMA optimize;`);
    return await this.getChunkIndexStatus();
  }

  async getChunkIndexStatus() {
    const row = await this.one(`SELECT
      (SELECT count(*) FROM article_chunks c JOIN articles a ON a.id=c.article_id WHERE a.archived=0) AS chunk_count,
      (SELECT count(DISTINCT c.article_id) FROM article_chunks c JOIN articles a ON a.id=c.article_id WHERE a.archived=0) AS indexed_articles,
      (SELECT count(*) FROM articles WHERE archived=0) AS article_count,
      (SELECT count(*) FROM articles) AS total_articles,
      (SELECT count(*) FROM article_chunks) AS total_chunks,
      (SELECT count(*) FROM article_search_docsize) AS article_search_rows,
      (SELECT count(*) FROM article_search_trigram_docsize) AS article_search_trigram_rows,
      (SELECT count(*) FROM chunk_search_docsize) AS chunk_search_rows,
      (SELECT count(*) FROM chunk_embeddings) AS embedding_rows,
      (SELECT count(*) FROM chunk_embedding_buckets) AS embedding_bucket_rows,
      (SELECT count(*) FROM articles a WHERE a.archived=0 AND length(trim(a.content))>0 AND NOT EXISTS (SELECT 1 FROM article_chunks c WHERE c.article_id=a.id)) AS pending_articles;`);
    const totalArticles = Number(row?.total_articles || 0);
    const totalChunks = Number(row?.total_chunks || 0);
    const articleSearchRows = Number(row?.article_search_rows || 0);
    const articleSearchTrigramRows = Number(row?.article_search_trigram_rows || 0);
    const chunkSearchRows = Number(row?.chunk_search_rows || 0);
    const embeddingRows = Number(row?.embedding_rows || 0);
    const embeddingBucketRows = Number(row?.embedding_bucket_rows || 0);
    const embeddingConsistent = embeddingBucketRows === embeddingRows * SEMANTIC_SEARCH_HASH_BANDS;
    return {
      version: 1,
      mode: 'local-lexical',
      chunkCount: Number(row?.chunk_count || 0),
      indexedArticles: Number(row?.indexed_articles || 0),
      articleCount: Number(row?.article_count || 0),
      pendingArticles: Number(row?.pending_articles || 0),
      articleSearchRows,
      articleSearchTrigramRows,
      chunkSearchRows,
      embeddingRows,
      embeddingBucketRows,
      embeddingConsistent,
      consistent: totalArticles === articleSearchRows && totalArticles === articleSearchTrigramRows
        && totalChunks === chunkSearchRows && embeddingConsistent
    };
  }

  async getEmbeddingIndexStatus(model = '') {
    const normalizedModel = normalizeEmbeddingModel(model, { required: false });
    const modelFilter = normalizedModel ? ` AND e.model=${sqlValue(normalizedModel)}` : '';
    const row = await this.one(`SELECT
      (SELECT count(*) FROM article_chunks c JOIN articles a ON a.id=c.article_id WHERE a.archived=0) AS total_chunks,
      (SELECT count(*) FROM chunk_embeddings e JOIN article_chunks c ON c.id=e.chunk_id JOIN articles a ON a.id=c.article_id WHERE a.archived=0${modelFilter}) AS embedded_chunks,
      (SELECT min(e.dimensions) FROM chunk_embeddings e WHERE e.model=${sqlValue(normalizedModel)}) AS min_dimensions,
      (SELECT max(e.dimensions) FROM chunk_embeddings e WHERE e.model=${sqlValue(normalizedModel)}) AS max_dimensions;`);
    const totalChunks = Number(row?.total_chunks || 0);
    const embeddedChunks = Number(row?.embedded_chunks || 0);
    const minDimensions = Number(row?.min_dimensions || 0);
    const maxDimensions = Number(row?.max_dimensions || 0);
    return {
      totalChunks,
      embeddedChunks,
      pendingChunks: Math.max(0, totalChunks - embeddedChunks),
      dimensions: minDimensions > 0 && minDimensions === maxDimensions ? minDimensions : null
    };
  }

  async listPendingEmbeddingChunks(model, limit = 16) {
    const normalizedModel = normalizeEmbeddingModel(model);
    const safeLimit = Math.min(Math.max(Number(limit) || 16, 1), 16);
    return await this.query(`SELECT c.id,c.heading,c.content,c.content_sha256
      FROM article_chunks c
      JOIN articles a ON a.id=c.article_id
      LEFT JOIN chunk_embeddings e ON e.chunk_id=c.id AND e.model=${sqlValue(normalizedModel)}
      WHERE a.archived=0 AND e.chunk_id IS NULL
      ORDER BY c.rowid
      LIMIT ${safeLimit};`);
  }

  async saveChunkEmbeddings(model, entries) {
    const normalizedModel = normalizeEmbeddingModel(model);
    if (!Array.isArray(entries) || !entries.length || entries.length > 16) throw new TypeError('向量批次必须包含 1–16 个片段');
    const timestamp = now();
    const statements = [];
    for (const entry of entries) {
      const chunkId = String(entry?.chunkId || '');
      const contentHash = String(entry?.contentHash || '');
      if (!chunkId || chunkId.length > 300 || !/^[0-9a-f]{64}$/i.test(contentHash)) throw new TypeError('向量片段标识无效');
      const vector = normalizeEmbeddingVector(entry.vector);
      const vectorHex = embeddingVectorHex(vector);
      const buckets = embeddingBuckets(vector);
      statements.push(`DELETE FROM chunk_embedding_buckets WHERE chunk_id=${sqlValue(chunkId)};`);
      statements.push(`INSERT INTO chunk_embeddings(chunk_id,model,dimensions,vector,created_at)
        SELECT c.id,${sqlValue(normalizedModel)},${vector.length},X'${vectorHex}',${sqlValue(timestamp)}
        FROM article_chunks c
        WHERE c.id=${sqlValue(chunkId)} AND c.content_sha256=${sqlValue(contentHash)}
        ON CONFLICT(chunk_id) DO UPDATE SET
          model=excluded.model,dimensions=excluded.dimensions,vector=excluded.vector,created_at=excluded.created_at;`);
      for (const bucket of buckets) {
        statements.push(`INSERT INTO chunk_embedding_buckets(chunk_id,model,band,bucket)
          SELECT chunk_id,model,${bucket.band},${bucket.bucket}
          FROM chunk_embeddings WHERE chunk_id=${sqlValue(chunkId)} AND model=${sqlValue(normalizedModel)};`);
      }
    }
    await this.execute(`BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`);
    return await this.getEmbeddingIndexStatus(normalizedModel);
  }

  async clearChunkEmbeddings() {
    await this.execute('DELETE FROM chunk_embeddings;');
    return { cleared: true };
  }

  async searchChunkEmbeddings(model, queryVector, { articleId = null, limit = 36 } = {}) {
    const normalizedModel = normalizeEmbeddingModel(model);
    const vector = normalizeEmbeddingVector(queryVector);
    const probes = embeddingBucketProbes(vector);
    const exactProbes = probes.filter((probe) => probe.exact);
    const safeLimit = Math.min(Math.max(Number(limit) || 36, 1), 48);
    const bucketWhere = probes.map(({ band, bucket }) => `(b.band=${band} AND b.bucket=${bucket})`).join(' OR ');
    const exactBucketWhere = exactProbes.map(({ band, bucket }) => `(b.band=${band} AND b.bucket=${bucket})`).join(' OR ');
    const articleFilter = articleId ? ` AND a.id=${sqlValue(articleId)}` : '';
    const candidates = await this.query(`WITH candidate_chunks AS (
        SELECT b.chunk_id,
          sum(CASE WHEN ${exactBucketWhere} THEN 1 ELSE 0 END) AS exact_band_matches,
          count(*) AS probe_matches
        FROM chunk_embedding_buckets b
        JOIN article_chunks c ON c.id=b.chunk_id
        JOIN articles a ON a.id=c.article_id
        WHERE b.model=${sqlValue(normalizedModel)} AND a.archived=0${articleFilter} AND (${bucketWhere})
        GROUP BY b.chunk_id
        ORDER BY exact_band_matches DESC,probe_matches DESC,b.chunk_id
        LIMIT 1500
      )
      SELECT c.id,c.article_id,c.chunk_index,c.heading,c.content,c.start_offset,c.end_offset,c.content_sha256,
        a.title AS article_title,a.excerpt AS article_excerpt,a.source AS article_source,a.url AS article_url,a.language AS article_language,
        e.dimensions,hex(e.vector) AS vector_hex,k.exact_band_matches,k.probe_matches
      FROM candidate_chunks k
      JOIN chunk_embeddings e ON e.chunk_id=k.chunk_id AND e.model=${sqlValue(normalizedModel)}
      JOIN article_chunks c ON c.id=e.chunk_id
      JOIN articles a ON a.id=c.article_id
      ORDER BY k.exact_band_matches DESC,k.probe_matches DESC,c.chunk_index;`);
    const ranked = candidates
      .map((chunk) => ({
        ...chunk,
        semanticScore: cosineSimilarity(vector, embeddingVectorFromHex(chunk.vector_hex, chunk.dimensions))
      }))
      .filter((chunk) => chunk.semanticScore >= 0.1)
      .sort((left, right) => right.semanticScore - left.semanticScore
        || Number(right.exact_band_matches) - Number(left.exact_band_matches)
        || Number(right.probe_matches) - Number(left.probe_matches)
        || Number(left.chunk_index) - Number(right.chunk_index));
    const seen = new Set();
    const results = [];
    for (const chunk of ranked) {
      if (seen.has(chunk.content_sha256)) continue;
      seen.add(chunk.content_sha256);
      results.push({
        id: chunk.id,
        articleId: chunk.article_id,
        articleTitle: chunk.article_title,
        articleSource: chunk.article_source || '',
        articleUrl: chunk.article_url || null,
        articleLanguage: chunk.article_language || 'zh',
        heading: chunk.heading || '',
        quote: chunk.content,
        chunkIndex: Number(chunk.chunk_index),
        startOffset: Number(chunk.start_offset),
        endOffset: Number(chunk.end_offset),
        score: Number(chunk.semanticScore.toFixed(6)),
        semanticScore: Number(chunk.semanticScore.toFixed(6))
      });
      if (results.length >= safeLimit) break;
    }
    return results;
  }

  async searchArticleChunks(query, { articleId = null, limit = 6 } = {}) {
    const prompt = String(query || '').trim().slice(0, 4_000);
    const terms = ragQueryTerms(prompt);
    if (!prompt || !terms.length) return [];
    const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 12);
    const hasCJK = terms.some((term) => /\p{Script=Han}/u.test(term));
    const articleFilter = articleId ? ` AND a.id=${sqlValue(articleId)}` : '';
    let candidates;
    if (!hasCJK) {
      const match = terms.map((term) => `"${term.replaceAll('"', '')}"`).join(' OR ');
      candidates = await this.query(`SELECT c.id,c.article_id,c.chunk_index,c.heading,c.content,c.start_offset,c.end_offset,c.content_sha256,
          a.title AS article_title,a.excerpt AS article_excerpt,a.source AS article_source,a.url AS article_url,a.language AS article_language
        FROM article_chunks c JOIN chunk_search ON chunk_search.rowid=c.rowid JOIN articles a ON a.id=c.article_id
        WHERE a.archived=0${articleFilter} AND chunk_search MATCH ${sqlValue(match)} LIMIT 240;`);
    } else {
      const conditions = terms.map((term) => {
        const pattern = `%${term}%`;
        return `(c.content LIKE ${sqlValue(pattern)} OR c.heading LIKE ${sqlValue(pattern)} OR a.title LIKE ${sqlValue(pattern)} OR a.excerpt LIKE ${sqlValue(pattern)} OR a.source LIKE ${sqlValue(pattern)})`;
      });
      candidates = await this.query(`SELECT c.id,c.article_id,c.chunk_index,c.heading,c.content,c.start_offset,c.end_offset,c.content_sha256,
          a.title AS article_title,a.excerpt AS article_excerpt,a.source AS article_source,a.url AS article_url,a.language AS article_language
        FROM article_chunks c JOIN articles a ON a.id=c.article_id
        WHERE a.archived=0${articleFilter} AND (${conditions.join(' OR ')}) LIMIT 240;`);
    }
    const ranked = candidates
      .map((chunk) => {
        const haystack = `${chunk.heading || ''}\n${chunk.content || ''}\n${chunk.article_title || ''}\n${chunk.article_excerpt || ''}\n${chunk.article_source || ''}`.normalize('NFKC').toLocaleLowerCase();
        return { ...chunk, relevance: scoreRagChunk(chunk, prompt, terms), coverage: terms.filter((term) => haystack.includes(term)).length };
      })
      .sort((left, right) => right.relevance - left.relevance || Number(left.chunk_index) - Number(right.chunk_index));
    const bestScore = Number(ranked[0]?.relevance || 0);
    const minimumCoverage = terms.length >= 4 ? 2 : 1;
    const minimumScore = Math.max(2.5, bestScore * 0.45);
    const seen = new Set();
    const results = [];
    for (const chunk of ranked) {
      if (chunk.coverage < minimumCoverage || chunk.relevance < minimumScore) continue;
      if (seen.has(chunk.content_sha256)) continue;
      seen.add(chunk.content_sha256);
      results.push({
        id: chunk.id,
        articleId: chunk.article_id,
        articleTitle: chunk.article_title,
        articleSource: chunk.article_source || '',
        articleUrl: chunk.article_url || null,
        articleLanguage: chunk.article_language || 'zh',
        heading: chunk.heading || '',
        quote: chunk.content,
        chunkIndex: Number(chunk.chunk_index),
        startOffset: Number(chunk.start_offset),
        endOffset: Number(chunk.end_offset),
        score: chunk.relevance
      });
      if (results.length >= safeLimit) break;
    }
    return results;
  }

  async repairLegacyWeChatCaptures() {
    const captures = await this.query(`SELECT id,url,title,content,created_at,metadata_json FROM articles WHERE url LIKE '%mp.weixin.qq.com/mp/wappoc_appmsgcaptcha%';`);
    const groups = new Map();
    for (const article of captures) {
      const targetURL = legacyWeChatTarget(article.url);
      if (!targetURL) continue;
      const group = groups.get(targetURL) || [];
      group.push(article);
      groups.set(targetURL, group);
    }
    let normalized = 0;
    let archived = 0;
    for (const [targetURL, articles] of groups) {
      const existing = await this.getArticleByURL(targetURL);
      const sorted = [...articles].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const keeper = existing || sorted[0];
      for (const article of sorted) {
        const metadata = {
          ...(article.metadata || {}),
          legacyWeChatCaptureURL: article.url,
          legacyWeChatTargetURL: targetURL,
          importState: 'needs-reimport',
          importError: '微信验证页已被识别，重新导入原链接即可修复'
        };
        if (!existing && article.id === keeper.id) {
          await this.execute(`UPDATE articles SET url=${sqlValue(targetURL)}, metadata_json=${sqlValue(JSON.stringify(metadata))}, updated_at=${sqlValue(now())} WHERE id=${sqlValue(article.id)};`);
          normalized += 1;
        } else {
          await this.execute(`UPDATE articles SET archived=1, metadata_json=${sqlValue(JSON.stringify({ ...metadata, importState: 'legacy-duplicate-archived' }))}, updated_at=${sqlValue(now())} WHERE id=${sqlValue(article.id)};`);
          archived += 1;
        }
      }
    }
    return { normalized, archived };
  }

  async listCollections() {
    return await this.query(`
      WITH RECURSIVE collection_tree(root_id,id) AS (
        SELECT id,id FROM collections
        UNION ALL
        SELECT collection_tree.root_id,c.id FROM collections c JOIN collection_tree ON c.parent_id=collection_tree.id
      )
      SELECT c.*,
        CASE WHEN c.id IN ('inbox','notes') THEN 1 ELSE 0 END AS is_system,
        (SELECT count(*) FROM articles a JOIN collection_tree t ON t.id=a.collection_id WHERE t.root_id=c.id AND a.archived=0) AS article_count,
        (SELECT count(*) FROM collections child WHERE child.parent_id=c.id) AS child_count
      FROM collections c ORDER BY c.position, c.name COLLATE NOCASE;
    `);
  }

  async listSmartCollections() {
    const collections = await this.query('SELECT * FROM smart_collections ORDER BY position, name COLLATE NOCASE;');
    const result = [];
    for (const collection of collections) {
      const rule = normalizeSmartCollectionRule(collection.rule);
      const count = await this.one(`SELECT count(*) AS article_count FROM articles a WHERE a.archived=0 AND ${smartCollectionWhere(rule)};`);
      result.push({ ...collection, rule, article_count: Number(count?.article_count || 0) });
    }
    return result;
  }

  async getSmartCollection(id) {
    const collection = await this.one(`SELECT * FROM smart_collections WHERE id=${sqlValue(id)};`);
    return collection ? { ...collection, rule: normalizeSmartCollectionRule(collection.rule) } : null;
  }

  async createSmartCollection({ name, rule }) {
    const cleanName = boundedString(name, 120);
    if (!cleanName) throw new Error('智能资料夹名称不能为空');
    const duplicate = await this.one(`SELECT id FROM smart_collections WHERE name=${sqlValue(cleanName)} COLLATE NOCASE;`);
    if (duplicate) throw new Error('智能资料夹名称已存在');
    const normalizedRule = normalizeSmartCollectionRule(rule);
    if (normalizedRule.collection_id && !(await this.one(`SELECT id FROM collections WHERE id=${sqlValue(normalizedRule.collection_id)};`))) throw new Error('规则中的资料夹不存在');
    const id = randomUUID();
    const timestamp = now();
    const position = await this.one('SELECT coalesce(max(position), -1) + 1 AS position FROM smart_collections;');
    await this.execute(`INSERT INTO smart_collections(id,name,position,rule_json,created_at,updated_at) VALUES (${[
      id, cleanName, Number(position?.position || 0), JSON.stringify(normalizedRule), timestamp, timestamp
    ].map(sqlValue).join(',')});`);
    return (await this.listSmartCollections()).find((collection) => collection.id === id) || null;
  }

  async updateSmartCollection(id, patch) {
    const collection = await this.getSmartCollection(id);
    if (!collection) return null;
    const assignments = [];
    if ('name' in patch) {
      const cleanName = boundedString(patch.name, 120);
      if (!cleanName) throw new Error('智能资料夹名称不能为空');
      const duplicate = await this.one(`SELECT id FROM smart_collections WHERE id!=${sqlValue(id)} AND name=${sqlValue(cleanName)} COLLATE NOCASE;`);
      if (duplicate) throw new Error('智能资料夹名称已存在');
      assignments.push(`name=${sqlValue(cleanName)}`);
    }
    if ('rule' in patch) {
      const normalizedRule = normalizeSmartCollectionRule(patch.rule);
      if (normalizedRule.collection_id && !(await this.one(`SELECT id FROM collections WHERE id=${sqlValue(normalizedRule.collection_id)};`))) throw new Error('规则中的资料夹不存在');
      assignments.push(`rule_json=${sqlValue(JSON.stringify(normalizedRule))}`);
    }
    if ('position' in patch) assignments.push(`position=${sqlValue(Math.max(0, Math.trunc(Number(patch.position) || 0)))}`);
    if (!assignments.length) return (await this.listSmartCollections()).find((item) => item.id === id) || null;
    assignments.push(`updated_at=${sqlValue(now())}`);
    await this.execute(`UPDATE smart_collections SET ${assignments.join(',')} WHERE id=${sqlValue(id)};`);
    return (await this.listSmartCollections()).find((item) => item.id === id) || null;
  }

  async deleteSmartCollection(id) {
    const collection = await this.getSmartCollection(id);
    if (!collection) return null;
    await this.execute(`DELETE FROM smart_collections WHERE id=${sqlValue(id)};`);
    return collection;
  }

  async reorderSmartCollections(orderedIds) {
    const ids = [...new Set((Array.isArray(orderedIds) ? orderedIds : []).map(String))];
    const current = await this.query('SELECT id FROM smart_collections ORDER BY position, name COLLATE NOCASE;');
    if (ids.length !== current.length || current.some((item) => !ids.includes(item.id))) throw new Error('智能资料夹排序列表不完整');
    const timestamp = now();
    await this.execute(`BEGIN IMMEDIATE;\n${ids.map((id, position) => `UPDATE smart_collections SET position=${position},updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)};`).join('\n')}\nCOMMIT;`);
    return await this.listSmartCollections();
  }

  async stats() {
    return await this.one(`
      SELECT
        (SELECT count(*) FROM articles WHERE archived=0) AS total,
        (SELECT count(*) FROM articles WHERE archived=0 AND is_read=0) AS unread,
        (SELECT count(*) FROM articles WHERE archived=0 AND is_favorite=1) AS favorites,
        (SELECT count(*) FROM articles WHERE archived=0 AND type='markdown') AS notes,
        (SELECT count(*) FROM articles WHERE archived=1) AS archived;
    `);
  }

  async createCollection({ name, parentId = null }) {
    if (parentId && !(await this.one(`SELECT id FROM collections WHERE id=${sqlValue(parentId)};`))) throw new Error('父资料夹不存在');
    const duplicate = await this.one(`SELECT id FROM collections WHERE name=${sqlValue(name)} COLLATE NOCASE AND ${parentId ? `parent_id=${sqlValue(parentId)}` : 'parent_id IS NULL'};`);
    if (duplicate) throw new Error('同级资料夹名称已存在');
    const id = randomUUID();
    const timestamp = now();
    const position = await this.one(`SELECT coalesce(max(position), -1) + 1 AS position FROM collections WHERE ${parentId ? `parent_id=${sqlValue(parentId)}` : 'parent_id IS NULL'};`);
    await this.execute(`INSERT INTO collections(id,name,parent_id,position,created_at,updated_at) VALUES (${sqlValue(id)},${sqlValue(name)},${sqlValue(parentId)},${Number(position?.position || 0)},${sqlValue(timestamp)},${sqlValue(timestamp)});`);
    return (await this.listCollections()).find((collection) => collection.id === id) || null;
  }

  async updateCollection(id, patch) {
    const collection = await this.one(`SELECT * FROM collections WHERE id=${sqlValue(id)};`);
    if (!collection) return null;
    const assignments = [];
    const parentId = 'parent_id' in patch ? patch.parent_id || null : collection.parent_id;
    const name = 'name' in patch ? String(patch.name || '').trim() : collection.name;
    if (!name) throw new Error('资料夹名称不能为空');
    if (parentId === id) throw new Error('资料夹不能移动到自身');
    if (parentId) {
      const parent = await this.one(`SELECT id FROM collections WHERE id=${sqlValue(parentId)};`);
      if (!parent) throw new Error('父资料夹不存在');
      const descendant = await this.one(`WITH RECURSIVE descendants(id) AS (SELECT id FROM collections WHERE parent_id=${sqlValue(id)} UNION ALL SELECT c.id FROM collections c JOIN descendants d ON c.parent_id=d.id) SELECT id FROM descendants WHERE id=${sqlValue(parentId)};`);
      if (descendant) throw new Error('资料夹不能移动到自己的子资料夹');
    }
    const duplicate = await this.one(`SELECT id FROM collections WHERE id!=${sqlValue(id)} AND name=${sqlValue(name)} COLLATE NOCASE AND ${parentId ? `parent_id=${sqlValue(parentId)}` : 'parent_id IS NULL'};`);
    if (duplicate) throw new Error('同级资料夹名称已存在');
    if ('name' in patch) assignments.push(`name=${sqlValue(name)}`);
    if ('parent_id' in patch) assignments.push(`parent_id=${sqlValue(parentId)}`);
    if ('position' in patch) assignments.push(`position=${sqlValue(Math.max(0, Number(patch.position) || 0))}`);
    if (!assignments.length) return (await this.listCollections()).find((item) => item.id === id) || null;
    assignments.push(`updated_at=${sqlValue(now())}`);
    await this.execute(`UPDATE collections SET ${assignments.join(',')} WHERE id=${sqlValue(id)};`);
    return (await this.listCollections()).find((item) => item.id === id) || null;
  }

  async reorderCollections(parentId, orderedIds) {
    const ids = [...new Set((Array.isArray(orderedIds) ? orderedIds : []).map(String))];
    const parentWhere = parentId ? `parent_id=${sqlValue(parentId)}` : 'parent_id IS NULL';
    const current = await this.query(`SELECT id FROM collections WHERE ${parentWhere} ORDER BY position, name COLLATE NOCASE;`);
    if (ids.length !== current.length || current.some((item) => !ids.includes(item.id))) throw new Error('资料夹排序列表不完整');
    const timestamp = now();
    await this.execute(`BEGIN IMMEDIATE;\n${ids.map((id, position) => `UPDATE collections SET position=${position},updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)} AND ${parentWhere};`).join('\n')}\nCOMMIT;`);
    return await this.listCollections();
  }

  async deleteCollection(id, { moveTo = 'inbox' } = {}) {
    if (['inbox', 'notes'].includes(id)) throw new Error('系统资料夹不能删除');
    const collection = await this.one(`SELECT * FROM collections WHERE id=${sqlValue(id)};`);
    if (!collection) return null;
    const target = await this.one(`SELECT id FROM collections WHERE id=${sqlValue(moveTo)};`);
    if (!target) throw new Error('接收内容的资料夹不存在');
    const invalidTarget = await this.one(`WITH RECURSIVE subtree(id) AS (SELECT ${sqlValue(id)} UNION ALL SELECT c.id FROM collections c JOIN subtree s ON c.parent_id=s.id) SELECT id FROM subtree WHERE id=${sqlValue(moveTo)};`);
    if (invalidTarget) throw new Error('不能把内容移动到将被删除的资料夹');
    await this.execute(`BEGIN IMMEDIATE;
      WITH RECURSIVE subtree(id) AS (SELECT ${sqlValue(id)} UNION ALL SELECT c.id FROM collections c JOIN subtree s ON c.parent_id=s.id)
      UPDATE articles SET collection_id=${sqlValue(moveTo)}, updated_at=${sqlValue(now())} WHERE collection_id IN (SELECT id FROM subtree);
      DELETE FROM collections WHERE id=${sqlValue(id)};
      COMMIT;`);
    return collection;
  }

  async listTags() {
    return await this.query(`SELECT t.id,t.name,t.created_at,count(a.id) AS article_count FROM tags t LEFT JOIN article_tags at ON at.tag_id=t.id LEFT JOIN articles a ON a.id=at.article_id AND a.archived=0 GROUP BY t.id ORDER BY article_count DESC,t.name COLLATE NOCASE;`);
  }

  async articleListParts({ view = 'inbox', query = '', collectionId = null, smartCollectionId = null, types = [], tag = '', mediaOnly = false } = {}) {
    const where = [view === 'archive' ? 'a.archived=1' : 'a.archived=0'];
    if (view === 'unread') where.push('a.is_read=0');
    if (view === 'favorites') where.push('a.is_favorite=1');
    if (view === 'notes') where.push("a.type='markdown'");
    if (collectionId) where.push(`a.collection_id IN (WITH RECURSIVE descendants(id) AS (SELECT ${sqlValue(collectionId)} UNION ALL SELECT c.id FROM collections c JOIN descendants d ON c.parent_id=d.id) SELECT id FROM descendants)`);
    if (smartCollectionId) {
      const smartCollection = await this.getSmartCollection(smartCollectionId);
      if (!smartCollection) throw new Error('智能资料夹不存在');
      where.push(smartCollectionWhere(smartCollection.rule));
    }
    const normalizedTypes = [...new Set((Array.isArray(types) ? types : String(types || '').split(',')).map((type) => String(type).trim()).filter(Boolean))].slice(0, 20);
    if (normalizedTypes.length) where.push(`a.type IN (${normalizedTypes.map(sqlValue).join(',')})`);
    if (tag) where.push(`EXISTS (SELECT 1 FROM article_tags filter_at JOIN tags filter_t ON filter_t.id=filter_at.tag_id WHERE filter_at.article_id=a.id AND filter_t.name=${sqlValue(tag)})`);
    if (mediaOnly) where.push(`EXISTS (SELECT 1 FROM attachments media_attachment WHERE media_attachment.article_id=a.id AND (media_attachment.mime_type LIKE 'image/%' OR media_attachment.mime_type LIKE 'video/%' OR media_attachment.mime_type LIKE 'audio/%' OR media_attachment.mime_type='application/pdf'))`);
    const joins = [];
    if (query.trim()) {
      const tokens = query.trim().split(/\s+/).filter(Boolean);
      if (tokens.some((token) => /[\u3400-\u9fff]/.test(token))) {
        const trigramTokens = tokens.filter((token) => Array.from(token).length >= 3);
        if (trigramTokens.length) {
          joins.push('JOIN article_search_trigram trigram_search ON trigram_search.rowid=a.rowid');
          where.push(`article_search_trigram MATCH ${sqlValue(trigramTokens.map((token) => `"${token.replaceAll('"', '')}"`).join(' AND '))}`);
        }
        for (const token of tokens.filter((candidate) => Array.from(candidate).length < 3)) {
          const pattern = `%${token}%`;
          where.push(`(a.title LIKE ${sqlValue(pattern)} OR a.excerpt LIKE ${sqlValue(pattern)} OR a.content LIKE ${sqlValue(pattern)} OR a.author LIKE ${sqlValue(pattern)} OR a.source LIKE ${sqlValue(pattern)})`);
        }
      } else {
        const match = tokens.map((token) => `"${token.replaceAll('"', '')}"`).join(' AND ');
        joins.push('JOIN article_search s ON s.rowid=a.rowid');
        where.push(`article_search MATCH ${sqlValue(match)}`);
      }
    }
    return { where, join: joins.join(' ') };
  }

  async listArticlePage(options = {}) {
    const { limit = 100, cursor = null, includeTotal = true, includeContent = true } = options;
    const { where, join } = await this.articleListParts(options);
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const articleColumns = includeContent
      ? 'a.*'
      : `a.id,a.url,a.title,a.source,a.author,a.type,a.language,a.published_at,a.created_at,a.updated_at,
        a.excerpt,a.summary,a.read_time_minutes,a.is_favorite,a.is_read,a.reading_progress,a.archived,
        a.collection_id,a.metadata_json`;
    const decodedCursor = decodeArticleCursor(cursor);
    const pageWhere = [...where];
    if (decodedCursor) {
      pageWhere.push(`(a.created_at < ${sqlValue(decodedCursor.createdAt)} OR (a.created_at=${sqlValue(decodedCursor.createdAt)} AND a.id < ${sqlValue(decodedCursor.id)}))`);
    }
    const rows = await this.query(`
      SELECT ${articleColumns}, c.name AS collection_name,
        (SELECT count(*) FROM article_revisions r WHERE r.article_id=a.id) AS revision_count,
        coalesce((SELECT json_group_array(t.name) FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id), '[]') AS tags_json,
        coalesce((SELECT json_group_array(json_object('id',f.id,'file_name',f.file_name,'mime_type',f.mime_type,'byte_size',f.byte_size,'sha256',f.sha256,'url','/api/attachments/' || f.id || '/content','thumbnail_url',CASE WHEN f.mime_type='application/pdf' OR f.mime_type LIKE 'image/%' THEN '/api/attachments/' || f.id || '/thumbnail' ELSE NULL END)) FROM attachments f WHERE f.article_id=a.id), '[]') AS attachments_json
      FROM articles a ${join}
      LEFT JOIN collections c ON c.id=a.collection_id
      WHERE ${pageWhere.join(' AND ')}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${safeLimit + 1};
    `);
    const hasMore = rows.length > safeLimit;
    const articles = hasMore ? rows.slice(0, safeLimit) : rows;
    const totalRow = includeTotal
      ? await this.one(`SELECT count(*) AS total FROM articles a ${join} WHERE ${where.join(' AND ')};`)
      : null;
    return {
      articles,
      total: totalRow ? Number(totalRow.total || 0) : null,
      hasMore,
      nextCursor: hasMore && articles.length ? encodeArticleCursor(articles.at(-1)) : null
    };
  }

  async listArticles(options = {}) {
    return (await this.listArticlePage({ ...options, includeTotal: false })).articles;
  }

  async getArticle(id) {
    return await this.one(`
      SELECT a.*, c.name AS collection_name,
        (SELECT count(*) FROM article_revisions r WHERE r.article_id=a.id) AS revision_count,
        coalesce((SELECT json_group_array(t.name) FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id), '[]') AS tags_json,
        coalesce((SELECT json_group_array(json_object('id',f.id,'file_name',f.file_name,'mime_type',f.mime_type,'byte_size',f.byte_size,'sha256',f.sha256,'url','/api/attachments/' || f.id || '/content','thumbnail_url',CASE WHEN f.mime_type='application/pdf' OR f.mime_type LIKE 'image/%' THEN '/api/attachments/' || f.id || '/thumbnail' ELSE NULL END)) FROM attachments f WHERE f.article_id=a.id), '[]') AS attachments_json
      FROM articles a LEFT JOIN collections c ON c.id=a.collection_id WHERE a.id=${sqlValue(id)};
    `);
  }

  async enqueueAllSpotlightArticles() {
    await this.execute(`
      INSERT INTO spotlight_outbox(article_id,operation,revision,changed_at)
      SELECT id,CASE WHEN archived=1 THEN 'delete' ELSE 'upsert' END,1,datetime('now') FROM articles WHERE true
      ON CONFLICT(article_id) DO UPDATE SET
        operation=excluded.operation,revision=spotlight_outbox.revision+1,changed_at=excluded.changed_at;
    `);
    return await this.countSpotlightChanges();
  }

  async listSpotlightChanges(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    const rows = await this.query(`
      SELECT o.article_id,o.operation,o.revision,o.changed_at,
        a.title,a.excerpt,a.content,a.author,a.source,a.type,a.language,a.published_at,a.created_at,a.updated_at,a.archived,
        coalesce((SELECT json_group_array(t.name) FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id), '[]') AS tags_json
      FROM spotlight_outbox o LEFT JOIN articles a ON a.id=o.article_id
      ORDER BY o.changed_at,o.article_id LIMIT ${safeLimit};
    `);
    return rows.map((row) => {
      const missing = row.title === null || row.title === undefined;
      return {
        id: row.article_id,
        revision: Number(row.revision),
        operation: missing || row.archived || row.operation === 'delete' ? 'delete' : 'upsert',
        ...(missing ? {} : {
          title: row.title,
          excerpt: row.excerpt || '',
          content: row.content || '',
          author: row.author || '',
          source: row.source || '',
          type: row.type || 'article',
          language: row.language || '',
          publishedAt: row.published_at || null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          tags: Array.isArray(row.tags) ? row.tags : []
        })
      };
    });
  }

  async acknowledgeSpotlightChanges(entries) {
    const normalized = (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === 'string' && Number.isSafeInteger(Number(entry.revision)))
      .slice(0, 100);
    if (!normalized.length) return 0;
    await this.execute(`BEGIN IMMEDIATE;
      ${normalized.map((entry) => `DELETE FROM spotlight_outbox WHERE article_id=${sqlValue(entry.id)} AND revision=${sqlValue(Number(entry.revision))};`).join('\n')}
      COMMIT;`);
    return normalized.length;
  }

  async clearSpotlightOutbox() {
    await this.execute('DELETE FROM spotlight_outbox;');
  }

  async countSpotlightChanges() {
    return Number((await this.one('SELECT count(*) AS count FROM spotlight_outbox;'))?.count || 0);
  }

  async getArticlesForExport(ids) {
    const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean))].slice(0, 500);
    if (!normalizedIds.length) return [];
    const rows = await this.query(`
      SELECT a.*, c.name AS collection_name,
        coalesce((SELECT json_group_array(t.name) FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id), '[]') AS tags_json,
        coalesce((SELECT json_group_array(json_object('id',f.id,'file_name',f.file_name,'storage_name',f.storage_name,'mime_type',f.mime_type,'byte_size',f.byte_size,'sha256',f.sha256)) FROM attachments f WHERE f.article_id=a.id), '[]') AS attachments_json,
        coalesce((SELECT json_group_array(json_object('id',h.id,'quote',h.quote,'note',h.note,'color',h.color,'start_offset',h.start_offset,'end_offset',h.end_offset,'created_at',h.created_at,'updated_at',h.updated_at)) FROM highlights h WHERE h.article_id=a.id ORDER BY h.start_offset,h.created_at), '[]') AS highlights_json
      FROM articles a LEFT JOIN collections c ON c.id=a.collection_id
      WHERE a.id IN (${normalizedIds.map(sqlValue).join(',')});
    `);
    const order = new Map(normalizedIds.map((id, index) => [id, index]));
    return rows.sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  async findDuplicateGroups(limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const articles = await this.query(`SELECT id,url,title,source,author,type,language,created_at,updated_at,excerpt,content,is_favorite,is_read,reading_progress,collection_id,metadata_json FROM articles WHERE archived=0 ORDER BY created_at DESC LIMIT 5000;`);
    const parent = new Map(articles.map((article) => [article.id, article.id]));
    const find = (id) => { let root = id; while (parent.get(root) !== root) root = parent.get(root); while (parent.get(id) !== id) { const next = parent.get(id); parent.set(id, root); id = next; } return root; };
    const union = (left, right) => { const leftRoot = find(left); const rightRoot = find(right); if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot); };
    const evidenceByKey = new Map();
    const addEvidence = (reason, key, articleId) => {
      if (!key) return;
      const evidenceKey = `${reason}:${key}`;
      let group = evidenceByKey.get(evidenceKey);
      if (!group) { group = { reason, key, ids: [] }; evidenceByKey.set(evidenceKey, group); }
      group.ids.push(articleId);
    };
    for (const article of articles) {
      const canonicalURL = canonicalDuplicateURL(article.url);
      if (canonicalURL) addEvidence('同一原始链接', duplicateHash(canonicalURL), article.id);
      const content = normalizedDuplicateText(article.content);
      if (content.length >= 120) addEvidence('正文完全相同', duplicateHash(content), article.id);
      const title = normalizedDuplicateText(article.title);
      const excerpt = normalizedDuplicateText(article.excerpt);
      if (title.length >= 6 && excerpt.length >= 60) addEvidence('标题与摘要相同', duplicateHash(`${title}\n${excerpt}`), article.id);
    }
    const evidence = [...evidenceByKey.values()];
    for (const group of evidence.filter((item) => item.ids.length > 1)) for (const id of group.ids.slice(1)) union(group.ids[0], id);
    const grouped = new Map();
    for (const article of articles) {
      const root = find(article.id);
      grouped.set(root, [...(grouped.get(root) || []), article]);
    }
    const results = [];
    for (const members of grouped.values()) {
      if (members.length < 2) continue;
      const memberIds = new Set(members.map((member) => member.id));
      const reasons = [...new Set(evidence.filter((item) => item.ids.length > 1 && item.ids.every((id) => memberIds.has(id))).map((item) => item.reason))];
      if (!reasons.length) continue;
      const ids = members.map((member) => member.id).sort();
      results.push({
        id: `duplicate-${duplicateHash(ids.join('|')).slice(0, 16)}`,
        confidence: reasons.some((reason) => reason === '正文完全相同' || reason === '同一原始链接') ? 'exact' : 'high',
        reasons,
        articles: members.map(({ content: _content, metadata: _metadata, ...article }) => ({ ...article, content_length: String(_content || '').length }))
      });
    }
    return results.sort((a, b) => b.articles.length - a.articles.length || String(b.articles[0].created_at).localeCompare(String(a.articles[0].created_at))).slice(0, safeLimit);
  }

  async resolveDuplicates({ keepId, duplicateIds }) {
    const normalizedDuplicates = [...new Set((Array.isArray(duplicateIds) ? duplicateIds : []).map((id) => String(id).trim()).filter(Boolean))].filter((id) => id !== keepId).slice(0, 50);
    if (!keepId || !normalizedDuplicates.length) throw new Error('请选择保留内容和至少一条副本');
    const ids = [String(keepId), ...normalizedDuplicates];
    const rows = await this.query(`SELECT * FROM articles WHERE id IN (${ids.map(sqlValue).join(',')});`);
    if (rows.length !== ids.length) throw new Error('部分内容不存在');
    if (rows.some((article) => article.archived)) throw new Error('归档内容不能参与重复合并');
    const keeper = rows.find((article) => article.id === keepId);
    if (!keeper) throw new Error('保留内容不存在');
    const timestamp = now();
    const isFavorite = rows.some((article) => article.is_favorite);
    const isRead = rows.every((article) => article.is_read);
    const readingProgress = Math.max(...rows.map((article) => Number(article.reading_progress || 0)));
    const summary = rows.map((article) => String(article.summary || '')).sort((a, b) => b.length - a.length)[0] || '';
    const keeperMetadata = { ...(keeper.metadata || {}), duplicateResolution: { mergedIds: normalizedDuplicates, resolvedAt: timestamp, strategy: 'archive-copies-v1' } };
    const statements = [
      `INSERT OR IGNORE INTO article_tags(article_id,tag_id) SELECT ${sqlValue(keepId)},tag_id FROM article_tags WHERE article_id IN (${ids.map(sqlValue).join(',')});`,
      `UPDATE articles SET is_favorite=${sqlValue(isFavorite)},is_read=${sqlValue(isRead)},reading_progress=${sqlValue(readingProgress)},summary=${sqlValue(summary)},metadata_json=${sqlValue(JSON.stringify(keeperMetadata))},updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(keepId)};`
    ];
    for (const duplicateId of normalizedDuplicates) {
      const duplicate = rows.find((article) => article.id === duplicateId);
      const metadata = { ...(duplicate.metadata || {}), mergedInto: keepId, mergedAt: timestamp, mergeStrategy: 'archive-copy-v1' };
      statements.push(`UPDATE articles SET archived=1,metadata_json=${sqlValue(JSON.stringify(metadata))},updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(duplicateId)};`);
    }
    await this.execute(`BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`);
    return { article: await this.getArticle(keepId), archivedIds: normalizedDuplicates };
  }

  async getArticleByURL(url) {
    return await this.one(`
      SELECT a.*, c.name AS collection_name,
        (SELECT count(*) FROM article_revisions r WHERE r.article_id=a.id) AS revision_count,
        coalesce((SELECT json_group_array(t.name) FROM article_tags at JOIN tags t ON t.id=at.tag_id WHERE at.article_id=a.id), '[]') AS tags_json,
        coalesce((SELECT json_group_array(json_object('id',f.id,'file_name',f.file_name,'mime_type',f.mime_type,'byte_size',f.byte_size,'sha256',f.sha256,'url','/api/attachments/' || f.id || '/content','thumbnail_url',CASE WHEN f.mime_type='application/pdf' OR f.mime_type LIKE 'image/%' THEN '/api/attachments/' || f.id || '/thumbnail' ELSE NULL END)) FROM attachments f WHERE f.article_id=a.id), '[]') AS attachments_json
      FROM articles a LEFT JOIN collections c ON c.id=a.collection_id WHERE a.url=${sqlValue(url)};
    `);
  }

  async createArticle(input) {
    const id = input.id || randomUUID();
    const timestamp = now();
    const words = String(input.content || '').trim().split(/\s+|(?<=[。！？])/).filter(Boolean).length;
    const readTime = input.read_time_minutes || Math.max(1, Math.ceil(words / 280));
    const articleValues = [
      id, input.url ?? null, input.title, input.source || '', input.author || '', input.type || 'article', input.language || 'zh', input.published_at ?? null,
      timestamp, timestamp, input.excerpt || '', input.content || '', input.summary || '', readTime, Boolean(input.is_favorite), Boolean(input.is_read), input.reading_progress || 0,
      false, input.collection_id || 'inbox', JSON.stringify(input.metadata || {})
    ];
    await this.execute(`BEGIN IMMEDIATE;
      INSERT INTO articles(id,url,title,source,author,type,language,published_at,created_at,updated_at,excerpt,content,summary,read_time_minutes,is_favorite,is_read,reading_progress,archived,collection_id,metadata_json)
      VALUES (${articleValues.map(sqlValue).join(',')});
      INSERT INTO article_revisions(id,article_id,version,title,excerpt,content,author,source,language,reason,created_at)
      VALUES (${[randomUUID(), id, 1, input.title, input.excerpt || '', input.content || '', input.author || '', input.source || '', input.language || 'zh', 'created', timestamp].map(sqlValue).join(',')});
      ${chunkIndexSQL({ id, title: input.title, excerpt: input.excerpt || '', content: input.content || '' }, timestamp)}
      COMMIT;`);
    return await this.getArticle(id);
  }

  async updateArticle(id, patch, { revisionReason = 'edit' } = {}) {
    const allowed = {
      title: 'title', content: 'content', excerpt: 'excerpt', summary: 'summary', collection_id: 'collection_id',
      author: 'author', source: 'source', language: 'language',
      is_favorite: 'is_favorite', is_read: 'is_read', reading_progress: 'reading_progress', archived: 'archived'
    };
    const entries = Object.entries(patch).filter(([key]) => key in allowed);
    if (!entries.length) return await this.getArticle(id);
    const assignments = entries.map(([key, value]) => `${allowed[key]}=${sqlValue(value)}`);
    assignments.push(`updated_at=${sqlValue(now())}`);
    const versionedFields = new Set(['title', 'content', 'excerpt', 'author', 'source', 'language']);
    const createsRevision = entries.some(([key]) => versionedFields.has(key));
    const reindexesChunks = entries.some(([key]) => ['title', 'content', 'excerpt'].includes(key));
    const current = reindexesChunks ? await this.getArticle(id) : null;
    const timestamp = now();
    const revisionSQL = createsRevision ? `
      INSERT INTO article_revisions(id,article_id,version,title,excerpt,content,author,source,language,reason,created_at)
      SELECT ${sqlValue(randomUUID())}, a.id, coalesce((SELECT max(r.version) + 1 FROM article_revisions r WHERE r.article_id=a.id), 1), a.title, a.excerpt, a.content, a.author, a.source, a.language, ${sqlValue(revisionReason)}, ${sqlValue(timestamp)}
      FROM articles a WHERE a.id=${sqlValue(id)};` : '';
    const chunkSQL = reindexesChunks && current ? chunkIndexSQL({ id, title: patch.title ?? current.title, excerpt: patch.excerpt ?? current.excerpt, content: patch.content ?? current.content }, timestamp) : '';
    await this.execute(`BEGIN IMMEDIATE; UPDATE articles SET ${assignments.join(',')} WHERE id=${sqlValue(id)}; ${revisionSQL} ${chunkSQL} COMMIT;`);
    return await this.getArticle(id);
  }

  async listArticleRevisions(articleId) {
    return await this.query(`SELECT id,article_id,version,title,excerpt,author,source,language,reason,created_at,length(content) AS content_length FROM article_revisions WHERE article_id=${sqlValue(articleId)} ORDER BY version DESC;`);
  }

  async getArticleRevision(articleId, version) {
    return await this.one(`SELECT * FROM article_revisions WHERE article_id=${sqlValue(articleId)} AND version=${sqlValue(Number(version))};`);
  }

  async restoreArticleRevision(articleId, version) {
    const revision = await this.getArticleRevision(articleId, version);
    if (!revision) return null;
    const timestamp = now();
    await this.execute(`BEGIN IMMEDIATE;
      UPDATE articles SET title=${sqlValue(revision.title)}, excerpt=${sqlValue(revision.excerpt)}, content=${sqlValue(revision.content)}, author=${sqlValue(revision.author)}, source=${sqlValue(revision.source)}, language=${sqlValue(revision.language)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(articleId)};
      INSERT INTO article_revisions(id,article_id,version,title,excerpt,content,author,source,language,reason,created_at)
      SELECT ${sqlValue(randomUUID())}, a.id, coalesce((SELECT max(r.version) + 1 FROM article_revisions r WHERE r.article_id=a.id), 1), a.title, a.excerpt, a.content, a.author, a.source, a.language, ${sqlValue(`restore:${version}`)}, ${sqlValue(timestamp)} FROM articles a WHERE a.id=${sqlValue(articleId)};
      ${chunkIndexSQL({ id: articleId, title: revision.title, excerpt: revision.excerpt, content: revision.content }, timestamp)}
      COMMIT;`);
    return await this.getArticle(articleId);
  }

  async updateArticleMetadata(id, patch) {
    const article = await this.getArticle(id);
    if (!article) return null;
    const metadata = { ...(article.metadata || {}), ...patch };
    await this.execute(`UPDATE articles SET metadata_json=${sqlValue(JSON.stringify(metadata))}, updated_at=${sqlValue(now())} WHERE id=${sqlValue(id)};`);
    return await this.getArticle(id);
  }

  async finalizeImportedArticle(id, { content, metadata }) {
    const article = await this.getArticle(id);
    if (!article) return null;
    const timestamp = now();
    const words = String(content || '').trim().split(/\s+|(?<=[。！？])/).filter(Boolean).length;
    const readTime = Math.max(1, Math.ceil(words / 280));
    await this.execute(`BEGIN IMMEDIATE;
      UPDATE articles SET content=${sqlValue(content || '')}, metadata_json=${sqlValue(JSON.stringify(metadata || {}))}, read_time_minutes=${readTime}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)};
      UPDATE article_revisions SET content=${sqlValue(content || '')} WHERE article_id=${sqlValue(id)} AND version=1 AND reason='created';
      ${chunkIndexSQL({ id, title: article.title, excerpt: article.excerpt, content: content || '' }, timestamp)}
      COMMIT;`);
    return await this.getArticle(id);
  }

  async addTags(articleId, names) {
    const timestamp = now();
    const normalized = [...new Set(names.map((name) => String(name).trim()).filter(Boolean))].slice(0, 20);
    if (!normalized.length) return await this.getArticle(articleId);
    const statements = [];
    for (const name of normalized) {
      const id = `tag-${Buffer.from(name).toString('hex').slice(0, 32)}`;
      statements.push(`INSERT OR IGNORE INTO tags(id,name,created_at) VALUES (${sqlValue(id)},${sqlValue(name)},${sqlValue(timestamp)});`);
      statements.push(`INSERT OR IGNORE INTO article_tags(article_id,tag_id) VALUES (${sqlValue(articleId)},${sqlValue(id)});`);
    }
    await this.execute(`BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`);
    return await this.getArticle(articleId);
  }

  async removeTags(articleId, names) {
    const normalized = [...new Set(names.map((name) => String(name).trim()).filter(Boolean))].slice(0, 20);
    if (!normalized.length) return await this.getArticle(articleId);
    await this.execute(`DELETE FROM article_tags WHERE article_id=${sqlValue(articleId)} AND tag_id IN (SELECT id FROM tags WHERE name IN (${normalized.map(sqlValue).join(',')}));`);
    await this.execute('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM article_tags at WHERE at.tag_id=tags.id);');
    return await this.getArticle(articleId);
  }

  async listHighlights(articleId) {
    return await this.query(`SELECT * FROM highlights WHERE article_id=${sqlValue(articleId)} ORDER BY start_offset, created_at;`);
  }

  async getHighlight(id) {
    return await this.one(`SELECT * FROM highlights WHERE id=${sqlValue(id)};`);
  }

  async createHighlight({ articleId, quote, note = '', color = 'amber', startOffset, endOffset }) {
    if (!(await this.one(`SELECT id FROM articles WHERE id=${sqlValue(articleId)};`))) throw new Error('内容不存在');
    if (!String(quote || '').trim() || String(quote).length > 5000) throw new Error('高亮原文无效');
    if (String(note).length > 20_000) throw new Error('批注长度超过限制');
    if (!HIGHLIGHT_COLORS.has(color)) throw new Error('高亮颜色无效');
    if (!Number.isSafeInteger(Number(startOffset)) || !Number.isSafeInteger(Number(endOffset)) || Number(startOffset) < 0 || Number(endOffset) <= Number(startOffset)) throw new Error('高亮位置无效');
    const id = randomUUID();
    const timestamp = now();
    await this.execute(`INSERT INTO highlights(id,article_id,quote,note,color,start_offset,end_offset,created_at,updated_at) VALUES (${[
      id, articleId, quote, note, color, startOffset, endOffset, timestamp, timestamp
    ].map(sqlValue).join(',')});`);
    return await this.getHighlight(id);
  }

  async updateHighlight(id, patch) {
    const highlight = await this.getHighlight(id);
    if (!highlight) return null;
    const assignments = [];
    if ('note' in patch) {
      if (String(patch.note).length > 20_000) throw new Error('批注长度超过限制');
      assignments.push(`note=${sqlValue(patch.note)}`);
    }
    if ('color' in patch) {
      if (!HIGHLIGHT_COLORS.has(patch.color)) throw new Error('高亮颜色无效');
      assignments.push(`color=${sqlValue(patch.color)}`);
    }
    if (!assignments.length) return highlight;
    assignments.push(`updated_at=${sqlValue(now())}`);
    await this.execute(`UPDATE highlights SET ${assignments.join(',')} WHERE id=${sqlValue(id)};`);
    return await this.getHighlight(id);
  }

  async deleteHighlight(id) {
    const highlight = await this.getHighlight(id);
    if (!highlight) return null;
    await this.execute(`DELETE FROM highlights WHERE id=${sqlValue(id)};`);
    return highlight;
  }

  async batchUpdateArticles(ids, { collection_id, is_favorite, is_read, archived, tags_add = [], tags_remove = [] } = {}) {
    const normalizedIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))].slice(0, 500);
    if (!normalizedIds.length) return { updated: 0 };
    if (collection_id !== undefined && collection_id !== null && !(await this.one(`SELECT id FROM collections WHERE id=${sqlValue(collection_id)};`))) throw new Error('目标资料夹不存在');
    const assignments = [];
    if (collection_id !== undefined) assignments.push(`collection_id=${sqlValue(collection_id)}`);
    if (is_favorite !== undefined) assignments.push(`is_favorite=${sqlValue(Boolean(is_favorite))}`);
    if (is_read !== undefined) assignments.push(`is_read=${sqlValue(Boolean(is_read))}`);
    if (archived !== undefined) assignments.push(`archived=${sqlValue(Boolean(archived))}`);
    const idList = normalizedIds.map(sqlValue).join(',');
    const timestamp = now();
    const statements = [];
    if (assignments.length) statements.push(`UPDATE articles SET ${assignments.join(',')},updated_at=${sqlValue(timestamp)} WHERE id IN (${idList});`);
    const additions = [...new Set(tags_add.map((name) => String(name).trim()).filter(Boolean))].slice(0, 20);
    for (const name of additions) {
      const tagId = `tag-${Buffer.from(name).toString('hex').slice(0, 32)}`;
      statements.push(`INSERT OR IGNORE INTO tags(id,name,created_at) VALUES (${sqlValue(tagId)},${sqlValue(name)},${sqlValue(timestamp)});`);
      statements.push(`INSERT OR IGNORE INTO article_tags(article_id,tag_id) SELECT id,${sqlValue(tagId)} FROM articles WHERE id IN (${idList});`);
    }
    const removals = [...new Set(tags_remove.map((name) => String(name).trim()).filter(Boolean))].slice(0, 20);
    if (removals.length) statements.push(`DELETE FROM article_tags WHERE article_id IN (${idList}) AND tag_id IN (SELECT id FROM tags WHERE name IN (${removals.map(sqlValue).join(',')}));`);
    statements.push('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM article_tags at WHERE at.tag_id=tags.id);');
    if (statements.length) await this.execute(`BEGIN IMMEDIATE;\n${statements.join('\n')}\nCOMMIT;`);
    const count = await this.one(`SELECT count(*) AS count FROM articles WHERE id IN (${idList});`);
    return { updated: Number(count?.count || 0) };
  }

  async listSources() {
    return await this.query('SELECT * FROM sources ORDER BY enabled DESC, title COLLATE NOCASE;');
  }

  async getSource(id) {
    return await this.one(`SELECT * FROM sources WHERE id=${sqlValue(id)};`);
  }

  async findSource(kind, url) {
    return await this.one(`SELECT * FROM sources WHERE kind=${sqlValue(kind)} AND url=${sqlValue(url)} ORDER BY created_at LIMIT 1;`);
  }

  async listDueSources(at = now(), limit = 20) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    return await this.query(`SELECT * FROM sources WHERE enabled=1 AND kind IN ('rss','youtube','x','weibo') AND last_status!='syncing' AND (next_fetch_at IS NULL OR next_fetch_at<=${sqlValue(at)}) ORDER BY coalesce(next_fetch_at, created_at), created_at LIMIT ${safeLimit};`);
  }

  async createSource({ kind, title, url, syncIntervalMinutes = 60 }) {
    const existing = await this.findSource(kind, url);
    if (existing) return existing;
    const id = randomUUID();
    const timestamp = now();
    const interval = Math.min(Math.max(Number(syncIntervalMinutes) || 60, 15), 10080);
    await this.execute(`INSERT INTO sources(id,kind,title,url,sync_interval_minutes,next_fetch_at,created_at,updated_at) VALUES (${sqlValue(id)},${sqlValue(kind)},${sqlValue(title)},${sqlValue(url)},${interval},${sqlValue(timestamp)},${sqlValue(timestamp)},${sqlValue(timestamp)});`);
    return await this.getSource(id);
  }

  async updateSource(id, patch) {
    const allowed = {
      kind: 'kind', title: 'title', url: 'url', enabled: 'enabled', sync_interval_minutes: 'sync_interval_minutes',
      next_fetch_at: 'next_fetch_at', last_fetched_at: 'last_fetched_at', last_error: 'last_error', etag: 'etag',
      last_modified: 'last_modified', consecutive_failures: 'consecutive_failures', last_status: 'last_status',
      last_sync_count: 'last_sync_count', last_http_status: 'last_http_status', external_id: 'external_id',
      sync_cursor: 'sync_cursor', rate_limit_remaining: 'rate_limit_remaining', rate_limit_reset_at: 'rate_limit_reset_at'
    };
    const entries = Object.entries(patch).filter(([key]) => key in allowed);
    if (!entries.length) return await this.getSource(id);
    const assignments = entries.map(([key, value]) => `${allowed[key]}=${sqlValue(value)}`);
    assignments.push(`updated_at=${sqlValue(now())}`);
    await this.execute(`UPDATE sources SET ${assignments.join(',')} WHERE id=${sqlValue(id)};`);
    return await this.getSource(id);
  }

  async deleteSource(id) {
    const source = await this.getSource(id);
    if (!source) return null;
    await this.execute(`DELETE FROM sources WHERE id=${sqlValue(id)};`);
    return source;
  }

  async createAttachment({ articleId, fileName, storageName, mimeType, byteSize, sha256 }) {
    if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ''))) throw new Error('附件哈希无效');
    if (!storageName || path.basename(storageName) !== storageName || storageName.includes('\\')) throw new Error('附件存储名无效');
    if (!Number.isSafeInteger(Number(byteSize)) || Number(byteSize) < 0) throw new Error('附件大小无效');
    const id = randomUUID();
    await this.execute(`INSERT INTO attachments(id,article_id,file_name,storage_name,mime_type,byte_size,sha256,created_at) VALUES (${[
      id, articleId, fileName, storageName, mimeType, byteSize, sha256, now()
    ].map(sqlValue).join(',')});`);
    return await this.one(`SELECT * FROM attachments WHERE id=${sqlValue(id)};`);
  }

  async getAttachment(id) {
    return await this.one(`SELECT * FROM attachments WHERE id=${sqlValue(id)};`);
  }

  async createImportJob(kind, payload, { platform = kind === 'attachment' ? 'local' : 'web', phase = null } = {}) {
    const id = randomUUID();
    const timestamp = now();
    await this.execute(`INSERT INTO import_jobs(id,kind,status,platform,phase,progress,payload_json,created_at,updated_at) VALUES (${[
      id, kind, 'pending', platform, phase, 0, JSON.stringify(payload), timestamp, timestamp
    ].map(sqlValue).join(',')});`);
    return await this.getImportJob(id);
  }

  async listImportJobs(limit = 40) {
    const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 200);
    return await this.query(`SELECT * FROM import_jobs ORDER BY created_at DESC LIMIT ${safeLimit};`);
  }

  async getImportJob(id) {
    return await this.one(`SELECT * FROM import_jobs WHERE id=${sqlValue(id)};`);
  }

  async claimImportJob() {
    const job = await this.one("SELECT * FROM import_jobs WHERE status='pending' ORDER BY created_at LIMIT 1;");
    if (!job) return null;
    const timestamp = now();
    await this.execute(`UPDATE import_jobs SET status='running', attempts=attempts+1, started_at=coalesce(started_at,${sqlValue(timestamp)}), updated_at=${sqlValue(timestamp)}, error=NULL, action_required=NULL WHERE id=${sqlValue(job.id)} AND status='pending';`);
    return await this.getImportJob(job.id);
  }

  async updateImportJobProgress(id, { phase, progress, warning = undefined } = {}) {
    const assignments = [`updated_at=${sqlValue(now())}`];
    if (phase !== undefined) assignments.push(`phase=${sqlValue(phase)}`);
    if (progress !== undefined) {
      const safeProgress = Math.min(Math.max(Math.round(Number(progress) || 0), 0), 100);
      assignments.push(`progress=${safeProgress}`);
    }
    if (warning !== undefined) assignments.push(`warning=${sqlValue(warning ? String(warning).slice(0, 1000) : null)}`);
    await this.execute(`UPDATE import_jobs SET ${assignments.join(',')} WHERE id=${sqlValue(id)} AND status='running';`);
    return await this.getImportJob(id);
  }

  async awaitImportJob(id, { phase, actionRequired, warning = null, error = null } = {}) {
    const timestamp = now();
    await this.execute(`UPDATE import_jobs SET status='awaiting_user',phase=${sqlValue(phase || 'waiting_login')},action_required=${sqlValue(String(actionRequired || 'resume').slice(0, 80))},warning=${sqlValue(warning ? String(warning).slice(0, 1000) : null)},error=${sqlValue(error ? String(error).slice(0, 2000) : null)},updated_at=${sqlValue(timestamp)},finished_at=NULL WHERE id=${sqlValue(id)} AND status='running';`);
    return await this.getImportJob(id);
  }

  async completeImportJob(id, articleId, { warning = null } = {}) {
    const timestamp = now();
    await this.execute(`UPDATE import_jobs SET status='completed',phase='complete',progress=100,warning=coalesce(${sqlValue(warning)},warning),action_required=NULL,result_article_id=${sqlValue(articleId)},finished_at=${sqlValue(timestamp)},updated_at=${sqlValue(timestamp)},error=NULL WHERE id=${sqlValue(id)} AND status IN ('pending','running');`);
    return await this.getImportJob(id);
  }

  async failImportJob(id, error) {
    const timestamp = now();
    await this.execute(`UPDATE import_jobs SET status='failed',action_required=NULL,error=${sqlValue(String(error || '导入失败').slice(0, 2000))},finished_at=${sqlValue(timestamp)},updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)} AND status='running';`);
    return await this.getImportJob(id);
  }

  async retryImportJob(id) {
    const timestamp = now();
    await this.execute(`UPDATE import_jobs SET status='pending',phase=CASE WHEN platform='douyin' THEN 'parsing' ELSE phase END,progress=0,warning=NULL,action_required=NULL,error=NULL,result_article_id=NULL,started_at=NULL,finished_at=NULL,updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)} AND status='failed';`);
    return await this.getImportJob(id);
  }

  async actOnImportJob(id, action) {
    const job = await this.getImportJob(id);
    if (!job) return null;
    const timestamp = now();
    if (action === 'cancel') {
      if (!['pending', 'running', 'awaiting_user'].includes(job.status)) return job;
      await this.execute(`UPDATE import_jobs SET status='cancelled',phase='complete',action_required=NULL,error=NULL,finished_at=${sqlValue(timestamp)},updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)};`);
      return await this.getImportJob(id);
    }
    if (action === 'resume') {
      if (job.status !== 'awaiting_user') return job;
      await this.execute(`UPDATE import_jobs SET status='pending',phase=CASE WHEN platform='douyin' THEN 'parsing' ELSE phase END,progress=0,action_required=NULL,error=NULL,finished_at=NULL,updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)};`);
      return await this.getImportJob(id);
    }
    if (action === 'skip_transcription') {
      if (job.status !== 'awaiting_user' || job.action_required !== 'install_transcription_model') return job;
      const payload = { ...job.payload, skipTranscription: true };
      await this.execute(`UPDATE import_jobs SET status='pending',phase='saving',action_required=NULL,error=NULL,payload_json=${sqlValue(JSON.stringify(payload))},finished_at=NULL,updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(id)};`);
      return await this.getImportJob(id);
    }
    throw Object.assign(new Error('不支持的导入任务操作'), { status: 400 });
  }
}

import { createHash } from 'node:crypto';
import { BOOTSTRAP_SCHEMA_VERSION, SCHEMA_VERSION } from './schema.mjs';

function sqlValue(value) {
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function migrationChecksum(signature) {
  return createHash('sha256').update(signature).digest('hex');
}

async function buildV8MigrationSQL(database) {
  const sourceColumns = new Set((await database.query('PRAGMA table_info(sources);')).map((column) => column.name));
  const additions = [
    ['sync_interval_minutes', 'INTEGER NOT NULL DEFAULT 60 CHECK (sync_interval_minutes >= 15 AND sync_interval_minutes <= 10080)'],
    ['next_fetch_at', 'TEXT'],
    ['etag', 'TEXT'],
    ['last_modified', 'TEXT'],
    ['consecutive_failures', 'INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)'],
    ['last_status', "TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle','syncing','ok','error','not_modified'))"],
    ['last_sync_count', 'INTEGER NOT NULL DEFAULT 0 CHECK (last_sync_count >= 0)'],
    ['last_http_status', 'INTEGER'],
    ['external_id', 'TEXT'],
    ['sync_cursor', 'TEXT'],
    ['rate_limit_remaining', 'INTEGER'],
    ['rate_limit_reset_at', 'TEXT']
  ];
  const statements = additions
    .filter(([name]) => !sourceColumns.has(name))
    .map(([name, definition]) => `ALTER TABLE sources ADD COLUMN ${name} ${definition};`);
  statements.push(`
    CREATE INDEX IF NOT EXISTS idx_sources_due ON sources(enabled, next_fetch_at);
    CREATE INDEX IF NOT EXISTS idx_highlights_article ON highlights(article_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_collections_name ON smart_collections(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_smart_collections_position ON smart_collections(position, name COLLATE NOCASE);
    UPDATE sources
    SET next_fetch_at=coalesce(next_fetch_at, datetime('now')),
        last_status=CASE WHEN last_status='syncing' THEN 'idle' ELSE last_status END,
        updated_at=CASE WHEN last_status='syncing' THEN datetime('now') ELSE updated_at END;
  `);
  return statements.join('\n');
}

const v8Migration = {
  version: 8,
  name: 'v8-smart-collections-and-source-state',
  signature: 'reader-schema-v8-smart-collections-and-source-state:1',
  buildSQL: buildV8MigrationSQL
};
v8Migration.checksum = migrationChecksum(v8Migration.signature);

const v9Migration = {
  version: 9,
  name: 'v9-migration-audit',
  signature: 'reader-schema-v9-migration-audit:1',
  async buildSQL() {
    return `
      CREATE TABLE schema_migration_audit (
        version INTEGER PRIMARY KEY REFERENCES schema_migrations(version) ON DELETE CASCADE,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64),
        applied_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migration_audit(version,name,checksum,applied_at)
      SELECT version,${sqlValue(v8Migration.name)},${sqlValue(v8Migration.checksum)},applied_at
      FROM schema_migrations WHERE version=${v8Migration.version};
    `;
  }
};
v9Migration.checksum = migrationChecksum(v9Migration.signature);

const v10Migration = {
  version: 10,
  name: 'v10-library-pagination-indexes',
  signature: 'reader-schema-v10-library-pagination-indexes:1',
  async buildSQL() {
    return `
      CREATE INDEX IF NOT EXISTS idx_articles_archive_created ON articles(archived, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_articles_unread_created ON articles(archived, is_read, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_articles_favorite_created ON articles(archived, is_favorite, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_articles_type_created ON articles(archived, type, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_articles_collection_created ON articles(collection_id, archived, created_at DESC, id DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS article_search_trigram USING fts5(
        title,
        excerpt,
        content,
        author,
        source,
        content='articles',
        content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER IF NOT EXISTS articles_trigram_ai AFTER INSERT ON articles BEGIN
        INSERT INTO article_search_trigram(rowid, title, excerpt, content, author, source)
        VALUES (new.rowid, new.title, new.excerpt, new.content, new.author, new.source);
      END;
      CREATE TRIGGER IF NOT EXISTS articles_trigram_ad AFTER DELETE ON articles BEGIN
        INSERT INTO article_search_trigram(article_search_trigram, rowid, title, excerpt, content, author, source)
        VALUES ('delete', old.rowid, old.title, old.excerpt, old.content, old.author, old.source);
      END;
      CREATE TRIGGER IF NOT EXISTS articles_trigram_au AFTER UPDATE OF title,excerpt,content,author,source ON articles BEGIN
        INSERT INTO article_search_trigram(article_search_trigram, rowid, title, excerpt, content, author, source)
        VALUES ('delete', old.rowid, old.title, old.excerpt, old.content, old.author, old.source);
        INSERT INTO article_search_trigram(rowid, title, excerpt, content, author, source)
        VALUES (new.rowid, new.title, new.excerpt, new.content, new.author, new.source);
      END;
      INSERT INTO article_search_trigram(article_search_trigram) VALUES ('rebuild');
    `;
  }
};
v10Migration.checksum = migrationChecksum(v10Migration.signature);

const v11Migration = {
  version: 11,
  name: 'v11-spotlight-index-outbox',
  signature: 'reader-schema-v11-spotlight-index-outbox:1',
  async buildSQL() {
    return `
      CREATE TABLE spotlight_outbox (
        article_id TEXT PRIMARY KEY,
        operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        changed_at TEXT NOT NULL
      );
      CREATE INDEX idx_spotlight_outbox_changed ON spotlight_outbox(changed_at, article_id);
      CREATE TRIGGER spotlight_articles_ai AFTER INSERT ON articles BEGIN
        INSERT INTO spotlight_outbox(article_id,operation,revision,changed_at)
        VALUES (new.id,CASE WHEN new.archived=1 THEN 'delete' ELSE 'upsert' END,1,datetime('now'))
        ON CONFLICT(article_id) DO UPDATE SET
          operation=excluded.operation,revision=spotlight_outbox.revision+1,changed_at=excluded.changed_at;
      END;
      CREATE TRIGGER spotlight_articles_au
      AFTER UPDATE OF title,excerpt,content,author,source,type,language,published_at,archived ON articles BEGIN
        INSERT INTO spotlight_outbox(article_id,operation,revision,changed_at)
        VALUES (new.id,CASE WHEN new.archived=1 THEN 'delete' ELSE 'upsert' END,1,datetime('now'))
        ON CONFLICT(article_id) DO UPDATE SET
          operation=excluded.operation,revision=spotlight_outbox.revision+1,changed_at=excluded.changed_at;
      END;
      CREATE TRIGGER spotlight_articles_ad AFTER DELETE ON articles BEGIN
        INSERT INTO spotlight_outbox(article_id,operation,revision,changed_at)
        VALUES (old.id,'delete',1,datetime('now'))
        ON CONFLICT(article_id) DO UPDATE SET
          operation='delete',revision=spotlight_outbox.revision+1,changed_at=excluded.changed_at;
      END;
      CREATE TRIGGER spotlight_article_tags_ai AFTER INSERT ON article_tags BEGIN
        INSERT INTO spotlight_outbox(article_id,operation,revision,changed_at)
        SELECT new.article_id,CASE WHEN a.archived=1 THEN 'delete' ELSE 'upsert' END,1,datetime('now')
        FROM articles a WHERE a.id=new.article_id
        ON CONFLICT(article_id) DO UPDATE SET
          operation=excluded.operation,revision=spotlight_outbox.revision+1,changed_at=excluded.changed_at;
      END;
      CREATE TRIGGER spotlight_article_tags_ad AFTER DELETE ON article_tags BEGIN
        INSERT INTO spotlight_outbox(article_id,operation,revision,changed_at)
        SELECT old.article_id,CASE WHEN a.archived=1 THEN 'delete' ELSE 'upsert' END,1,datetime('now')
        FROM articles a WHERE a.id=old.article_id
        ON CONFLICT(article_id) DO UPDATE SET
          operation=excluded.operation,revision=spotlight_outbox.revision+1,changed_at=excluded.changed_at;
      END;
    `;
  }
};
v11Migration.checksum = migrationChecksum(v11Migration.signature);

const v12Migration = {
  version: 12,
  name: 'v12-local-semantic-index',
  signature: 'reader-schema-v12-local-semantic-index:1',
  async buildSQL() {
    return `
      CREATE TABLE chunk_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES article_chunks(id) ON DELETE CASCADE,
        model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
        dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 8 AND 4096),
        vector BLOB NOT NULL CHECK (typeof(vector)='blob' AND length(vector)=dimensions*4),
        created_at TEXT NOT NULL,
        UNIQUE(chunk_id,model)
      );
      CREATE INDEX idx_chunk_embeddings_model ON chunk_embeddings(model,chunk_id);
      CREATE TABLE chunk_embedding_buckets (
        chunk_id TEXT NOT NULL,
        model TEXT NOT NULL,
        band INTEGER NOT NULL CHECK (band BETWEEN 0 AND 15),
        bucket INTEGER NOT NULL CHECK (bucket BETWEEN 0 AND 255),
        PRIMARY KEY(chunk_id,band),
        FOREIGN KEY(chunk_id,model) REFERENCES chunk_embeddings(chunk_id,model) ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE INDEX idx_chunk_embedding_buckets_lookup ON chunk_embedding_buckets(model,band,bucket,chunk_id);
    `;
  }
};
v12Migration.checksum = migrationChecksum(v12Migration.signature);

const v13Migration = {
  version: 13,
  name: 'v13-resumable-platform-imports',
  signature: 'reader-schema-v13-resumable-platform-imports:1',
  async buildSQL() {
    return `
      CREATE TABLE import_jobs_v13 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('url','attachment')),
        status TEXT NOT NULL CHECK (status IN ('pending','running','awaiting_user','completed','failed','cancelled')),
        platform TEXT NOT NULL DEFAULT 'web' CHECK (length(platform) BETWEEN 1 AND 40),
        phase TEXT,
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        warning TEXT,
        action_required TEXT,
        payload_json TEXT NOT NULL,
        result_article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO import_jobs_v13(
        id,kind,status,platform,phase,progress,payload_json,result_article_id,error,attempts,
        created_at,updated_at,started_at,finished_at
      )
      SELECT
        id,kind,status,CASE WHEN kind='attachment' THEN 'local' ELSE 'web' END,
        CASE status WHEN 'completed' THEN 'complete' WHEN 'running' THEN 'parsing' ELSE NULL END,
        CASE status WHEN 'completed' THEN 100 ELSE 0 END,payload_json,result_article_id,error,attempts,
        created_at,updated_at,started_at,finished_at
      FROM import_jobs;
      DROP TABLE import_jobs;
      ALTER TABLE import_jobs_v13 RENAME TO import_jobs;
      CREATE INDEX idx_import_jobs_status ON import_jobs(status, created_at);
      CREATE INDEX idx_import_jobs_platform ON import_jobs(platform, created_at DESC);
    `;
  }
};
v13Migration.checksum = migrationChecksum(v13Migration.signature);

export const MIGRATION_REGISTRY = Object.freeze([
  Object.freeze(v8Migration),
  Object.freeze(v9Migration),
  Object.freeze(v10Migration),
  Object.freeze(v11Migration),
  Object.freeze(v12Migration),
  Object.freeze(v13Migration)
]);

function validateMigrationRegistry() {
  const versions = MIGRATION_REGISTRY.map((migration) => migration.version);
  if (versions[0] !== BOOTSTRAP_SCHEMA_VERSION || versions.at(-1) !== SCHEMA_VERSION) {
    throw new Error(`迁移注册表必须覆盖 schema v${BOOTSTRAP_SCHEMA_VERSION} 到 v${SCHEMA_VERSION}`);
  }
  for (let index = 0; index < MIGRATION_REGISTRY.length; index += 1) {
    const migration = MIGRATION_REGISTRY[index];
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 || migration.checksum.length !== 64) {
      throw new Error('迁移注册表包含无效条目');
    }
    if (index > 0 && migration.version !== MIGRATION_REGISTRY[index - 1].version + 1) {
      throw new Error('迁移注册表版本必须连续递增');
    }
  }
}

validateMigrationRegistry();

export async function verifyMigrationHistory(database) {
  const current = await database.one('SELECT max(version) AS version FROM schema_migrations;');
  if (Number(current?.version) !== SCHEMA_VERSION) {
    throw new Error(`资料库迁移未到达目标 schema v${SCHEMA_VERSION}`);
  }
  const auditTable = await database.one("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration_audit';");
  if (!auditTable) throw new Error('资料库缺少迁移审计记录');

  const rows = await database.query('SELECT version,name,checksum,applied_at FROM schema_migration_audit ORDER BY version;');
  const rowsByVersion = new Map(rows.map((row) => [Number(row.version), row]));
  for (const migration of MIGRATION_REGISTRY) {
    const row = rowsByVersion.get(migration.version);
    if (!row || row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new Error(`资料库 schema v${migration.version} 的迁移审计记录不匹配；为避免数据损坏，已停止打开`);
    }
  }
  for (const row of rows) {
    if (Number(row.version) >= BOOTSTRAP_SCHEMA_VERSION && !MIGRATION_REGISTRY.some((migration) => migration.version === Number(row.version))) {
      throw new Error(`资料库包含未知的迁移审计版本 v${row.version}`);
    }
  }
}

export async function applyPendingMigrations(database, fromVersion = 0) {
  const applied = [];
  for (const migration of MIGRATION_REGISTRY) {
    if (migration.version <= fromVersion) continue;
    const body = await migration.buildSQL(database);
    const appliedAt = new Date().toISOString();
    const auditSQL = migration.version >= 9
      ? `INSERT INTO schema_migration_audit(version,name,checksum,applied_at) VALUES (${migration.version},${sqlValue(migration.name)},${sqlValue(migration.checksum)},${sqlValue(appliedAt)});`
      : '';
    await database.execute(`
      BEGIN IMMEDIATE;
      ${body}
      INSERT INTO schema_migrations(version,applied_at) VALUES (${migration.version},${sqlValue(appliedAt)});
      ${auditSQL}
      COMMIT;
    `);
    applied.push({ version: migration.version, name: migration.name, checksum: migration.checksum, appliedAt });
  }
  await verifyMigrationHistory(database);
  return applied;
}

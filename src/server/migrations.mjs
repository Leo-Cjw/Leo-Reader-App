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

export const MIGRATION_REGISTRY = Object.freeze([
  Object.freeze(v8Migration),
  Object.freeze(v9Migration)
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

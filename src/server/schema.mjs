// Schema v8 is the immutable bootstrap. Add every later change to migrations.mjs.
export const BOOTSTRAP_SCHEMA_VERSION = 8;
export const SCHEMA_VERSION = 12;

export const schemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS smart_collections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  rule_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_collections_name ON smart_collections(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_smart_collections_position ON smart_collections(position, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY,
  url TEXT,
  title TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'article',
  language TEXT NOT NULL DEFAULT 'zh',
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  read_time_minutes INTEGER NOT NULL DEFAULT 1,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
  is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
  reading_progress REAL NOT NULL DEFAULT 0 CHECK (reading_progress >= 0 AND reading_progress <= 1),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  collection_id TEXT REFERENCES collections(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url ON articles(url) WHERE url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_articles_created ON articles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_collection ON articles(collection_id);
CREATE INDEX IF NOT EXISTS idx_articles_flags ON articles(archived, is_read, is_favorite);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS article_tags (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, tag_id)
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('rss','x','weibo','youtube')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sync_interval_minutes INTEGER NOT NULL DEFAULT 60 CHECK (sync_interval_minutes >= 15 AND sync_interval_minutes <= 10080),
  next_fetch_at TEXT,
  last_fetched_at TEXT,
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_status TEXT NOT NULL DEFAULT 'idle' CHECK (last_status IN ('idle','syncing','ok','error','not_modified')),
  last_sync_count INTEGER NOT NULL DEFAULT 0 CHECK (last_sync_count >= 0),
  last_http_status INTEGER,
  external_id TEXT,
  sync_cursor TEXT,
  rate_limit_remaining INTEGER,
  rate_limit_reset_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  quote TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT 'amber',
  start_offset INTEGER,
  end_offset INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_highlights_article ON highlights(article_id, created_at);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_article ON attachments(article_id);
CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('url','attachment')),
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','failed')),
  payload_json TEXT NOT NULL,
  result_article_id TEXT REFERENCES articles(id) ON DELETE SET NULL,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS article_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'zh',
  reason TEXT NOT NULL DEFAULT 'edit',
  created_at TEXT NOT NULL,
  UNIQUE(article_id, version)
);

CREATE INDEX IF NOT EXISTS idx_article_revisions_article ON article_revisions(article_id, version DESC);

CREATE TABLE IF NOT EXISTS article_chunks (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  heading TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(article_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_article_chunks_article ON article_chunks(article_id, chunk_index);

CREATE VIRTUAL TABLE IF NOT EXISTS chunk_search USING fts5(
  heading,
  content,
  content='article_chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS article_chunks_ai AFTER INSERT ON article_chunks BEGIN
  INSERT INTO chunk_search(rowid, heading, content) VALUES (new.rowid, new.heading, new.content);
END;

CREATE TRIGGER IF NOT EXISTS article_chunks_ad AFTER DELETE ON article_chunks BEGIN
  INSERT INTO chunk_search(chunk_search, rowid, heading, content) VALUES ('delete', old.rowid, old.heading, old.content);
END;

CREATE TRIGGER IF NOT EXISTS article_chunks_au AFTER UPDATE ON article_chunks BEGIN
  INSERT INTO chunk_search(chunk_search, rowid, heading, content) VALUES ('delete', old.rowid, old.heading, old.content);
  INSERT INTO chunk_search(rowid, heading, content) VALUES (new.rowid, new.heading, new.content);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS article_search USING fts5(
  title,
  excerpt,
  content,
  author,
  source,
  content='articles',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO article_search(rowid, title, excerpt, content, author, source)
  VALUES (new.rowid, new.title, new.excerpt, new.content, new.author, new.source);
END;

CREATE TRIGGER IF NOT EXISTS articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO article_search(article_search, rowid, title, excerpt, content, author, source)
  VALUES ('delete', old.rowid, old.title, old.excerpt, old.content, old.author, old.source);
END;

CREATE TRIGGER IF NOT EXISTS articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO article_search(article_search, rowid, title, excerpt, content, author, source)
  VALUES ('delete', old.rowid, old.title, old.excerpt, old.content, old.author, old.source);
  INSERT INTO article_search(rowid, title, excerpt, content, author, source)
  VALUES (new.rowid, new.title, new.excerpt, new.content, new.author, new.source);
END;
`;

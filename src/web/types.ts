export type View = 'inbox' | 'unread' | 'favorites' | 'notes' | 'archive';

export interface Article {
  id: string;
  url: string | null;
  title: string;
  source: string;
  author: string;
  type: string;
  language: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  excerpt: string;
  content: string;
  summary: string;
  read_time_minutes: number;
  is_favorite: boolean;
  is_read: boolean;
  reading_progress: number;
  archived: boolean;
  collection_id: string | null;
  collection_name: string | null;
  tags: string[];
  attachments: Attachment[];
  revision_count: number;
  metadata?: Record<string, unknown>;
}

export type HighlightColor = 'amber' | 'green' | 'blue' | 'pink';

export interface Highlight {
  id: string;
  article_id: string;
  quote: string;
  note: string;
  color: HighlightColor;
  start_offset: number;
  end_offset: number;
  created_at: string;
  updated_at: string;
}

export interface AIStatus {
  provider: string;
  remoteConfigured: boolean;
  configurationSource?: string;
  credentialBackend?: string;
  capabilities: { summary: boolean; chat: boolean; rag: boolean; compose: boolean; translate: boolean };
  index?: RAGIndexStatus;
}

export interface RAGIndexStatus {
  version: number;
  mode: 'local-lexical' | string;
  chunkCount: number;
  indexedArticles: number;
  articleCount: number;
  pendingArticles: number;
  articleSearchRows: number;
  chunkSearchRows: number;
  consistent: boolean;
}

export interface RAGCitation {
  id: string;
  articleId: string;
  articleTitle: string;
  articleSource: string;
  articleUrl: string | null;
  articleLanguage: string;
  heading: string;
  quote: string;
  chunkIndex: number;
  startOffset: number;
  endOffset: number;
  score: number;
}

export interface RAGChatResult {
  provider: string;
  model?: string | null;
  answer: string;
  scope: 'article' | 'library';
  citations: RAGCitation[];
  retrieval: { mode: string; matchedChunks: number; citedChunks: number };
}

export interface AISettings {
  configured: boolean;
  enabled: boolean;
  endpoint: string;
  apiKeyStored: boolean;
  apiKeySource: 'keychain' | 'environment' | 'none';
  credentialBackend: 'macos-keychain' | 'environment-only' | string;
  credentialWritable: boolean;
  environmentAvailable: boolean;
  updatedAt: string | null;
  warning: string | null;
}

export interface AIConnectionResult {
  ok: boolean;
  provider: string;
  model: string | null;
  summary: string;
}

export interface AISourceReference {
  id: string;
  title: string;
  source: string;
  url: string | null;
}

export interface AIProvenance {
  version: number;
  task: 'translate' | 'compose';
  provider: string;
  model: string | null;
  sourceArticles: AISourceReference[];
  targetLanguage?: string;
  language?: string;
  format?: 'brief' | 'outline' | 'essay' | 'social';
  prompt?: string;
  promptVersion: string;
  createdAt: string;
}

export interface AIDraftResult {
  article: Article;
  provenance: AIProvenance;
}

export interface Attachment {
  id: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  url: string;
  thumbnail_url: string | null;
}

export interface ImportJob {
  id: string;
  kind: 'url' | 'attachment';
  status: 'pending' | 'running' | 'completed' | 'failed';
  payload: { url?: string; fileName?: string; mimeType?: string; byteSize?: number; collectionId?: string };
  result_article_id: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type PortableImportConflict = 'duplicate_id' | 'duplicate_url';

export interface PortableImportPreviewArticle {
  id: string;
  title: string;
  source: string;
  originalURL: string | null;
  originalCollection: string | null;
  tags: string[];
  highlights: number;
  attachments: number;
  selectable: boolean;
  conflict: PortableImportConflict | null;
}

export interface PortableImportPreview {
  id: string;
  formatVersion: number;
  appVersion: string;
  createdAt: string | null;
  compatibilityMode: boolean;
  counts: { articles: number; highlights: number; attachments: number };
  articles: PortableImportPreviewArticle[];
}

export interface PortableImportResult {
  imported: number;
  skipped: number;
  failed: number;
  results: Array<{
    id: string;
    title: string;
    status: 'imported' | 'skipped' | 'failed';
    reason?: PortableImportConflict | string;
  }>;
}

export interface ArticleRevisionSummary {
  id: string;
  article_id: string;
  version: number;
  title: string;
  excerpt: string;
  author: string;
  source: string;
  language: string;
  reason: string;
  created_at: string;
  content_length: number;
}

export interface ArticleRevision extends ArticleRevisionSummary {
  content: string;
}

export interface Backup {
  id: string;
  file_name: string;
  byte_size: number;
  created_at: string;
  sha256?: string;
  reason?: string;
  encrypted: boolean;
}

export interface MigrationSnapshot {
  id: string;
  file_name: string;
  byte_size: number;
  created_at: string;
  from_schema_version: number;
  to_schema_version: number;
}

export interface DataHealthCheck {
  id: string;
  label: string;
  status: 'pass' | 'warning' | 'fail';
  detail: string;
}

export interface DataHealth {
  status: 'healthy' | 'warning' | 'error';
  checked_at: string;
  duration_ms: number;
  schema_version: number;
  database: {
    byte_size: number;
    integrity: boolean;
    foreign_key_violations: number | null;
    migration_history_verified: boolean;
    private_permissions: boolean;
  };
  attachments: {
    records: number;
    referenced_files: number;
    stored_files: number;
    missing_files: number;
    size_mismatches: number;
    orphan_files: number;
  };
  search: RAGIndexStatus | null;
  repair: {
    available: boolean;
    actions: Array<'storage_permissions' | 'search_index'>;
    blockers: Array<'database_integrity' | 'foreign_keys' | 'migration_history' | 'attachment_files'>;
  };
  checks: DataHealthCheck[];
}

export interface DataRepairResult {
  repaired_at: string;
  actions: Array<'storage_permissions' | 'search_index'>;
  backup: Backup | null;
  health: DataHealth;
}

export interface PendingRestore {
  id: string;
  backupCreatedAt: string;
  safetyBackupId: string;
  scheduledAt: string;
  encrypted?: boolean;
}

export interface Collection {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  article_count: number;
  child_count: number;
  is_system: boolean;
  created_at: string;
  updated_at: string;
}

export interface SmartCollectionRule {
  match: 'all' | 'any';
  query: string;
  types: string[];
  tags: string[];
  tag_match: 'all' | 'any';
  source: string;
  collection_id: string | null;
  unread: boolean | null;
  favorite: boolean | null;
  has_highlights: boolean | null;
  has_attachments: boolean | null;
  created_within_days: number | null;
}

export interface SmartCollection {
  id: string;
  name: string;
  position: number;
  rule: SmartCollectionRule;
  article_count: number;
  created_at: string;
  updated_at: string;
}

export interface Tag {
  id: string;
  name: string;
  article_count: number;
  created_at: string;
}

export interface DuplicateArticle {
  id: string;
  url: string | null;
  title: string;
  source: string;
  author: string;
  type: string;
  language: string;
  created_at: string;
  updated_at: string;
  excerpt: string;
  is_favorite: boolean;
  is_read: boolean;
  reading_progress: number;
  collection_id: string | null;
  content_length: number;
}

export interface DuplicateGroup {
  id: string;
  confidence: 'exact' | 'high';
  reasons: string[];
  articles: DuplicateArticle[];
}

export interface Source {
  id: string;
  kind: 'rss' | 'x' | 'weibo' | 'youtube';
  title: string;
  url: string;
  enabled: boolean;
  sync_interval_minutes: number;
  next_fetch_at: string | null;
  last_fetched_at: string | null;
  last_error: string | null;
  etag: string | null;
  last_modified: string | null;
  consecutive_failures: number;
  last_status: 'idle' | 'syncing' | 'ok' | 'error' | 'not_modified';
  last_sync_count: number;
  last_http_status: number | null;
  external_id: string | null;
  sync_cursor: string | null;
  rate_limit_remaining: number | null;
  rate_limit_reset_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConnectorStatus {
  x: {
    configured: boolean;
    credentialSource: 'keychain' | 'environment' | 'none';
    credentialBackend: string;
    credentialWritable: boolean;
    environmentAvailable: boolean;
  };
  weibo: {
    installed: boolean;
    authenticated: boolean;
    account: string | null;
    error: string | null;
  };
}

export interface Stats {
  total: number;
  unread: number;
  favorites: number;
  notes: number;
  archived: number;
}

export interface SummaryResult {
  provider: string;
  summary: string;
  points: string[];
}

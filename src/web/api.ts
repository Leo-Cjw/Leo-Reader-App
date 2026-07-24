import type { AIConnectionResult, AIDraftResult, AISettings, AIStatus, Article, ArticleRevision, ArticleRevisionSummary, Attachment, Backup, Collection, ConnectorStatus, DuplicateGroup, Highlight, HighlightColor, ImportJob, MigrationSnapshot, PendingRestore, RAGChatResult, RAGCitation, RAGIndexStatus, SmartCollection, SmartCollectionRule, Source, Stats, SummaryResult, Tag, View } from './types';

export class APIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new APIError(response.status, payload.error || `请求失败 (${response.status})`);
  return payload as T;
}

function encodeSecretHeader(value: string) {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes));
}

export const api = {
  async listArticles(view: View, query = '', collectionId?: string | null, filters: { types?: string[]; tag?: string; mediaOnly?: boolean } = {}, smartCollectionId?: string | null) {
    const params = new URLSearchParams({ view });
    if (query) params.set('q', query);
    if (collectionId) params.set('collection', collectionId);
    if (smartCollectionId) params.set('smart', smartCollectionId);
    if (filters.types?.length) params.set('types', filters.types.join(','));
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.mediaOnly) params.set('media', '1');
    return (await request<{ articles: Article[] }>(`/api/articles?${params}`)).articles;
  },
  async updateArticle(id: string, patch: Partial<Article>) {
    return (await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).article;
  },
  async getArticle(id: string) {
    return (await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}`)).article;
  },
  async importURL(url: string, collectionId?: string) {
    return (await request<{ article: Article }>('/api/articles', { method: 'POST', body: JSON.stringify({ mode: 'url', url, collection_id: collectionId }) })).article;
  },
  async createURLImport(url: string, collectionId?: string) {
    return (await request<{ job: ImportJob }>('/api/import-jobs', { method: 'POST', body: JSON.stringify({ kind: 'url', url, collection_id: collectionId }) })).job;
  },
  async uploadAttachment(file: File, collectionId?: string) {
    const params = new URLSearchParams();
    if (collectionId) params.set('collection', collectionId);
    const response = await fetch(`/api/import-jobs/upload?${params}`, {
      method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-reader-filename': encodeURIComponent(file.name) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new APIError(response.status, payload.error || `上传失败 (${response.status})`);
    return (payload as { job: ImportJob }).job;
  },
  async uploadArticleImage(articleId: string, file: File) {
    const response = await fetch(`/api/articles/${encodeURIComponent(articleId)}/attachments`, {
      method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-reader-filename': encodeURIComponent(file.name) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new APIError(response.status, payload.error || `图片上传失败 (${response.status})`);
    return payload as { article: Article; attachment: Attachment; duplicate: boolean };
  },
  async listImportJobs() {
    return (await request<{ jobs: ImportJob[] }>('/api/import-jobs')).jobs;
  },
  async getImportJob(id: string) {
    return (await request<{ job: ImportJob }>(`/api/import-jobs/${encodeURIComponent(id)}`)).job;
  },
  async retryImportJob(id: string) {
    return (await request<{ job: ImportJob }>(`/api/import-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST' })).job;
  },
  async createMarkdown(title: string, content: string, collectionId?: string) {
    return (await request<{ article: Article }>('/api/articles', { method: 'POST', body: JSON.stringify({ mode: 'markdown', title, content, collection_id: collectionId }) })).article;
  },
  async addTags(id: string, tags: string[]) {
    return (await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}/tags`, { method: 'POST', body: JSON.stringify({ tags }) })).article;
  },
  async updateTags(id: string, add: string[] = [], remove: string[] = []) {
    return (await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}/tags`, { method: 'PATCH', body: JSON.stringify({ add, remove }) })).article;
  },
  async batchUpdateArticles(ids: string[], patch: { collection_id?: string; is_favorite?: boolean; is_read?: boolean; archived?: boolean; tags_add?: string[]; tags_remove?: string[] }) {
    return await request<{ updated: number }>('/api/articles/batch', { method: 'POST', body: JSON.stringify({ ids, ...patch }) });
  },
  async exportArticles(ids: string[], includeAttachments = true) {
    const response = await fetch('/api/exports/markdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, include_attachments: includeAttachments }) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new APIError(response.status, payload.error || `导出失败 (${response.status})`);
    }
    const blob = await response.blob();
    let fileName = 'Reader-Markdown.zip';
    try { fileName = decodeURIComponent(response.headers.get('x-reader-filename') || fileName); } catch {}
    const objectURL = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectURL; anchor.download = fileName; anchor.style.display = 'none';
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectURL), 30_000);
    return { fileName, byteSize: blob.size };
  },
  async listDuplicateGroups() {
    return (await request<{ groups: DuplicateGroup[] }>('/api/duplicates')).groups;
  },
  async resolveDuplicates(keepId: string, duplicateIds: string[]) {
    return await request<{ article: Article; archivedIds: string[] }>('/api/duplicates/resolve', { method: 'POST', body: JSON.stringify({ keep_id: keepId, duplicate_ids: duplicateIds }) });
  },
  async listRevisions(id: string) {
    return (await request<{ revisions: ArticleRevisionSummary[] }>(`/api/articles/${encodeURIComponent(id)}/revisions`)).revisions;
  },
  async getRevision(id: string, version: number) {
    return (await request<{ revision: ArticleRevision }>(`/api/articles/${encodeURIComponent(id)}/revisions/${version}`)).revision;
  },
  async restoreRevision(id: string, version: number) {
    return (await request<{ article: Article }>(`/api/articles/${encodeURIComponent(id)}/revisions/${version}/restore`, { method: 'POST' })).article;
  },
  async listHighlights(articleId: string) {
    return (await request<{ highlights: Highlight[] }>(`/api/articles/${encodeURIComponent(articleId)}/highlights`)).highlights;
  },
  async createHighlight(articleId: string, input: { quote: string; note?: string; color: HighlightColor; startOffset: number; endOffset: number }) {
    return (await request<{ highlight: Highlight }>(`/api/articles/${encodeURIComponent(articleId)}/highlights`, {
      method: 'POST',
      body: JSON.stringify({ quote: input.quote, note: input.note || '', color: input.color, start_offset: input.startOffset, end_offset: input.endOffset })
    })).highlight;
  },
  async updateHighlight(id: string, patch: { note?: string; color?: HighlightColor }) {
    return (await request<{ highlight: Highlight }>(`/api/highlights/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).highlight;
  },
  async deleteHighlight(id: string) {
    return await request<{ deleted: true; highlight: Highlight }>(`/api/highlights/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async listCollections() {
    return (await request<{ collections: Collection[] }>('/api/collections')).collections;
  },
  async createCollection(name: string, parentId?: string | null) {
    return (await request<{ collection: Collection }>('/api/collections', { method: 'POST', body: JSON.stringify({ name, parent_id: parentId || null }) })).collection;
  },
  async updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'parent_id' | 'position'>>) {
    return (await request<{ collection: Collection }>(`/api/collections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).collection;
  },
  async deleteCollection(id: string, moveTo = 'inbox') {
    return await request<{ deleted: true; collection: Collection }>(`/api/collections/${encodeURIComponent(id)}?move_to=${encodeURIComponent(moveTo)}`, { method: 'DELETE' });
  },
  async reorderCollections(parentId: string | null, orderedIds: string[]) {
    return (await request<{ collections: Collection[] }>('/api/collections/reorder', { method: 'POST', body: JSON.stringify({ parent_id: parentId, ordered_ids: orderedIds }) })).collections;
  },
  async listSmartCollections() {
    return (await request<{ smartCollections: SmartCollection[] }>('/api/smart-collections')).smartCollections;
  },
  async createSmartCollection(name: string, rule: SmartCollectionRule) {
    return (await request<{ smartCollection: SmartCollection }>('/api/smart-collections', { method: 'POST', body: JSON.stringify({ name, rule }) })).smartCollection;
  },
  async updateSmartCollection(id: string, patch: { name?: string; rule?: SmartCollectionRule; position?: number }) {
    return (await request<{ smartCollection: SmartCollection }>(`/api/smart-collections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).smartCollection;
  },
  async deleteSmartCollection(id: string) {
    return await request<{ deleted: true; smartCollection: SmartCollection }>(`/api/smart-collections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async reorderSmartCollections(orderedIds: string[]) {
    return (await request<{ smartCollections: SmartCollection[] }>('/api/smart-collections/reorder', { method: 'POST', body: JSON.stringify({ ordered_ids: orderedIds }) })).smartCollections;
  },
  async listTags() {
    return (await request<{ tags: Tag[] }>('/api/tags')).tags;
  },
  async getStats() {
    return (await request<{ stats: Stats }>('/api/stats')).stats;
  },
  async summarize(id: string) {
    return await request<SummaryResult>(`/api/articles/${encodeURIComponent(id)}/ai/summary`, { method: 'POST' });
  },
  async chat(id: string, prompt: string, scope: 'article' | 'library' = 'article') {
    return await request<RAGChatResult>(`/api/articles/${encodeURIComponent(id)}/ai/chat`, { method: 'POST', body: JSON.stringify({ prompt, scope }) });
  },
  async aiStatus() {
    return await request<AIStatus>('/api/ai/status');
  },
  async ragIndexStatus() {
    return (await request<{ index: RAGIndexStatus }>('/api/ai/index')).index;
  },
  async searchRAG(query: string, scope: 'article' | 'library', articleId?: string, limit = 6) {
    return await request<{ query: string; scope: 'article' | 'library'; citations: RAGCitation[]; index: RAGIndexStatus }>('/api/ai/search', { method: 'POST', body: JSON.stringify({ query, scope, article_id: articleId, limit }) });
  },
  async getAISettings() {
    return (await request<{ settings: AISettings }>('/api/settings/ai')).settings;
  },
  async updateAISettings(input: { enabled: boolean; endpoint: string; apiKey?: string; clearApiKey?: boolean }) {
    return await request<{ settings: AISettings; status: AIStatus }>('/api/settings/ai', { method: 'PUT', body: JSON.stringify({ enabled: input.enabled, endpoint: input.endpoint, api_key: input.apiKey || undefined, clear_api_key: input.clearApiKey || false }) });
  },
  async resetAISettings() {
    return await request<{ settings: AISettings; status: AIStatus }>('/api/settings/ai', { method: 'DELETE' });
  },
  async testAISettings(endpoint: string, apiKey?: string) {
    return (await request<{ result: AIConnectionResult }>('/api/settings/ai/test', { method: 'POST', body: JSON.stringify({ endpoint, api_key: apiKey || undefined }) })).result;
  },
  async getConnectorSettings() {
    return (await request<{ connectors: ConnectorStatus }>('/api/settings/connectors')).connectors;
  },
  async saveXConnector(bearerToken: string) {
    return (await request<{ connectors: ConnectorStatus }>('/api/settings/connectors/x', { method: 'PUT', body: JSON.stringify({ bearer_token: bearerToken }) })).connectors;
  },
  async clearXConnector() {
    return (await request<{ connectors: ConnectorStatus }>('/api/settings/connectors/x', { method: 'DELETE' })).connectors;
  },
  async testXConnector(bearerToken?: string) {
    return (await request<{ result: { ok: true; account: string; remaining: number | null; resetAt: string | null } }>('/api/settings/connectors/x/test', { method: 'POST', body: JSON.stringify({ bearer_token: bearerToken || undefined }) })).result;
  },
  async testWeiboConnector() {
    return (await request<{ result: { ok: true; account: string | null } }>('/api/settings/connectors/weibo/test', { method: 'POST' })).result;
  },
  async logoutWeiboConnector() {
    return (await request<{ connectors: ConnectorStatus }>('/api/settings/connectors/weibo', { method: 'DELETE' })).connectors;
  },
  async translateArticle(articleId: string, targetLanguage: string, collectionId?: string | null) {
    return await request<AIDraftResult>('/api/ai/translate', { method: 'POST', body: JSON.stringify({ article_id: articleId, target_language: targetLanguage, collection_id: collectionId || undefined }) });
  },
  async composeArticles(articleIds: string[], options: { prompt: string; format: string; language: string; collectionId?: string | null }) {
    return await request<AIDraftResult>('/api/ai/compose', { method: 'POST', body: JSON.stringify({ article_ids: articleIds, prompt: options.prompt, format: options.format, language: options.language, collection_id: options.collectionId || undefined }) });
  },
  async listSources() {
    return (await request<{ sources: Source[] }>('/api/sources')).sources;
  },
  async createSource(kind: Source['kind'], title: string, url: string, syncIntervalMinutes = 60) {
    return await request<{ source: Source; duplicate: boolean }>('/api/sources', { method: 'POST', body: JSON.stringify({ kind, title, url, sync_interval_minutes: syncIntervalMinutes }) });
  },
  async updateSource(id: string, patch: Partial<Pick<Source, 'title' | 'enabled' | 'sync_interval_minutes'>>) {
    return (await request<{ source: Source }>(`/api/sources/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).source;
  },
  async deleteSource(id: string) {
    return await request<{ deleted: true; source: Source }>(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async syncSource(id: string) {
    return await request<{ imported: number; total: number; notModified: boolean; source: Source }>(`/api/sources/${encodeURIComponent(id)}/sync`, { method: 'POST' });
  },
  async importOPML(file: File) {
    const response = await fetch('/api/sources/opml', { method: 'POST', body: file, headers: { 'content-type': 'text/x-opml; charset=utf-8' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new APIError(response.status, payload.error || `OPML 导入失败 (${response.status})`);
    return payload as { imported: number; duplicates: number; failed: number; errors: Array<{ title: string; error: string }>; sources: Source[] };
  },
  async listBackups() {
    return await request<{ backups: Backup[]; pendingRestore: PendingRestore | null }>('/api/backups');
  },
  async listMigrationSnapshots() {
    return (await request<{ snapshots: MigrationSnapshot[] }>('/api/migration-snapshots')).snapshots;
  },
  async createBackup(passphrase?: string) {
    return (await request<{ backup: Backup }>('/api/backups', { method: 'POST', body: JSON.stringify({ encrypted: Boolean(passphrase), passphrase: passphrase || '' }) })).backup;
  },
  async scheduleRestore(file: File, passphrase?: string) {
    const response = await fetch('/api/backups/restore', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-reader-filename': encodeURIComponent(file.name), ...(passphrase ? { 'x-reader-backup-passphrase': encodeSecretHeader(passphrase) } : {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new APIError(response.status, payload.error || `恢复校验失败 (${response.status})`);
    return payload as { pendingRestore: PendingRestore; restartRequired: true };
  },
  async cancelRestore() {
    return await request<{ cancelled: boolean }>('/api/backups/restore', { method: 'DELETE' });
  }
};

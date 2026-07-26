import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import type { AIModel, AIProviderPreset, AIProvenance, AISettings, AIStatus, Article, ArticleRevision, ArticleRevisionSummary, ArticleSummary, Attachment, BackgroundWorkState, Backup, Collection, ConnectorStatus, DataHealth, DiagnosticEntry, DiagnosticsSnapshot, DuplicateGroup, Highlight, HighlightColor, ImportJob, MigrationSnapshot, NotificationSettings, PendingRestore, PortableImportPreview, RAGCitation, SemanticSearchStatus, SmartCollection, SmartCollectionRule, Source, SpotlightSettings, Stats, SummaryResult, Tag, View } from './types';

type Toast = { id: number; message: string; tone?: 'error' | 'normal' };
type ChatMessage = { role: 'user' | 'assistant'; text: string; citations?: RAGCitation[]; retrieval?: { mode: string; matchedChunks: number; citedChunks: number } };

const initialStats: Stats = { total: 0, unread: 0, favorites: 0, notes: 0, archived: 0 };
const initialBackgroundWorkState: BackgroundWorkState = { suspended: false, online: true, lowBattery: false, powerConstrained: false, restoreLocked: false, importUserPaused: false, importsPaused: false, sourceSyncPaused: false, semanticSearchPaused: false, importPauseReasons: [], sourceSyncPauseReasons: [], semanticSearchPauseReasons: [] };
const viewLabels: Record<View, string> = { inbox: '收件箱', unread: '未读', favorites: '收藏', notes: '我的笔记', archive: '归档' };
type ContentFilter = 'all' | 'articles' | 'feeds' | 'attachments' | 'notes' | 'media';
type LibraryLayout = 'list' | 'gallery';
type DesktopCommand = 'new' | 'search' | 'edit' | 'settings' | 'import-queue' | 'sources' | 'data-safety' | 'toggle-ai';
type SharedFileInfo = { token: string; name: string; size: number; mimeType: string };
type ExternalAddRequest = { kind: 'url'; url: string } | { kind: 'text'; text: string } | { kind: 'file'; token: string };
const smartTypeOptions = [
  ['article', '网页'], ['rss', 'RSS'], ['youtube', 'YouTube'], ['x', 'X'], ['weibo', '微博'],
  ['markdown', '笔记'], ['pdf', 'PDF'], ['image', '图片'], ['video', '视频'], ['attachment', '附件']
] as const;

declare global {
  interface Window {
    readerDesktop?: {
      platform: string;
      onCommand(callback: (command: DesktopCommand) => void): () => void;
      onAddRequest(callback: (request: ExternalAddRequest) => void): () => void;
      openArticleWindow(articleId: string): Promise<boolean>;
      focusLibrary(): Promise<boolean>;
      inspectSharedFile(token: string): Promise<SharedFileInfo | null>;
      importSharedFile(token: string, collectionId: string): Promise<ImportJob>;
      discardSharedFile(token: string): Promise<boolean>;
    };
  }
}

function flattenedCollections(collections: Collection[]) {
  const children = new Map<string | null, Collection[]>();
  for (const collection of collections) {
    const key = collection.parent_id || null;
    children.set(key, [...(children.get(key) || []), collection]);
  }
  const result: Array<Collection & { depth: number; path: string }> = [];
  const visit = (parentId: string | null, depth: number, parentPath: string) => {
    for (const collection of children.get(parentId) || []) {
      const path = parentPath ? `${parentPath} / ${collection.name}` : collection.name;
      result.push({ ...collection, depth, path });
      visit(collection.id, depth + 1, path);
    }
  };
  visit(null, 0, '');
  return result;
}

function emptySmartRule(): SmartCollectionRule {
  return {
    match: 'all', query: '', types: [], tags: [], tag_match: 'any', source: '', collection_id: null,
    unread: null, favorite: null, has_highlights: null, has_attachments: null, created_within_days: null
  };
}

function smartRuleHasCriteria(rule: SmartCollectionRule) {
  return Boolean(rule.query || rule.types.length || rule.tags.length || rule.source || rule.collection_id || rule.unread !== null
    || rule.favorite !== null || rule.has_highlights !== null || rule.has_attachments !== null || rule.created_within_days !== null);
}

function describeSmartRule(rule: SmartCollectionRule) {
  const parts: string[] = [];
  if (rule.query) parts.push(`包含“${rule.query}”`);
  if (rule.types.length) parts.push(rule.types.map((type) => smartTypeOptions.find(([value]) => value === type)?.[1] || type).join('、'));
  if (rule.tags.length) parts.push(`${rule.tag_match === 'all' ? '全部' : '任一'}标签：${rule.tags.join('、')}`);
  if (rule.source) parts.push(`来源含“${rule.source}”`);
  if (rule.unread !== null) parts.push(rule.unread ? '未读' : '已读');
  if (rule.favorite !== null) parts.push(rule.favorite ? '已收藏' : '未收藏');
  if (rule.has_highlights !== null) parts.push(rule.has_highlights ? '有高亮' : '无高亮');
  if (rule.has_attachments !== null) parts.push(rule.has_attachments ? '有附件' : '无附件');
  if (rule.created_within_days) parts.push(`最近 ${rule.created_within_days} 天`);
  if (rule.collection_id) parts.push('指定资料夹');
  return `${rule.match === 'any' ? '满足任一：' : '同时满足：'}${parts.join(' · ') || '尚未设置规则'}`;
}

function draggedArticleIds(event: React.DragEvent) {
  try {
    const value = JSON.parse(event.dataTransfer.getData('application/x-reader-articles'));
    return Array.isArray(value) ? value.map(String).filter(Boolean).slice(0, 500) : [];
  } catch { return []; }
}

function formatDate(value: string | null) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(date);
}

function formatMoment(value: string | null) {
  if (!value) return '尚未同步';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const delta = date.getTime() - Date.now();
  const absoluteMinutes = Math.round(Math.abs(delta) / 60_000);
  if (absoluteMinutes < 1) return delta >= 0 ? '即将同步' : '刚刚';
  if (absoluteMinutes < 60) return delta >= 0 ? `${absoluteMinutes} 分钟后` : `${absoluteMinutes} 分钟前`;
  const hours = Math.round(absoluteMinutes / 60);
  if (hours < 24) return delta >= 0 ? `${hours} 小时后` : `${hours} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function sourceInitial(article: ArticleSummary) {
  return (article.source || article.title || 'R').trim().slice(0, 1).toUpperCase();
}

function toArticleSummary({ content: _content, ...summary }: Article): ArticleSummary {
  return summary;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const highlightColors: Array<{ value: HighlightColor; label: string }> = [
  { value: 'amber', label: '琥珀' },
  { value: 'green', label: '苔绿' },
  { value: 'blue', label: '雾蓝' },
  { value: 'pink', label: '柔粉' }
];

type NativeHighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
type NativeHighlightConstructor = new (...ranges: Range[]) => unknown;
type ModifiableSelection = Selection & {
  modify?: (alter: 'move' | 'extend', direction: 'forward' | 'backward', granularity: 'character' | 'word' | 'line') => void;
};

function highlightRegistry() {
  return (CSS as unknown as { highlights?: NativeHighlightRegistry }).highlights || null;
}

function nativeHighlightConstructor() {
  return (window as unknown as { Highlight?: NativeHighlightConstructor }).Highlight || null;
}

function textRangeFromOffsets(root: HTMLElement, start: number, end: number) {
  if (start < 0 || end <= start) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cursor = 0;
  let startNode: Text | null = null;
  let startInNode = 0;
  let endNode: Text | null = null;
  let endInNode = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const next = cursor + node.data.length;
    if (!startNode && start >= cursor && start <= next) {
      startNode = node;
      startInNode = Math.min(start - cursor, node.data.length);
    }
    if (startNode && end >= cursor && end <= next) {
      endNode = node;
      endInNode = Math.min(end - cursor, node.data.length);
      break;
    }
    cursor = next;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startInNode);
  range.setEnd(endNode, endInNode);
  return range;
}

function anchoredHighlightRange(root: HTMLElement, highlight: Pick<Highlight, 'quote' | 'start_offset' | 'end_offset'>) {
  const fullText = root.textContent || '';
  let start = Number(highlight.start_offset);
  let end = Number(highlight.end_offset);
  if (fullText.slice(start, end) !== highlight.quote) {
    const candidates: number[] = [];
    let cursor = fullText.indexOf(highlight.quote);
    while (cursor >= 0) {
      candidates.push(cursor);
      cursor = fullText.indexOf(highlight.quote, cursor + Math.max(highlight.quote.length, 1));
    }
    if (!candidates.length) return null;
    start = candidates.sort((left, right) => Math.abs(left - Number(highlight.start_offset)) - Math.abs(right - Number(highlight.start_offset)))[0];
    end = start + highlight.quote.length;
  }
  return textRangeFromOffsets(root, start, end);
}

function selectionOffsets(root: HTMLElement, range: Range) {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const throughSelection = document.createRange();
  throughSelection.selectNodeContents(root);
  throughSelection.setEnd(range.endContainer, range.endOffset);
  const start = prefix.toString().length;
  const end = throughSelection.toString().length;
  const fullText = root.textContent || '';
  const rawQuote = fullText.slice(start, end);
  const leading = rawQuote.length - rawQuote.trimStart().length;
  const trailing = rawQuote.length - rawQuote.trimEnd().length;
  return { start: start + leading, end: end - trailing, quote: rawQuote.trim() };
}

function articlePreviewAttachment(article: ArticleSummary) {
  return article.attachments?.find((attachment) => attachment.mime_type.startsWith('image/') || attachment.mime_type.startsWith('video/') || attachment.mime_type === 'application/pdf') || null;
}

function offlineDescriptor(article: Article) {
  const status = typeof article.metadata?.offlineResourceStatus === 'string' ? article.metadata.offlineResourceStatus : '';
  const localized = Number(article.metadata?.localizedImageCount || 0);
  if (status === 'complete') return { status, label: '离线完整', detail: localized ? `正文和 ${localized} 张图片均保存在本机` : '正文已完整保存在本机' };
  if (status === 'partial') return { status, label: '部分离线', detail: `${localized} 张图片已保存在本机，部分资源仅保留在线链接` };
  if (status === 'text-only') return { status, label: '仅正文离线', detail: '正文已保存在本机，图片未能离线保存' };
  if (article.url) return { status: 'legacy', label: '正文在本机', detail: '正文已保存在本地资料库；旧内容未记录图片完整度' };
  return { status: 'local', label: '本地内容', detail: '这条内容及其附件存储在本机' };
}

function articleProvenance(article: Article): AIProvenance | null {
  const value = article.metadata?.aiProvenance;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<AIProvenance>;
  if ((candidate.task !== 'translate' && candidate.task !== 'compose') || !Array.isArray(candidate.sourceArticles)) return null;
  return candidate as AIProvenance;
}

function FilePickerButton({ accept, multiple = false, disabled = false, className, ariaLabel, onFiles, children }: {
  accept: string; multiple?: boolean; disabled?: boolean; className: string; ariaLabel: string;
  onFiles: (files: File[]) => void; children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const openPicker = () => {
    inputRef.current?.click();
  };
  return <>
    <input ref={inputRef} className="native-file-input" type="file" hidden accept={accept} multiple={multiple} disabled={disabled} onChange={(event) => {
      const files = [...(event.currentTarget.files || [])];
      if (files.length) onFiles(files);
      event.currentTarget.value = '';
    }}/>
    <button className={className} type="button" disabled={disabled} aria-label={ariaLabel} onClick={openPicker}>{children}</button>
  </>;
}

function TrafficLights() {
  return <div className="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div>;
}

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}

const dialogFocusableSelector = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

function DialogAccessibilityManager() {
  useLayoutEffect(() => {
    let activeDialog: HTMLElement | null = null;
    let opener: HTMLElement | null = null;
    let reconcileFrame = 0;
    let lastOutsideFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
    const modalDialogs = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
    const topDialog = () => modalDialogs().at(-1) || null;
    const focusableElements = (dialog: HTMLElement) => [...dialog.querySelectorAll<HTMLElement>(dialogFocusableSelector)].filter((element) => element.getClientRects().length > 0);
    const labelledElement = (dialog: HTMLElement) => (dialog.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map((id) => document.getElementById(id))
      .find((element): element is HTMLElement => element instanceof HTMLElement && dialog.contains(element)) || null;
    const reconcile = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      const dialog = dialogs.at(-1) || null;
      const appWindow = document.querySelector<HTMLElement>('.app-window');
      appWindow?.toggleAttribute('inert', Boolean(dialog));
      for (const candidate of dialogs) candidate.toggleAttribute('inert', candidate !== dialog);
      if (dialog === activeDialog) return;
      if (!activeDialog && dialog) {
        const current = document.activeElement;
        opener = current instanceof HTMLElement && current !== document.body && !dialog.contains(current)
          ? current
          : lastOutsideFocus;
      }
      activeDialog = dialog;
      if (dialog) {
        if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
        const label = labelledElement(dialog);
        if (label && !label.hasAttribute('tabindex')) label.tabIndex = -1;
        if (!dialog.contains(document.activeElement)) (label || focusableElements(dialog)[0] || dialog).focus();
      } else {
        const restoreTarget = opener?.isConnected ? opener : lastOutsideFocus?.isConnected ? lastOutsideFocus : null;
        if (restoreTarget && restoreTarget !== document.body) restoreTarget.focus();
        opener = null;
      }
    };
    const scheduleReconcile = () => {
      window.cancelAnimationFrame(reconcileFrame);
      reconcileFrame = window.requestAnimationFrame(reconcile);
    };
    const trackOutsideFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const dialog = topDialog();
      if (dialog && !dialog.contains(target)) {
        (focusableElements(dialog)[0] || dialog).focus();
        return;
      }
      if (!dialog && target !== document.body) lastOutsideFocus = target;
    };
    const trackOutsideActivation = (event: MouseEvent) => {
      if (topDialog()) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[href], input, select, textarea, [tabindex]') : null;
      if (target && target !== document.body) lastOutsideFocus = target;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = topDialog();
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dialog.querySelector<HTMLButtonElement>('button[aria-label^="关闭"]:not([disabled])')?.click();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements(dialog);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const observer = new MutationObserver(scheduleReconcile);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', trackOutsideFocus, true);
    document.addEventListener('click', trackOutsideActivation, true);
    document.addEventListener('keydown', handleKeyDown, true);
    reconcile();
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', trackOutsideFocus, true);
      document.removeEventListener('click', trackOutsideActivation, true);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.cancelAnimationFrame(reconcileFrame);
      document.querySelector<HTMLElement>('.app-window')?.removeAttribute('inert');
      for (const dialog of modalDialogs()) dialog.removeAttribute('inert');
    };
  }, []);
  return null;
}

function Sidebar({ view, setView, collectionId, setCollectionId, smartCollectionId, setSmartCollectionId, collections, smartCollections, tags, tagFilter, setTagFilter, stats, sources, onAdd, onSources, onCollections, onSmartCollections, onDuplicates, onDataSafety, onMoveArticles }: {
  view: View; setView: (view: View) => void; collectionId: string | null; setCollectionId: (id: string | null) => void;
  smartCollectionId: string | null; setSmartCollectionId: (id: string | null) => void;
  collections: Collection[]; smartCollections: SmartCollection[]; tags: Tag[]; tagFilter: string; setTagFilter: (tag: string) => void; stats: Stats; sources: Source[];
  onAdd: () => void; onSources: () => void; onCollections: () => void; onSmartCollections: () => void; onDuplicates: () => void; onDataSafety: () => void;
  onMoveArticles: (ids: string[], collectionId: string) => void;
}) {
  const [dropCollectionId, setDropCollectionId] = useState<string | null>(null);
  const [collapsedCollectionIds, setCollapsedCollectionIds] = useState<Set<string>>(() => new Set());
  const [focusedCollectionId, setFocusedCollectionId] = useState<string | null>(null);
  const items: Array<{ view: View; glyph: string; count: number }> = [
    { view: 'inbox', glyph: '⌁', count: stats.total }, { view: 'unread', glyph: '○', count: stats.unread },
    { view: 'favorites', glyph: '☆', count: stats.favorites }, { view: 'notes', glyph: '≡', count: stats.notes },
    { view: 'archive', glyph: '⌄', count: stats.archived }
  ];
  const collectionRows = flattenedCollections(collections);
  const visibleCollectionRows: typeof collectionRows = [];
  const siblingCounts = new Map<string, number>();
  const siblingPositions = new Map<string, number>();
  let hiddenBelowDepth: number | null = null;
  for (const collection of collectionRows) {
    const parentKey = collection.parent_id || '';
    const siblingPosition = (siblingCounts.get(parentKey) || 0) + 1;
    siblingCounts.set(parentKey, siblingPosition);
    siblingPositions.set(collection.id, siblingPosition);
    if (hiddenBelowDepth !== null) {
      if (collection.depth > hiddenBelowDepth) continue;
      hiddenBelowDepth = null;
    }
    visibleCollectionRows.push(collection);
    if (collection.child_count && collapsedCollectionIds.has(collection.id)) hiddenBelowDepth = collection.depth;
  }
  const visibleCollectionIds = new Set(visibleCollectionRows.map((collection) => collection.id));
  const treeTabStopId = focusedCollectionId && visibleCollectionIds.has(focusedCollectionId)
    ? focusedCollectionId
    : collectionId && visibleCollectionIds.has(collectionId) ? collectionId : visibleCollectionRows[0]?.id;
  const focusCollection = (id: string) => {
    setFocusedCollectionId(id);
    window.requestAnimationFrame(() => document.getElementById(`sidebar-collection-${id}`)?.focus());
  };
  const toggleCollection = (id: string) => {
    setCollapsedCollectionIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const handleCollectionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const collection = visibleCollectionRows[index];
    if (!collection) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.currentTarget.click();
      return;
    }
    let targetId: string | undefined;
    if (event.key === 'ArrowDown') targetId = visibleCollectionRows[Math.min(index + 1, visibleCollectionRows.length - 1)]?.id;
    else if (event.key === 'ArrowUp') targetId = visibleCollectionRows[Math.max(index - 1, 0)]?.id;
    else if (event.key === 'Home') targetId = visibleCollectionRows[0]?.id;
    else if (event.key === 'End') targetId = visibleCollectionRows.at(-1)?.id;
    else if (event.key === 'ArrowRight' && collection.child_count) {
      if (collapsedCollectionIds.has(collection.id)) toggleCollection(collection.id);
      else targetId = visibleCollectionRows[index + 1]?.depth === collection.depth + 1 ? visibleCollectionRows[index + 1].id : undefined;
    } else if (event.key === 'ArrowLeft') {
      if (collection.child_count && !collapsedCollectionIds.has(collection.id)) toggleCollection(collection.id);
      else targetId = collection.parent_id || undefined;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (targetId) focusCollection(targetId);
  };
  return <aside className="sidebar" aria-label="产品导航">
    <div className="brand-row"><div className="brand"><span className="brand-mark">R</span><strong>Reader</strong></div><button className="icon-button" type="button" aria-label="添加内容" onClick={onAdd}>＋</button></div>
    <nav className="nav-stack" aria-label="资料库">
      {items.map((item) => <button key={item.view} type="button" aria-current={view === item.view && !collectionId && !smartCollectionId && !tagFilter ? 'page' : undefined} className={`nav-item ${view === item.view && !collectionId && !smartCollectionId && !tagFilter ? 'active' : ''}`} onClick={() => { setView(item.view); setCollectionId(null); setSmartCollectionId(null); setTagFilter(''); }}>
        <span className="nav-glyph">{item.glyph}</span><span className="nav-label">{viewLabels[item.view]}</span><span className="nav-count">{item.count}</span>
      </button>)}
    </nav>
    <div className="section-heading"><span>资料夹</span><span className="section-heading-actions"><button type="button" className="text-icon" aria-label="检查重复内容" onClick={onDuplicates}>查重</button><button type="button" className="text-icon" aria-label="管理资料夹" onClick={onCollections}>管理</button></span></div>
    <nav className="nav-stack collection-nav" aria-label="资料夹" role="tree">
      {visibleCollectionRows.map((collection, index) => <button key={collection.id} id={`sidebar-collection-${collection.id}`} type="button" role="treeitem"
        aria-level={collection.depth + 1} aria-posinset={siblingPositions.get(collection.id)} aria-setsize={siblingCounts.get(collection.parent_id || '')}
        aria-expanded={collection.child_count ? !collapsedCollectionIds.has(collection.id) : undefined} aria-selected={collectionId === collection.id}
        tabIndex={treeTabStopId === collection.id ? 0 : -1}
        className={`nav-item collection-drop-target ${collectionId === collection.id ? 'active' : ''} ${dropCollectionId === collection.id ? 'drop-active' : ''}`}
        style={{ paddingLeft: 9 + collection.depth * 14 }}
        onFocus={() => setFocusedCollectionId(collection.id)}
        onKeyDown={(event) => handleCollectionKeyDown(event, index)}
        onClick={() => { setFocusedCollectionId(collection.id); setCollectionId(collection.id); setSmartCollectionId(null); setView('inbox'); setTagFilter(''); }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-reader-articles')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropCollectionId(collection.id); } }}
        onDragLeave={() => setDropCollectionId((current) => current === collection.id ? null : current)}
        onDrop={(event) => { event.preventDefault(); const ids = draggedArticleIds(event); setDropCollectionId(null); if (ids.length) onMoveArticles(ids, collection.id); }}>
        <span className={`nav-glyph folder ${collection.child_count ? 'has-children' : ''}`} aria-hidden="true"
          title={collection.child_count ? collapsedCollectionIds.has(collection.id) ? '展开资料夹' : '折叠资料夹' : undefined}
          onClick={collection.child_count ? (event) => { event.stopPropagation(); toggleCollection(collection.id); } : undefined}>
          {collection.child_count ? collapsedCollectionIds.has(collection.id) ? '›' : '▿' : '□'}
        </span>
        <span className="nav-label">{collection.name}</span><span className="nav-count">{collection.article_count}</span>
      </button>)}
    </nav>
    <div className="section-heading"><span>智能资料夹</span><button type="button" className="text-icon" aria-label="管理智能资料夹" onClick={onSmartCollections}>管理</button></div>
    <nav className="nav-stack smart-collection-nav" aria-label="智能资料夹">
      {smartCollections.length ? smartCollections.map((collection) => <button key={collection.id} type="button" aria-current={smartCollectionId === collection.id ? 'page' : undefined} title={describeSmartRule(collection.rule)} className={`nav-item ${smartCollectionId === collection.id ? 'active' : ''}`} onClick={() => { setSmartCollectionId(collection.id); setCollectionId(null); setView('inbox'); setTagFilter(''); }}>
        <span className="nav-glyph smart">✦</span><span className="nav-label">{collection.name}</span><span className="nav-count">{collection.article_count}</span>
      </button>) : <button type="button" className="nav-item smart-empty-link" onClick={onSmartCollections}><span className="nav-glyph smart">✦</span><span className="nav-label">创建动态规则</span></button>}
    </nav>
    {tags.length > 0 && <><div className="section-heading"><span>标签</span></div><nav className="nav-stack tag-nav" aria-label="标签">{tags.slice(0, 6).map((tag) => <button key={tag.id} type="button" aria-current={tagFilter === tag.name ? 'page' : undefined} className={`nav-item ${tagFilter === tag.name ? 'active' : ''}`} onClick={() => { setTagFilter(tag.name); setCollectionId(null); setSmartCollectionId(null); setView('inbox'); }}><span className="nav-glyph">#</span><span className="nav-label">{tag.name}</span><span className="nav-count">{tag.article_count}</span></button>)}</nav></>}
    <div className="section-heading"><span>自动订阅</span><button type="button" className="text-icon" aria-label="管理订阅" onClick={onSources}>管理</button></div>
    <button className="nav-item" type="button" onClick={onSources}><span className="nav-glyph">◌</span><span className="nav-label">内容来源</span><span className="nav-count">{sources.length}</span></button>
    <div className="sidebar-spacer"></div>
    <button className="local-status" type="button" onClick={onDataSafety}><span className="local-icon">⌂</span><span><strong>数据安全</strong><small>备份 · 校验 · 恢复</small></span></button>
  </aside>;
}

function ArticleList({ articles, total, hasMore, loadingMore, onLoadMore, selectedId, onSelect, loading, title, query, setQuery, contentFilter, setContentFilter, layout, setLayout, selectedIds, onToggleSelection, onSelectAll, onClearSelection, onBatch, onExport, onCompose, collections, tags, archiveView }: {
  articles: ArticleSummary[]; total: number; hasMore: boolean; loadingMore: boolean; onLoadMore: () => void; selectedId: string | null; onSelect: (article: ArticleSummary) => void; loading: boolean; title: string; query: string; setQuery: (value: string) => void;
  contentFilter: ContentFilter; setContentFilter: (value: ContentFilter) => void; layout: LibraryLayout; setLayout: (value: LibraryLayout) => void;
  selectedIds: Set<string>; onToggleSelection: (id: string) => void; onSelectAll: () => void; onClearSelection: () => void;
  onBatch: (patch: { collection_id?: string; is_favorite?: boolean; is_read?: boolean; archived?: boolean; tags_add?: string[]; tags_remove?: string[] }, message: string) => void;
  onExport: () => void; onCompose: () => void;
  collections: Collection[]; tags: Tag[]; archiveView: boolean;
}) {
  const [batchTag, setBatchTag] = useState('');
  const collectionRows = flattenedCollections(collections);
  const filters: Array<{ value: ContentFilter; label: string }> = [{ value: 'all', label: '全部' }, { value: 'articles', label: '网页' }, { value: 'feeds', label: '订阅' }, { value: 'attachments', label: '附件' }, { value: 'notes', label: '笔记' }, { value: 'media', label: '媒体' }];
  const submitBatchTag = () => {
    const tag = batchTag.trim();
    if (!tag) return;
    onBatch({ tags_add: [tag] }, `已为 ${selectedIds.size} 条内容添加标签`);
    setBatchTag('');
  };
  return <section className="library-pane" aria-labelledby="library-pane-title" aria-busy={loading || loadingMore}>
    <header className="library-header"><div><h1 id="library-pane-title">{title}</h1><p role="status" aria-live="polite" aria-atomic="true">{loading ? '正在读取本地资料库…' : selectedIds.size ? `已选择 ${selectedIds.size} / 已加载 ${articles.length} 条` : hasMore ? `已加载 ${articles.length} / 共 ${total} 条` : `${total} 条内容`}</p></div><div className="library-header-actions"><button className="icon-button" type="button" aria-label={selectedIds.size ? '取消选择' : '选择已加载内容'} onClick={selectedIds.size ? onClearSelection : onSelectAll}>{selectedIds.size ? '×' : '✓'}</button><button className="icon-button" type="button" aria-label={layout === 'list' ? '切换到画廊视图' : '切换到列表视图'} onClick={() => setLayout(layout === 'list' ? 'gallery' : 'list')}>{layout === 'list' ? '▦' : '☷'}</button></div></header>
    <div className="search-box"><span>⌕</span><input aria-label="搜索资料库" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全文、标题或作者"/><kbd>⌘K</kbd></div>
    <div className="library-filters" role="group" aria-label="内容类型">{filters.map((filter) => <button type="button" key={filter.value} aria-pressed={contentFilter === filter.value} className={contentFilter === filter.value ? 'active' : ''} onClick={() => { setContentFilter(filter.value); if (filter.value === 'media') setLayout('gallery'); }}>{filter.label}</button>)}</div>
    <div className={`article-list ${layout === 'gallery' ? 'gallery' : ''}`}>
      {!loading && !articles.length && <div className="empty-state"><strong>{archiveView ? '归档中没有内容' : '这里还没有内容'}</strong><span>{archiveView ? '归档后的文章会保留在本机，可随时恢复。' : '调整筛选条件，或添加网页、Markdown 和订阅。'}</span></div>}
      {articles.map((article) => {
        const preview = articlePreviewAttachment(article);
        const checked = selectedIds.has(article.id);
        const descriptionId = `article-description-${article.id}`;
        return <article key={article.id} draggable className={`article-card ${preview ? 'has-preview' : ''} ${selectedId === article.id && !selectedIds.size ? 'selected' : ''} ${checked ? 'batch-selected' : ''}`} onClick={selectedIds.size ? () => onToggleSelection(article.id) : undefined}
          onDragStart={(event) => { const ids = checked && selectedIds.size ? [...selectedIds] : [article.id]; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-reader-articles', JSON.stringify(ids)); event.dataTransfer.setData('text/plain', `${ids.length} 条 Reader 内容`); }}>
          {!selectedIds.size && <button key="open" className="article-open" type="button" aria-label={`打开 ${article.title}`} aria-describedby={descriptionId} aria-current={selectedId === article.id ? 'true' : undefined} onClick={() => onSelect(article)}></button>}
          <button key="select" className={`selection-check ${checked ? 'checked' : ''}`} type="button" aria-label={checked ? `取消选择 ${article.title}` : `选择 ${article.title}`} aria-describedby={descriptionId} aria-pressed={checked} onClick={(event) => { event.stopPropagation(); onToggleSelection(article.id); }}>{checked ? '✓' : ''}</button>
          <span id={descriptionId} hidden>{article.is_read ? '已读' : '未读'}{article.is_favorite ? '，已收藏' : ''}。来源：{article.source || '本地内容'}。日期：{formatDate(article.published_at || article.created_at)}。类型：{article.type}{article.collection_name ? `。资料夹：${article.collection_name}` : ''}{article.tags.length ? `。标签：${article.tags.slice(0, 3).join('、')}` : ''}{article.excerpt ? `。摘要：${article.excerpt.slice(0, 180)}` : ''}</span>
          <span className="source-mark" data-kind={article.type} aria-hidden="true">{sourceInitial(article)}</span>
          <span className="card-content" aria-hidden="true"><span className="card-meta"><strong>{article.source || '本地内容'}</strong><span>·</span><span>{formatDate(article.published_at || article.created_at)}</span>{!article.is_read && <i></i>}</span>
            <span className="card-title">{article.title}</span><span className="card-excerpt">{article.excerpt}</span>
            <span className="card-footer"><span className="chip">{article.type}</span>{article.collection_name && <span className="chip">{article.collection_name}</span>}{article.tags.slice(0, 2).map((tag) => <span className="chip tag-chip" key={tag}>#{tag}</span>)}{article.is_favorite && <span className="favorite">★</span>}</span>
          </span>
          {preview && <span className="card-preview" aria-hidden="true" data-kind={preview.mime_type === 'application/pdf' ? 'pdf' : preview.mime_type.split('/')[0]}>{preview.mime_type.startsWith('video/') ? <video src={preview.url} muted playsInline preload="metadata" onLoadedData={(event) => { if (event.currentTarget.duration > 0.02) event.currentTarget.currentTime = 0.01; }}></video> : <img src={preview.thumbnail_url || preview.url} alt="" loading="lazy"/>}<i>{preview.mime_type === 'application/pdf' ? 'PDF' : preview.mime_type.startsWith('video/') ? 'VIDEO' : ''}</i></span>}
        </article>;
      })}
      {hasMore && <div className="load-more-row"><button className="button" type="button" disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? '正在加载…' : '加载更多'}</button><span>还有 {(total - articles.length).toLocaleString()} 条内容</span></div>}
    </div>
    {selectedIds.size > 0 && <div className="batch-toolbar" aria-label="批量整理"><div className="batch-count"><strong>{selectedIds.size}</strong><span>条已选</span></div><button type="button" className="button primary" aria-label="使用已选内容创作" onClick={onCompose}>✦ 创作</button><select aria-label="批量移动到资料夹" defaultValue="" onChange={(event) => { if (event.target.value) onBatch({ collection_id: event.target.value }, `已移动 ${selectedIds.size} 条内容`); event.currentTarget.value = ''; }}><option value="" disabled>移动到…</option>{collectionRows.map((collection) => <option key={collection.id} value={collection.id}>{'— '.repeat(collection.depth)}{collection.name}</option>)}</select><button type="button" className="button" onClick={() => onBatch({ is_favorite: true }, `已收藏 ${selectedIds.size} 条内容`)}>收藏</button><button type="button" className="button" onClick={() => onBatch({ is_read: true }, `已标记 ${selectedIds.size} 条为已读`)}>已读</button><button type="button" className="button" aria-label="导出已选内容" onClick={onExport}>导出</button><span className="batch-tag"><input aria-label="批量添加标签" value={batchTag} onChange={(event) => setBatchTag(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submitBatchTag()} placeholder="＋ 标签"/><button type="button" onClick={submitBatchTag}>添加</button></span>{tags.length > 0 && <select aria-label="批量移除标签" defaultValue="" onChange={(event) => { if (event.target.value) onBatch({ tags_remove: [event.target.value] }, `已移除标签 ${event.target.value}`); event.currentTarget.value = ''; }}><option value="" disabled>移除标签…</option>{tags.map((tag) => <option key={tag.id} value={tag.name}>{tag.name}</option>)}</select>}<button type="button" className={`button ${archiveView ? '' : 'danger'}`} onClick={() => onBatch({ archived: !archiveView }, archiveView ? `已恢复 ${selectedIds.size} 条内容` : `已归档 ${selectedIds.size} 条内容`)}>{archiveView ? '恢复' : '归档'}</button></div>}
  </section>;
}

function ReaderPane({ article, loadingTitle, collections, focusedCitation, onDismissCitation, onPatch, onAddTags, onRemoveTags, onToggleAI, onEdit, onHistory, onOpenSource, onOpenWindow, onFocusLibrary, onToggleTheme, readOnly = false, notify }: {
  article: Article | null; loadingTitle?: string; collections: Collection[]; focusedCitation: RAGCitation | null; onDismissCitation: () => void; onPatch: (patch: Partial<Article>) => Promise<void>; onAddTags: (tags: string[]) => Promise<void>; onRemoveTags: (tags: string[]) => Promise<void>; onToggleAI: () => void; onEdit: () => void; onHistory: () => void; onOpenSource: (id: string) => void; onOpenWindow?: () => void; onFocusLibrary?: () => void; onToggleTheme?: () => void; readOnly?: boolean; notify: (message: string, tone?: Toast['tone']) => void;
}) {
  const progressTimer = useRef<number | undefined>(undefined);
  const articleBodyRef = useRef<HTMLDivElement>(null);
  const annotationsRef = useRef<HTMLElement>(null);
  const selectionOpenerRef = useRef<HTMLElement | null>(null);
  const keyboardSelectionButtonRef = useRef<HTMLButtonElement>(null);
  const [tagInput, setTagInput] = useState('');
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [highlightBusy, setHighlightBusy] = useState(false);
  const [highlightAnnouncement, setHighlightAnnouncement] = useState('');
  const [keyboardSelectionMode, setKeyboardSelectionMode] = useState(false);
  const [keyboardSelectionStatus, setKeyboardSelectionStatus] = useState('');
  const [keyboardSelectionCandidate, setKeyboardSelectionCandidate] = useState<{
    quote: string; start: number; end: number;
  } | null>(null);
  const [selectionDraft, setSelectionDraft] = useState<{
    quote: string; startOffset: number; endOffset: number; color: HighlightColor; note: string; top: number; left: number;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHighlights([]);
    setSelectionDraft(null);
    setKeyboardSelectionMode(false);
    setKeyboardSelectionStatus('');
    setKeyboardSelectionCandidate(null);
    if (!article) return;
    void api.listHighlights(article.id)
      .then((next) => { if (!cancelled) setHighlights(next); })
      .catch((error) => { if (!cancelled) notify(error instanceof Error ? error.message : '高亮加载失败', 'error'); });
    return () => { cancelled = true; };
  }, [article?.id, notify]);
  useEffect(() => {
    const registry = highlightRegistry();
    const HighlightClass = nativeHighlightConstructor();
    const root = articleBodyRef.current;
    if (!registry || !HighlightClass || !root) return;
    const names = highlightColors.map((color) => `reader-${color.value}`);
    for (const name of names) registry.delete(name);
    const frame = window.requestAnimationFrame(() => {
      for (const color of highlightColors) {
        const ranges = highlights
          .filter((highlight) => highlight.color === color.value)
          .map((highlight) => anchoredHighlightRange(root, highlight))
          .filter((range): range is Range => Boolean(range));
        if (ranges.length) registry.set(`reader-${color.value}`, new HighlightClass(...ranges));
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      for (const name of names) registry.delete(name);
      registry.delete('reader-focus');
    };
  }, [article?.id, article?.content, highlights]);
  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!article || readOnly) return;
    const target = event.currentTarget;
    const range = Math.max(target.scrollHeight - target.clientHeight, 1);
    const progress = Math.min(1, Math.max(0, target.scrollTop / range));
    window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => void onPatch({ reading_progress: Number(progress.toFixed(3)), is_read: progress > 0.75 || article.is_read }), 500);
  };
  const captureSelection = () => {
    if (readOnly) return false;
    const root = articleBodyRef.current;
    const selection = window.getSelection();
    if (!root) return false;
    const range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null;
    const selectedOffsets = range ? selectionOffsets(root, range) : null;
    const offsets = selectedOffsets?.quote ? selectedOffsets : keyboardSelectionCandidate;
    if (!offsets || !offsets.quote || offsets.quote.length > 5000 || offsets.end <= offsets.start) {
      setSelectionDraft(null);
      return false;
    }
    const rect = range?.getBoundingClientRect() || root.getBoundingClientRect();
    const activeElement = document.activeElement;
    selectionOpenerRef.current = activeElement instanceof HTMLElement && activeElement !== document.body ? activeElement : root;
    setSelectionDraft({
      quote: offsets.quote,
      startOffset: offsets.start,
      endOffset: offsets.end,
      color: 'amber',
      note: '',
      top: Math.min(window.innerHeight - 185, Math.max(12, rect.bottom + 9)),
      left: Math.min(window.innerWidth - 310, Math.max(12, rect.left + rect.width / 2 - 145))
    });
    return true;
  };
  const updateKeyboardSelection = () => {
    const root = articleBodyRef.current;
    const selection = window.getSelection();
    const range = root && selection?.rangeCount ? selection.getRangeAt(0) : null;
    const offsets = root && range ? selectionOffsets(root, range) : null;
    const registry = highlightRegistry();
    registry?.delete('reader-keyboard-caret');
    if (!offsets) {
      setKeyboardSelectionCandidate(null);
      setKeyboardSelectionStatus('用方向键移动光标，按住 Shift 并配合方向键选择文字。');
      return;
    }
    if (!offsets.quote || offsets.end <= offsets.start) {
      setKeyboardSelectionCandidate(null);
      const fullText = root?.textContent || '';
      if (fullText && registry) {
        const markerStart = Math.min(offsets.start, fullText.length - 1);
        const marker = textRangeFromOffsets(root!, markerStart, markerStart + 1);
        const HighlightClass = nativeHighlightConstructor();
        if (marker && HighlightClass) registry.set('reader-keyboard-caret', new HighlightClass(marker));
      }
      setKeyboardSelectionStatus(`光标位置：${(fullText.slice(offsets.start, offsets.start + 40) || '正文末尾').trim()}`);
      return;
    }
    setKeyboardSelectionCandidate(offsets);
    setKeyboardSelectionStatus(`已选择 ${offsets.quote.length} 个字符：${offsets.quote.slice(0, 80)}`);
  };
  const startKeyboardSelection = () => {
    setSelectionDraft(null);
    setKeyboardSelectionCandidate(null);
    setKeyboardSelectionStatus('用方向键移动光标，按住 Shift 并配合方向键选择文字。');
    setKeyboardSelectionMode(true);
    window.requestAnimationFrame(() => {
      const root = articleBodyRef.current;
      if (!root) return;
      root.focus();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let first = walker.nextNode() as Text | null;
      while (first && !first.data.length) first = walker.nextNode() as Text | null;
      if (!first) return;
      const range = document.createRange();
      range.setStart(first, 0);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      updateKeyboardSelection();
    });
  };
  const exitKeyboardSelection = () => {
    setKeyboardSelectionMode(false);
    setKeyboardSelectionCandidate(null);
    setKeyboardSelectionStatus('');
    highlightRegistry()?.delete('reader-keyboard-caret');
    window.getSelection()?.removeAllRanges();
    window.requestAnimationFrame(() => keyboardSelectionButtonRef.current?.focus());
  };
  const handleArticleBodyKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!keyboardSelectionMode) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      exitKeyboardSelection();
      return;
    }
    if (
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      && !event.metaKey
      && !(event.ctrlKey && event.altKey)
    ) {
      const selection = window.getSelection() as ModifiableSelection | null;
      if (!selection?.modify) {
        setKeyboardSelectionStatus('当前系统无法启动键盘选区，请继续使用鼠标或触控板。');
        return;
      }
      event.preventDefault();
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 'forward' : 'backward';
      const granularity = event.altKey ? 'word' : event.key === 'ArrowUp' || event.key === 'ArrowDown' ? 'line' : 'character';
      selection.modify(event.shiftKey ? 'extend' : 'move', direction, granularity);
      updateKeyboardSelection();
      return;
    }
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    if (!captureSelection()) setKeyboardSelectionStatus('请先按住 Shift 并配合方向键选择要高亮的文字。');
  };
  const dismissSelection = useCallback(() => {
    setSelectionDraft(null);
    window.getSelection()?.removeAllRanges();
    const target = keyboardSelectionMode
      ? keyboardSelectionButtonRef.current
      : selectionOpenerRef.current?.isConnected ? selectionOpenerRef.current : articleBodyRef.current;
    if (keyboardSelectionMode) {
      setKeyboardSelectionMode(false);
      setKeyboardSelectionCandidate(null);
      setKeyboardSelectionStatus('');
      highlightRegistry()?.delete('reader-keyboard-caret');
    }
    window.requestAnimationFrame(() => target?.focus());
  }, [keyboardSelectionMode]);
  useEffect(() => {
    if (!selectionDraft) return;
    const handleSelectionEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || highlightBusy) return;
      event.preventDefault();
      event.stopPropagation();
      dismissSelection();
    };
    document.addEventListener('keydown', handleSelectionEscape, true);
    return () => document.removeEventListener('keydown', handleSelectionEscape, true);
  }, [selectionDraft, highlightBusy, dismissSelection]);
  const saveSelection = async () => {
    if (!article || !selectionDraft || highlightBusy) return;
    setHighlightBusy(true);
    try {
      const created = await api.createHighlight(article.id, selectionDraft);
      setHighlights((current) => [...current, created].sort((left, right) => left.start_offset - right.start_offset));
      dismissSelection();
      notify(created.note ? '高亮和批注已保存在本机' : '高亮已保存在本机');
    } catch (error) { notify(error instanceof Error ? error.message : '高亮保存失败', 'error'); }
    finally { setHighlightBusy(false); }
  };
  const saveHighlightPatch = async (id: string, patch: { note?: string; color?: HighlightColor }, announcement?: string) => {
    try {
      const updated = await api.updateHighlight(id, patch);
      setHighlights((current) => current.map((highlight) => highlight.id === id ? { ...highlight, ...patch, updated_at: updated.updated_at } : highlight));
      if (announcement) setHighlightAnnouncement(announcement);
    } catch (error) { notify(error instanceof Error ? error.message : '批注保存失败', 'error'); }
  };
  const deleteHighlight = async (highlight: Highlight) => {
    if (!window.confirm('删除这条高亮和批注？')) return;
    try {
      await api.deleteHighlight(highlight.id);
      setHighlights((current) => current.filter((item) => item.id !== highlight.id));
      notify('高亮已删除');
    } catch (error) { notify(error instanceof Error ? error.message : '高亮删除失败', 'error'); }
  };
  const focusHighlight = (highlight: Highlight) => {
    const root = articleBodyRef.current;
    const range = root ? anchoredHighlightRange(root, highlight) : null;
    if (!range) {
      notify('原文已发生变化，暂时无法定位这条高亮', 'error');
      return;
    }
    const target = range.startContainer.parentElement;
    target?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'center' });
    const registry = highlightRegistry();
    const HighlightClass = nativeHighlightConstructor();
    if (registry && HighlightClass) {
      registry.set('reader-focus', new HighlightClass(range));
      window.setTimeout(() => registry.delete('reader-focus'), 1600);
    }
    const index = highlights.findIndex((item) => item.id === highlight.id);
    setHighlightAnnouncement(`已定位高亮 ${index + 1}：${highlight.quote.slice(0, 80)}`);
  };
  const focusAnnotations = () => {
    annotationsRef.current?.scrollIntoView({ behavior: preferredScrollBehavior(), block: 'start' });
    window.requestAnimationFrame(() => annotationsRef.current?.focus({ preventScroll: true }));
  };
  if (!article) return <main className="reader-pane empty-reader" aria-label="阅读器" aria-busy={Boolean(loadingTitle)}><div><strong>{loadingTitle ? `正在载入“${loadingTitle}”` : readOnly ? '无法载入这篇内容' : '选择一篇内容开始阅读'}</strong><span>{loadingTitle ? '正文从本地资料库读取，完成后会自动显示。' : readOnly ? '内容可能已从资料库移除。' : '阅读进度、收藏和批注都会保存在本地。'}</span>{readOnly && onFocusLibrary && <button className="button" type="button" onClick={onFocusLibrary}>返回资料库</button>}</div></main>;
  const embeddedIds = new Set(Array.isArray(article.metadata?.embeddedAttachmentIds) ? article.metadata.embeddedAttachmentIds.filter((id): id is string => typeof id === 'string') : []);
  for (const attachment of article.attachments || []) if (article.content.includes(attachment.url) || (attachment.thumbnail_url && article.content.includes(attachment.thumbnail_url))) embeddedIds.add(attachment.id);
  const leadAttachmentId = typeof article.metadata?.leadAttachmentId === 'string' ? article.metadata.leadAttachmentId : '';
  const leadAttachment = embeddedIds.has(leadAttachmentId) ? undefined : article.attachments?.find((attachment) => attachment.id === leadAttachmentId);
  const standaloneAttachments = article.attachments?.filter((attachment) => attachment.id !== leadAttachmentId && !embeddedIds.has(attachment.id)) || [];
  const offline = offlineDescriptor(article);
  const provenance = articleProvenance(article);
  const collectionRows = flattenedCollections(collections);
  const submitTag = async () => {
    const tag = tagInput.trim();
    if (!tag) return;
    await onAddTags([tag]);
    setTagInput('');
  };
  return <main className="reader-pane" aria-label={`阅读器：${article.title}`}>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{highlightAnnouncement}</span>
    <div className="reader-toolbar">
      {readOnly ? <span className="focused-reader-label"><i aria-hidden="true">◎</i><span><strong>专注阅读</strong><small>独立只读窗口</small></span></span> : <>
        <button className="icon-button" type="button" aria-label={article.is_favorite ? '取消收藏' : '收藏'} onClick={() => void onPatch({ is_favorite: !article.is_favorite })}>{article.is_favorite ? '★' : '☆'}</button>
        <select aria-label="移动到资料夹" value={article.collection_id || ''} onChange={(event) => void onPatch({ collection_id: event.target.value })}>{collectionRows.map((collection) => <option key={collection.id} value={collection.id}>{'— '.repeat(collection.depth)}{collection.name}</option>)}</select>
      </>}
      <div className="toolbar-spacer"></div>
      {!readOnly && <button className={`button ${article.archived ? '' : 'quiet-danger'}`} type="button" onClick={() => void onPatch({ archived: !article.archived })}>{article.archived ? '恢复' : '归档'}</button>}
      <button className="button" type="button" onClick={focusAnnotations}>高亮 <span className="button-count">{highlights.length}</span></button>
      {!readOnly && <><button ref={keyboardSelectionButtonRef} className="button" type="button" aria-pressed={keyboardSelectionMode} onClick={keyboardSelectionMode ? exitKeyboardSelection : startKeyboardSelection}>键盘选取</button>
        <button className="button" type="button" aria-label="查看版本历史" onClick={onHistory}>历史 <span className="button-count">{article.revision_count || 1}</span></button>
        <button className="button" type="button" aria-label="编辑文章" onClick={onEdit}>编辑 <kbd>⌘E</kbd></button>
        {onOpenWindow && <button className="button" type="button" onClick={onOpenWindow}>新窗口</button>}
      </>}
      {article.url && <a className="button" href={article.url} target="_blank" rel="noreferrer">原文 ↗</a>}
      {readOnly ? <><button className="button" type="button" onClick={onToggleTheme}>明暗</button><button className="button primary" type="button" onClick={onFocusLibrary}>返回资料库</button></> : <button className="button primary" type="button" onClick={onToggleAI}>✦ 文章助手</button>}
    </div>
    <div className="reader-scroll" onScroll={onScroll}>
      <article className="document" lang={article.language}>
        <div className="document-topline"><div className="document-kicker">{article.collection_name || '本地资料库'} · {article.type}</div><span className="offline-status" data-status={offline.status} title={offline.detail}><i></i>{offline.label}</span></div>
        {provenance && <section className="provenance-card" aria-label="AI 内容来源"><span className="provenance-mark">✦ AI 草稿</span><div><strong>{provenance.task === 'translate' ? '从原文生成的翻译' : `基于 ${provenance.sourceArticles.length} 篇资料二次创作`}</strong><small>{provenance.provider === 'local-structured' ? '完全在本机整理' : `由已配置 AI 服务生成${provenance.model ? ` · ${provenance.model}` : ''}`} · 可继续编辑</small><div className="provenance-sources">{provenance.sourceArticles.map((source) => <button type="button" key={source.id} onClick={() => onOpenSource(source.id)} title={source.source || source.title}>{source.title}</button>)}</div></div></section>}
        {focusedCitation?.articleId === article.id && <section className="citation-focus" aria-label="引用原文片段"><header><span><small>引用定位 · 段落 {focusedCitation.chunkIndex + 1}</small><strong>{focusedCitation.heading || article.title}</strong></span><button type="button" className="icon-button" aria-label="关闭引用定位" onClick={onDismissCitation}>×</button></header><blockquote>{focusedCitation.quote}</blockquote><footer>这段文字来自本地索引；可继续向下阅读完整上下文。</footer></section>}
        <h2>{article.title}</h2><p className="dek">{article.excerpt}</p>
        <div className="byline"><span className="avatar">{(article.author || article.source || 'R').slice(0, 1)}</span><span><strong>{article.author || article.source || '未知作者'}</strong><small>{article.source} · {article.read_time_minutes} 分钟</small></span></div>
        <div className="tag-row">{article.tags.map((tag) => readOnly ? <span className="chip" key={tag}>{tag}</span> : <span className="chip removable-tag" key={tag}>{tag}<button type="button" aria-label={`移除标签 ${tag}`} onClick={() => void onRemoveTags([tag])}>×</button></span>)}{!readOnly && <span className="tag-input-wrap"><input aria-label="添加标签" value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void submitTag()} placeholder="＋ 标签"/></span>}</div>
        {leadAttachment && <figure className="lead-image"><img src={leadAttachment.url} alt=""/><figcaption>{formatBytes(leadAttachment.byte_size)} · 本地主图</figcaption></figure>}
        {standaloneAttachments.length ? <div className="attachment-stack">{standaloneAttachments.map((attachment) => <section className="attachment-viewer" key={attachment.id}>
          <header><span><strong>{attachment.file_name}</strong><small>{formatBytes(attachment.byte_size)} · 已保存在本机</small></span><a className="button" href={attachment.url} download={attachment.file_name}>导出</a></header>
          {attachment.mime_type.startsWith('image/') && <img src={attachment.url} alt={attachment.file_name}/>}
          {attachment.mime_type.startsWith('video/') && <video controls preload="metadata" src={attachment.url}></video>}
          {attachment.mime_type === 'application/pdf' && <object data={attachment.url} type="application/pdf" aria-label={attachment.file_name}><a href={attachment.url}>打开 PDF</a></object>}
        </section>)}</div> : null}
        {!readOnly && <p id="article-selection-help" className="sr-only">鼠标或触控板可直接选择文字。纯键盘使用时，请先按工具栏的“键盘选取”，再用方向键移动光标，按住 Shift 并配合方向键选择；Option 加方向键可逐词移动。按 Enter 创建高亮，按 Escape 退出。</p>}
        {!readOnly && keyboardSelectionMode && <div className="keyboard-selection-bar"><span><strong>键盘选取已开启</strong><small role="status" aria-live="polite" aria-atomic="true">{keyboardSelectionStatus}</small></span><button className="button primary" type="button" disabled={!keyboardSelectionCandidate} onClick={() => captureSelection()}>创建高亮</button><button className="button" type="button" onClick={exitKeyboardSelection}>退出</button></div>}
        <div
          className={`article-body ${keyboardSelectionMode ? 'keyboard-selecting' : ''}`}
          ref={articleBodyRef}
          role={keyboardSelectionMode ? 'document' : 'region'}
          tabIndex={0}
          aria-label={readOnly ? '文章正文，只读' : keyboardSelectionMode ? '文章正文键盘选取区，只读' : '文章正文，可选择文字创建高亮'}
          aria-describedby={readOnly ? undefined : 'article-selection-help'}
          onMouseUp={readOnly ? undefined : keyboardSelectionMode ? updateKeyboardSelection : captureSelection}
          onKeyDown={readOnly ? undefined : handleArticleBodyKeyDown}
          onKeyUp={readOnly ? undefined : (event) => { if (keyboardSelectionMode && event.key !== 'Enter' && event.key !== 'Escape') updateKeyboardSelection(); }}
        ><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ node: _node, ...props }) => <span className="inline-figure" role="group"><img {...props} loading="lazy"/><span className="image-caption">{props.alt || '正文图片'} · 已保存在本机</span></span> }}>{article.content}</ReactMarkdown></div>
        <section className="annotations" ref={annotationsRef} tabIndex={-1} aria-label="高亮与批注">
          <header><span><small>LOCAL ANNOTATIONS</small><strong>高亮与批注</strong></span><em aria-live="polite">{highlights.length ? `${highlights.length} 条 · 全部保存在本机` : readOnly ? '返回资料库即可创建' : '选中正文即可开始'}</em></header>
          {!highlights.length ? <div className="annotations-empty"><span>✦</span><div><strong>{readOnly ? '这篇内容还没有高亮' : '让收藏变成自己的理解'}</strong><p>{readOnly ? '返回资料库即可创建高亮和批注。' : '在上方正文中选中一句话，选择颜色并写下批注。高亮会随资料库备份迁移。'}</p></div></div> :
            <div className="annotation-list">{highlights.map((highlight, index) => <article key={highlight.id} className="annotation-card" data-color={highlight.color}>
              <button type="button" className="annotation-index" onClick={() => focusHighlight(highlight)} aria-label={`定位高亮 ${index + 1}`}>{String(index + 1).padStart(2, '0')}</button>
              <div className="annotation-copy">
                <button type="button" className="annotation-quote" onClick={() => focusHighlight(highlight)}><q>{highlight.quote}</q></button>
                {readOnly ? highlight.note && <p className="annotation-readonly-note">{highlight.note}</p> : <textarea aria-label={`高亮 ${index + 1} 的批注`} value={highlight.note} onChange={(event) => setHighlights((current) => current.map((item) => item.id === highlight.id ? { ...item, note: event.target.value } : item))} onBlur={(event) => void saveHighlightPatch(highlight.id, { note: event.target.value }, `高亮 ${index + 1} 的批注已保存`)} placeholder="写下你的理解…"/>}
                <footer>{!readOnly && <span className="annotation-colors" role="group" aria-label={`高亮 ${index + 1} 的颜色`}>{highlightColors.map((color) => <button type="button" key={color.value} className={highlight.color === color.value ? 'active' : ''} data-color={color.value} aria-label={`改为${color.label}`} aria-pressed={highlight.color === color.value} onClick={() => void saveHighlightPatch(highlight.id, { color: color.value }, `高亮 ${index + 1} 已改为${color.label}`)}></button>)}</span>}<small>{formatDate(highlight.created_at)}</small>{!readOnly && <button type="button" className="annotation-delete" aria-label={`删除高亮 ${index + 1}`} onClick={() => void deleteHighlight(highlight)}>删除</button>}</footer>
              </div>
            </article>)}</div>}
        </section>
        <div className="document-end"><span>阅读完毕</span>{!readOnly && <button type="button" className="button" onClick={() => void onPatch({ is_read: true, reading_progress: 1 })}>标记为已读</button>}</div>
      </article>
    </div>
    {!readOnly && selectionDraft && <aside className="selection-popover" style={{ top: selectionDraft.top, left: selectionDraft.left }} role="dialog" aria-labelledby="selection-popover-title" aria-describedby="selection-popover-quote">
      <header><span id="selection-popover-title">保存高亮</span><button type="button" aria-label="取消高亮" disabled={highlightBusy} onClick={dismissSelection}>×</button></header>
      <q id="selection-popover-quote">{selectionDraft.quote}</q>
      <div className="selection-colors" role="group" aria-label="高亮颜色">{highlightColors.map((color) => <button type="button" key={color.value} data-color={color.value} className={selectionDraft.color === color.value ? 'active' : ''} aria-label={color.label} aria-pressed={selectionDraft.color === color.value} onClick={() => setSelectionDraft((current) => current ? { ...current, color: color.value } : current)}></button>)}</div>
      <textarea autoFocus value={selectionDraft.note} onChange={(event) => setSelectionDraft((current) => current ? { ...current, note: event.target.value } : current)} placeholder="写一句批注（可选）" aria-label="高亮批注"/>
      <button className="button primary" type="button" disabled={highlightBusy} onClick={() => void saveSelection()}>{highlightBusy ? '保存中…' : '保存到本机'}</button>
    </aside>}
  </main>;
}

function AIPanel({ article, onClose, onArticleUpdated, onDerivedCreated, onOpenCitation, configurationVersion, notify }: { article: Article | null; onClose: () => void; onArticleUpdated: (article: Article) => void; onDerivedCreated: (article: Article, message: string) => void; onOpenCitation: (citation: RAGCitation) => void; configurationVersion: number; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [tab, setTab] = useState<'summary' | 'chat' | 'translate'>('summary');
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [chatScope, setChatScope] = useState<'article' | 'library'>('article');
  const [targetLanguage, setTargetLanguage] = useState('en');
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSummary(null); setMessages([]); setChatScope('article'); setTab('summary'); }, [article?.id]);
  useEffect(() => { void api.aiStatus().then(setStatus).catch(() => setStatus(null)); }, [configurationVersion]);
  if (!article) return null;
  const generate = async () => {
    setBusy(true);
    try { const result = await api.summarize(article.id); setSummary(result); onArticleUpdated({ ...article, summary: result.summary }); }
    catch (error) { notify(error instanceof Error ? error.message : '摘要生成失败', 'error'); }
    finally { setBusy(false); }
  };
  const send = async () => {
    const prompt = input.trim(); if (!prompt || busy) return;
    setInput(''); setTab('chat'); setMessages((current) => [...current, { role: 'user', text: prompt }]); setBusy(true);
    try { const result = await api.chat(article.id, prompt, chatScope); setMessages((current) => [...current, { role: 'assistant', text: result.answer, citations: result.citations, retrieval: result.retrieval }]); }
    catch (error) { notify(error instanceof Error ? error.message : '对话失败', 'error'); }
    finally { setBusy(false); }
  };
  const translate = async () => {
    if (busy || status?.remoteConfigured === false) return;
    setBusy(true);
    try {
      const result = await api.translateArticle(article.id, targetLanguage, article.collection_id);
      onDerivedCreated(result.article, '译文已作为可编辑文章保存到本机');
    } catch (error) { notify(error instanceof Error ? error.message : '翻译失败', 'error'); }
    finally { setBusy(false); }
  };
  const visibleSummary = summary?.summary || article.summary;
  return <aside className="ai-panel" aria-label="AI 文章助手">
    <header><div className="ai-title"><span>✦</span><strong>文章助手</strong></div><button className="icon-button" aria-label="关闭文章助手" type="button" onClick={onClose}>×</button></header>
    <div className="ai-tabs" role="group" aria-label="文章助手功能"><button type="button" aria-pressed={tab === 'summary'} className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>摘要</button><button type="button" aria-pressed={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>对话</button><button type="button" aria-pressed={tab === 'translate'} className={tab === 'translate' ? 'active' : ''} onClick={() => setTab('translate')}>翻译</button></div>
    <div className="ai-content">
      {tab === 'summary' && <>{visibleSummary ? <><span className="eyebrow">核心摘要</span><p className="summary-text">{visibleSummary}</p>{summary?.points?.length ? <><span className="eyebrow">关键观点</span><ol className="point-list">{summary.points.map((point) => <li key={point}>{point}</li>)}</ol></> : null}</> : <div className="ai-empty"><strong>把内容压缩成可行动的理解</strong><span>默认使用完全本地的提取式摘要；配置 AI 服务后可获得更深层分析。</span><button type="button" className="button primary" onClick={() => void generate()} disabled={busy}>{busy ? '正在分析…' : '生成本地摘要'}</button></div>}</>}
      {tab === 'chat' && <div className="rag-chat"><div className="rag-scope" role="group" aria-label="检索范围"><button type="button" aria-pressed={chatScope === 'article'} className={chatScope === 'article' ? 'active' : ''} onClick={() => setChatScope('article')}>当前文章</button><button type="button" aria-pressed={chatScope === 'library'} className={chatScope === 'library' ? 'active' : ''} onClick={() => setChatScope('library')}>整个资料库</button></div><div className={`rag-boundary ${status?.remoteConfigured ? 'remote' : 'local'}`}><i></i><span>{status?.index?.semantic?.enabled ? status.remoteConfigured ? '先在本机混合检索，再仅发送命中的片段' : '全文与向量混合检索完全在本机完成' : status?.remoteConfigured ? '先在本机全文检索，再仅发送命中的片段' : '全文检索与提取式回答完全在本机完成'}{status?.index ? ` · ${status.index.chunkCount} 个片段` : ''}</span></div><div className="messages">{messages.length === 0 && <div className="message assistant">我会先检索{chatScope === 'article' ? '当前文章' : '本地资料库'}，并把每条结论连回原文片段。</div>}{messages.map((message, index) => <div className={`message-group ${message.role}`} key={index}><div className={`message ${message.role}`}>{message.text}</div>{message.citations?.length ? <div className="rag-citations" aria-label="回答引用">{message.citations.map((citation, citationIndex) => <button type="button" key={citation.id} onClick={() => onOpenCitation(citation)}><span className="citation-number">{citationIndex + 1}</span><span><strong>{citation.heading || citation.articleTitle}</strong><small>{citation.articleTitle}{citation.articleSource ? ` · ${citation.articleSource}` : ''}</small><q>{citation.quote.slice(0, 145)}{citation.quote.length > 145 ? '…' : ''}</q></span></button>)}</div> : null}{message.retrieval && message.role === 'assistant' ? <small className="rag-trace">{message.retrieval.mode.includes('hybrid') ? '本地混合检索' : message.retrieval.mode.includes('fallback') ? '本地全文回退' : '本地全文检索'} {message.retrieval.matchedChunks} 段 · 引用 {message.retrieval.citedChunks} 段</small> : null}</div>)}{busy && <div className="message assistant pending">正在本机检索相关片段…</div>}</div></div>}
      {tab === 'translate' && <div className="translation-panel"><span className="eyebrow">生成可编辑译文</span><label><span>目标语言</span><select aria-label="翻译目标语言" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="es">Español</option><option value="fr">Français</option><option value="de">Deutsch</option></select></label><div className={`ai-privacy ${status?.remoteConfigured ? 'remote' : 'local'}`}><i></i><span><strong>{status?.remoteConfigured ? '仅在点击后发送当前文章' : '尚未配置 AI 服务'}</strong><small>{status?.remoteConfigured ? '译文及来源关系会保存到本地资料库。' : 'Reader 不会用词语替换冒充翻译；配置服务后才可使用。'}</small></span></div><button type="button" className="button primary translate-action" disabled={busy || !status?.remoteConfigured} onClick={() => void translate()}>{busy ? '正在翻译…' : '生成译文并保存'}</button></div>}
    </div>
    {tab === 'chat' && <div className="ai-composer"><textarea aria-label="就资料提问" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={chatScope === 'article' ? '就这篇内容提问…' : '检索整个本地资料库…'}></textarea><button className="icon-button" type="button" aria-label="发送问题" onClick={() => void send()}>↑</button></div>}
  </aside>;
}

function ComposeModal({ articles, collections, busy, onClose, onCreate }: { articles: ArticleSummary[]; collections: Collection[]; busy: boolean; onClose: () => void; onCreate: (options: { prompt: string; format: string; language: string; collectionId: string }) => void }) {
  const [prompt, setPrompt] = useState('提炼共同主题、关键分歧和可执行结论，只使用来源中明确出现的信息。');
  const [format, setFormat] = useState('brief');
  const [language, setLanguage] = useState('zh-CN');
  const [collectionId, setCollectionId] = useState('notes');
  const [status, setStatus] = useState<AIStatus | null>(null);
  useEffect(() => { void api.aiStatus().then(setStatus).catch(() => setStatus(null)); }, []);
  const collectionRows = flattenedCollections(collections);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal compose-modal" role="dialog" aria-modal="true" aria-labelledby="compose-title"><header><div><span className="eyebrow">AI 工作台</span><h2 id="compose-title">从 {articles.length} 篇资料开始创作</h2><p>结果会保存为带来源回链的 Markdown 草稿。</p></div><button type="button" className="icon-button" aria-label="关闭二次创作" onClick={onClose} disabled={busy}>×</button></header><div className="compose-grid"><div className="compose-form"><label><span>成稿类型</span><select value={format} onChange={(event) => setFormat(event.target.value)}><option value="brief">资料综述</option><option value="outline">写作提纲</option><option value="essay">长文草稿</option><option value="social">社交媒体草稿</option></select></label><label><span>成稿语言</span><select value={language} onChange={(event) => setLanguage(event.target.value)}><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option><option value="es">Español</option><option value="fr">Français</option><option value="de">Deutsch</option></select></label><label><span>保存到</span><select value={collectionId} onChange={(event) => setCollectionId(event.target.value)}>{collectionRows.map((collection) => <option key={collection.id} value={collection.id}>{'— '.repeat(collection.depth)}{collection.path}</option>)}</select></label><label className="compose-prompt"><span>写作要求</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} placeholder="希望比较什么、面向谁、采用什么语气…"></textarea><small>{prompt.length} / 4000</small></label></div><aside className="compose-sources"><span className="eyebrow">来源资料</span><ol>{articles.map((article) => <li key={article.id}><i>{sourceInitial(article)}</i><span><strong>{article.title}</strong><small>{article.source || '本地内容'} · {article.read_time_minutes} 分钟</small></span></li>)}</ol></aside></div><div className={`ai-privacy compose-privacy ${status?.remoteConfigured ? 'remote' : 'local'}`}><i></i><span><strong>{status?.remoteConfigured ? '点击生成后，所选正文会发送给已配置的 AI 服务' : '当前使用完全本地的结构化整理'}</strong><small>{status?.remoteConfigured ? 'Reader 只保存成稿、设置与来源关系，不保存服务密钥。' : '本地模式会提取并组织来源原文，不补写来源之外的事实。'}</small></span></div><footer><button type="button" className="button" onClick={onClose} disabled={busy}>取消</button><button type="button" className="button primary" onClick={() => onCreate({ prompt, format, language, collectionId })} disabled={busy}>{busy ? '正在生成草稿…' : status?.remoteConfigured ? '生成 AI 草稿' : '生成本地整理草稿'}</button></footer></section></div>;
}

function AISettingsModal({ notificationsAvailable, onClose, onConfigurationChanged, notify }: { notificationsAvailable: boolean; onClose: () => void; onConfigurationChanged: (status: AIStatus) => void; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null);
  const [spotlightSettings, setSpotlightSettings] = useState<SpotlightSettings | null>(null);
  const [semanticSearch, setSemanticSearch] = useState<SemanticSearchStatus | null>(null);
  const [semanticModel, setSemanticModel] = useState('embeddinggemma');
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<AIProviderPreset['id']>('reader-gateway');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<AIModel[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'models' | 'reset' | 'notifications' | 'spotlight' | 'semantic-test' | 'semantic-enable' | 'semantic-disable' | null>('load');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [semanticResult, setSemanticResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    void Promise.all([
      api.getAISettings(),
      notificationsAvailable ? api.getNotificationSettings() : Promise.resolve(null),
      notificationsAvailable ? api.getSpotlightSettings() : Promise.resolve(null),
      api.getSemanticSearchSettings()
    ]).then(([value, notifications, spotlight, semantic]) => {
      setSettings(value); setEnabled(value.enabled); setProvider(value.provider); setEndpoint(value.endpoint); setModel(value.model); setNotificationSettings(notifications); setSpotlightSettings(spotlight);
      setSemanticSearch(semantic); setSemanticModel(semantic.model);
    }).catch((error) => notify(error instanceof Error ? error.message : '设置加载失败', 'error')).finally(() => setBusy(null));
  }, [notificationsAvailable, notify]);
  useEffect(() => {
    if (!semanticSearch?.enabled) return;
    const timer = window.setInterval(() => {
      void api.getSemanticSearchSettings().then(setSemanticSearch).catch(() => {});
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [semanticSearch?.enabled]);
  const selectedProvider = settings?.providers.find((item) => item.id === provider);
  const changeProvider = (nextId: AIProviderPreset['id']) => {
    const next = settings?.providers.find((item) => item.id === nextId);
    setProvider(nextId); setEndpoint(next?.defaultEndpoint || ''); setModel(''); setModels([]); setApiKey(''); setClearApiKey(false); setTestResult(null);
  };
  const toggleNotifications = async (kind: 'enabled' | 'sourceSyncEnabled', nextEnabled: boolean) => {
    setBusy('notifications');
    try {
      const next = await api.updateNotificationSettings({ [kind]: nextEnabled });
      setNotificationSettings(next);
      const label = kind === 'enabled' ? '后台导入通知' : '后台订阅通知';
      notify(nextEnabled ? `${label}已开启` : `${label}已关闭`);
    } catch (error) { notify(error instanceof Error ? error.message : '通知设置保存失败', 'error'); }
    finally { setBusy(null); }
  };
  const toggleSpotlight = async (nextEnabled: boolean) => {
    if (!nextEnabled && !window.confirm('关闭 Spotlight 搜索？Reader 会从 macOS 系统索引删除已加入的内容，本地资料不会受影响。')) return;
    setBusy('spotlight');
    try {
      const next = await api.updateSpotlightSettings(nextEnabled);
      setSpotlightSettings(next);
      notify(nextEnabled ? 'Spotlight 搜索已开启' : 'Spotlight 索引已删除');
    } catch (error) { notify(error instanceof Error ? error.message : 'Spotlight 设置保存失败', 'error'); }
    finally { setBusy(null); }
  };
  const save = async () => {
    setBusy('save'); setTestResult(null);
    try {
      const result = await api.updateAISettings({ enabled, provider, endpoint: endpoint.trim(), model: model.trim(), apiKey: apiKey || undefined, clearApiKey });
      setSettings(result.settings); setEnabled(result.settings.enabled); setProvider(result.settings.provider); setEndpoint(result.settings.endpoint); setModel(result.settings.model); setApiKey(''); setClearApiKey(false);
      onConfigurationChanged(result.status); notify(enabled ? 'AI 服务设置已保存并立即生效' : '远程 AI 已关闭，Reader 将使用本地能力');
    } catch (error) { notify(error instanceof Error ? error.message : 'AI 设置保存失败', 'error'); }
    finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test'); setTestResult(null);
    try {
      const result = await api.testAISettings(provider, endpoint.trim(), model.trim(), apiKey || undefined);
      setTestResult({ ok: true, message: `连接成功${result.model ? ` · ${result.model}` : ''}` });
    } catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : '连接测试失败' }); }
    finally { setBusy(null); }
  };
  const loadModels = async () => {
    setBusy('models'); setTestResult(null);
    try {
      const result = await api.listAIModels(provider, endpoint.trim(), model.trim(), apiKey || undefined);
      setModels(result);
      if (!model && result.length === 1) setModel(result[0].id);
      setTestResult({ ok: true, message: result.length ? `已读取 ${result.length} 个模型` : '服务没有返回可用模型' });
    } catch (error) { setTestResult({ ok: false, message: error instanceof Error ? error.message : '模型目录读取失败' }); }
    finally { setBusy(null); }
  };
  const reset = async () => {
    if (!window.confirm('恢复环境变量默认值？Reader 会移除为应用保存的 Keychain 密钥。')) return;
    setBusy('reset'); setTestResult(null);
    try {
      const result = await api.resetAISettings(); setSettings(result.settings); setEnabled(result.settings.enabled); setProvider(result.settings.provider); setEndpoint(result.settings.endpoint); setModel(result.settings.model); setModels([]); setApiKey(''); setClearApiKey(false);
      onConfigurationChanged(result.status); notify('已恢复环境变量默认配置');
    } catch (error) { notify(error instanceof Error ? error.message : '默认配置恢复失败', 'error'); }
    finally { setBusy(null); }
  };
  const testSemanticSearch = async () => {
    setBusy('semantic-test'); setSemanticResult(null);
    try {
      const result = await api.testSemanticSearch(semanticModel.trim());
      const qualityLabel = result.quality.assessment === 'strong' ? '分离良好' : result.quality.assessment === 'partial' ? '部分通过' : '质量有限';
      setSemanticResult({
        ok: result.quality.assessment !== 'poor',
        message: `本地嵌入模型可用 · ${result.dimensions} 维 · 中英探针 ${result.quality.passed}/${result.quality.total}（${qualityLabel}）`
      });
    } catch (error) { setSemanticResult({ ok: false, message: error instanceof Error ? error.message : '本地嵌入模型测试失败' }); }
    finally { setBusy(null); }
  };
  const enableSemanticSearch = async () => {
    setBusy('semantic-enable'); setSemanticResult(null);
    try {
      const next = await api.updateSemanticSearch(true, semanticModel.trim());
      setSemanticSearch(next); setSemanticModel(next.model);
      const status = await api.aiStatus().catch(() => null);
      if (status) onConfigurationChanged(status);
      notify(next.pendingChunks ? `本地语义索引已启用，待处理 ${next.pendingChunks} 个片段` : '本地语义检索已启用');
    } catch (error) { notify(error instanceof Error ? error.message : '本地语义检索启用失败', 'error'); }
    finally { setBusy(null); }
  };
  const disableSemanticSearch = async () => {
    if (!window.confirm('关闭本地语义检索并删除全部派生向量？文章、全文索引和 AI 设置不会受影响。')) return;
    setBusy('semantic-disable'); setSemanticResult(null);
    try {
      const next = await api.updateSemanticSearch(false, semanticModel.trim());
      setSemanticSearch(next); setSemanticModel(next.model);
      const status = await api.aiStatus().catch(() => null);
      if (status) onConfigurationChanged(status);
      notify('本地语义索引已关闭并删除');
    } catch (error) { notify(error instanceof Error ? error.message : '本地语义索引删除失败', 'error'); }
    finally { setBusy(null); }
  };
  const keychain = settings?.credentialBackend === 'macos-keychain';
  const credentialScopeChanged = Boolean(settings && (provider !== settings.provider || endpoint.trim() !== settings.endpoint));
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-screen-label="设置">
      <header>
        <div><span className="eyebrow">Reader 设置</span><h2 id="settings-title">应用设置与 AI 隐私</h2><p>控制系统搜索、后台通知、正文何时离开本机，以及凭据保存在哪里。</p></div>
        <button type="button" className="icon-button" aria-label="关闭设置" onClick={onClose} disabled={Boolean(busy)}>×</button>
      </header>
      {busy === 'load' ? <div className="settings-loading">正在读取本地设置…</div> : <>
        <div className="settings-layout">
          <aside className="settings-summary">
            <span className={`settings-state ${enabled && endpoint ? 'remote' : 'local'}`}><i></i><span><strong>{enabled && endpoint ? '远程 AI 已启用' : '本地模式'}</strong><small>{enabled && endpoint ? '仅在你主动执行任务时发送正文' : '摘要与结构化整理不离开设备'}</small></span></span>
            <div className="settings-facts">
              <span><small>AI 提供商</small><strong>{selectedProvider?.name || '本地能力'}</strong></span>
              <span><small>模型</small><strong>{model || '由网关选择'}</strong></span>
              <span><small>凭据存储</small><strong>{keychain ? 'macOS Keychain' : settings?.credentialBackend === 'environment-only' ? '环境变量' : settings?.credentialBackend || '未配置'}</strong></span>
              <span><small>配置来源</small><strong>{settings?.configured ? 'Reader 设置' : settings?.environmentAvailable ? '环境变量' : '本地默认'}</strong></span>
              <span><small>本地语义索引</small><strong>{semanticSearch?.enabled ? semanticSearch.state === 'ready' ? '已就绪' : semanticSearch.state === 'paused' ? '已暂停' : '正在建立' : '未启用'}</strong></span>
              <span><small>最近更新</small><strong>{settings?.updatedAt ? formatMoment(settings.updatedAt) : '尚未保存'}</strong></span>
            </div>
            {notificationsAvailable && notificationSettings && <div className="settings-notification-controls">
              <label className="settings-toggle settings-notification-toggle"><input type="checkbox" checked={notificationSettings.enabled} disabled={Boolean(busy)} onChange={(event) => void toggleNotifications('enabled', event.target.checked)}/><span><strong>后台导入通知</strong><small>默认关闭；只显示成功/失败数量，不显示标题、网址、文件名或错误内容。</small></span><i aria-hidden="true"></i></label>
              <label className="settings-toggle settings-notification-toggle"><input type="checkbox" checked={notificationSettings.sourceSyncEnabled} disabled={Boolean(busy)} onChange={(event) => void toggleNotifications('sourceSyncEnabled', event.target.checked)}/><span><strong>后台订阅通知</strong><small>默认关闭；自动同步有新增或失败时只显示聚合数量，手动同步不通知。</small></span><i aria-hidden="true"></i></label>
            </div>}
            {notificationsAvailable && spotlightSettings && <div className="settings-notification-controls spotlight-controls">
              <label className="settings-toggle settings-notification-toggle"><input type="checkbox" checked={spotlightSettings.enabled} disabled={Boolean(busy) || (!spotlightSettings.available && !spotlightSettings.enabled)} onChange={(event) => void toggleSpotlight(event.target.checked)}/><span><strong>在 macOS Spotlight 中搜索</strong><small>默认关闭；开启后标题、摘要、标签和最多 20,000 字正文会进入本机受保护的系统索引。关闭会删除索引。</small></span><i aria-hidden="true"></i></label>
              <small className="spotlight-status">{spotlightSettings.state === 'indexing' ? `正在更新索引${spotlightSettings.pending ? ` · 待处理 ${spotlightSettings.pending}` : ''}` : spotlightSettings.enabled ? `索引已开启${spotlightSettings.indexedAt ? ` · ${formatMoment(spotlightSettings.indexedAt)}` : ''}` : spotlightSettings.available ? '未开启，不会向系统索引写入资料' : '当前 Reader 未检测到 Spotlight 组件'}</small>
              {spotlightSettings.warning && <p className="settings-warning">{spotlightSettings.warning}</p>}
            </div>}
            {settings?.warning && <p className="settings-warning">{settings.warning}</p>}
          </aside>
          <div className="settings-form">
            <label className="settings-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)}/><span><strong>启用远程 AI 服务</strong><small>关闭后，翻译不可用；摘要和资料整理继续在本机运行。</small></span><i aria-hidden="true"></i></label>
            <label>
              <span>AI 提供商</span>
              <select value={provider} onChange={(event) => changeProvider(event.target.value as AIProviderPreset['id'])}>
                {(settings?.providers || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <small>Reader Gateway 保持原有 action 契约；其他预设使用 OpenAI-compatible Chat Completions。</small>
            </label>
            <label>
              <span>{provider === 'reader-gateway' ? 'Reader Gateway 地址' : 'OpenAI-compatible 基础地址'}</span>
              <input type="url" value={endpoint} disabled={selectedProvider?.endpointLocked} onChange={(event) => { setEndpoint(event.target.value); setModels([]); setApiKey(''); setClearApiKey(false); setTestResult(null); }} placeholder={provider === 'reader-gateway' ? 'https://gateway.example/v1/respond' : 'https://models.example/v1/'}/>
              <small>{selectedProvider?.endpointLocked ? '该预设使用固定官方或本机回环地址。' : '远程服务必须使用 HTTPS；HTTP 仅允许 localhost 或 127.0.0.1。'}</small>
            </label>
            {selectedProvider?.modelRequired && <label>
              <span>模型 ID</span>
              <div className="secret-field">
                <input list="ai-model-catalog" value={model} onChange={(event) => { setModel(event.target.value); setTestResult(null); }} placeholder="先读取目录或手动填写"/>
                <button type="button" onClick={() => void loadModels()} disabled={Boolean(busy) || !selectedProvider.modelCatalog || !endpoint.trim()}>{busy === 'models' ? '读取中…' : '读取模型'}</button>
              </div>
              <datalist id="ai-model-catalog">{models.map((item) => <option key={item.id} value={item.id}>{item.ownedBy}</option>)}</datalist>
              <small>目录来自当前服务的 `/models`，只读取模型元数据，不发送资料库内容；也可手动填写服务允许的模型 ID。</small>
            </label>}
            <label>
              <span>API 密钥</span>
              <div className="secret-field"><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearApiKey(false); }} disabled={!settings?.credentialWritable} placeholder={settings?.apiKeyStored && credentialScopeChanged ? '服务已切换；请为新服务重新输入' : settings?.apiKeyStored && !clearApiKey ? '已安全存储；输入新值可替换' : selectedProvider?.apiKeyRecommended ? '该提供商通常需要 API 密钥' : '可选，取决于服务'}/>{settings?.apiKeyStored && !credentialScopeChanged && <button type="button" onClick={() => { setApiKey(''); setClearApiKey((value) => !value); }}>{clearApiKey ? '保留密钥' : '移除密钥'}</button>}</div>
              <small>{credentialScopeChanged && settings?.apiKeyStored ? '提供商或地址已改变；旧密钥不会用于连接测试或模型目录，并会在保存时从 Keychain 清除。' : keychain ? '密钥写入 macOS Keychain，不进入 settings.json、备份、导出或模型目录响应。' : '当前平台只支持通过 READER_AI_API_KEY 环境变量提供密钥。'}</small>
            </label>
            <section className="settings-contract semantic-search-settings" aria-labelledby="semantic-search-title">
              <span className="eyebrow" id="semantic-search-title">本地语义检索</span>
              <p>可选调用固定回环地址的 Ollama `/api/embed`，把派生向量保存在本机并与全文结果混排；不会使用远程 AI 地址或 API 密钥。</p>
              <label>
                <span>本地嵌入模型</span>
                <input aria-label="本地嵌入模型" value={semanticModel} onChange={(event) => { setSemanticModel(event.target.value); setSemanticResult(null); }} placeholder="embeddinggemma"/>
                <small>推荐 `embeddinggemma`、`qwen3-embedding` 或 `all-minilm`；必须先在 Ollama 中安装。测试只发送 9 句 Reader 内置中英文探针，不读取资料库。</small>
              </label>
              <div className="semantic-search-actions">
                <button type="button" onClick={() => void testSemanticSearch()} disabled={Boolean(busy) || !semanticModel.trim()}>{busy === 'semantic-test' ? '测试中…' : '测试本地模型'}</button>
                <button type="button" className="button primary" onClick={() => void enableSemanticSearch()} disabled={Boolean(busy) || !semanticModel.trim()}>{busy === 'semantic-enable' ? '正在启用…' : semanticSearch?.enabled && semanticSearch.model !== semanticModel.trim() ? '切换模型并重建' : semanticSearch?.enabled ? '继续建立索引' : '启用语义检索'}</button>
                {semanticSearch?.enabled && <button type="button" className="quiet-danger" onClick={() => void disableSemanticSearch()} disabled={Boolean(busy)}>{busy === 'semantic-disable' ? '正在删除…' : '关闭并删除索引'}</button>}
              </div>
              <small className="semantic-search-status">{semanticSearch?.enabled ? `${semanticSearch.embeddedChunks} / ${semanticSearch.totalChunks} 个片段${semanticSearch.dimensions ? ` · ${semanticSearch.dimensions} 维` : ''}${semanticSearch.quality ? ` · 中英探针 ${semanticSearch.quality.passed}/${semanticSearch.quality.total}` : ''}${semanticSearch.state === 'paused' ? ' · 因系统资源限制暂停' : ''}` : '默认关闭；关闭后只使用现有本地全文检索。'}</small>
              {semanticSearch?.warning && <p className="settings-warning">{semanticSearch.warning}</p>}
              {semanticSearch?.quality?.assessment === 'poor' && <p className="settings-warning">该模型能生成向量，但内置中英语义分离探针表现有限；可更换推荐嵌入模型，Reader 仍会保留全文检索回退。</p>}
              {semanticResult && <span className={semanticResult.ok ? 'success' : 'error'}><i></i>{semanticResult.message}</span>}
            </section>
            <div className="settings-contract"><span className="eyebrow">连接测试</span><p>测试只发送 Reader 自带的一句英文，不会读取或发送你的资料库内容。</p>{testResult && <span className={testResult.ok ? 'success' : 'error'}><i></i>{testResult.message}</span>}</div>
          </div>
        </div>
        <footer>
          <button type="button" className="button quiet-danger settings-reset" onClick={() => void reset()} disabled={Boolean(busy) || !settings?.configured}>恢复默认</button>
          <span className="settings-footer-spacer"></span>
          <button type="button" className="button" onClick={() => void test()} disabled={Boolean(busy) || !endpoint.trim() || Boolean(selectedProvider?.modelRequired && !model.trim())}>{busy === 'test' ? '正在测试…' : '测试连接'}</button>
          <button type="button" className="button primary" onClick={() => void save()} disabled={Boolean(busy)}>{busy === 'save' ? '正在保存…' : '保存 AI 设置'}</button>
        </footer>
      </>}
    </section>
  </div>;
}

function ConnectorSettingsModal({ onClose, notify }: { onClose: () => void; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [xToken, setXToken] = useState('');
  const [busy, setBusy] = useState<'load' | 'x-save' | 'x-test' | 'x-clear' | 'weibo-test' | 'weibo-clear' | null>('load');
  const [result, setResult] = useState<{ platform: 'x' | 'weibo'; ok: boolean; message: string } | null>(null);
  useEffect(() => {
    void api.getConnectorSettings()
      .then(setStatus)
      .catch((error) => notify(error instanceof Error ? error.message : '连接器状态加载失败', 'error'))
      .finally(() => setBusy(null));
  }, [notify]);
  const saveX = async () => {
    setBusy('x-save'); setResult(null);
    try { const next = await api.saveXConnector(xToken); setStatus(next); setXToken(''); notify('X Bearer Token 已保存到 macOS Keychain'); }
    catch (error) { notify(error instanceof Error ? error.message : 'X 连接器保存失败', 'error'); }
    finally { setBusy(null); }
  };
  const testX = async () => {
    setBusy('x-test'); setResult(null);
    try {
      const test = await api.testXConnector(xToken || undefined);
      setResult({ platform: 'x', ok: true, message: `连接成功 · @${test.account}${test.remaining !== null ? ` · 剩余 ${test.remaining}` : ''}` });
    } catch (error) { setResult({ platform: 'x', ok: false, message: error instanceof Error ? error.message : 'X 连接测试失败' }); }
    finally { setBusy(null); }
  };
  const clearX = async () => {
    if (!window.confirm('移除 Reader 保存的 X Bearer Token？已有 X 文章会保留，自动同步将暂停。')) return;
    setBusy('x-clear'); setResult(null);
    try { setStatus(await api.clearXConnector()); notify('已从 macOS Keychain 移除 X Bearer Token'); }
    catch (error) { notify(error instanceof Error ? error.message : 'X 凭据移除失败', 'error'); }
    finally { setBusy(null); }
  };
  const testWeibo = async () => {
    setBusy('weibo-test'); setResult(null);
    try {
      const test = await api.testWeiboConnector();
      setResult({ platform: 'weibo', ok: true, message: `官方 CLI 已登录${test.account ? ` · ${test.account}` : ''}` });
      setStatus(await api.getConnectorSettings());
    } catch (error) { setResult({ platform: 'weibo', ok: false, message: error instanceof Error ? error.message : '微博连接测试失败' }); }
    finally { setBusy(null); }
  };
  const logoutWeibo = async () => {
    if (!window.confirm('退出微博官方 CLI 登录？这会影响本机其他使用 weibo CLI 的工具。')) return;
    setBusy('weibo-clear'); setResult(null);
    try { setStatus(await api.logoutWeiboConnector()); notify('微博官方 CLI 已退出登录'); }
    catch (error) { notify(error instanceof Error ? error.message : '微博授权撤销失败', 'error'); }
    finally { setBusy(null); }
  };
  const xStored = Boolean(status?.x.configured);
  const xWritable = Boolean(status?.x.credentialWritable);
  const weiboReady = Boolean(status?.weibo.authenticated);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="modal connector-modal" role="dialog" aria-modal="true" aria-labelledby="connector-title">
    <header><div><span className="eyebrow">官方数据通道</span><h2 id="connector-title">社交连接器</h2><p>只接入官方 API 或官方 CLI，不使用易失效的页面爬虫。</p></div><button className="icon-button" type="button" aria-label="关闭连接器设置" onClick={onClose} disabled={Boolean(busy)}>×</button></header>
    {busy === 'load' ? <div className="settings-loading">正在检查本机连接器…</div> : <div className="connector-grid">
      <section className="connector-card" data-platform="x"><header><span className="connector-logo">X</span><span><strong>X API</strong><small>读取公开用户动态</small></span><i className={xStored ? 'ready' : ''}>{xStored ? '已连接' : '未连接'}</i></header>
        <p>在 X Developer Console 创建应用并复制 Bearer Token。Reader 使用用户查询与时间线端点，并以 <code>since_id</code> 增量同步。</p>
        <label><span>Bearer Token</span><input type="password" autoComplete="new-password" value={xToken} disabled={!xWritable} onChange={(event) => { setXToken(event.target.value); setResult(null); }} placeholder={xStored ? '已安全存储；输入新值可替换' : '粘贴 X Bearer Token'}/><small>{status?.x.credentialSource === 'environment' ? '当前由 READER_X_BEARER_TOKEN 提供。' : xWritable ? '保存后写入 macOS Keychain，不进入 SQLite、备份或导出。' : '当前平台不可写 Keychain，可使用环境变量。'}</small></label>
        {result?.platform === 'x' && <span className={`connector-result ${result.ok ? 'success' : 'error'}`}>{result.message}</span>}
        <footer><a className="button" href="https://developer.x.com/" target="_blank" rel="noreferrer">开发者控制台</a>{xStored && status?.x.credentialSource === 'keychain' && <button className="button quiet-danger" type="button" onClick={() => void clearX()} disabled={Boolean(busy)}>移除凭据</button>}<span></span><button className="button" type="button" onClick={() => void testX()} disabled={Boolean(busy) || (!xToken && !xStored)}>{busy === 'x-test' ? '测试中…' : '测试连接'}</button><button className="button primary" type="button" onClick={() => void saveX()} disabled={Boolean(busy) || !xToken || !xWritable}>{busy === 'x-save' ? '保存中…' : '保存到 Keychain'}</button></footer>
      </section>
      <section className="connector-card" data-platform="weibo"><header><span className="connector-logo">微</span><span><strong>微博开放平台 CLI</strong><small>读取用户时间线</small></span><i className={weiboReady ? 'ready' : ''}>{weiboReady ? '已登录' : status?.weibo.installed ? '待登录' : '未安装'}</i></header>
        <p>Reader 调用微博开放平台官方 <code>@weibo-ai/weibo-cli</code>。OAuth 令牌由 CLI 写入系统 Keychain，Reader 不读取令牌。</p>
        <div className="connector-steps"><span><b>1</b><code>npm install -g @weibo-ai/weibo-cli</code></span><span><b>2</b><code>weibo auth login --device</code></span><small>{weiboReady ? `当前账号：${status?.weibo.account || '已认证用户'}` : status?.weibo.error || '完成后返回这里测试登录状态。'}</small></div>
        {result?.platform === 'weibo' && <span className={`connector-result ${result.ok ? 'success' : 'error'}`}>{result.message}</span>}
        <footer><a className="button" href="https://open.weibo.com/cli/index" target="_blank" rel="noreferrer">官方说明</a>{weiboReady && <button className="button quiet-danger" type="button" onClick={() => void logoutWeibo()} disabled={Boolean(busy)}>撤销 CLI 登录</button>}<span></span><button className="button primary" type="button" onClick={() => void testWeibo()} disabled={Boolean(busy)}>{busy === 'weibo-test' ? '检查中…' : '检查连接'}</button></footer>
      </section>
    </div>}
    <footer className="connector-footer"><span>删除或断开连接器不会删除已保存的文章。</span><button className="button" type="button" onClick={onClose} disabled={Boolean(busy)}>完成</button></footer>
  </section></div>;
}

function EditorModal({ article, onClose, onSave, onUploadImage, notify }: { article: Article; onClose: () => void; onSave: (patch: Partial<Article>) => Promise<Article>; onUploadImage: (file: File) => Promise<{ article: Article; attachment: Attachment; duplicate: boolean }>; notify: (message: string, tone?: Toast['tone']) => void }) {
  const [title, setTitle] = useState(article.title);
  const [excerpt, setExcerpt] = useState(article.excerpt);
  const [content, setContent] = useState(article.content);
  const [author, setAuthor] = useState(article.author);
  const [source, setSource] = useState(article.source);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'waiting' | 'error'>('saved');
  const [saved, setSaved] = useState({ title: article.title, excerpt: article.excerpt, content: article.content, author: article.author, source: article.source });
  const [images, setImages] = useState(() => article.attachments.filter((attachment) => attachment.mime_type.startsWith('image/')));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const contentRef = useRef(content);
  const savingRef = useRef(false);
  contentRef.current = content;
  const dirty = title !== saved.title || excerpt !== saved.excerpt || content !== saved.content || author !== saved.author || source !== saved.source;
  const persist = useCallback(async (closeAfter = false, announce = false) => {
    if (!dirty) { if (closeAfter) onClose(); return true; }
    if (!title.trim()) { if (announce) notify('标题不能为空', 'error'); return false; }
    if (savingRef.current) return false;
    const snapshot = { title: title.trim(), excerpt: excerpt.trim(), content, author: author.trim(), source: source.trim() };
    savingRef.current = true; setBusy(true);
    try {
      const updated = await onSave(snapshot);
      setSaved(snapshot); setImages(updated.attachments.filter((attachment) => attachment.mime_type.startsWith('image/'))); setSavedAt(new Date()); setSaveState('saved');
      if (announce) notify('编辑已写入本地数据库');
      if (closeAfter) onClose();
      return true;
    } catch (error) { setSaveState('error'); notify(error instanceof Error ? error.message : '保存失败', 'error'); return false; }
    finally { savingRef.current = false; setBusy(false); }
  }, [dirty, title, excerpt, content, author, source, onSave, onClose, notify]);
  useEffect(() => {
    if (!dirty || !title.trim() || busy || uploading) return;
    setSaveState('waiting');
    const timer = window.setTimeout(() => void persist(false, false), 1400);
    return () => window.clearTimeout(timer);
  }, [dirty, title, excerpt, content, author, source, busy, uploading, persist]);
  const requestClose = () => {
    if (busy || uploading) return;
    if (dirty && !window.confirm('仍有修改尚未写入本地数据库，确定关闭编辑器？')) return;
    onClose();
  };
  const insertMarkdown = (markdown: string) => {
    const textarea = textareaRef.current;
    const current = contentRef.current;
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? start;
    const leading = start > 0 && !current.slice(0, start).endsWith('\n') ? '\n\n' : '';
    const trailing = end < current.length && !current.slice(end).startsWith('\n') ? '\n\n' : '\n';
    const insertion = `${leading}${markdown}${trailing}`;
    const next = `${current.slice(0, start)}${insertion}${current.slice(end)}`;
    setContent(next);
    window.requestAnimationFrame(() => { textareaRef.current?.focus(); textareaRef.current?.setSelectionRange(start + insertion.length, start + insertion.length); });
  };
  const imageMarkdown = (attachment: Attachment) => `![${attachment.file_name.replace(/[\[\]]/g, '')}](${attachment.url})`;
  const uploadFiles = async (files: File[]) => {
    const accepted = files.filter((file) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(file.name));
    if (!accepted.length) return notify('请选择 PNG、JPEG、WebP、GIF、AVIF 或 HEIC 图片', 'error');
    setUploading(true);
    try {
      const uploaded: Attachment[] = [];
      let duplicates = 0;
      for (const file of accepted) {
        const result = await onUploadImage(file);
        uploaded.push(result.attachment); if (result.duplicate) duplicates += 1;
        setImages(result.article.attachments.filter((attachment) => attachment.mime_type.startsWith('image/')));
      }
      insertMarkdown(uploaded.map(imageMarkdown).join('\n\n'));
      notify(`已保存并插入 ${uploaded.length} 张图片${duplicates ? `，其中 ${duplicates} 张复用已有文件` : ''}`);
    } catch (error) { notify(error instanceof Error ? error.message : '图片上传失败', 'error'); }
    finally { setUploading(false); setDragActive(false); }
  };
  const statusText = uploading ? '正在保存图片…' : busy ? '正在保存…' : saveState === 'error' ? '保存失败' : dirty ? '停笔后自动保存' : savedAt ? `已保存 ${savedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '已保存';
  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (!busy && !uploading) void persist(false, true);
  };
  return <div className="modal-backdrop editor-backdrop"><section className="modal editor-modal" role="dialog" aria-modal="true" aria-label="Markdown 编辑器" aria-busy={busy || uploading} onKeyDown={handleEditorKeyDown}>
    <header><div><span className="eyebrow">本地 Markdown</span><h2>编辑内容</h2></div><div className="editor-status"><span role="status" aria-live="polite" aria-atomic="true" className={dirty || saveState === 'error' ? 'dirty' : ''}>{statusText}</span><button className="icon-button" type="button" aria-label="关闭编辑器" disabled={busy || uploading} onClick={requestClose}>×</button></div></header>
    <div className="editor-meta">
      <label className="editor-title"><span>标题</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} aria-label="编辑标题"/></label>
      <label><span>作者</span><input value={author} onChange={(event) => setAuthor(event.target.value)} aria-label="编辑作者"/></label>
      <label><span>来源</span><input value={source} onChange={(event) => setSource(event.target.value)} aria-label="编辑来源"/></label>
      <label className="editor-excerpt"><span>摘要</span><input value={excerpt} onChange={(event) => setExcerpt(event.target.value)} aria-label="编辑摘要"/></label>
    </div>
    <div className="editor-assets"><div className="editor-assets-title"><strong>文章图片</strong><small>{images.length ? `${images.length} 张保存在本机 · 点击插入光标处` : '上传后自动插入正文并保存在本机'}</small></div><div className="editor-asset-list">{images.map((attachment) => <button type="button" key={attachment.id} aria-label={`插入图片 ${attachment.file_name}`} onClick={() => insertMarkdown(imageMarkdown(attachment))}><img src={attachment.thumbnail_url || attachment.url} alt=""/><span>{attachment.file_name}</span></button>)}{!images.length && <span className="editor-assets-empty">还没有文章图片</span>}</div><FilePickerButton className="editor-image-upload" ariaLabel="上传文章图片" disabled={uploading} accept=".png,.jpg,.jpeg,.gif,.webp,.avif,.heic,image/png,image/jpeg,image/gif,image/webp,image/avif,image/heic" multiple onFiles={(files) => void uploadFiles(files)}><span>{uploading ? '上传中…' : '＋ 上传图片'}</span><small>单张 ≤ 20 MB</small></FilePickerButton></div>
    <div className="editor-workspace">
      <section className={`editor-source ${dragActive ? 'drag-active' : ''}`} aria-labelledby="editor-source-title"><header><strong id="editor-source-title">Markdown</strong><span>{content.length.toLocaleString()} 字符 · 可拖入图片</span></header><textarea ref={textareaRef} value={content} onChange={(event) => setContent(event.target.value)} onDragEnter={(event) => { if ([...event.dataTransfer.items].some((item) => item.kind === 'file')) setDragActive(true); }} onDragOver={(event) => { event.preventDefault(); }} onDragLeave={() => setDragActive(false)} onDrop={(event) => { event.preventDefault(); void uploadFiles([...event.dataTransfer.files]); }} aria-label="Markdown 正文" spellCheck={false}></textarea></section>
      <section className="editor-preview" aria-labelledby="editor-preview-title"><header><strong id="editor-preview-title">实时预览</strong><span>安全渲染 · 不执行 HTML</span></header><article lang={article.language}><h1>{title || '无标题'}</h1>{excerpt && <p className="dek">{excerpt}</p>}<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></article></section>
    </div>
    <footer><span className="editor-footer-note">停笔 1.4 秒后自动保存；⌘S 立即保存，每次变更都可在版本历史中恢复。</span><button className="button" type="button" disabled={busy || uploading || !dirty || !title.trim()} onClick={() => void persist(false, true)}>保存 <kbd>⌘S</kbd></button><button className="button" type="button" disabled={busy || uploading} onClick={requestClose}>关闭</button><button className="button primary" type="button" disabled={busy || uploading || !title.trim()} onClick={() => void persist(true, true)}>{busy ? '正在保存…' : dirty ? '保存并关闭' : '完成'}</button></footer>
  </section></div>;
}

function AddModal({ collections, initialRequest, onClose, onCreated, onQueued, onImported, notify, onSourceCreated, onOpenConnectors }: { collections: Collection[]; initialRequest?: ExternalAddRequest; onClose: () => void; onCreated: (article: Article) => void; onQueued: (job: ImportJob) => void; onImported: () => Promise<void>; notify: (message: string, tone?: Toast['tone']) => void; onSourceCreated: (source: Source) => void; onOpenConnectors: () => void }) {
  const [tab, setTab] = useState<'url' | 'attachment' | 'markdown' | 'feed' | 'package'>(initialRequest?.kind === 'text' ? 'markdown' : initialRequest?.kind === 'file' ? 'attachment' : 'url');
  const [url, setURL] = useState(initialRequest?.kind === 'url' ? initialRequest.url : ''); const [title, setTitle] = useState(initialRequest?.kind === 'text' ? '分享的文本摘录' : ''); const [content, setContent] = useState(initialRequest?.kind === 'text' ? initialRequest.text : ''); const [file, setFile] = useState<File | null>(null); const [packageFile, setPackageFile] = useState<File | null>(null); const [packagePreview, setPackagePreview] = useState<PortableImportPreview | null>(null); const [packageSelection, setPackageSelection] = useState<Set<string>>(new Set()); const [collection, setCollection] = useState('inbox'); const [busy, setBusy] = useState(false);
  const [sharedFile, setSharedFile] = useState<SharedFileInfo | null>(null); const [sharedFileLoading, setSharedFileLoading] = useState(initialRequest?.kind === 'file');
  const [sourceKind, setSourceKind] = useState<Source['kind']>('rss'); const [sourceInterval, setSourceInterval] = useState(60);
  useEffect(() => {
    if (!initialRequest) return;
    if (initialRequest.kind === 'url') {
      setTab('url');
      setURL(initialRequest.url);
      return;
    }
    if (initialRequest.kind === 'text') {
      setTab('markdown');
      setTitle('分享的文本摘录');
      setContent(initialRequest.text);
      return;
    }
    let active = true;
    setTab('attachment');
    setFile(null);
    setSharedFile(null);
    setSharedFileLoading(true);
    window.readerDesktop?.inspectSharedFile(initialRequest.token).then((value) => {
      if (!active) return;
      if (!value) throw new Error('分享文件不可用或已经过期');
      setSharedFile(value);
    }).catch((error) => {
      if (active) notify(error instanceof Error ? error.message : '无法读取分享文件', 'error');
    }).finally(() => {
      if (active) setSharedFileLoading(false);
    });
    return () => { active = false; };
  }, [initialRequest, notify]);
  const isWeChatURL = /^https?:\/\/mp\.weixin\.qq\.com\//i.test(url.trim());
  const close = async () => {
    if (packagePreview) await api.cancelMarkdownImport(packagePreview.id).catch(() => {});
    if (initialRequest?.kind === 'file') await window.readerDesktop?.discardSharedFile(initialRequest.token).catch(() => {});
    onClose();
  };
  const changeTab = async (next: typeof tab) => {
    if (packagePreview) await api.cancelMarkdownImport(packagePreview.id).catch(() => {});
    if (initialRequest?.kind === 'file' && tab === 'attachment' && next !== 'attachment') {
      await window.readerDesktop?.discardSharedFile(initialRequest.token).catch(() => {});
      setSharedFile(null);
    }
    setPackagePreview(null);
    setPackageSelection(new Set());
    setTab(next);
  };
  const submit = async () => {
    setBusy(true);
    try {
      if (tab === 'url') { const job = await api.createURLImport(url, collection); onQueued(job); notify('网页已加入本地导入队列'); }
      if (tab === 'attachment') {
        let job;
        if (file) job = await api.uploadAttachment(file, collection);
        else if (initialRequest?.kind === 'file' && sharedFile) job = await window.readerDesktop?.importSharedFile(initialRequest.token, collection);
        else throw new Error(sharedFileLoading ? '正在检查分享文件' : '请选择附件');
        if (!job) throw new Error('分享文件导入失败');
        onQueued(job);
        notify('附件已安全上传并加入队列');
      }
      if (tab === 'markdown') onCreated(await api.createMarkdown(title, content, collection));
      if (tab === 'feed') {
        const created = await api.createSource(sourceKind, title, url, sourceInterval);
        onSourceCreated(created.source);
        const result = await api.syncSource(created.source.id);
        notify(created.duplicate ? `订阅已存在，${result.notModified ? '内容没有更新' : `新增 ${result.imported} 条内容`}` : `订阅已添加，本次导入 ${result.imported} 条内容`);
      }
      if (tab === 'package') {
        if (!packagePreview) {
          if (!packageFile) throw new Error('请选择 Reader Markdown ZIP');
          const preview = await api.previewMarkdownImport(packageFile);
          setPackagePreview(preview);
          setPackageSelection(new Set(preview.articles.filter((article) => article.selectable).map((article) => article.id)));
          return;
        }
        const result = await api.commitMarkdownImport(packagePreview.id, [...packageSelection], collection);
        setPackagePreview(null);
        await onImported();
        notify(`已导入 ${result.imported} 篇${result.skipped ? `，跳过 ${result.skipped} 篇冲突内容` : ''}${result.failed ? `，${result.failed} 篇失败` : ''}`, result.failed ? 'error' : 'normal');
      }
      if (initialRequest?.kind === 'file') await window.readerDesktop?.discardSharedFile(initialRequest.token).catch(() => {});
      onClose();
    } catch (error) { notify(error instanceof Error ? error.message : '添加失败', 'error'); }
    finally { setBusy(false); }
  };
  const selectableIds = packagePreview?.articles.filter((article) => article.selectable).map((article) => article.id) || [];
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => packageSelection.has(id));
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && void close()}><section className={`modal ${tab === 'package' ? 'portable-import-modal' : ''}`} role="dialog" aria-modal="true" aria-label="添加内容">
    <header><div><span className="eyebrow">本地采集</span><h2>添加到 Reader</h2></div><button className="icon-button" type="button" aria-label="关闭添加窗口" disabled={busy} onClick={() => void close()}>×</button></header>
    <div className="modal-tabs" role="group" aria-label="添加内容类型">{([['url','网页 URL'],['attachment','附件'],['markdown','Markdown'],['package','Reader ZIP'],['feed','自动订阅']] as const).map(([value,label]) => <button type="button" key={value} aria-pressed={tab === value} className={tab === value ? 'active' : ''} disabled={busy} onClick={() => void changeTab(value)}>{label}</button>)}</div>
    <div className="modal-body">
      {(tab === 'url' || tab === 'feed') && <label><span>{tab === 'feed' ? sourceKind === 'x' ? 'X 用户名或主页' : sourceKind === 'weibo' ? '微博数字 UID 或主页' : '订阅地址' : '网页地址'}</span><input autoFocus aria-label={tab === 'url' ? '网页地址' : undefined} type={tab === 'feed' && (sourceKind === 'x' || sourceKind === 'weibo') ? 'text' : 'url'} value={url} onChange={(event) => setURL(event.target.value)} placeholder={tab === 'feed' ? sourceKind === 'youtube' ? 'https://www.youtube.com/@channel' : sourceKind === 'x' ? '@XDevelopers' : sourceKind === 'weibo' ? '例如：1234567890' : 'https://example.com/feed.xml' : 'https://example.com/article'}/></label>}
      {tab === 'attachment' && <FilePickerButton className="file-drop" ariaLabel={file ? `更换附件，当前为 ${file.name}` : sharedFile ? `更换分享附件，当前为 ${sharedFile.name}` : '选择 PDF、图片、视频或文本'} accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.avif,.heic,.mp4,.mov,.m4v,.webm,.txt,.md,.markdown" onFiles={(files) => setFile(files[0] || null)}><span className="file-drop-icon">{sharedFile && !file ? '↥' : '＋'}</span><strong>{file?.name || sharedFile?.name || (sharedFileLoading ? '正在检查分享文件…' : '选择 PDF、图片、视频或文本')}</strong><small>{file ? `${formatBytes(file.size)} · ${file.type || '未知类型'}` : sharedFile ? `${formatBytes(sharedFile.size)} · 来自 macOS 分享，确认前不会进入资料库` : '单个文件最大 100 MB，原文件和内容都只保存在本机。'}</small></FilePickerButton>}
      {tab === 'package' && !packagePreview && <><FilePickerButton className="file-drop" ariaLabel={packageFile ? `更换 Reader Markdown ZIP，当前为 ${packageFile.name}` : '选择 Reader Markdown ZIP'} accept=".zip,application/zip" onFiles={(files) => setPackageFile(files[0] || null)}><span className="file-drop-icon">↥</span><strong>{packageFile ? packageFile.name : '选择 Reader Markdown ZIP'}</strong><small>{packageFile ? `${formatBytes(packageFile.size)} · 等待安全检查` : '只接受 Reader 导出的 ZIP，最大 2 GB；预览前不会写入资料库。'}</small></FilePickerButton><div className="privacy-note"><strong>导入与完整恢复严格分离</strong><span>Reader 会拒绝越界路径、未知文件、超限内容和附件哈希不符；检查通过后仍需逐篇确认，已有 ID 或原链接默认跳过。</span></div></>}
      {tab === 'package' && packagePreview && <div className="portable-import-review">
        <div className="portable-import-summary"><span><strong>{packagePreview.counts.articles}</strong><small>篇文章</small></span><span><strong>{packagePreview.counts.attachments}</strong><small>个附件</small></span><span><strong>{packagePreview.counts.highlights}</strong><small>条高亮</small></span><button className="button" type="button" onClick={() => setPackageSelection(allSelected ? new Set() : new Set(selectableIds))}>{allSelected ? '取消全选' : '选择可导入内容'}</button></div>
        {packagePreview.compatibilityMode && <div className="privacy-note warning"><strong>旧版 v2 兼容导入</strong><span>Reader 会从标准 Markdown 重建正文并去除导出时生成的附录；0.19 起的 v3 包带有无损 sidecar，可精确保留原正文。</span></div>}
        <div className="portable-import-list">{packagePreview.articles.map((article) => <label key={article.id} className={`${packageSelection.has(article.id) ? 'selected' : ''} ${!article.selectable ? 'disabled' : ''}`}>
          <input type="checkbox" disabled={!article.selectable} checked={packageSelection.has(article.id)} onChange={() => setPackageSelection((current) => { const next = new Set(current); if (next.has(article.id)) next.delete(article.id); else next.add(article.id); return next; })}/>
          <span className="portable-import-check">{article.selectable ? '✓' : '—'}</span><span className="portable-import-copy"><span><strong>{article.title}</strong>{article.conflict && <i>{article.conflict === 'duplicate_id' ? '已在资料库' : '原链接已存在'}</i>}</span><small>{article.source || article.originalCollection || '本地内容'} · {article.attachments} 附件 · {article.highlights} 高亮{article.tags.length ? ` · ${article.tags.slice(0, 3).join('、')}` : ''}</small></span>
        </label>)}</div>
      </div>}
      {(tab === 'markdown' || tab === 'feed') && <label><span>{tab === 'feed' ? '订阅名称' : '标题'}</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={tab === 'feed' ? '例如：产品设计周刊' : '写下标题'}/></label>}
      {tab === 'feed' && <div className="source-create-grid"><label><span>来源类型</span><select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as Source['kind'])}><option value="rss">RSS / Atom</option><option value="youtube">YouTube 频道</option><option value="x">X 用户</option><option value="weibo">微博用户</option></select></label><label><span>自动同步</span><select value={sourceInterval} onChange={(event) => setSourceInterval(Number(event.target.value))}><option value={15}>每 15 分钟</option><option value={30}>每 30 分钟</option><option value={60}>每小时</option><option value={360}>每 6 小时</option><option value={1440}>每天</option></select></label></div>}
      {tab === 'markdown' && <label><span>正文</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="支持 Markdown 文本；内容会直接写入本地 SQLite。"></textarea></label>}
      {tab !== 'feed' && (tab !== 'package' || packagePreview) && <label><span>保存到</span><select value={collection} onChange={(event) => setCollection(event.target.value)}>{collections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {tab === 'url' && <div className="privacy-note"><strong>{isWeChatURL ? '微信公众号专用导入' : '安全抓取'}</strong><span>{isWeChatURL ? 'Reader 会识别公众号标题、作者、正文和图片并保存到本机。若微信要求环境验证，本次任务会失败并可重试，不会把验证页保存成文章。' : 'Reader 会阻止本机、局域网和云元数据地址，最多读取 4 MB，并把正文与可下载图片保存到本机。'}</span></div>}
      {tab === 'feed' && <div className="privacy-note source-privacy"><strong>后台同步，本地入库</strong><span>{sourceKind === 'youtube' ? '支持频道主页、/channel/UC… 与官方 Feed 地址；新视频作为可整理的内容进入收件箱。' : sourceKind === 'x' ? '通过 X 官方 API 读取公开动态，使用 since_id 增量同步；Bearer Token 只保存在 macOS Keychain。' : sourceKind === 'weibo' ? '通过微博开放平台官方 CLI 读取用户时间线；Reader 复用 CLI 登录态，不接触或保存微博令牌。' : 'Reader 使用 ETag 与 Last-Modified 避免重复下载，失败时自动退避并保留可见状态。'}</span>{(sourceKind === 'x' || sourceKind === 'weibo') && <button type="button" className="button" onClick={onOpenConnectors}>配置社交连接器</button>}</div>}
    </div>
    <footer><button className="button" type="button" disabled={busy} onClick={() => void close()}>取消</button><button className="button primary" type="button" disabled={busy || (tab === 'attachment' && sharedFileLoading && !file) || (tab === 'package' && (!packagePreview ? !packageFile : packageSelection.size === 0))} onClick={() => void submit()}>{busy ? packagePreview ? '正在导入…' : '正在安全检查…' : tab === 'feed' ? '添加并同步' : tab === 'markdown' ? '保存到本机' : tab === 'package' ? packagePreview ? `导入 ${packageSelection.size} 篇` : '检查导入包' : '加入导入队列'}</button></footer>
  </section></div>;
}

function SourcesModal({ sources, background, onClose, onSync, onUpdate, onDelete, onImport, onConnections, busySource }: {
  sources: Source[]; onClose: () => void; onSync: (source: Source) => void;
  background: BackgroundWorkState;
  onUpdate: (source: Source, patch: Partial<Pick<Source, 'enabled' | 'sync_interval_minutes'>>) => void;
  onDelete: (source: Source) => void; onImport: (file: File) => void; onConnections: () => void; busySource: string | null;
}) {
  const active = sources.filter((source) => source.enabled).length;
  const errors = sources.filter((source) => source.last_status === 'error').length;
  const pauseMessage = background.restoreLocked ? '资料库等待恢复重启，自动同步已暂停。'
    : background.suspended ? 'Mac 正在睡眠，唤醒后自动继续。'
    : background.powerConstrained ? '系统处于严重热状态或主动降频，后台任务已暂停。'
    : background.lowBattery ? '电池电量不高于 20%，自动同步将在充电或电量恢复后继续。'
    : !background.online ? 'Mac 当前离线，自动同步将在网络恢复后继续。'
    : '';
  const statusLabel: Record<Source['last_status'], string> = { idle: '待同步', syncing: '同步中', ok: '已更新', error: '需处理', not_modified: '无更新' };
  const intervalLabel: Record<number, string> = { 15: '15 分钟', 30: '30 分钟', 60: '1 小时', 360: '6 小时', 1440: '每天', 10080: '每周' };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal sources-modal" role="dialog" aria-modal="true" aria-label="订阅管理">
    <header><div><span className="eyebrow">自动采集</span><h2>订阅中心</h2></div><div className="source-header-actions"><button className="button" type="button" onClick={onConnections}>连接器</button><FilePickerButton className="button source-import" ariaLabel="导入 OPML 文件" accept=".opml,.xml,text/x-opml" onFiles={(files) => { const file = files[0]; if (file) onImport(file); }}>导入 OPML</FilePickerButton><a className="button" href="/api/sources/opml">导出</a><button className="icon-button" type="button" aria-label="关闭订阅管理" onClick={onClose}>×</button></div></header>
    <div className="source-overview"><span><strong>{sources.length}</strong><small>全部来源</small></span><span><strong>{active}</strong><small>自动同步</small></span><span className={errors ? 'warning' : ''}><strong>{errors}</strong><small>需要处理</small></span><p className={pauseMessage ? 'warning' : ''} role="status" aria-live="polite">{pauseMessage || 'RSS、YouTube、X 与微博统一在后台增量同步，正文和状态都保存在本机。'}</p></div>
    <div className="source-list">{sources.length === 0 ? <div className="empty-state"><strong>尚未添加订阅</strong><span>从“添加”菜单加入 RSS、YouTube、X 或微博账号，也可以导入 OPML。</span></div> : sources.map((source) => {
      const busy = busySource === source.id;
      const kindLabel: Record<Source['kind'], string> = { rss: 'RSS', youtube: 'YT', x: 'X', weibo: '微' };
      const rateText = source.kind === 'x' && source.rate_limit_remaining !== null ? ` · X 额度余 ${source.rate_limit_remaining}` : '';
      return <article className={`source-row ${!source.enabled ? 'disabled' : ''}`} key={source.id}>
        <span className="source-kind" data-kind={source.kind}>{kindLabel[source.kind]}</span>
        <span className="source-copy"><span className="source-name"><strong>{source.title}</strong><i data-status={source.last_status}>{statusLabel[source.last_status]}</i></span><small className="source-url">{source.url}</small><small className={source.last_error ? 'source-error' : ''}>{source.last_error || `上次 ${formatMoment(source.last_fetched_at)} · 下次 ${source.enabled ? formatMoment(source.next_fetch_at) : '已暂停'}${source.last_sync_count ? ` · 新增 ${source.last_sync_count} 条` : ''}${rateText}`}</small></span>
        <span className="source-controls"><label className="source-switch"><input type="checkbox" checked={source.enabled} disabled={busy} onChange={(event) => onUpdate(source, { enabled: event.target.checked })}/><span></span><em>{source.enabled ? '开启' : '暂停'}</em></label><select aria-label={`${source.title} 同步间隔`} value={source.sync_interval_minutes} disabled={busy || !source.enabled} onChange={(event) => onUpdate(source, { sync_interval_minutes: Number(event.target.value) })}>{[15,30,60,360,1440,10080].map((minutes) => <option key={minutes} value={minutes}>{intervalLabel[minutes]}</option>)}</select><button className="button" type="button" disabled={busy} onClick={() => onSync(source)}>{busy ? '处理中…' : '立即同步'}</button><button className="icon-button source-delete" type="button" aria-label={`删除 ${source.title}`} disabled={busy} onClick={() => onDelete(source)}>×</button></span>
      </article>;
    })}</div>
    <footer className="source-footer"><span>删除订阅不会删除已经保存的文章。</span><span>失败会自动退避，恢复后继续按设定频率同步。</span></footer>
  </section></div>;
}

function CollectionManagerModal({ collections, busy, onClose, onCreate, onUpdate, onDelete, onReorder }: {
  collections: Collection[]; busy: boolean; onClose: () => void;
  onCreate: (name: string, parentId: string | null) => Promise<void>;
  onUpdate: (id: string, patch: { name?: string; parent_id?: string | null }) => Promise<void>;
  onDelete: (collection: Collection) => Promise<void>;
  onReorder: (parentId: string | null, orderedIds: string[]) => Promise<void>;
}) {
  const rows = flattenedCollections(collections);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string>('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const editing = rows.find((row) => row.id === editingId) || null;
  const blockedParents = new Set(editing ? rows.filter((row) => row.id === editing.id || row.path.startsWith(`${editing.path} / `)).map((row) => row.id) : []);
  const reset = () => { setEditingId(null); setName(''); setParentId(''); };
  const beginCreate = (parent: Collection | null = null) => { setEditingId(null); setName(''); setParentId(parent?.id || ''); };
  const beginEdit = (collection: Collection) => { setEditingId(collection.id); setName(collection.name); setParentId(collection.parent_id || ''); };
  const submit = async () => {
    const cleanName = name.trim();
    if (!cleanName || busy) return;
    try {
      if (editingId) await onUpdate(editingId, { name: cleanName, parent_id: parentId || null });
      else await onCreate(cleanName, parentId || null);
      reset();
    } catch {}
  };
  const reorderBefore = async (target: Collection) => {
    if (!draggingId || draggingId === target.id || busy) return;
    const dragged = rows.find((row) => row.id === draggingId);
    if (!dragged || dragged.parent_id !== target.parent_id) return;
    const siblings = rows.filter((row) => row.parent_id === target.parent_id).map((row) => row.id);
    const next = siblings.filter((id) => id !== draggingId);
    next.splice(next.indexOf(target.id), 0, draggingId);
    setDraggingId(null);
    await onReorder(target.parent_id, next);
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal collections-modal" role="dialog" aria-modal="true" aria-label="资料夹管理">
    <header><div><span className="eyebrow">树形整理</span><h2>资料夹</h2></div><button className="icon-button" type="button" aria-label="关闭资料夹管理" onClick={onClose}>×</button></header>
    <div className="collections-workspace">
      <section className="collection-list"><div className="collection-list-heading"><span><strong>{collections.length}</strong><small>个本地资料夹</small></span><button className="button" type="button" onClick={() => beginCreate()}>＋ 新建</button></div>
        <div className="collection-rows">{rows.map((collection) => <article key={collection.id} draggable className={`${editingId === collection.id ? 'editing' : ''} ${draggingId === collection.id ? 'dragging' : ''}`} style={{ paddingLeft: 14 + collection.depth * 24 }}
          onDragStart={(event) => { setDraggingId(collection.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', collection.name); }}
          onDragEnd={() => setDraggingId(null)}
          onDragOver={(event) => { const dragged = rows.find((row) => row.id === draggingId); if (dragged?.parent_id === collection.parent_id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
          onDrop={(event) => { event.preventDefault(); void reorderBefore(collection); }}>
          <span className="collection-drag-handle" title="拖动排序">⋮⋮</span><span className="collection-folder">{collection.child_count ? '▿' : '□'}</span><span className="collection-copy"><strong>{collection.name}</strong><small>{collection.article_count} 条内容{collection.child_count ? ` · ${collection.child_count} 个子资料夹` : ''}</small></span><span className="collection-actions"><button type="button" onClick={() => beginCreate(collection)}>＋ 子资料夹</button><button type="button" onClick={() => beginEdit(collection)}>编辑</button>{!collection.is_system && <button className="danger-link" type="button" disabled={busy} onClick={() => void onDelete(collection)}>删除</button>}</span>
        </article>)}</div>
      </section>
      <form className="collection-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}><span className="eyebrow">{editing ? '编辑资料夹' : parentId ? '创建子资料夹' : '创建资料夹'}</span><h3>{editing?.name || '为内容建立长期秩序'}</h3><p>资料夹支持多层嵌套；删除资料夹时，其中的内容会安全移回收件箱。</p><label><span>名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：研究 / 产品"/></label><label><span>上级资料夹</span><select value={parentId} onChange={(event) => setParentId(event.target.value)}><option value="">无（顶层）</option>{rows.filter((row) => !blockedParents.has(row.id)).map((row) => <option key={row.id} value={row.id}>{'— '.repeat(row.depth)}{row.name}</option>)}</select></label><div className="collection-form-actions"><button className="button" type="button" onClick={reset}>清空</button><button className="button primary" type="submit" disabled={!name.trim() || busy}>{busy ? '正在保存…' : editing ? '保存修改' : '创建资料夹'}</button></div></form>
    </div>
    <footer className="source-footer"><span>同一级资料夹可直接拖动排序；文章可从列表拖到左侧资料夹。</span><span>父资料夹计数包含全部子资料夹内容。</span></footer>
  </section></div>;
}

function SmartCollectionManagerModal({ smartCollections, collections, tags, busy, onClose, onCreate, onUpdate, onDelete, onReorder }: {
  smartCollections: SmartCollection[]; collections: Collection[]; tags: Tag[]; busy: boolean; onClose: () => void;
  onCreate: (name: string, rule: SmartCollectionRule) => Promise<void>;
  onUpdate: (id: string, patch: { name?: string; rule?: SmartCollectionRule }) => Promise<void>;
  onDelete: (collection: SmartCollection) => Promise<void>;
  onReorder: (orderedIds: string[]) => Promise<void>;
}) {
  const collectionRows = flattenedCollections(collections);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [rule, setRule] = useState<SmartCollectionRule>(emptySmartRule);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const editing = smartCollections.find((item) => item.id === editingId) || null;
  const reset = () => { setEditingId(null); setName(''); setRule(emptySmartRule()); };
  const beginEdit = (collection: SmartCollection) => { setEditingId(collection.id); setName(collection.name); setRule({ ...collection.rule, types: [...collection.rule.types], tags: [...collection.rule.tags] }); };
  const setRulePatch = (patch: Partial<SmartCollectionRule>) => setRule((current) => ({ ...current, ...patch }));
  const triState = (value: string): boolean | null => value === 'true' ? true : value === 'false' ? false : null;
  const submit = async () => {
    const cleanName = name.trim();
    if (!cleanName || !smartRuleHasCriteria(rule) || busy) return;
    try {
      if (editingId) await onUpdate(editingId, { name: cleanName, rule });
      else await onCreate(cleanName, rule);
      reset();
    } catch {}
  };
  const reorderBefore = async (targetId: string) => {
    if (!draggingId || draggingId === targetId || busy) return;
    const ids = smartCollections.map((item) => item.id).filter((id) => id !== draggingId);
    ids.splice(ids.indexOf(targetId), 0, draggingId);
    setDraggingId(null);
    await onReorder(ids);
  };
  return <div className="modal-backdrop smart-collections-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal smart-collections-modal" role="dialog" aria-modal="true" aria-label="智能资料夹管理">
    <header><div><span className="eyebrow">动态整理</span><h2>智能资料夹</h2><p>内容仍留在原资料夹；规则变化时，结果会自动更新。</p></div><button className="icon-button" type="button" aria-label="关闭智能资料夹管理" onClick={onClose}>×</button></header>
    <div className="smart-collections-workspace">
      <aside className="smart-collection-list">
        <div className="smart-list-heading"><span><strong>{smartCollections.length}</strong><small>个动态视图</small></span><button className="button" type="button" onClick={reset}>＋ 新建</button></div>
        <div className="smart-list-rows">{smartCollections.map((collection, index) => <article key={collection.id} draggable className={`${editingId === collection.id ? 'editing' : ''} ${draggingId === collection.id ? 'dragging' : ''}`}
          onDragStart={(event) => { setDraggingId(collection.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', collection.name); }}
          onDragEnd={() => setDraggingId(null)}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }}
          onDrop={(event) => { event.preventDefault(); void reorderBefore(collection.id); }}>
          <span className="smart-order">{String(index + 1).padStart(2, '0')}</span><span className="smart-list-copy"><span><strong>{collection.name}</strong><i>{collection.article_count}</i></span><small>{describeSmartRule(collection.rule)}</small></span><span className="smart-list-actions"><button type="button" onClick={() => beginEdit(collection)}>编辑</button><button className="danger-link" type="button" onClick={() => void onDelete(collection)}>删除</button></span>
        </article>)}</div>
        {!smartCollections.length && <div className="smart-list-empty"><span>✦</span><strong>让资料自己归位</strong><small>从右侧设置第一组规则。</small></div>}
      </aside>
      <form className="smart-rule-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="smart-rule-intro"><span className="eyebrow">{editing ? '编辑动态视图' : '新建动态视图'}</span><h3>{editing?.name || '把常用筛选保存下来'}</h3><div className="match-switch" role="group" aria-label="规则匹配方式"><button type="button" aria-pressed={rule.match === 'all'} className={rule.match === 'all' ? 'active' : ''} onClick={() => setRulePatch({ match: 'all' })}>全部满足</button><button type="button" aria-pressed={rule.match === 'any'} className={rule.match === 'any' ? 'active' : ''} onClick={() => setRulePatch({ match: 'any' })}>任一满足</button></div></div>
        <label className="smart-name"><span>名称</span><input autoFocus value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="例如：本周待读"/></label>
        <div className="smart-rule-grid">
          <label><span>正文、标题或作者包含</span><input value={rule.query} maxLength={200} onChange={(event) => setRulePatch({ query: event.target.value })} placeholder="关键词（可选）"/></label>
          <label><span>来源包含</span><input value={rule.source} maxLength={120} onChange={(event) => setRulePatch({ source: event.target.value })} placeholder="公众号、作者或站点"/></label>
          <label><span>标签</span><input value={rule.tags.join(', ')} onChange={(event) => setRulePatch({ tags: [...new Set(event.target.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))].slice(0, 10) })} placeholder={tags.slice(0, 3).map((tag) => tag.name).join('、') || '多个标签用逗号分隔'}/><select aria-label="标签匹配方式" value={rule.tag_match} onChange={(event) => setRulePatch({ tag_match: event.target.value as 'all' | 'any' })}><option value="any">任一标签</option><option value="all">全部标签</option></select></label>
          <label><span>原资料夹</span><select value={rule.collection_id || ''} onChange={(event) => setRulePatch({ collection_id: event.target.value || null })}><option value="">不限资料夹</option>{collectionRows.map((collection) => <option key={collection.id} value={collection.id}>{'— '.repeat(collection.depth)}{collection.name}</option>)}</select></label>
        </div>
        <fieldset className="smart-types"><legend>内容类型</legend><div>{smartTypeOptions.map(([value, label]) => <label key={value} className={rule.types.includes(value) ? 'checked' : ''}><input type="checkbox" checked={rule.types.includes(value)} onChange={() => setRulePatch({ types: rule.types.includes(value) ? rule.types.filter((item) => item !== value) : [...rule.types, value] })}/><span>{label}</span></label>)}</div></fieldset>
        <div className="smart-state-grid">
          <label><span>阅读状态</span><select value={rule.unread === null ? '' : String(rule.unread)} onChange={(event) => setRulePatch({ unread: triState(event.target.value) })}><option value="">不限</option><option value="true">未读</option><option value="false">已读</option></select></label>
          <label><span>收藏</span><select value={rule.favorite === null ? '' : String(rule.favorite)} onChange={(event) => setRulePatch({ favorite: triState(event.target.value) })}><option value="">不限</option><option value="true">已收藏</option><option value="false">未收藏</option></select></label>
          <label><span>高亮</span><select value={rule.has_highlights === null ? '' : String(rule.has_highlights)} onChange={(event) => setRulePatch({ has_highlights: triState(event.target.value) })}><option value="">不限</option><option value="true">有高亮</option><option value="false">无高亮</option></select></label>
          <label><span>附件</span><select value={rule.has_attachments === null ? '' : String(rule.has_attachments)} onChange={(event) => setRulePatch({ has_attachments: triState(event.target.value) })}><option value="">不限</option><option value="true">有附件</option><option value="false">无附件</option></select></label>
          <label><span>保存时间</span><select value={rule.created_within_days || ''} onChange={(event) => setRulePatch({ created_within_days: event.target.value ? Number(event.target.value) : null })}><option value="">不限</option><option value="1">今天</option><option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="90">最近 90 天</option><option value="365">最近一年</option></select></label>
        </div>
        <div className={`smart-rule-preview ${smartRuleHasCriteria(rule) ? 'ready' : ''}`}><span>RULE PREVIEW</span><p>{describeSmartRule(rule)}</p></div>
        <div className="smart-form-actions"><button className="button" type="button" onClick={reset}>清空</button><button className="button primary" type="submit" disabled={!name.trim() || !smartRuleHasCriteria(rule) || busy}>{busy ? '正在保存…' : editing ? '保存规则' : '创建智能资料夹'}</button></div>
      </form>
    </div>
    <footer className="source-footer"><span>智能资料夹只保存规则，不复制文章。</span><span>列表可拖动排序；所有规则和顺序都保存在本机。</span></footer>
  </section></div>;
}

function ExportModal({ articles, busy, onClose, onExport }: { articles: ArticleSummary[]; busy: boolean; onClose: () => void; onExport: (includeAttachments: boolean) => Promise<void> }) {
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const attachments = articles.flatMap((article) => article.attachments || []);
  const attachmentBytes = attachments.reduce((sum, attachment) => sum + attachment.byte_size, 0);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section className="modal export-modal" role="dialog" aria-modal="true" aria-label="导出资料包">
    <header><div><span className="eyebrow">Portable Markdown</span><h2>导出资料包</h2></div><button className="icon-button" type="button" aria-label="关闭导出" disabled={busy} onClick={onClose}>×</button></header>
    <div className="export-body"><div className="export-summary"><strong>{articles.length}</strong><span>篇内容将导出为普通 Markdown，不依赖 Reader 即可阅读。</span></div><div className="export-structure"><span className="export-folder">ZIP</span><span><strong>Reader Markdown</strong><small>articles/ · attachments/ · manifest.json</small></span></div><label className="security-toggle export-option"><input type="checkbox" checked={includeAttachments} onChange={(event) => setIncludeAttachments(event.target.checked)}/><span><strong>包含原始附件</strong><small>{attachments.length ? `${attachments.length} 个文件 · ${formatBytes(attachmentBytes)}；正文链接会改为相对路径。` : '所选内容没有附件，资料包仍会包含来源和标签清单。'}</small></span></label><div className="privacy-note"><strong>可验证、可迁移</strong><span>manifest 会保留 Reader ID、原链接、标签和附件 SHA-256。导出不会改变或归档本地资料。</span></div></div>
    <footer><button className="button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="button primary" type="button" disabled={busy} onClick={() => void onExport(includeAttachments)}>{busy ? '正在打包…' : '下载 ZIP'}</button></footer>
  </section></div>;
}

function DuplicateManagerModal({ groups, busy, onClose, onRefresh, onResolve }: { groups: DuplicateGroup[]; busy: boolean; onClose: () => void; onRefresh: () => void; onResolve: (keepId: string, duplicateIds: string[]) => Promise<void> }) {
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id || '');
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) || groups[0] || null;
  const [keepId, setKeepId] = useState(selectedGroup?.articles[0]?.id || '');
  useEffect(() => {
    if (!selectedGroup) { setKeepId(''); return; }
    if (!selectedGroup.articles.some((article) => article.id === keepId)) setKeepId(selectedGroup.articles[0].id);
  }, [selectedGroup, keepId]);
  const resolve = async () => {
    if (!selectedGroup || !keepId) return;
    await onResolve(keepId, selectedGroup.articles.filter((article) => article.id !== keepId).map((article) => article.id));
  };
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}><section className="modal duplicates-modal" role="dialog" aria-modal="true" aria-label="重复内容治理">
    <header><div><span className="eyebrow">Non-destructive cleanup</span><h2>重复内容</h2></div><div className="duplicate-header-actions"><button className="button" type="button" disabled={busy} onClick={onRefresh}>重新检查</button><button className="icon-button" type="button" aria-label="关闭重复内容" disabled={busy} onClick={onClose}>×</button></div></header>
    {!groups.length ? <div className="duplicate-empty"><span className="duplicate-clean-mark">✓</span><strong>资料库很干净</strong><p>没有发现正文、原链接或标题摘要相同的活动内容。归档内容不会参与检查。</p><button className="button" type="button" onClick={onRefresh}>再次检查</button></div> : <div className="duplicates-workspace"><aside className="duplicate-groups"><div className="duplicate-overview"><strong>{groups.length}</strong><span>组待处理</span></div>{groups.map((group) => <button type="button" key={group.id} aria-pressed={selectedGroup?.id === group.id} className={selectedGroup?.id === group.id ? 'active' : ''} onClick={() => { setSelectedGroupId(group.id); setKeepId(group.articles[0].id); }}><span><strong>{group.articles[0].title}</strong><i>{group.confidence === 'exact' ? '精确' : '高置信'}</i></span><small>{group.articles.length} 条 · {group.reasons.join('、')}</small></button>)}</aside><section className="duplicate-review"><header><span><strong>选择要保留的版本</strong><small>其余内容只会归档，原文和附件不会删除。</small></span></header><div className="duplicate-versions">{selectedGroup?.articles.map((article) => <label key={article.id} className={keepId === article.id ? 'selected' : ''}><input type="radio" name="duplicate-keeper" checked={keepId === article.id} onChange={() => setKeepId(article.id)}/><span className="duplicate-radio"></span><span className="duplicate-copy"><span><strong>{article.title}</strong>{article.is_favorite && <i>已收藏</i>}</span><small>{article.source || '本地内容'} · {formatDate(article.created_at)} · {article.content_length.toLocaleString()} 字符</small><p>{article.excerpt || '没有摘要'}</p></span></label>)}</div><footer><span>标签、收藏和最远阅读进度会合并到保留版本。</span><button className="button danger" type="button" disabled={busy || !selectedGroup} onClick={() => void resolve()}>{busy ? '正在整理…' : `保留此版本，归档 ${(selectedGroup?.articles.length || 1) - 1} 条`}</button></footer></section></div>}
    <footer className="source-footer"><span>检测最多扫描最近 5,000 条活动内容。</span><span>误判后可在“归档”中恢复副本。</span></footer>
  </section></div>;
}

function ImportQueueModal({ jobs, background, busy, onClose, onRetry, onTogglePaused }: { jobs: ImportJob[]; background: BackgroundWorkState; busy: boolean; onClose: () => void; onRetry: (job: ImportJob) => void; onTogglePaused: () => void }) {
  const statusLabel: Record<ImportJob['status'], string> = { pending: '等待中', running: '正在导入', completed: '已完成', failed: '失败' };
  const activeCount = jobs.filter((job) => job.status === 'pending' || job.status === 'running').length;
  const pauseLabels: Record<string, string> = { user: '手动暂停', restore: '等待资料恢复', suspended: 'Mac 已休眠', 'system-constrained': '系统资源受限' };
  const pauseDescription = background.importPauseReasons.map((reason) => pauseLabels[reason] || reason).join('、');
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal queue-modal" role="dialog" aria-modal="true" aria-label="导入队列">
    <header><div><span className="eyebrow">可恢复任务</span><h2>导入队列</h2></div><button className="icon-button" type="button" aria-label="关闭导入队列" onClick={onClose}>×</button></header>
    <div className="queue-summary" aria-live="polite"><strong>{activeCount}</strong><span>{background.importsPaused ? `个任务等待处理。队列已暂停：${pauseDescription || '系统条件限制'}。` : '个任务正在处理。应用重启后，未完成任务会自动继续。'}</span><button className="button" type="button" aria-pressed={background.importUserPaused} disabled={busy} onClick={onTogglePaused}>{busy ? '正在更新…' : background.importUserPaused ? '继续队列' : '暂停队列'}</button></div>
    <div className="job-list">{jobs.length === 0 ? <div className="empty-state"><strong>队列为空</strong><span>添加网页或附件后，可以在这里查看处理进度。</span></div> : jobs.map((job) => <article className="job-row" key={job.id}>
      <span className={`job-state ${job.status}`} aria-hidden="true">{job.status === 'completed' ? '✓' : job.status === 'failed' ? '!' : job.status === 'running' ? '↻' : '·'}</span>
      <span className="job-copy"><strong>{job.kind === 'attachment' ? job.payload.fileName || '本地附件' : job.payload.url || '网页内容'}</strong><small>{statusLabel[job.status]} · {formatDate(job.created_at)}{job.attempts ? ` · 尝试 ${job.attempts} 次` : ''}</small>{job.error && <em>{job.error}</em>}</span>
      {job.status === 'failed' && <button className="button" type="button" onClick={() => onRetry(job)}>重试</button>}
    </article>)}</div>
  </section></div>;
}

function VersionHistoryModal({ article, revisions, preview, busy, onClose, onSelect, onRestore }: { article: Article; revisions: ArticleRevisionSummary[]; preview: ArticleRevision | null; busy: boolean; onClose: () => void; onSelect: (version: number) => void; onRestore: (version: number) => void }) {
  const reasonLabel = (reason: string) => reason === 'created' || reason === 'baseline' ? '初始版本' : reason.startsWith('restore:') ? `恢复自 v${reason.split(':')[1]}` : '编辑保存';
  const newestVersion = revisions[0]?.version || 1;
  return <div className="modal-backdrop history-backdrop"><section className="modal history-modal" role="dialog" aria-modal="true" aria-label="版本历史">
    <header><div><span className="eyebrow">可恢复编辑</span><h2>版本历史</h2></div><button className="icon-button" type="button" aria-label="关闭版本历史" onClick={onClose}>×</button></header>
    <div className="history-workspace">
      <aside className="revision-list"><div className="history-summary"><strong>{revisions.length}</strong><span>个本地版本</span></div>{revisions.map((revision) => <button key={revision.id} type="button" aria-current={preview?.version === revision.version ? 'true' : undefined} className={preview?.version === revision.version ? 'active' : ''} onClick={() => onSelect(revision.version)}>
        <span><strong>版本 {revision.version}</strong>{revision.version === newestVersion && <i>当前</i>}</span><small>{reasonLabel(revision.reason)} · {formatDate(revision.created_at)}</small><em>{revision.title}</em>
      </button>)}</aside>
      <section className="revision-preview">{preview ? <><header><span><strong>版本 {preview.version}</strong><small>{new Date(preview.created_at).toLocaleString('zh-CN')}</small></span><button className="button" type="button" disabled={busy || preview.version === newestVersion} onClick={() => onRestore(preview.version)}>{busy ? '正在恢复…' : preview.version === newestVersion ? '当前版本' : '恢复为此版本'}</button></header><article lang={preview.language}><h1>{preview.title}</h1>{preview.excerpt && <p className="dek">{preview.excerpt}</p>}<ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown></article></> : <div className="empty-state"><strong>选择一个版本</strong><span>历史内容只保存在本机。</span></div>}</section>
    </div>
  </section></div>;
}

const diagnosticEventLabels: Record<DiagnosticEntry['event'], string> = {
  app_started: 'Reader 已启动',
  app_stopped: 'Reader 已安全退出',
  startup_failed: '启动检查失败',
  api_error: '本地请求失败',
  backup_created: '完整备份已创建',
  restore_scheduled: '资料库恢复已安排',
  restore_cancelled: '资料库恢复已取消',
  data_repair_completed: '资料库安全修复完成',
  renderer_gone: '阅读界面意外停止'
};

const diagnosticRouteLabels: Record<string, string> = {
  health: '运行状态', stats: '资料统计', articles: '文章', imports: '导入', ai: 'AI', sources: '订阅',
  backups: '备份', data_health: '资料库检查', migration_snapshots: '升级快照', attachments: '附件',
  settings: '设置', collections: '资料夹', smart_collections: '智能资料夹', duplicates: '重复治理',
  export: '导出', diagnostics: '本地日志', static: '界面资源', unknown: '本地服务'
};

const diagnosticCategoryLabels: Record<string, string> = {
  request: '请求无效', database: '数据库异常', filesystem: '文件系统异常',
  network: '网络异常', network_timeout: '网络超时', internal: '内部异常'
};

function diagnosticDetail(entry: DiagnosticEntry) {
  const details = entry.details;
  if (entry.event === 'app_started') return `Reader ${details.version || ''} · Schema v${details.schemaVersion ?? '—'}${details.restored ? ' · 已应用待恢复资料' : ''}`;
  if (entry.event === 'startup_failed') return `${details.phase === 'restore' ? '恢复阶段' : details.phase === 'database' ? '数据库阶段' : '服务阶段'} · ${diagnosticCategoryLabels[String(details.category)] || '内部异常'}`;
  if (entry.event === 'api_error') return `${diagnosticRouteLabels[String(details.route)] || '本地服务'} · ${details.status || 500} · ${diagnosticCategoryLabels[String(details.category)] || '内部异常'}`;
  if (entry.event === 'backup_created') return `${details.encrypted ? '口令加密' : '本机明文'} · ${formatBytes(Number(details.byteSize) || 0)}`;
  if (entry.event === 'restore_scheduled') return details.source === 'migration_snapshot' ? '升级快照已验证，等待下次启动' : details.encrypted ? '加密备份已验证，等待下次启动' : '备份已验证，等待下次启动';
  if (entry.event === 'renderer_gone') {
    const reason = String(details.reason);
    return reason === 'oom' || reason === 'memory-eviction' ? '界面内存不足 · 本地服务与资料库未中断' : '界面进程异常退出 · 本地服务与资料库未中断';
  }
  if (entry.event === 'data_repair_completed') {
    const actions = Array.isArray(details.actions) ? details.actions.map((action) => action === 'storage_permissions' ? '本地权限' : action === 'search_index' ? '搜索索引' : '').filter(Boolean) : [];
    return `${actions.join('、') || '可重建项目'}${details.backupCreated ? ' · 已保留修复前备份' : ''}`;
  }
  return '没有记录正文、文件名、路径或凭据';
}

function DiagnosticsModal({ diagnostics, busy, onClose, onRefresh, onClear }: { diagnostics: DiagnosticsSnapshot | null; busy: boolean; onClose: () => void; onRefresh: () => void; onClear: () => void }) {
  return <div className="modal-backdrop diagnostics-backdrop"><section className="modal diagnostics-modal" role="dialog" aria-modal="true" aria-label="本地运行日志">
    <header><div><span className="eyebrow">On-device diagnostics</span><h2>本地运行日志</h2><p>只记录受限事件代码与状态，不记录阅读内容。</p></div><button className="icon-button" type="button" aria-label="关闭本地日志" disabled={busy} onClick={onClose}>×</button></header>
    <div className="diagnostics-summary">
      <span><strong>{diagnostics?.entries.length ?? 0}</strong><small>当前可见事件</small></span>
      <span><strong>{formatBytes(diagnostics?.byte_size || 0)}</strong><small>本地占用</small></span>
      <span><strong>{diagnostics?.file_count ?? 0}</strong><small>轮转文件</small></span>
      <p>{diagnostics?.available === false ? '日志存储当前不可用；Reader 的资料库功能不受影响。' : `最多保留 ${formatBytes(diagnostics?.max_bytes || 0)}，超出后自动轮转。`}</p>
    </div>
    <div className="diagnostics-body">
      <div className="diagnostics-privacy"><i>⌁</i><span><strong>留在本机，不是遥测</strong><small>不记录标题、正文、附件名、URL、磁盘路径、记录 ID、错误原文或密钥；不会进入备份，也不会自动上传。</small></span></div>
      <div className="diagnostics-list" aria-live="polite">
        {busy && !diagnostics ? <div className="empty-state compact"><strong>正在读取本地日志…</strong><span>只读取权限受限的诊断文件。</span></div> : diagnostics?.entries.length ? diagnostics.entries.map((entry) => <article key={entry.id} data-level={entry.level}>
          <span className="diagnostic-level">{entry.level === 'error' ? '×' : entry.level === 'warning' ? '!' : '·'}</span>
          <span><strong>{diagnosticEventLabels[entry.event]}</strong><small>{diagnosticDetail(entry)}</small></span>
          <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString('zh-CN')}</time>
        </article>) : <div className="empty-state compact"><strong>当前没有运行日志</strong><span>后续启动、备份、恢复、修复或内部错误会以脱敏事件记录。</span></div>}
      </div>
    </div>
    <footer><button className="button quiet-danger diagnostics-clear" type="button" disabled={busy || !diagnostics?.entries.length} onClick={onClear}>清除日志</button><span className="diagnostics-footer-spacer"></span><a className="button" href="/api/diagnostics/logs/download" download>导出 JSONL</a><button className="button" type="button" disabled={busy} onClick={onRefresh}>{busy ? '读取中…' : '刷新'}</button><button className="button primary" type="button" disabled={busy} onClick={onClose}>完成</button></footer>
  </section></div>;
}

function DataSafetyModal({ backups, migrationSnapshots, health, pendingRestore, busy, onClose, onCheck, onRepair, onDiagnostics, onCreate, onScheduleRestore, onScheduleSnapshotRestore, onCancelRestore }: { backups: Backup[]; migrationSnapshots: MigrationSnapshot[]; health: DataHealth | null; pendingRestore: PendingRestore | null; busy: boolean; onClose: () => void; onCheck: () => void; onRepair: () => void; onDiagnostics: () => void; onCreate: (passphrase?: string) => void; onScheduleRestore: (file: File, passphrase?: string) => void; onScheduleSnapshotRestore: (snapshot: MigrationSnapshot) => void; onCancelRestore: () => void }) {
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [encryptBackup, setEncryptBackup] = useState(true);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [backupPassphraseAgain, setBackupPassphraseAgain] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const restoreEncrypted = Boolean(restoreFile?.name.toLowerCase().endsWith('.enc'));
  const passphraseLongEnough = Array.from(backupPassphrase).length >= 12;
  const canCreate = !busy && (!encryptBackup || (passphraseLongEnough && backupPassphrase === backupPassphraseAgain));
  const canRestore = !busy && Boolean(restoreFile) && confirmation === '恢复' && (!restoreEncrypted || Boolean(restorePassphrase));
  return <div className="modal-backdrop safety-backdrop"><section className="modal safety-modal" role="dialog" aria-modal="true" aria-label="数据安全中心">
    <header><div><span className="eyebrow">Local-first</span><h2>数据安全中心</h2></div><button className="icon-button" type="button" aria-label="关闭数据安全中心" onClick={onClose}>×</button></header>
    <div className="safety-grid">
      <section className="safety-section"><header><span><strong>资料库与备份</strong><small>先检查，再创建可验证恢复点</small></span></header>
        <div className={`data-health-card ${health?.status || 'checking'}`} aria-live="polite">
          <header><span className="health-mark">{health?.status === 'healthy' ? '✓' : health?.status === 'warning' ? '!' : health?.status === 'error' ? '×' : '···'}</span><span><strong>{health?.status === 'healthy' ? '资料库状态正常' : health?.status === 'warning' ? '资料库有待处理项' : health?.status === 'error' ? '资料库发现问题' : '正在检查资料库'}</strong><small>{health ? `${new Date(health.checked_at).toLocaleString('zh-CN')} · ${health.duration_ms} ms · ${formatBytes(health.database.byte_size)}` : '完整性、关联、迁移、权限、附件与索引'}</small></span><span className="health-actions"><button className="button" type="button" disabled={busy} onClick={onCheck}>{busy ? '处理中…' : '重新检查'}</button>{health?.repair.available && <button className="button primary" type="button" disabled={busy} onClick={onRepair}>{busy ? '修复中…' : '安全修复'}</button>}</span></header>
          {health && <div className="data-health-checks">{health.checks.map((item) => <span key={item.id} data-status={item.status}><i>{item.status === 'pass' ? '✓' : item.status === 'warning' ? '!' : '×'}</i><span><strong>{item.label}</strong><small>{item.detail}</small></span></span>)}</div>}
          {health?.repair.available && <p className="health-repair-note">只处理可重建的本地权限与搜索索引；不会改动正文或附件。写入索引前会自动创建完整安全备份。</p>}
          {health && health.repair.blockers.length > 0 && <p className="health-repair-note blocked">结构、关联、迁移或附件异常不会自动修复，请优先使用可靠备份恢复。</p>}
        </div>
        <div className="backup-creator">
          <label className="security-toggle"><input type="checkbox" checked={encryptBackup} onChange={(event) => setEncryptBackup(event.target.checked)}/><span><strong>使用口令加密</strong><small>推荐。下载或复制备份后，只有持有口令的人可以恢复。</small></span></label>
          {encryptBackup && <><div className="passphrase-grid"><label><span>备份口令</span><input type="password" value={backupPassphrase} onChange={(event) => setBackupPassphrase(event.target.value)} autoComplete="new-password" aria-label="备份口令" placeholder="至少 12 个字符"/></label><label><span>再次输入</span><input type="password" value={backupPassphraseAgain} onChange={(event) => setBackupPassphraseAgain(event.target.value)} autoComplete="new-password" aria-label="确认备份口令" placeholder="重复口令"/></label></div><p className={`passphrase-note ${backupPassphraseAgain && backupPassphrase !== backupPassphraseAgain ? 'error' : ''}`}>{backupPassphraseAgain && backupPassphrase !== backupPassphraseAgain ? '两次输入的口令不一致。' : 'Reader 不保存口令。遗忘后无法恢复这份备份。'}</p></>}
          <button className="button primary create-backup-button" type="button" disabled={!canCreate} onClick={() => onCreate(encryptBackup ? backupPassphrase : undefined)}>{busy ? '正在校验…' : encryptBackup ? '创建加密备份' : '创建明文备份'}</button>
        </div>
        <div className="backup-list">{backups.length ? backups.map((backup) => <article key={backup.id}><span className={`backup-mark ${backup.encrypted ? 'encrypted' : ''}`} title={backup.encrypted ? '口令加密备份' : '明文备份'}>{backup.encrypted ? 'E' : 'B'}</span><span><strong>{formatDate(backup.created_at)} 的备份</strong><small>{formatBytes(backup.byte_size)} · {backup.encrypted ? 'AES-256-GCM 加密' : '本机明文文件'}</small></span><a className="button" href={`/api/backups/${backup.id}/download`}>下载</a></article>) : <div className="empty-state compact"><strong>还没有备份</strong><span>创建首个可验证恢复点。</span></div>}</div>
      </section>
      <section className="safety-section restore-section"><header><span><strong>恢复资料库</strong><small>先校验，再安排下次启动恢复</small></span></header>
        {pendingRestore ? <div className="pending-restore"><span className="pending-icon">↻</span><strong>{pendingRestore.kind === 'migration_snapshot' ? '升级快照恢复已就绪' : '恢复已就绪'}</strong><p>{pendingRestore.kind === 'migration_snapshot' ? `下次启动将回到 Schema v${pendingRestore.fromSchemaVersion} 的升级前状态，再重新迁移；当前完整资料和附件已创建安全备份。为保证备份边界，资料库写入和后台同步已暂停。` : '下次重新启动 Reader 时应用。当前资料已经自动创建安全备份；资料库写入和后台同步已暂停。'}</p><button className="button" type="button" disabled={busy} onClick={onCancelRestore}>取消恢复并继续使用</button></div> : <><FilePickerButton className="restore-file" ariaLabel={restoreFile ? `更换 Reader 备份，当前为 ${restoreFile.name}` : '选择 Reader 备份'} accept=".zip,.enc,.readerbackup" onFiles={(files) => { setRestoreFile(files[0] || null); setRestorePassphrase(''); }}><span className="restore-icon">＋</span><strong>{restoreFile ? restoreFile.name : '选择 Reader 备份'}</strong><small>{restoreFile ? `${formatBytes(restoreFile.size)}${restoreEncrypted ? ' · 已加密' : ''}` : '接受 .readerbackup.enc 和 .readerbackup.zip'}</small></FilePickerButton>{restoreEncrypted && <label className="confirm-restore"><span>加密备份口令</span><input type="password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} autoComplete="current-password" aria-label="恢复备份口令" placeholder="输入创建备份时的口令"/></label>}<label className="confirm-restore"><span>输入“恢复”确认安排</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} aria-label="恢复确认" placeholder="恢复"/></label><button className="button danger" type="button" disabled={!canRestore} onClick={() => restoreFile && onScheduleRestore(restoreFile, restoreEncrypted ? restorePassphrase : undefined)}>校验并安排恢复</button></>}
        <div className="migration-protection">
          <header><span><strong>升级保护</strong><small>schema 变更前自动创建数据库快照</small></span></header>
          {migrationSnapshots.length ? <div className="migration-snapshot-list">{migrationSnapshots.map((snapshot) => <article key={snapshot.id}>
            <span className="backup-mark migration">M</span>
            <span><strong>Schema v{snapshot.from_schema_version} → v{snapshot.to_schema_version}</strong><small>{new Date(snapshot.created_at).toLocaleString('zh-CN')} · {formatBytes(snapshot.byte_size)}</small></span>
            <span className="migration-snapshot-actions"><a className="button" href={`/api/migration-snapshots/${snapshot.id}/download`} download>导出</a><button className="button quiet-danger" type="button" disabled={busy || Boolean(pendingRestore)} onClick={() => onScheduleSnapshotRestore(snapshot)}>恢复</button></span>
          </article>)}</div> : <p className="migration-empty">当前资料库尚未经历需要迁移的升级。</p>}
          <p className="migration-note">升级快照仅包含 SQLite 数据库；恢复会回到升级前记录并重新迁移，之后的变化保存在自动创建的完整安全备份中。长期恢复点仍请使用包含附件的完整备份。</p>
        </div>
      </section>
    </div>
    <footer className="safety-footer"><span>恢复不会立即覆盖数据；Reader 会先创建安全备份，并在下次启动时原子替换。升级快照不会自动删除。</span><button className="button" type="button" onClick={onDiagnostics}>查看本地日志</button></footer>
  </section></div>;
}

function FocusedReaderApp({ articleId }: { articleId: string }) {
  const [article, setArticle] = useState<Article | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(() => localStorage.getItem('reader-theme') || 'light');
  const [toast, setToast] = useState<Toast | null>(null);
  const notify = useCallback((message: string, tone: Toast['tone'] = 'normal') => setToast({ id: Date.now(), message, tone }), []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api.getArticle(articleId)
      .then((next) => { if (!cancelled) setArticle(next); })
      .catch((error) => { if (!cancelled) notify(error instanceof Error ? error.message : '内容加载失败', 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [articleId, notify]);
  useEffect(() => {
    document.title = article ? `${article.title} — Reader` : '专注阅读 — Reader';
  }, [article]);
  useEffect(() => { localStorage.setItem('reader-theme', theme); }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const focusLibrary = () => {
    void window.readerDesktop?.focusLibrary().then((focused) => {
      if (!focused) notify('无法返回资料库', 'error');
    }).catch(() => notify('无法返回资料库', 'error'));
  };
  const openSource = (id: string) => {
    void window.readerDesktop?.openArticleWindow(id).then((opened) => {
      if (!opened) notify('来源内容已不存在', 'error');
    }).catch(() => notify('无法打开来源内容', 'error'));
  };
  return <div className="app-stage focused-reader-stage" data-theme={theme} data-desktop="true">
    <ReaderPane
      article={article}
      loadingTitle={loading ? '专注阅读' : undefined}
      collections={[]}
      focusedCitation={null}
      onDismissCitation={() => {}}
      onPatch={async () => {}}
      onAddTags={async () => {}}
      onRemoveTags={async () => {}}
      onToggleAI={() => {}}
      onEdit={() => {}}
      onHistory={() => {}}
      onOpenSource={openSource}
      onFocusLibrary={focusLibrary}
      onToggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      readOnly
      notify={notify}
    />
    {toast && <div className={`toast ${toast.tone === 'error' ? 'error' : ''}`} role="status">{toast.message}</div>}
  </div>;
}

export function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('readerWindow') === '1') return <FocusedReaderApp articleId={params.get('article') || ''}/>;
  return <ReaderWorkspace/>;
}

function ReaderWorkspace() {
  const isDesktop = new URLSearchParams(window.location.search).get('desktop') === '1';
  const [articles, setArticles] = useState<ArticleSummary[]>([]); const [collections, setCollections] = useState<Collection[]>([]); const [smartCollections, setSmartCollections] = useState<SmartCollection[]>([]); const [tags, setTags] = useState<Tag[]>([]); const [sources, setSources] = useState<Source[]>([]); const [jobs, setJobs] = useState<ImportJob[]>([]); const [stats, setStats] = useState(initialStats);
  const [backgroundWork, setBackgroundWork] = useState(initialBackgroundWorkState);
  const [articleTotal, setArticleTotal] = useState(0); const [articleCursor, setArticleCursor] = useState<string | null>(null); const [loadingMore, setLoadingMore] = useState(false);
  const [revisions, setRevisions] = useState<ArticleRevisionSummary[]>([]); const [revisionPreview, setRevisionPreview] = useState<ArticleRevision | null>(null); const [backups, setBackups] = useState<Backup[]>([]); const [migrationSnapshots, setMigrationSnapshots] = useState<MigrationSnapshot[]>([]); const [dataHealth, setDataHealth] = useState<DataHealth | null>(null); const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null); const [duplicateGroups, setDuplicateGroups] = useState<DuplicateGroup[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [view, setView] = useState<View>('inbox'); const [collectionId, setCollectionId] = useState<string | null>(null); const [smartCollectionId, setSmartCollectionId] = useState<string | null>(null); const [tagFilter, setTagFilter] = useState(''); const [contentFilter, setContentFilter] = useState<ContentFilter>('all'); const [query, setQuery] = useState(''); const [selectedId, setSelectedId] = useState<string | null>(null); const [selected, setSelected] = useState<Article | null>(null); const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true); const [aiOpen, setAIOpen] = useState(true); const [addOpen, setAddOpen] = useState(false); const [editOpen, setEditOpen] = useState(false); const [historyOpen, setHistoryOpen] = useState(false); const [sourcesOpen, setSourcesOpen] = useState(false); const [collectionsOpen, setCollectionsOpen] = useState(false); const [smartCollectionsOpen, setSmartCollectionsOpen] = useState(false); const [queueOpen, setQueueOpen] = useState(false); const [safetyOpen, setSafetyOpen] = useState(false); const [settingsOpen, setSettingsOpen] = useState(false); const [connectorSettingsOpen, setConnectorSettingsOpen] = useState(false); const [exportOpen, setExportOpen] = useState(false); const [composeOpen, setComposeOpen] = useState(false); const [duplicatesOpen, setDuplicatesOpen] = useState(false); const [focusedCitation, setFocusedCitation] = useState<RAGCitation | null>(null); const [busySource, setBusySource] = useState<string | null>(null); const [busyCollection, setBusyCollection] = useState(false); const [busySmartCollection, setBusySmartCollection] = useState(false); const [busyHistory, setBusyHistory] = useState(false); const [busySafety, setBusySafety] = useState(false); const [busyImportQueue, setBusyImportQueue] = useState(false); const [busyExport, setBusyExport] = useState(false); const [busyCompose, setBusyCompose] = useState(false); const [busyDuplicates, setBusyDuplicates] = useState(false); const [aiConfigurationVersion, setAIConfigurationVersion] = useState(0);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false); const [busyDiagnostics, setBusyDiagnostics] = useState(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('reader-theme') || 'light'); const [libraryLayout, setLibraryLayout] = useState<LibraryLayout>(() => localStorage.getItem('reader-library-layout') === 'gallery' ? 'gallery' : 'list'); const [toast, setToast] = useState<Toast | null>(null);
  const [externalAddRequests, setExternalAddRequests] = useState<ExternalAddRequest[]>([]);
  const jobStates = useRef(new Map<string, ImportJob['status']>());
  const articleRequestId = useRef(0);
  const articleDetailRequestId = useRef(0);
  const notify = useCallback((message: string, tone: Toast['tone'] = 'normal') => setToast({ id: Date.now(), message, tone }), []);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(null), 2600); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => { localStorage.setItem('reader-theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('reader-library-layout', libraryLayout); }, [libraryLayout]);
  useEffect(() => window.readerDesktop?.onAddRequest((request) => {
    setExternalAddRequests((current) => current.some((item) => (item.kind === 'url' && request.kind === 'url' && item.url === request.url)
      || (item.kind === 'text' && request.kind === 'text' && item.text === request.text)
      || (item.kind === 'file' && request.kind === 'file' && item.token === request.token)) || current.length >= 20
      ? current
      : [...current, request]);
  }), []);
  useEffect(() => {
    if (externalAddRequests.length) setAddOpen(true);
  }, [externalAddRequests]);

  const articleFilters = useMemo(() => ({
    types: contentFilter === 'articles' ? ['article'] : contentFilter === 'feeds' ? ['rss', 'youtube', 'x', 'weibo'] : contentFilter === 'attachments' ? ['pdf', 'image', 'video', 'attachment'] : contentFilter === 'notes' ? ['markdown'] : undefined,
    tag: tagFilter || undefined,
    mediaOnly: contentFilter === 'media'
  }), [contentFilter, tagFilter]);

  const refreshChrome = useCallback(async () => {
    try { const [nextCollections, nextSmartCollections, nextSources, nextStats, nextTags, nextBackgroundWork] = await Promise.all([api.listCollections(), api.listSmartCollections(), api.listSources(), api.getStats(), api.listTags(), api.getBackgroundWorkState()]); setCollections(nextCollections); setSmartCollections(nextSmartCollections); setSources(nextSources); setStats(nextStats); setTags(nextTags); setBackgroundWork(nextBackgroundWork); }
    catch (error) { notify(error instanceof Error ? error.message : '无法读取本地资料库', 'error'); }
  }, [notify]);

  const refreshArticles = useCallback(async () => {
    const requestId = ++articleRequestId.current;
    setLoadingMore(false);
    setLoading(true);
    try {
      const page = await api.listArticles(view, query, collectionId, articleFilters, smartCollectionId);
      if (requestId !== articleRequestId.current) return;
      setArticles(page.articles); setArticleTotal(page.total); setArticleCursor(page.nextCursor);
      setSelectedId((current) => current && page.articles.some((item) => item.id === current) ? current : page.articles[0]?.id || null);
    } catch (error) { if (requestId === articleRequestId.current) notify(error instanceof Error ? error.message : '内容加载失败', 'error'); }
    finally { if (requestId === articleRequestId.current) setLoading(false); }
  }, [view, query, collectionId, smartCollectionId, articleFilters, notify]);

  const loadMoreArticles = useCallback(async () => {
    if (!articleCursor || loadingMore) return;
    const requestId = articleRequestId.current;
    setLoadingMore(true);
    try {
      const page = await api.listArticles(view, query, collectionId, articleFilters, smartCollectionId, articleCursor);
      if (requestId !== articleRequestId.current) return;
      setArticles((current) => {
        const known = new Set(current.map((article) => article.id));
        return [...current, ...page.articles.filter((article) => !known.has(article.id))];
      });
      setArticleTotal(page.total); setArticleCursor(page.nextCursor);
    } catch (error) { if (requestId === articleRequestId.current) notify(error instanceof Error ? error.message : '更多内容加载失败', 'error'); }
    finally { if (requestId === articleRequestId.current) setLoadingMore(false); }
  }, [articleCursor, loadingMore, view, query, collectionId, smartCollectionId, articleFilters, notify]);

  useEffect(() => { void refreshChrome(); }, [refreshChrome]);
  useEffect(() => { const timer = window.setTimeout(() => void refreshArticles(), query ? 220 : 0); return () => window.clearTimeout(timer); }, [refreshArticles, query]);
  useEffect(() => {
    const requestId = ++articleDetailRequestId.current;
    if (!selectedId) {
      setSelected(null);
      return;
    }
    setSelected((current) => current?.id === selectedId ? current : null);
    void api.getArticle(selectedId).then((article) => {
      if (requestId !== articleDetailRequestId.current) return;
      setSelected(article);
      setArticles((current) => current.map((item) => item.id === article.id ? toArticleSummary(article) : item));
    }).catch((error) => {
      if (requestId === articleDetailRequestId.current) notify(error instanceof Error ? error.message : '正文加载失败', 'error');
    });
  }, [selectedId, notify]);
  useEffect(() => {
    const timer = window.setInterval(() => void refreshChrome(), 30_000);
    return () => window.clearInterval(timer);
  }, [refreshChrome]);
  useEffect(() => { setSelectedIds(new Set()); }, [view, collectionId, smartCollectionId, tagFilter, contentFilter, query]);

  const refreshJobs = useCallback(async () => {
    try {
      const next = await api.listImportJobs();
      let libraryChanged = false;
      for (const job of next) {
        const previous = jobStates.current.get(job.id);
        if (previous && previous !== job.status && job.status === 'completed') libraryChanged = true;
        jobStates.current.set(job.id, job.status);
      }
      setJobs(next);
      if (libraryChanged) await Promise.all([refreshArticles(), refreshChrome()]);
    } catch (error) { notify(error instanceof Error ? error.message : '无法读取导入队列', 'error'); }
  }, [notify, refreshArticles, refreshChrome]);

  const jobPollInterval = jobs.some((job) => job.status === 'pending' || job.status === 'running') && !backgroundWork.importsPaused ? 800 : 5000;
  useEffect(() => { void refreshJobs(); const timer = window.setInterval(() => void refreshJobs(), jobPollInterval); return () => window.clearInterval(timer); }, [refreshJobs, jobPollInterval]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.querySelector<HTMLInputElement>('[aria-label="搜索资料库"]')?.focus(); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') { event.preventDefault(); setAddOpen(true); } if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') { event.preventDefault(); setEditOpen(true); } };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, []);

  const selectedArticles = useMemo(() => articles.filter((article) => selectedIds.has(article.id)), [articles, selectedIds]);
  const selectedSummary = selectedId ? articles.find((article) => article.id === selectedId) : undefined;
  const currentArticle = selected?.id === selectedId ? selected : null;
  const detailAnnouncement = selectedId
    ? currentArticle ? `已载入文章：${currentArticle.title}` : `正在载入文章：${selectedSummary?.title || '当前内容'}`
    : '未选择文章';
  const title = smartCollectionId ? smartCollections.find((item) => item.id === smartCollectionId)?.name || '智能资料夹' : tagFilter ? `# ${tagFilter}` : collectionId ? collections.find((item) => item.id === collectionId)?.name || '资料夹' : viewLabels[view];

  const updateArticleInState = useCallback((article: Article) => {
    setArticles((current) => current.map((item) => item.id === article.id ? toArticleSummary(article) : item));
    setSelected((current) => current?.id === article.id ? article : current);
  }, []);
  const patchSelected = async (patch: Partial<Article>) => {
    if (!selected) return; const optimistic = { ...selected, ...patch }; updateArticleInState(optimistic);
    try { updateArticleInState(await api.updateArticle(selected.id, patch)); await Promise.all([refreshArticles(), refreshChrome()]); }
    catch (error) { updateArticleInState(selected); notify(error instanceof Error ? error.message : '保存失败', 'error'); }
  };
  const selectArticle = (article: ArticleSummary) => { setFocusedCitation(null); setSelectedId(article.id); if (!article.is_read) void api.updateArticle(article.id, { is_read: true }).then((next) => { updateArticleInState(next); void Promise.all([refreshChrome(), refreshArticles()]); }); };
  const addTags = async (nextTags: string[]) => { if (!selected) return; try { updateArticleInState(await api.updateTags(selected.id, nextTags, [])); await refreshChrome(); } catch (error) { notify(error instanceof Error ? error.message : '标签保存失败', 'error'); } };
  const removeTags = async (nextTags: string[]) => { if (!selected) return; try { updateArticleInState(await api.updateTags(selected.id, [], nextTags)); await refreshChrome(); } catch (error) { notify(error instanceof Error ? error.message : '标签移除失败', 'error'); } };
  const toggleSelection = (id: string) => setSelectedIds((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectAll = () => setSelectedIds(new Set(articles.map((article) => article.id)));
  const batchOrganize = async (patch: { collection_id?: string; is_favorite?: boolean; is_read?: boolean; archived?: boolean; tags_add?: string[]; tags_remove?: string[] }, message: string) => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    try { await api.batchUpdateArticles(ids, patch); setSelectedIds(new Set()); await Promise.all([refreshArticles(), refreshChrome()]); notify(message); }
    catch (error) { notify(error instanceof Error ? error.message : '批量整理失败', 'error'); }
  };
  const moveDraggedArticles = async (ids: string[], targetCollectionId: string) => {
    if (!ids.length) return;
    try {
      await api.batchUpdateArticles(ids, { collection_id: targetCollectionId });
      setSelectedIds(new Set());
      await Promise.all([refreshArticles(), refreshChrome()]);
      const target = collections.find((item) => item.id === targetCollectionId);
      notify(`已把 ${ids.length} 条内容移到“${target?.name || '资料夹'}”`);
    } catch (error) { notify(error instanceof Error ? error.message : '拖放整理失败', 'error'); }
  };
  const exportSelected = async (includeAttachments: boolean) => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusyExport(true);
    try {
      const result = await api.exportArticles(ids, includeAttachments);
      setExportOpen(false);
      notify(`已导出 ${ids.length} 条内容：${result.fileName}`);
    } catch (error) { notify(error instanceof Error ? error.message : '导出失败', 'error'); }
    finally { setBusyExport(false); }
  };
  const showDerivedArticle = (article: Article, message: string) => {
    setView('inbox'); setCollectionId(null); setSmartCollectionId(null); setTagFilter(''); setContentFilter('all'); setQuery(''); setSelectedIds(new Set());
    setArticles((current) => [toArticleSummary(article), ...current.filter((item) => item.id !== article.id)]); setSelected(article); setSelectedId(article.id);
    void refreshChrome(); notify(message);
  };
  const composeSelected = async (options: { prompt: string; format: string; language: string; collectionId: string }) => {
    const ids = [...selectedIds]; if (!ids.length) return;
    setBusyCompose(true);
    try { const result = await api.composeArticles(ids, options); setComposeOpen(false); showDerivedArticle(result.article, '创作草稿已保存，并保留全部来源回链'); }
    catch (error) { notify(error instanceof Error ? error.message : '创作草稿生成失败', 'error'); }
    finally { setBusyCompose(false); }
  };
  const openSourceArticle = async (id: string) => {
    try {
      let article = articles.find((item) => item.id === id);
      if (!article) {
        const detail = await api.getArticle(id);
        article = toArticleSummary(detail);
        setSelected(detail);
      }
      setFocusedCitation(null);
      setView('inbox'); setCollectionId(null); setSmartCollectionId(null); setTagFilter(''); setContentFilter('all'); setQuery(''); setSelectedIds(new Set());
      setArticles((current) => current.some((item) => item.id === article.id) ? current : [article, ...current]); setSelectedId(article.id);
      return article;
    } catch (error) { notify(error instanceof Error ? error.message : '来源文章不存在', 'error'); }
  };
  const openCitation = async (citation: RAGCitation) => { const article = await openSourceArticle(citation.articleId); if (article) setFocusedCitation(citation); };
  const refreshDuplicates = async () => {
    setBusyDuplicates(true);
    try { setDuplicateGroups(await api.listDuplicateGroups()); }
    catch (error) { notify(error instanceof Error ? error.message : '重复内容检查失败', 'error'); }
    finally { setBusyDuplicates(false); }
  };
  const openDuplicates = () => { setDuplicatesOpen(true); void refreshDuplicates(); };
  const resolveDuplicateGroup = async (keepId: string, duplicateIds: string[]) => {
    setBusyDuplicates(true);
    try {
      const result = await api.resolveDuplicates(keepId, duplicateIds);
      const [groups] = await Promise.all([api.listDuplicateGroups(), refreshArticles(), refreshChrome()]);
      setDuplicateGroups(groups);
      notify(`已合并标签和阅读状态，${result.archivedIds.length} 条副本移入归档`);
    } catch (error) { notify(error instanceof Error ? error.message : '重复内容整理失败', 'error'); }
    finally { setBusyDuplicates(false); }
  };
  const createCollection = async (name: string, parentId: string | null) => { setBusyCollection(true); try { await api.createCollection(name, parentId); await refreshChrome(); notify('资料夹已创建'); } catch (error) { notify(error instanceof Error ? error.message : '资料夹创建失败', 'error'); throw error; } finally { setBusyCollection(false); } };
  const updateCollection = async (id: string, patch: { name?: string; parent_id?: string | null }) => { setBusyCollection(true); try { await api.updateCollection(id, patch); await refreshChrome(); notify('资料夹已更新'); } catch (error) { notify(error instanceof Error ? error.message : '资料夹更新失败', 'error'); throw error; } finally { setBusyCollection(false); } };
  const reorderCollections = async (parentId: string | null, orderedIds: string[]) => { setBusyCollection(true); try { setCollections(await api.reorderCollections(parentId, orderedIds)); notify('资料夹顺序已保存'); } catch (error) { notify(error instanceof Error ? error.message : '资料夹排序失败', 'error'); throw error; } finally { setBusyCollection(false); } };
  const deleteCollection = async (collection: Collection) => { if (!window.confirm(`删除资料夹“${collection.name}”及其子资料夹？其中的内容会移回收件箱。`)) return; setBusyCollection(true); try { await api.deleteCollection(collection.id); setCollectionId(null); setTagFilter(''); await Promise.all([refreshChrome(), refreshArticles()]); notify('资料夹已删除，内容已移回收件箱'); } catch (error) { notify(error instanceof Error ? error.message : '资料夹删除失败', 'error'); } finally { setBusyCollection(false); } };
  const createSmartCollection = async (name: string, rule: SmartCollectionRule) => { setBusySmartCollection(true); try { await api.createSmartCollection(name, rule); await refreshChrome(); notify('智能资料夹已创建'); } catch (error) { notify(error instanceof Error ? error.message : '智能资料夹创建失败', 'error'); throw error; } finally { setBusySmartCollection(false); } };
  const updateSmartCollection = async (id: string, patch: { name?: string; rule?: SmartCollectionRule }) => { setBusySmartCollection(true); try { await api.updateSmartCollection(id, patch); await Promise.all([refreshChrome(), refreshArticles()]); notify('智能资料夹规则已更新'); } catch (error) { notify(error instanceof Error ? error.message : '智能资料夹更新失败', 'error'); throw error; } finally { setBusySmartCollection(false); } };
  const deleteSmartCollection = async (collection: SmartCollection) => {
    if (!window.confirm(`删除智能资料夹“${collection.name}”？文章不会被删除或移动。`)) return;
    setBusySmartCollection(true);
    try {
      await api.deleteSmartCollection(collection.id);
      if (smartCollectionId === collection.id) {
        setSmartCollectionId(null);
        const page = await api.listArticles(view, query, collectionId, articleFilters, null);
        setArticles(page.articles); setArticleTotal(page.total); setArticleCursor(page.nextCursor);
        setSelectedId(page.articles[0]?.id || null);
      } else await refreshArticles();
      await refreshChrome();
      notify('智能资料夹已删除，文章保持原位');
    } catch (error) { notify(error instanceof Error ? error.message : '智能资料夹删除失败', 'error'); }
    finally { setBusySmartCollection(false); }
  };
  const reorderSmartCollections = async (orderedIds: string[]) => { setBusySmartCollection(true); try { setSmartCollections(await api.reorderSmartCollections(orderedIds)); notify('智能资料夹顺序已保存'); } catch (error) { notify(error instanceof Error ? error.message : '智能资料夹排序失败', 'error'); throw error; } finally { setBusySmartCollection(false); } };
  const created = (article: Article) => { setArticles((current) => [toArticleSummary(article), ...current]); setSelected(article); setSelectedId(article.id); setView('inbox'); setCollectionId(null); setSmartCollectionId(null); void refreshChrome(); notify('内容已安全保存到本机'); };
  const queued = (job: ImportJob) => { jobStates.current.set(job.id, job.status); setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]); setQueueOpen(true); };
  const retryJob = async (job: ImportJob) => { try { const next = await api.retryImportJob(job.id); jobStates.current.set(next.id, next.status); setJobs((current) => current.map((item) => item.id === next.id ? next : item)); notify('任务已重新加入队列'); } catch (error) { notify(error instanceof Error ? error.message : '重试失败', 'error'); } };
  const toggleImportQueue = async () => {
    setBusyImportQueue(true);
    try {
      const next = await api.updateImportQueueState(!backgroundWork.importUserPaused);
      setBackgroundWork(next);
      if (next.importUserPaused) notify('导入队列已暂停；当前任务完成后停止处理');
      else if (next.importsPaused) notify('已取消手动暂停；系统条件恢复后会自动继续');
      else notify('导入队列已继续');
      void refreshJobs();
    } catch (error) { notify(error instanceof Error ? error.message : '导入队列状态更新失败', 'error'); }
    finally { setBusyImportQueue(false); }
  };
  const saveEditor = async (patch: Partial<Article>) => { if (!selected) throw new Error('内容不存在'); const updated = await api.updateArticle(selected.id, patch); updateArticleInState(updated); return updated; };
  const uploadEditorImage = async (file: File) => { if (!selected) throw new Error('内容不存在'); const result = await api.uploadArticleImage(selected.id, file); updateArticleInState(result.article); return result; };
  const openHistory = async () => {
    if (!selected) return;
    setHistoryOpen(true); setBusyHistory(true);
    try { const next = await api.listRevisions(selected.id); setRevisions(next); setRevisionPreview(next[0] ? await api.getRevision(selected.id, next[0].version) : null); }
    catch (error) { notify(error instanceof Error ? error.message : '版本历史加载失败', 'error'); }
    finally { setBusyHistory(false); }
  };
  const selectRevision = async (version: number) => { if (!selected) return; setBusyHistory(true); try { setRevisionPreview(await api.getRevision(selected.id, version)); } catch (error) { notify(error instanceof Error ? error.message : '历史版本加载失败', 'error'); } finally { setBusyHistory(false); } };
  const restoreRevision = async (version: number) => { if (!selected) return; setBusyHistory(true); try { const article = await api.restoreRevision(selected.id, version); updateArticleInState(article); const next = await api.listRevisions(article.id); setRevisions(next); setRevisionPreview(await api.getRevision(article.id, next[0].version)); notify(`已恢复版本 ${version}，原内容仍保留在历史中`); } catch (error) { notify(error instanceof Error ? error.message : '版本恢复失败', 'error'); } finally { setBusyHistory(false); } };
  const refreshDiagnostics = async () => { setBusyDiagnostics(true); try { setDiagnostics(await api.listDiagnostics()); } catch (error) { notify(error instanceof Error ? error.message : '本地日志读取失败', 'error'); } finally { setBusyDiagnostics(false); } };
  const openDiagnostics = () => { setSafetyOpen(false); setDiagnosticsOpen(true); void refreshDiagnostics(); };
  const clearDiagnostics = async () => {
    if (!window.confirm('清除本机全部 Reader 运行日志？这不会影响文章、附件或备份。')) return;
    setBusyDiagnostics(true);
    try { await api.clearDiagnostics(); setDiagnostics(await api.listDiagnostics()); notify('本地运行日志已清除'); }
    catch (error) { notify(error instanceof Error ? error.message : '本地日志清除失败', 'error'); }
    finally { setBusyDiagnostics(false); }
  };
  const openSafety = async () => { setSafetyOpen(true); setBusySafety(true); try { const [result, snapshots, health] = await Promise.all([api.listBackups(), api.listMigrationSnapshots(), api.checkDataHealth()]); setBackups(result.backups); setMigrationSnapshots(snapshots); setDataHealth(health); setPendingRestore(result.pendingRestore); } catch (error) { notify(error instanceof Error ? error.message : '数据安全信息加载失败', 'error'); } finally { setBusySafety(false); } };
  const checkLocalData = async () => { setBusySafety(true); try { const health = await api.checkDataHealth(); setDataHealth(health); notify(health.status === 'healthy' ? '资料库检查通过' : health.status === 'warning' ? '资料库检查完成，有待处理项' : '资料库检查发现问题', health.status === 'error' ? 'error' : 'normal'); } catch (error) { notify(error instanceof Error ? error.message : '资料库检查失败', 'error'); } finally { setBusySafety(false); } };
  const repairLocalData = async () => {
    if (!dataHealth?.repair.available) return;
    const labels = dataHealth.repair.actions.map((action) => action === 'storage_permissions' ? '本地文件权限' : '全文与 RAG 索引').join('、');
    if (!window.confirm(`Reader 将修复${labels}。不会改动正文或附件；如需重建索引，会先创建完整安全备份。继续吗？`)) return;
    setBusySafety(true);
    try {
      const result = await api.repairDataHealth();
      setDataHealth(result.health);
      if (result.backup) setBackups((current) => [result.backup!, ...current.filter((item) => item.id !== result.backup!.id)]);
      await Promise.all([refreshArticles(), refreshChrome()]);
      notify(result.backup ? '安全修复完成，修复前备份可随时下载' : '本地文件权限已安全修复');
    } catch (error) { notify(error instanceof Error ? error.message : '资料库修复失败', 'error'); }
    finally { setBusySafety(false); }
  };
  const createLocalBackup = async (passphrase?: string) => { setBusySafety(true); try { const backup = await api.createBackup(passphrase); setBackups((current) => [backup, ...current.filter((item) => item.id !== backup.id)]); notify(backup.encrypted ? '加密备份已创建并通过校验' : '明文备份已创建并通过校验'); } catch (error) { notify(error instanceof Error ? error.message : '备份创建失败', 'error'); } finally { setBusySafety(false); } };
  const scheduleLocalRestore = async (file: File, passphrase?: string) => { setBusySafety(true); try { const result = await api.scheduleRestore(file, passphrase); setPendingRestore(result.pendingRestore); const next = await api.listBackups(); setBackups(next.backups); notify('恢复包已解密并通过校验，将在下次启动时应用'); } catch (error) { notify(error instanceof Error ? error.message : '恢复校验失败', 'error'); } finally { setBusySafety(false); } };
  const scheduleSnapshotRestore = async (snapshot: MigrationSnapshot) => {
    if (!window.confirm(`恢复到 Schema v${snapshot.from_schema_version} 的升级前状态？升级后新增或修改的资料不会出现在恢复后的资料库；Reader 会先暂停写入与后台同步，创建包含当前数据库和附件的完整安全备份，并在下次启动重新迁移。`)) return;
    setBusySafety(true);
    try {
      const result = await api.scheduleMigrationSnapshotRestore(snapshot.id);
      setPendingRestore(result.pendingRestore);
      const next = await api.listBackups();
      setBackups(next.backups);
      notify('升级快照已校验，当前完整资料已备份；将在下次启动恢复');
    } catch (error) { notify(error instanceof Error ? error.message : '升级快照恢复安排失败', 'error'); }
    finally { setBusySafety(false); }
  };
  const cancelLocalRestore = async () => { setBusySafety(true); try { await api.cancelRestore(); setPendingRestore(null); notify('已取消待执行恢复'); } catch (error) { notify(error instanceof Error ? error.message : '取消恢复失败', 'error'); } finally { setBusySafety(false); } };
  const syncSource = async (source: Source) => { setBusySource(source.id); try { const result = await api.syncSource(source.id); notify(result.notModified ? '同步完成，内容没有更新' : `同步完成，新增 ${result.imported} 条内容`); await Promise.all([refreshArticles(), refreshChrome()]); } catch (error) { notify(error instanceof Error ? error.message : '同步失败', 'error'); await refreshChrome(); } finally { setBusySource(null); } };
  const updateSource = async (source: Source, patch: Partial<Pick<Source, 'enabled' | 'sync_interval_minutes'>>) => { setBusySource(source.id); try { const updated = await api.updateSource(source.id, patch); setSources((current) => current.map((item) => item.id === updated.id ? updated : item)); notify(patch.enabled === false ? '已暂停自动同步' : patch.enabled === true ? '自动同步已开启' : '同步频率已更新'); } catch (error) { notify(error instanceof Error ? error.message : '订阅设置保存失败', 'error'); await refreshChrome(); } finally { setBusySource(null); } };
  const deleteSource = async (source: Source) => { if (!window.confirm(`删除订阅“${source.title}”？已保存的文章会保留。`)) return; setBusySource(source.id); try { await api.deleteSource(source.id); setSources((current) => current.filter((item) => item.id !== source.id)); notify('订阅已删除，已保存文章仍在本机'); } catch (error) { notify(error instanceof Error ? error.message : '订阅删除失败', 'error'); } finally { setBusySource(null); } };
  const importOPML = async (file: File) => { setBusySource('opml'); try { const result = await api.importOPML(file); setSources(result.sources); notify(`OPML 导入完成：新增 ${result.imported}，跳过 ${result.duplicates}${result.failed ? `，失败 ${result.failed}` : ''}`); } catch (error) { notify(error instanceof Error ? error.message : 'OPML 导入失败', 'error'); } finally { setBusySource(null); } };
  const activeJobCount = jobs.filter((job) => job.status === 'pending' || job.status === 'running').length;
  const closeAddModal = () => {
    setAddOpen(false);
    setExternalAddRequests((current) => current.length ? current.slice(1) : current);
  };
  useEffect(() => {
    return window.readerDesktop?.onCommand((command) => {
      if (command === 'new') setAddOpen(true);
      if (command === 'search') document.querySelector<HTMLInputElement>('[aria-label="搜索资料库"]')?.focus();
      if (command === 'edit') {
        if (selected) setEditOpen(true);
        else notify('请先选择一条内容');
      }
      if (command === 'settings') setSettingsOpen(true);
      if (command === 'import-queue') setQueueOpen(true);
      if (command === 'sources') setSourcesOpen(true);
      if (command === 'toggle-ai') setAIOpen((value) => !value);
      if (command === 'data-safety') void openSafety();
    });
  }, [selected, notify]);

  return <div className="app-stage" data-theme={theme} data-desktop={isDesktop ? 'true' : 'false'}>
    <DialogAccessibilityManager/>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{detailAnnouncement}</span>
    <div className="app-window">
      <header className="titlebar"><TrafficLights/><div className="save-state"><i></i><span>{activeJobCount ? backgroundWork.importsPaused ? `${activeJobCount} 个导入任务已暂停` : `${activeJobCount} 个导入任务处理中` : '本地资料库已保存'}</span></div><div className="title-actions"><button className="button queue-button" type="button" onClick={() => setQueueOpen(true)}>导入队列{activeJobCount ? <b>{activeJobCount}</b> : null}</button><button className="button" type="button" onClick={() => setSettingsOpen(true)}>设置</button><button className="button" type="button" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '深色' : '浅色'}</button><button className="button primary" type="button" onClick={() => setAddOpen(true)}>＋ 添加 <kbd>⌘N</kbd></button></div></header>
      <div className={`workspace ${aiOpen ? 'with-ai' : ''}`}>
        <Sidebar view={view} setView={setView} collectionId={collectionId} setCollectionId={setCollectionId} smartCollectionId={smartCollectionId} setSmartCollectionId={setSmartCollectionId} collections={collections} smartCollections={smartCollections} tags={tags} tagFilter={tagFilter} setTagFilter={setTagFilter} stats={stats} sources={sources} onAdd={() => setAddOpen(true)} onSources={() => setSourcesOpen(true)} onCollections={() => setCollectionsOpen(true)} onSmartCollections={() => setSmartCollectionsOpen(true)} onDuplicates={openDuplicates} onDataSafety={() => void openSafety()} onMoveArticles={(ids, targetCollectionId) => void moveDraggedArticles(ids, targetCollectionId)}/>
        <ArticleList articles={articles} total={articleTotal} hasMore={Boolean(articleCursor)} loadingMore={loadingMore} onLoadMore={() => void loadMoreArticles()} selectedId={selectedId} onSelect={selectArticle} loading={loading} title={title} query={query} setQuery={setQuery} contentFilter={contentFilter} setContentFilter={setContentFilter} layout={libraryLayout} setLayout={setLibraryLayout} selectedIds={selectedIds} onToggleSelection={toggleSelection} onSelectAll={selectAll} onClearSelection={() => setSelectedIds(new Set())} onBatch={(patch, message) => void batchOrganize(patch, message)} onExport={() => setExportOpen(true)} onCompose={() => setComposeOpen(true)} collections={collections} tags={tags} archiveView={view === 'archive'}/>
        <ReaderPane article={currentArticle} loadingTitle={selectedId && !currentArticle ? selectedSummary?.title || '当前内容' : undefined} collections={collections} focusedCitation={focusedCitation} onDismissCitation={() => setFocusedCitation(null)} onPatch={patchSelected} onAddTags={addTags} onRemoveTags={removeTags} onToggleAI={() => setAIOpen((value) => !value)} onEdit={() => setEditOpen(true)} onHistory={() => void openHistory()} onOpenSource={(id) => void openSourceArticle(id)} onOpenWindow={isDesktop && currentArticle ? () => { void window.readerDesktop?.openArticleWindow(currentArticle.id).then((opened) => { if (!opened) notify('无法打开专注阅读窗口', 'error'); }).catch(() => notify('无法打开专注阅读窗口', 'error')); } : undefined} notify={notify}/>
        {aiOpen && <AIPanel article={currentArticle} onClose={() => setAIOpen(false)} onArticleUpdated={updateArticleInState} onDerivedCreated={showDerivedArticle} onOpenCitation={(citation) => void openCitation(citation)} configurationVersion={aiConfigurationVersion} notify={notify}/>}
      </div>
    </div>
    {addOpen && <AddModal collections={collections} initialRequest={externalAddRequests[0]} onClose={closeAddModal} onCreated={created} onQueued={queued} onImported={async () => { await Promise.all([refreshArticles(), refreshChrome()]); }} notify={notify} onSourceCreated={(source) => { setSources((current) => [...current, source]); void refreshChrome(); }} onOpenConnectors={() => { closeAddModal(); setConnectorSettingsOpen(true); }}/>}
    {editOpen && selected && <EditorModal article={selected} onClose={() => setEditOpen(false)} onSave={saveEditor} onUploadImage={uploadEditorImage} notify={notify}/>}
    {historyOpen && selected && <VersionHistoryModal article={selected} revisions={revisions} preview={revisionPreview} busy={busyHistory} onClose={() => setHistoryOpen(false)} onSelect={(version) => void selectRevision(version)} onRestore={(version) => void restoreRevision(version)}/>}
    {sourcesOpen && <SourcesModal sources={sources} background={backgroundWork} onClose={() => setSourcesOpen(false)} onSync={(source) => void syncSource(source)} onUpdate={(source, patch) => void updateSource(source, patch)} onDelete={(source) => void deleteSource(source)} onImport={(file) => void importOPML(file)} onConnections={() => { setSourcesOpen(false); setConnectorSettingsOpen(true); }} busySource={busySource}/>}
    {collectionsOpen && <CollectionManagerModal collections={collections} busy={busyCollection} onClose={() => setCollectionsOpen(false)} onCreate={createCollection} onUpdate={updateCollection} onDelete={deleteCollection} onReorder={reorderCollections}/>}
    {smartCollectionsOpen && <SmartCollectionManagerModal smartCollections={smartCollections} collections={collections} tags={tags} busy={busySmartCollection} onClose={() => setSmartCollectionsOpen(false)} onCreate={createSmartCollection} onUpdate={updateSmartCollection} onDelete={deleteSmartCollection} onReorder={reorderSmartCollections}/>}
    {exportOpen && selectedArticles.length > 0 && <ExportModal articles={selectedArticles} busy={busyExport} onClose={() => setExportOpen(false)} onExport={exportSelected}/>}
    {composeOpen && selectedArticles.length > 0 && <ComposeModal articles={selectedArticles} collections={collections} busy={busyCompose} onClose={() => setComposeOpen(false)} onCreate={(options) => void composeSelected(options)}/>}
    {duplicatesOpen && <DuplicateManagerModal groups={duplicateGroups} busy={busyDuplicates} onClose={() => setDuplicatesOpen(false)} onRefresh={() => void refreshDuplicates()} onResolve={resolveDuplicateGroup}/>}
    {queueOpen && <ImportQueueModal jobs={jobs} background={backgroundWork} busy={busyImportQueue} onClose={() => setQueueOpen(false)} onRetry={(job) => void retryJob(job)} onTogglePaused={() => void toggleImportQueue()}/>}
    {safetyOpen && <DataSafetyModal backups={backups} migrationSnapshots={migrationSnapshots} health={dataHealth} pendingRestore={pendingRestore} busy={busySafety} onClose={() => setSafetyOpen(false)} onCheck={() => void checkLocalData()} onRepair={() => void repairLocalData()} onDiagnostics={openDiagnostics} onCreate={(passphrase) => void createLocalBackup(passphrase)} onScheduleRestore={(file, passphrase) => void scheduleLocalRestore(file, passphrase)} onScheduleSnapshotRestore={(snapshot) => void scheduleSnapshotRestore(snapshot)} onCancelRestore={() => void cancelLocalRestore()}/>}
    {diagnosticsOpen && <DiagnosticsModal diagnostics={diagnostics} busy={busyDiagnostics} onClose={() => setDiagnosticsOpen(false)} onRefresh={() => void refreshDiagnostics()} onClear={() => void clearDiagnostics()}/>}
    {settingsOpen && <AISettingsModal notificationsAvailable={isDesktop} onClose={() => setSettingsOpen(false)} onConfigurationChanged={() => setAIConfigurationVersion((value) => value + 1)} notify={notify}/>}
    {connectorSettingsOpen && <ConnectorSettingsModal onClose={() => setConnectorSettingsOpen(false)} notify={notify}/>}
    {toast && <div className={`toast ${toast.tone === 'error' ? 'error' : ''}`} role="status">{toast.message}</div>}
  </div>;
}

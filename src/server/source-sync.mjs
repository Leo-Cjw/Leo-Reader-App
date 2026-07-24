import { assertPublicURL, fetchRSS, safeFetchText } from './importers.mjs';
import { localizeImportedResources } from './import-worker.mjs';
import { normalizeSocialSourceURL } from './social-connectors.mjs';

const SUPPORTED_SOURCE_KINDS = new Set(['rss', 'youtube', 'x', 'weibo']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

function isoAfterMinutes(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function nextFetchAt(interval, feed) {
  const scheduled = isoAfterMinutes(interval);
  if (Number(feed?.response?.remaining) !== 0 || !feed?.response?.resetAt) return scheduled;
  const reset = new Date(feed.response.resetAt);
  return Number.isNaN(reset.getTime()) || reset.getTime() <= new Date(scheduled).getTime() ? scheduled : reset.toISOString();
}

function failureDelayMinutes(source, failures) {
  const configured = Math.min(Math.max(Number(source.sync_interval_minutes) || 60, 15), 10080);
  return Math.min(1440, Math.max(configured, 15 * (2 ** Math.max(0, failures - 1))));
}

function youtubeFeedURL(channelId) {
  if (!/^UC[A-Za-z0-9_-]{20,}$/.test(channelId)) throw new Error('YouTube 频道 ID 格式不正确');
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
}

function extractYouTubeChannelId(html) {
  const patterns = [
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/,
    /<meta[^>]+itemprop=["']channelId["'][^>]+content=["'](UC[A-Za-z0-9_-]{20,})["']/i,
    /<link[^>]+rel=["']canonical["'][^>]+href=["'][^"']*\/channel\/(UC[A-Za-z0-9_-]{20,})/i
  ];
  return patterns.map((pattern) => html.match(pattern)?.[1]).find(Boolean) || '';
}

export async function normalizeSourceURL(kind, value) {
  if (kind === 'x' || kind === 'weibo') return normalizeSocialSourceURL(kind, value);
  const publicURL = await assertPublicURL(value);
  if (kind !== 'youtube') return publicURL.toString();
  if (!YOUTUBE_HOSTS.has(publicURL.hostname.toLowerCase())) throw new Error('请输入 YouTube 频道或频道 Feed 地址');
  if (publicURL.pathname === '/feeds/videos.xml') {
    const channelId = publicURL.searchParams.get('channel_id');
    return youtubeFeedURL(channelId || '');
  }
  const channelMatch = publicURL.pathname.match(/^\/channel\/(UC[A-Za-z0-9_-]{20,})\/?$/);
  if (channelMatch) return youtubeFeedURL(channelMatch[1]);
  if (!/^\/(?:@[^/]+|c\/[^/]+|user\/[^/]+)\/?$/.test(publicURL.pathname)) {
    throw new Error('请输入 YouTube 频道主页，不支持视频或播放列表地址');
  }
  const response = await safeFetchText(publicURL.toString(), { accept: 'text/html,application/xhtml+xml' });
  const channelId = extractYouTubeChannelId(response.text);
  if (!channelId) throw new Error('无法识别 YouTube 频道 ID，请改用 /channel/UC… 地址');
  return youtubeFeedURL(channelId);
}

export function createSourceSyncService(database, { fetchFeed = fetchRSS, socialConnectors = null, paths = null } = {}) {
  const active = new Map();

  async function perform(source) {
    if (!SUPPORTED_SOURCE_KINDS.has(source.kind)) throw new Error('该平台连接器尚未配置');
    await database.updateSource(source.id, { last_status: 'syncing', last_error: null });
    try {
      const feed = source.kind === 'x' || source.kind === 'weibo'
        ? await socialConnectors?.fetchSource(source)
        : await fetchFeed(source.url, { etag: source.etag || '', lastModified: source.last_modified || '' });
      if (!feed) throw new Error('该平台连接器尚未配置');
      const timestamp = new Date().toISOString();
      const interval = Math.min(Math.max(Number(source.sync_interval_minutes) || 60, 15), 10080);
      if (feed.notModified) {
        const updatedSource = await database.updateSource(source.id, {
          last_status: 'not_modified', last_fetched_at: timestamp, next_fetch_at: nextFetchAt(interval, feed),
          consecutive_failures: 0, last_sync_count: 0, last_http_status: feed.response?.status || 304,
          etag: feed.response?.etag || source.etag || null,
          last_modified: feed.response?.lastModified || source.last_modified || null,
          external_id: feed.externalId || source.external_id || null,
          sync_cursor: feed.cursor || source.sync_cursor || null,
          rate_limit_remaining: Number.isFinite(feed.response?.remaining) ? feed.response.remaining : source.rate_limit_remaining ?? null,
          rate_limit_reset_at: feed.response?.resetAt || source.rate_limit_reset_at || null,
          last_error: null
        });
        return { imported: 0, total: 0, notModified: true, source: updatedSource };
      }
      let imported = 0;
      for (const item of feed.items || []) {
        try {
          let article = await database.createArticle({
            ...item,
            type: source.kind === 'youtube' ? 'youtube' : source.kind === 'x' || source.kind === 'weibo' ? source.kind : item.type,
            collection_id: 'inbox',
            metadata: { ...(item.metadata || {}), sourceId: source.id, sourceKind: source.kind }
          });
          if (paths && Array.isArray(item.metadata?.inlineImages) && item.metadata.inlineImages.length) {
            const finalized = await localizeImportedResources(database, article, item, paths);
            article = await database.finalizeImportedArticle(article.id, finalized);
          }
          imported += 1;
        } catch (error) {
          if (!/UNIQUE constraint failed/.test(error.message || '')) throw error;
        }
      }
      const updatedSource = await database.updateSource(source.id, {
        last_status: 'ok', last_fetched_at: timestamp, next_fetch_at: nextFetchAt(interval, feed), last_error: null,
        consecutive_failures: 0, last_sync_count: imported, last_http_status: feed.response?.status || 200,
        etag: feed.response?.etag || source.etag || null,
        last_modified: feed.response?.lastModified || source.last_modified || null,
        external_id: feed.externalId || source.external_id || null,
        sync_cursor: feed.cursor || source.sync_cursor || null,
        rate_limit_remaining: Number.isFinite(feed.response?.remaining) ? feed.response.remaining : source.rate_limit_remaining ?? null,
        rate_limit_reset_at: feed.response?.resetAt || source.rate_limit_reset_at || null
      });
      return { imported, total: feed.items?.length || 0, notModified: false, source: updatedSource };
    } catch (error) {
      const failures = Number(source.consecutive_failures || 0) + 1;
      await database.updateSource(source.id, {
        last_status: 'error', last_error: error.message || '同步失败', consecutive_failures: failures,
        last_sync_count: 0, last_http_status: error.httpStatus || null,
        rate_limit_remaining: Number.isFinite(error.rateLimitRemaining) ? error.rateLimitRemaining : source.rate_limit_remaining ?? null,
        rate_limit_reset_at: error.rateLimitResetAt || source.rate_limit_reset_at || null,
        next_fetch_at: error.rateLimitResetAt && new Date(error.rateLimitResetAt).getTime() > Date.now()
          ? error.rateLimitResetAt
          : isoAfterMinutes(failureDelayMinutes(source, failures))
      });
      throw error;
    }
  }

  async function syncSource(sourceOrId) {
    const source = typeof sourceOrId === 'string' ? await database.getSource(sourceOrId) : sourceOrId;
    if (!source) return null;
    if (active.has(source.id)) return active.get(source.id);
    const task = perform(source).finally(() => active.delete(source.id));
    active.set(source.id, task);
    return task;
  }

  return { syncSource, isSyncing: (id) => active.has(id) };
}

export function createSourceScheduler(database, syncService, { pollIntervalMs = 30_000, initialDelayMs = 2_000 } = {}) {
  let timer = null;
  let paused = false;
  let running = false;
  let stopped = false;
  let activeRun = null;

  function runDueSources() {
    if (activeRun) return activeRun;
    if (stopped || paused) return Promise.resolve({ synced: 0 });
    running = true;
    activeRun = (async () => {
      let synced = 0;
      try {
        const due = await database.listDueSources();
        for (const source of due) {
          if (stopped || paused) break;
          try { await syncService.syncSource(source); }
          catch (error) { if (!stopped) console.warn(`订阅源同步失败：${source.title}: ${error.message}`); }
          synced += 1;
        }
        return { synced };
      } catch (error) {
        if (!stopped) console.warn(`订阅调度失败：${error.message}`);
        return { synced };
      }
    })().finally(() => { running = false; activeRun = null; });
    return activeRun;
  }

  function schedule(delay) {
    if (stopped || paused) return;
    timer = setTimeout(() => { void runDueSources().finally(() => schedule(pollIntervalMs)); }, delay);
    timer.unref?.();
  }

  function start() { if (!timer && !stopped) schedule(initialDelayMs); }
  async function pause() {
    paused = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (activeRun) await activeRun;
  }
  function resume() {
    if (stopped || !paused) return;
    paused = false;
    schedule(initialDelayMs);
  }
  async function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; if (activeRun) await activeRun; }
  return { start, pause, resume, stop, runDueSources };
}

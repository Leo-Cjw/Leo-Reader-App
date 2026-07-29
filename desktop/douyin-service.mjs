import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { canonicalDouyinURL, DouyinImportError, extractDouyinAwemeId, normalizeDouyinDetail, selectDouyinVideoCandidates } from '../src/server/douyin.mjs';
import { safeFetchCaption, safeFetchMedia } from '../src/server/importers.mjs';

const DOUYIN_PARTITION = 'persist:reader-douyin';
const DETAIL_RESPONSE_PATTERN = /\/aweme\/v1\/web\/aweme\/detail\//;
const CAPTURE_TIMEOUT_MS = 35_000;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 300 * 1024 * 1024;

function extensionFor(contentType) {
  return ({
    'video/mp4': '.mp4',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/heic': '.heic',
    'image/gif': '.gif',
    'text/vtt': '.vtt'
  })[contentType] || '.bin';
}

function timestampVTT(milliseconds) {
  const total = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function segmentsToVTT(segments) {
  const cues = (Array.isArray(segments) ? segments : []).filter((segment) => String(segment?.text || '').trim());
  return `WEBVTT\n\n${cues.map((segment, index) => `${index + 1}\n${timestampVTT(segment.startMs)} --> ${timestampVTT(segment.endMs || Number(segment.startMs || 0) + 3000)}\n${String(segment.text).trim()}`).join('\n\n')}\n`;
}

async function stageBytes(bytes, contentType, stagingDir) {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const extension = extensionFor(contentType);
  const tempPath = path.join(stagingDir, `${sha256}.${randomUUID()}.douyin`);
  const handle = await open(tempPath, 'wx', 0o600);
  try { await handle.writeFile(bytes); }
  finally { await handle.close(); }
  return { tempPath, sha256, byteSize: bytes.length, contentType, extension };
}

async function persistStagedAttachment(database, articleId, staged, filesDir, fileName) {
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  const storageName = `${staged.sha256}${staged.extension}`;
  const destination = path.join(filesDir, storageName);
  try { await rename(staged.tempPath, destination); }
  catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await unlink(staged.tempPath).catch(() => {});
  }
  return await database.createAttachment({
    articleId,
    fileName,
    storageName,
    mimeType: staged.contentType,
    byteSize: staged.byteSize,
    sha256: staged.sha256
  });
}

function transcriptMarkdown(segments) {
  const lines = (Array.isArray(segments) ? segments : []).filter((segment) => String(segment?.text || '').trim()).map((segment) => {
    const minutes = Math.floor(Number(segment.startMs || 0) / 60_000);
    const seconds = Math.floor((Number(segment.startMs || 0) % 60_000) / 1000);
    return `- **${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}** ${String(segment.text).trim()}`;
  });
  return lines.length ? `## 转写\n\n${lines.join('\n')}` : '';
}

function captionTime(value) {
  if (typeof value === 'number') return value > 100_000 ? value : Math.round(value * 1000);
  const text = String(value || '').trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(text)) return captionTime(Number(text));
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part)) || parts.length < 2 || parts.length > 3) return NaN;
  const seconds = parts.pop();
  const minutes = parts.pop();
  const hours = parts.pop() || 0;
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function normalizeCaptionSegments(value) {
  const candidates = Array.isArray(value) ? value
    : Array.isArray(value?.segments) ? value.segments
      : Array.isArray(value?.utterances) ? value.utterances
        : Array.isArray(value?.body) ? value.body
          : Array.isArray(value?.data) ? value.data : [];
  return candidates.map((item) => ({
    startMs: captionTime(item?.startMs ?? item?.start_time_ms ?? item?.start_time ?? item?.start),
    endMs: captionTime(item?.endMs ?? item?.end_time_ms ?? item?.end_time ?? item?.end),
    text: String(item?.text ?? item?.content ?? item?.words ?? '').trim()
  })).filter((item) => Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs >= item.startMs && item.text);
}

export function parsePlatformCaption(text, contentType = '') {
  const source = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!source) return [];
  if (contentType === 'application/json' || /^[{[]/.test(source)) {
    try { return normalizeCaptionSegments(JSON.parse(source)); }
    catch { return []; }
  }
  const blocks = source.replace(/^WEBVTT[^\n]*\n/i, '').split(/\r?\n\r?\n+/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [start, endWithSettings] = lines[timingIndex].split('-->').map((part) => part.trim());
    const end = endWithSettings.split(/\s+/)[0];
    const segment = {
      startMs: captionTime(start),
      endMs: captionTime(end),
      text: lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim()
    };
    if (Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs && segment.text) segments.push(segment);
  }
  return segments;
}

async function fetchPlatformSegments(subtitles, fetchCaption) {
  for (const subtitle of Array.isArray(subtitles) ? subtitles : []) {
    for (const url of subtitle.urls) {
      try {
        const caption = await fetchCaption(url);
        const segments = parsePlatformCaption(caption.text, caption.contentType);
        if (segments.length) return segments;
      } catch {
        // A stale platform caption URL falls through to chapters or local Whisper.
      }
    }
  }
  return [];
}

function playableH264WithAudio(bytes, declaredCodec) {
  const codec = String(declaredCodec || '');
  const h264 = /h264|avc/i.test(codec) || bytes.includes(Buffer.from('avc1')) || bytes.includes(Buffer.from('avc3'));
  const audio = bytes.includes(Buffer.from('soun')) || bytes.includes(Buffer.from('mp4a'));
  return h264 && audio;
}

function safeMediaFailureCategory(message) {
  const value = String(message || '');
  if (/100 MB|超过.*MB/.test(value)) return '超过大小边界';
  if (/H\.264|带声音|音轨/.test(value)) return '未确认 H.264 音轨';
  if (/MIME|签名|格式|MP4/.test(value)) return 'MIME 或文件签名不匹配';
  if (/服务器返回\s*4\d\d/.test(value)) return '媒体服务器拒绝访问';
  if (/服务器返回\s*5\d\d/.test(value)) return '媒体服务器暂时不可用';
  if (/超时|ETIMEDOUT/.test(value)) return '下载超时';
  if (/公网|DNS|域名|网络地址/.test(value)) return '公网地址校验失败';
  return '媒体下载失败';
}

export class DouyinImportService {
  constructor({
    BrowserWindow,
    session,
    transcriptionService = null,
    partition = DOUYIN_PARTITION,
    fetchMedia = safeFetchMedia,
    fetchCaption = safeFetchCaption
  } = {}) {
    if (!BrowserWindow || !session) throw new TypeError('DouyinImportService 需要 Electron BrowserWindow 和 session');
    this.BrowserWindow = BrowserWindow;
    this.electronSession = session;
    this.transcriptionService = transcriptionService;
    this.partition = partition;
    this.fetchMedia = fetchMedia;
    this.fetchCaption = fetchCaption;
  }

  isolatedSession() {
    return this.electronSession.fromPartition(this.partition, { cache: true });
  }

  async status() {
    const cookies = await this.isolatedSession().cookies.get({ domain: '.douyin.com' });
    const authenticated = cookies.some((cookie) => /(?:session|sid|passport)/i.test(cookie.name) && cookie.value);
    return { available: true, desktopOnly: true, authenticated, partition: 'isolated' };
  }

  async clearSession() {
    await this.isolatedSession().clearStorageData();
    await this.isolatedSession().clearCache();
    return await this.status();
  }

  async login() {
    const window = this.createWindow({ visible: true, width: 1080, height: 760 });
    await window.loadURL('https://www.douyin.com/');
    await new Promise((resolve) => window.once('closed', resolve));
    return await this.status();
  }

  createWindow({ visible = false, width = 960, height = 720 } = {}) {
    const isolatedSession = this.isolatedSession();
    const window = new this.BrowserWindow({
      show: visible,
      width,
      height,
      webPreferences: {
        session: isolatedSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true
      }
    });
    const browserUserAgent = isolatedSession.getUserAgent()
      .replace(/\s+(?:Electron|Reader)\/[^\s]+/gi, '')
      .trim();
    window.webContents.setUserAgent(browserUserAgent);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    window.webContents.on('will-navigate', (event, target) => {
      try {
        const url = new URL(target);
        if (url.protocol !== 'https:' || !/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/.test(url.hostname)) event.preventDefault();
      } catch { event.preventDefault(); }
    });
    return window;
  }

  async captureDetail(url) {
    const window = this.createWindow();
    const isolatedSession = this.isolatedSession();
    let settled = false;
    let timer;
    let listening = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (listening) {
        isolatedSession.webRequest.onBeforeRequest(null);
        listening = false;
      }
      if (!window.isDestroyed()) window.destroy();
    };
    const capture = new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onTimeout = async () => {
        const current = window.isDestroyed() ? '' : window.webContents.getURL();
        let visibleLoginGate = false;
        if (!window.isDestroyed()) {
          visibleLoginGate = await Promise.race([
            window.webContents.executeJavaScript(
              `Boolean(document.body && /登录后(?:即可|查看)|扫码登录|手机号登录/.test(document.body.innerText.slice(0, 20000)))`,
              true
            ).catch(() => false),
            new Promise((resolve) => setTimeout(() => resolve(false), 1_000))
          ]);
        }
        const needsLogin = /passport|login/i.test(current) || visibleLoginGate;
        finish(needsLogin
          ? new DouyinImportError('抖音需要登录后才能读取这个作品', { actionRequired: 'douyin_login', code: 'login_required' })
          : new DouyinImportError('未能从抖音页面捕获作品详情，请稍后重试', { code: 'detail_timeout' }));
      };
      isolatedSession.webRequest.onBeforeRequest({ urls: ['https://*.douyin.com/*'] }, (details, callback) => {
        callback({ cancel: false });
        if (!DETAIL_RESPONSE_PATTERN.test(String(details.url || '')) || !listening) return;
        isolatedSession.webRequest.onBeforeRequest(null);
        listening = false;
        const detailURL = details.url;
        void (async () => {
          try {
            const response = await isolatedSession.fetch(detailURL, {
              method: details.method === 'POST' ? 'POST' : 'GET',
              headers: {
                accept: 'application/json, text/plain, */*',
                referer: 'https://www.douyin.com/'
              }
            });
            if (!response.ok) throw new Error(`详情响应状态 ${response.status}`);
            const declared = Number(response.headers.get('content-length') || 0);
            if (declared > 8 * 1024 * 1024) throw new Error('详情响应超过大小边界');
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length > 8 * 1024 * 1024) throw new Error('详情响应超过大小边界');
            const payload = JSON.parse(bytes.toString('utf8'));
            const detail = payload?.aweme_detail || payload?.aweme || payload;
            if (!Array.isArray(detail?.chapter_list) || !detail.chapter_list.length) {
              const renderedChapters = await this.readRenderedChapters(window);
              if (renderedChapters.length) {
                detail.chapter_list = renderedChapters;
                payload.reader_capture_source = 'network-detail+rendered-chapters';
              }
            }
            finish(null, payload);
          } catch {
            finish(new DouyinImportError('抖音作品详情响应无法读取', { code: 'detail_response_unreadable' }));
          }
        })();
      });
      listening = true;
      timer = setTimeout(() => void onTimeout(), CAPTURE_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      void window.loadURL(url).catch(() => {});
      return await capture;
    } catch (error) {
      cleanup();
      if (error?.actionRequired) throw error;
      return await this.captureRenderedDetail(url);
    }
  }

  async readRenderedChapters(window, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !window.isDestroyed()) {
      const chapters = await Promise.race([
        window.webContents.executeJavaScript(`(() => {
          const body = document.body?.innerText || '';
          const chapters = [];
          const pattern = /(?:^|\\n)(\\d{2}):(\\d{2})\\s+([^\\n]{2,120})/g;
          let match;
          while ((match = pattern.exec(body)) && chapters.length < 100) {
            chapters.push({
              start_time_ms: (Number(match[1]) * 60 + Number(match[2])) * 1000,
              title: match[3].trim()
            });
          }
          return chapters;
        })()`, true).catch(() => []),
        new Promise((resolve) => setTimeout(() => resolve([]), 2_000))
      ]);
      if (chapters.length) return chapters;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [];
  }

  async captureRenderedDetail(url) {
    const window = this.createWindow();
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;
    void window.loadURL(url).catch(() => {});
    try {
      while (Date.now() < deadline && !window.isDestroyed()) {
        const snapshot = await Promise.race([
          window.webContents.executeJavaScript(`(() => {
            const meta = (name) => document.querySelector('meta[name="' + name + '"]')?.content || '';
            const body = document.body?.innerText || '';
            const video = Array.from(document.querySelectorAll('video')).find((item) => {
              return item.currentSrc && Number.isFinite(item.duration) && item.duration > 0;
            });
            const sourceURLs = video ? Array.from(new Set([
              video.currentSrc,
              ...Array.from(video.querySelectorAll('source')).map((item) => item.src)
            ].filter((item) => typeof item === 'string' && item.startsWith('https://')))) : [];
            const descriptionMeta = meta('description');
            const authorMatch = descriptionMeta.match(/ - ([^\\n-]{1,100})于(\\d{8})发布在抖音/);
            const publishMatch = body.match(/发布时间[：:]\\s*(\\d{4}-\\d{2}-\\d{2})\\s*(\\d{2}:\\d{2})?/);
            const titleMeta = meta('lark:url:video_title').replace(/\\s+-\\s+抖音\\s*$/, '');
            const title = (titleMeta.split(/\\r?\\n/, 1)[0] || document.title.replace(/\\s+-\\s+抖音\\s*$/, '')).trim();
            const description = descriptionMeta.replace(/\\s+-\\s+[^\\n-]{1,100}于\\d{8}发布在抖音[\\s\\S]*$/, '').trim() || titleMeta;
            const chapters = [];
            const chapterPattern = /(?:^|\\n)(\\d{2}):(\\d{2})\\s+([^\\n]{2,120})/g;
            let chapterMatch;
            while ((chapterMatch = chapterPattern.exec(body)) && chapters.length < 100) {
              chapters.push({
                start_time_ms: (Number(chapterMatch[1]) * 60 + Number(chapterMatch[2])) * 1000,
                title: chapterMatch[3].trim()
              });
            }
            const published = publishMatch
              ? Date.parse(publishMatch[1] + 'T' + (publishMatch[2] || '00:00') + ':00+08:00')
              : authorMatch
                ? Date.parse(authorMatch[2].slice(0, 4) + '-' + authorMatch[2].slice(4, 6) + '-' + authorMatch[2].slice(6, 8) + 'T00:00:00+08:00')
                : NaN;
            return {
              ready: Boolean(video && sourceURLs.length && title && authorMatch),
              login: /登录后(?:即可|查看)|扫码登录|手机号登录/.test(body.slice(0, 20000)),
              detail: video && sourceURLs.length ? {
                aweme_id: location.pathname.match(/\\/(?:video|note)\\/(\\d{8,32})/)?.[1] || '',
                desc: description,
                create_time: Number.isFinite(published) ? Math.floor(published / 1000) : 0,
                author: { nickname: authorMatch?.[1] || '' },
                text_extra: meta('keywords').split(/[,，]/).slice(0, 30).map((hashtag_name) => ({ hashtag_name: hashtag_name.trim() })).filter((item) => item.hashtag_name),
                chapter_list: chapters,
                video: {
                  duration: Math.round(video.duration * 1000),
                  width: video.videoWidth,
                  height: video.videoHeight,
                  video_codec: 'h264',
                  cover: { url_list: [meta('lark:url:video_cover_image_url')].filter(Boolean) },
                  bit_rate: [{
                    video_codec: 'h264',
                    play_addr: {
                      width: video.videoWidth,
                      height: video.videoHeight,
                      url_list: sourceURLs
                    }
                  }]
                }
              } : null
            };
          })()`, true).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 2_000))
        ]);
        if (snapshot?.ready && snapshot.detail) {
          return { aweme_detail: snapshot.detail, reader_capture_source: 'rendered-dom' };
        }
        if (snapshot?.login) {
          throw new DouyinImportError('抖音需要登录后才能读取这个作品', { actionRequired: 'douyin_login', code: 'login_required' });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new DouyinImportError('抖音作品详情接口发生变化，且页面未渲染出可导入媒体', { code: 'detail_structure_changed' });
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }

  async resolveWorkURL(url) {
    const window = this.createWindow();
    return await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        window.webContents.removeListener('will-redirect', inspect);
        window.webContents.removeListener('did-navigate', inspect);
        window.webContents.removeListener('did-redirect-navigation', inspect);
        if (!window.isDestroyed()) window.destroy();
      };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const inspect = (_event, target) => {
        const awemeId = extractDouyinAwemeId(target);
        if (awemeId) finish(null, { awemeId, canonicalURL: canonicalDouyinURL(awemeId) });
      };
      window.webContents.on('will-redirect', inspect);
      window.webContents.on('did-navigate', inspect);
      window.webContents.on('did-redirect-navigation', inspect);
      timer = setTimeout(() => {
        const current = window.isDestroyed() ? '' : window.webContents.getURL();
        const awemeId = extractDouyinAwemeId(current);
        finish(
          awemeId ? null : new DouyinImportError('抖音短链未能解析为作品地址，请稍后重试', { code: 'short_link_timeout' }),
          awemeId ? { awemeId, canonicalURL: canonicalDouyinURL(awemeId) } : null
        );
      }, 20_000);
      timer.unref?.();
      void window.loadURL(url).catch(() => {});
    });
  }

  async prepareInput(url) {
    const directId = extractDouyinAwemeId(url);
    if (directId) return { awemeId: directId, canonicalURL: canonicalDouyinURL(directId) };
    return await this.resolveWorkURL(url);
  }

  async importWork(job, { database, paths, updateProgress, isCancelled }) {
    const existing = await database.getArticleByURL(job.payload.url);
    if (existing?.metadata?.importState === 'waiting-transcription') {
      return await this.finishTranscription(existing, job, { database, paths, updateProgress });
    }
    if (existing?.metadata?.importState === 'ready') return existing;
    const payload = await this.captureDetail(job.payload.url);
    let detail = normalizeDouyinDetail(payload);
    if (await isCancelled()) throw new DouyinImportError('导入任务已取消', { code: 'cancelled' });
    await updateProgress({ phase: 'downloading', progress: 15 });
    const staged = [];
    const failures = [];
    let actualQuality = '';
    let actualWidth = detail.width;
    let actualHeight = detail.height;
    let missingCover = false;
    try {
    if (detail.kind === 'video') {
      const orderedCandidates = selectDouyinVideoCandidates(detail.videoCandidates);
      for (const [candidateIndex, originalCandidate] of orderedCandidates.entries()) {
        let candidate = originalCandidate;
        if (candidateIndex === 1) {
          try {
            detail = normalizeDouyinDetail(await this.captureDetail(job.payload.url));
            candidate = selectDouyinVideoCandidates(detail.videoCandidates).find((item) => item.height === originalCandidate.height) || originalCandidate;
          } catch {
            // A refresh failure does not discard already discovered lower-quality candidates.
          }
        }
        if (/h265|hevc/i.test(candidate.codec || '')) continue;
        let saved = null;
        for (const url of candidate.urls) {
          try {
            const media = await this.fetchMedia(url, { maxBytes: MAX_VIDEO_BYTES });
            if (await isCancelled()) throw new DouyinImportError('导入任务已取消', { code: 'cancelled' });
            if (media.contentType !== 'video/mp4') throw new Error('视频候选不是可离线播放的 MP4');
            if (!playableH264WithAudio(media.bytes, candidate.codec)) throw new Error('视频候选不是带声音的 H.264 MP4');
            saved = await stageBytes(media.bytes, media.contentType, paths.stagingDir);
            actualQuality = candidate.height ? `${candidate.height}p` : candidate.quality || 'MP4';
            actualWidth = candidate.width || detail.width;
            actualHeight = candidate.height || detail.height;
            break;
          } catch (error) {
            if (error?.code === 'cancelled') throw error;
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (saved) {
          staged.push({ ...saved, role: 'video', fileName: `${detail.title.slice(0, 80)}.mp4` });
          break;
        }
      }
      if (!staged.length) {
        const categories = [...new Set(failures.map(safeMediaFailureCategory))].slice(0, 3);
        throw new DouyinImportError(`所有抖音视频候选均无法安全下载，未创建空壳文章（${categories.join('、')}）`, { code: 'media_unavailable' });
      }
      if (detail.coverURLs.length) {
        let cover = null;
        for (const url of detail.coverURLs) {
          try {
            const media = await this.fetchMedia(url, { maxBytes: MAX_IMAGE_BYTES });
            if (!media.contentType.startsWith('image/')) throw new Error('封面候选 MIME 类型无效');
            cover = await stageBytes(media.bytes, media.contentType, paths.stagingDir);
            break;
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (cover) staged.push({ ...cover, role: 'cover', fileName: `抖音封面${cover.extension}` });
        else missingCover = true;
      }
    } else {
      let totalBytes = 0;
      for (const image of detail.images) {
        let saved = null;
        for (const url of image.urls) {
          try {
            const media = await this.fetchMedia(url, { maxBytes: MAX_IMAGE_BYTES });
            if (await isCancelled()) throw new DouyinImportError('导入任务已取消', { code: 'cancelled' });
            if (!media.contentType.startsWith('image/')) throw new Error('图片候选 MIME 类型无效');
            if (totalBytes + media.bytes.length > MAX_IMAGE_TOTAL_BYTES) throw new Error('图文媒体达到 300 MB 本地保存上限');
            saved = await stageBytes(media.bytes, media.contentType, paths.stagingDir);
            totalBytes += media.bytes.length;
            break;
          } catch (error) {
            if (error?.code === 'cancelled') throw error;
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (saved) staged.push({ ...saved, role: 'image', fileName: `抖音图片-${image.index + 1}${saved.extension}` });
      }
      if (!staged.some((item) => item.role === 'image')) throw new DouyinImportError('抖音图文没有任何图片能够安全下载，未创建空壳文章', { code: 'media_unavailable' });
      for (const url of detail.music.urls) {
        try {
          const media = await this.fetchMedia(url, { maxBytes: MAX_VIDEO_BYTES });
          if (await isCancelled()) throw new DouyinImportError('导入任务已取消', { code: 'cancelled' });
          const saved = await stageBytes(media.bytes, media.contentType, paths.stagingDir);
          staged.push({ ...saved, role: 'music', fileName: `${detail.music.title || '背景音乐'}${saved.extension}` });
          break;
        } catch (error) {
          if (error?.code === 'cancelled') throw error;
          failures.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    const missingImageCount = Math.max(0, detail.images.length - staged.filter((item) => item.role === 'image').length);
    const missingMusic = detail.kind === 'images' && detail.music.urls.length > 0 && !staged.some((item) => item.role === 'music');
    const partialDetails = [
      missingImageCount ? `缺少 ${missingImageCount} 张图片` : '',
      missingMusic ? '背景音乐未保存' : '',
      missingCover ? '封面未保存' : ''
    ].filter(Boolean);
    const warning = partialDetails.length ? `部分离线：${partialDetails.join('，')}` : null;
    if (await isCancelled()) throw new DouyinImportError('导入任务已取消', { code: 'cancelled' });
    await updateProgress({ phase: 'saving', progress: 65, warning });
    const platformSegments = await fetchPlatformSegments(detail.subtitles, this.fetchCaption);
    const initialSegments = platformSegments.length ? platformSegments : detail.chapters;
    const transcriptSource = platformSegments.length ? 'platform-subtitles' : detail.chapters.length ? 'platform-chapters' : null;
    const body = [
      detail.description,
      detail.topics.length ? `## 话题\n\n${detail.topics.map((topic) => `#${topic}`).join(' ')}` : '',
      transcriptMarkdown(initialSegments)
    ].filter(Boolean).join('\n\n');
    let article = await database.createArticle({
      id: `douyin-${detail.awemeId}`,
      url: detail.canonicalURL,
      title: detail.title,
      source: '抖音',
      author: detail.author,
      type: 'douyin',
      language: 'zh',
      published_at: detail.publishedAt,
      excerpt: detail.description.slice(0, 220),
      content: body,
      collection_id: job.payload.collectionId || 'inbox',
      metadata: {
        platform: 'douyin',
        awemeId: detail.awemeId,
        authorId: detail.authorId,
        topics: detail.topics,
        durationMs: detail.durationMs,
        width: actualWidth,
        height: actualHeight,
        actualQuality,
        mediaKind: detail.kind,
        imageCount: staged.filter((item) => item.role === 'image').length,
        missingImageCount,
        backgroundMusicSaved: staged.some((item) => item.role === 'music'),
        offlineResourceStatus: warning ? 'partial' : 'complete',
        offlineResourceFailures: failures.slice(0, 12).map((message) => ({ kind: 'media', error: message })),
        transcriptSource,
        captureSource: detail.captureSource,
        importState: initialSegments.length || job.payload.skipTranscription ? 'ready' : 'waiting-transcription'
      }
    });
    const attachmentIds = [];
    for (const item of staged) {
      const attachment = await persistStagedAttachment(database, article.id, item, paths.filesDir, item.fileName);
      attachmentIds.push(attachment.id);
      if (item.role === 'cover') {
        article = await database.updateArticleMetadata(article.id, { leadAttachmentId: attachment.id });
      }
    }
    article = await database.updateArticleMetadata(article.id, { embeddedAttachmentIds: [], mediaAttachmentIds: attachmentIds });
    if (initialSegments.length || job.payload.skipTranscription) return article;
    return await this.finishTranscription(article, job, { database, paths, updateProgress });
    } finally {
      await Promise.all(staged.map((item) => unlink(item.tempPath).catch(() => {})));
    }
  }

  async finishTranscription(article, job, { database, paths, updateProgress }) {
    if (job.payload.skipTranscription) return await database.updateArticleMetadata(article.id, { importState: 'ready', transcriptSource: 'skipped' });
    if (!this.transcriptionService || !(await this.transcriptionService.status()).installed) {
      throw new DouyinImportError('离线媒体已保存；安装本地 Whisper small 模型后可继续转写', { actionRequired: 'install_transcription_model', code: 'model_required' });
    }
    const media = article.attachments.find((attachment) => attachment.mime_type.startsWith('video/') || attachment.mime_type.startsWith('audio/'));
    if (!media) throw new DouyinImportError('没有可用于本地转写的音视频附件', { code: 'missing_transcription_media' });
    const storedMedia = await database.getAttachment(media.id);
    if (!storedMedia?.storage_name) throw new DouyinImportError('本地转写媒体附件不可用', { code: 'missing_transcription_media' });
    await updateProgress({ phase: 'transcribing', progress: 78 });
    let progressUpdates = Promise.resolve();
    let lastMappedProgress = 78;
    const segments = await this.transcriptionService.transcribe(path.join(paths.filesDir, storedMedia.storage_name), {
      language: 'auto',
      onProgress: (progress) => {
        const mappedProgress = 78 + Math.round(Number(progress || 0) * 0.15);
        if (mappedProgress <= lastMappedProgress) return;
        lastMappedProgress = mappedProgress;
        progressUpdates = progressUpdates.then(() => updateProgress({
          phase: 'transcribing',
          progress: Math.min(93, Math.max(78, mappedProgress))
        }));
      }
    });
    await progressUpdates;
    if (!segments.length) throw new DouyinImportError('本地 Whisper 没有生成可搜索的转写分段，请重试或暂不转写', { code: 'empty_transcription' });
    const vtt = Buffer.from(segmentsToVTT(segments), 'utf8');
    const stagedVTT = await stageBytes(vtt, 'text/vtt', paths.stagingDir);
    await persistStagedAttachment(database, article.id, stagedVTT, paths.filesDir, '抖音转写.vtt');
    await updateProgress({ phase: 'indexing', progress: 94 });
    const content = `${article.content.trim()}\n\n${transcriptMarkdown(segments)}`;
    let updated = await database.updateArticle(article.id, { content, excerpt: article.excerpt }, { revisionReason: 'transcription' });
    updated = await database.updateArticleMetadata(updated.id, { importState: 'ready', transcriptSource: 'local-whisper-small', transcriptSegments: segments.length });
    return updated;
  }
}

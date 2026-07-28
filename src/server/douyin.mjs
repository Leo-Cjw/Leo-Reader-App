const DOUYIN_HOSTS = new Set([
  'douyin.com',
  'www.douyin.com',
  'v.douyin.com',
  'iesdouyin.com',
  'www.iesdouyin.com'
]);

const DOUYIN_URL_PATTERN = /https?:\/\/[^\s<>"'，。；！？、）】]+/giu;
const AWEME_ID_PATTERN = /^\d{8,32}$/;

export class DouyinImportError extends Error {
  constructor(message, { actionRequired = null, code = 'douyin_import_failed' } = {}) {
    super(message);
    this.name = 'DouyinImportError';
    this.code = code;
    this.actionRequired = actionRequired;
    this.expected = true;
  }
}

export function isDouyinHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/\.$/, '');
  return DOUYIN_HOSTS.has(host) || host.endsWith('.douyin.com') || host.endsWith('.iesdouyin.com');
}

export function extractDouyinURL(value) {
  const input = String(value || '').trim();
  if (!input) throw new DouyinImportError('抖音口令或链接不能为空', { code: 'invalid_input' });
  if (input.length > 4096) throw new DouyinImportError('抖音分享口令不能超过 4096 个字符', { code: 'invalid_input' });
  const matches = input.match(DOUYIN_URL_PATTERN) || [];
  const trusted = [];
  for (const match of matches) {
    try {
      const candidate = new URL(match.replace(/[):\]}]+$/g, ''));
      if (candidate.protocol === 'https:' && isDouyinHost(candidate.hostname)) trusted.push(candidate);
    } catch {}
  }
  const unique = [...new Map(trusted.map((candidate) => [candidate.toString(), candidate])).values()];
  if (unique.length !== 1) {
    throw new DouyinImportError(unique.length ? '分享口令中包含多个抖音链接，请只保留一个' : '没有找到可信的抖音 HTTPS 链接', { code: 'invalid_input' });
  }
  unique[0].hash = '';
  return unique[0].toString();
}

export function extractDouyinAwemeId(value) {
  let url;
  try { url = new URL(String(value || '')); }
  catch { return null; }
  if (!isDouyinHost(url.hostname)) return null;
  const pathMatch = url.pathname.match(/\/(?:video|note)\/(\d{8,32})(?:\/|$)/);
  const candidate = pathMatch?.[1] || url.searchParams.get('aweme_id') || url.searchParams.get('modal_id');
  return AWEME_ID_PATTERN.test(String(candidate || '')) ? String(candidate) : null;
}

export function canonicalDouyinURL(awemeId) {
  if (!AWEME_ID_PATTERN.test(String(awemeId || ''))) throw new DouyinImportError('抖音作品 ID 无效', { code: 'invalid_aweme_id' });
  return `https://www.douyin.com/video/${awemeId}`;
}

export function normalizeDouyinResolvedURL(value) {
  const url = extractDouyinURL(value);
  const awemeId = extractDouyinAwemeId(url);
  if (!awemeId) throw new DouyinImportError('无法从抖音页面确认作品 ID', { code: 'missing_aweme_id' });
  return { awemeId, canonicalURL: canonicalDouyinURL(awemeId), resolvedURL: url };
}

function nonEmpty(value, fallback = '') {
  const result = String(value || '').trim();
  return result || fallback;
}

function timestamp(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function urlList(value) {
  if (Array.isArray(value?.url_list)) return value.url_list.filter((item) => typeof item === 'string' && item.startsWith('https://'));
  if (typeof value === 'string' && value.startsWith('https://')) return [value];
  return [];
}

export function normalizeDouyinDetail(payload) {
  const detail = payload?.aweme_detail || payload?.aweme || payload;
  const awemeId = String(detail?.aweme_id || '');
  if (!AWEME_ID_PATTERN.test(awemeId)) throw new DouyinImportError('抖音作品详情缺少有效作品 ID', { code: 'invalid_detail' });
  const images = (Array.isArray(detail?.images) ? detail.images : [])
    .slice(0, 30)
    .map((image, index) => ({ index, urls: urlList(image?.url_list ? image : image?.display_image || image), width: Number(image?.width || 0), height: Number(image?.height || 0) }))
    .filter((image) => image.urls.length);
  const video = detail?.video || null;
  const bitRates = (Array.isArray(video?.bit_rate) ? video.bit_rate : []).map((candidate) => ({
    urls: urlList(candidate?.play_addr),
    width: Number(candidate?.play_addr?.width || video?.width || 0),
    height: Number(candidate?.play_addr?.height || video?.height || 0),
    bitRate: Number(candidate?.bit_rate || 0),
    quality: nonEmpty(candidate?.gear_name || candidate?.quality_type),
    codec: nonEmpty(candidate?.video_codec || candidate?.codec_type || candidate?.format || candidate?.video_extra)
  })).filter((candidate) => candidate.urls.length);
  const defaultVideoURLs = urlList(video?.play_addr);
  if (defaultVideoURLs.length) bitRates.push({
    urls: defaultVideoURLs,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    bitRate: Number(video?.bit_rate || 0),
    quality: 'default',
    codec: nonEmpty(video?.video_codec || video?.codec_type || video?.format)
  });
  const description = nonEmpty(detail?.desc, '抖音作品');
  const topics = (Array.isArray(detail?.text_extra) ? detail.text_extra : [])
    .map((item) => nonEmpty(item?.hashtag_name))
    .filter(Boolean);
  const chapterSources = [
    ...(Array.isArray(detail?.chapter_list) ? detail.chapter_list : []),
    ...(Array.isArray(detail?.video?.chapter_list) ? detail.video.chapter_list : []),
    ...(Array.isArray(detail?.video_text) ? detail.video_text : [])
  ];
  const chapters = chapterSources.map((item, index) => ({
    startMs: Number(item?.start_time ?? item?.start_time_ms ?? item?.start ?? index * 1000),
    endMs: Number(item?.end_time ?? item?.end_time_ms ?? item?.end ?? 0),
    text: nonEmpty(item?.text || item?.title || item?.content)
  })).filter((item) => item.text);
  const subtitles = (Array.isArray(detail?.video?.subtitle_infos) ? detail.video.subtitle_infos : Array.isArray(detail?.subtitle_list) ? detail.subtitle_list : [])
    .map((item) => ({
      language: nonEmpty(item?.language || item?.language_code, 'unknown'),
      urls: urlList(item?.url || item?.subtitle_url || item)
    }))
    .filter((item) => item.urls.length);
  return {
    awemeId,
    canonicalURL: canonicalDouyinURL(awemeId),
    title: description.split(/\r?\n/)[0].slice(0, 500),
    description,
    author: nonEmpty(detail?.author?.nickname, '抖音作者'),
    authorId: nonEmpty(detail?.author?.sec_uid || detail?.author?.unique_id),
    publishedAt: timestamp(detail?.create_time),
    topics,
    coverURLs: urlList(video?.cover || detail?.cover),
    durationMs: Number(video?.duration || detail?.duration || 0),
    width: Number(video?.width || images[0]?.width || 0),
    height: Number(video?.height || images[0]?.height || 0),
    kind: images.length ? 'images' : 'video',
    images,
    videoCandidates: bitRates,
    music: {
      title: nonEmpty(detail?.music?.title),
      author: nonEmpty(detail?.music?.author),
      durationSeconds: Number(detail?.music?.duration || 0),
      urls: urlList(detail?.music?.play_url)
    },
    chapters,
    subtitles,
    captureSource: nonEmpty(payload?.reader_capture_source, 'network-detail'),
    rawHasMoreImages: Array.isArray(detail?.images) && detail.images.length > 30
  };
}

export function selectDouyinVideoCandidates(candidates, { preferredHeight = 1080, fallbackHeight = 720 } = {}) {
  const safe = (Array.isArray(candidates) ? candidates : []).filter((candidate) => candidate?.urls?.length);
  const score = (candidate) => {
    const height = Number(candidate.height || 0);
    const target = height > preferredHeight ? fallbackHeight : preferredHeight;
    return Math.abs(height - target) * 10_000 - Number(candidate.bitRate || 0);
  };
  return [...safe].sort((left, right) => score(left) - score(right));
}

export function desktopOnlyDouyinError() {
  return Object.assign(new Error('抖音作品导入仅在 Reader 桌面版中支持'), { status: 501, expected: true });
}

import dns from 'node:dns/promises';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const MAX_REMOTE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_INLINE_IMAGES = 16;
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function browserHeaders(accept, url, extraHeaders = {}) {
  const headers = {
    accept,
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'cache-control': 'no-cache',
    'user-agent': DESKTOP_USER_AGENT,
    ...extraHeaders
  };
  if (/\.(?:qpic|qlogo)\.cn$/i.test(url.hostname)) headers.referer = 'https://mp.weixin.qq.com/';
  return headers;
}

export function isPrivateAddress(address) {
  if (!net.isIP(address)) return true;
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('::ffff:')) return isPrivateAddress(normalized.slice(7));
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return false;
}

export async function assertPublicURL(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('URL 格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 http/https 地址');
  const hostname = url.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('不允许访问本机或局域网地址');
  const directIP = net.isIP(hostname) ? [hostname] : [];
  const addresses = directIP.length ? directIP : (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('不允许访问私有网络地址');
  url.hash = '';
  return url;
}

async function readLimitedBytes(response, maxBytes, label) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function safeFetchText(value, {
  accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
  headers = {},
  allowNotModified = false
} = {}) {
  let url = await assertPublicURL(value);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: browserHeaders(accept, url, headers)
      });
    } finally {
      clearTimeout(timeout);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('重定向缺少目标地址');
      url = await assertPublicURL(new URL(location, url).toString());
      continue;
    }
    if (allowNotModified && response.status === 304) {
      return {
        text: '', url: url.toString(), contentType: response.headers.get('content-type') || '', status: 304,
        etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified')
      };
    }
    if (!response.ok) {
      const error = new Error(`远程服务器返回 ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    return {
      text: (await readLimitedBytes(response, MAX_REMOTE_BYTES, '远程内容')).toString('utf8'),
      url: url.toString(),
      contentType: response.headers.get('content-type') || '',
      status: response.status,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified')
    };
  }
  throw new Error('重定向次数过多');
}

export async function safeFetchImage(value) {
  let url = await assertPublicURL(value);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: browserHeaders('image/avif,image/webp,image/png,image/jpeg,image/gif,image/heic;q=0.8', url) });
    } finally { clearTimeout(timeout); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('图片重定向缺少目标地址');
      url = await assertPublicURL(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`图片服务器返回 ${response.status}`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif|avif|heic)$/.test(contentType)) throw new Error('远程主图格式不受支持');
    const bytes = await readLimitedBytes(response, MAX_IMAGE_BYTES, '远程主图');
    if (!validateImageSignature(bytes, contentType)) throw new Error('远程主图内容与 MIME 类型不一致');
    return { bytes, url: url.toString(), contentType };
  }
  throw new Error('图片重定向次数过多');
}

export function validateImageSignature(bytes, contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (type === 'image/jpeg' || type === 'image/jpg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/gif') return bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (type === 'image/webp') return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (type === 'image/avif') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['avif', 'avis'].includes(bytes.subarray(8, 12).toString('ascii'));
  if (type === 'image/heic') return bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp' && ['heic', 'heix', 'mif1', 'msf1'].includes(bytes.subarray(8, 12).toString('ascii'));
  return false;
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    const lower = code.toLowerCase();
    if (lower in named) return named[lower];
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return match;
  });
}

function firstMatch(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1].replace(/<[^>]+>/g, '').trim());
  }
  return '';
}

function htmlToText(fragment) {
  return decodeEntities(String(fragment || '')
    .replace(/<(script|style|noscript|svg|canvas|nav|footer|form|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|h[1-6]|li|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim());
}

function detectLanguage(text) {
  const sample = String(text || '').slice(0, 2000);
  const cjk = (sample.match(/[\u3400-\u9fff]/g) || []).length;
  return cjk > sample.length * 0.08 ? 'zh' : 'en';
}

function metaContent(document, selectors) {
  for (const selector of selectors) {
    const value = document.querySelector(selector)?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return '';
}

function absoluteURL(value, baseURL) {
  if (!value || /^data:|^blob:/i.test(value)) return null;
  try {
    const url = new URL(value, baseURL);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeWeChatURL(value) {
  const url = new URL(value);
  url.hash = '';
  if (url.hostname.toLowerCase() === 'mp.weixin.qq.com' && /^\/s\/[^/]+\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/$/, '');
    url.search = '';
  }
  return url.toString();
}

export function isWeChatVerificationPage(html, finalURL = '') {
  let captchaURL = false;
  try {
    const url = new URL(finalURL);
    captchaURL = url.hostname.toLowerCase() === 'mp.weixin.qq.com' && url.pathname.includes('wappoc_appmsgcaptcha');
  } catch {}
  const hasArticle = /id=["']js_content["']/i.test(html) && /id=["']activity-name["']/i.test(html);
  const hasChallengeCopy = /环境异常/.test(html) && /去验证/.test(html);
  return captchaURL || (!hasArticle && hasChallengeCopy);
}

function prepareReadableMarkdown(contentHTML, canonicalURL) {
  const { document } = parseHTML(`<html><head><base href="${canonicalURL.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></head><body>${contentHTML}</body></html>`);
  const inlineImages = [];
  const imageTokens = new Map();
  const sourceURLs = new Set();
  const candidates = [...document.querySelectorAll('img')];
  for (const image of candidates) {
    const source = image.getAttribute('src') || image.getAttribute('data-src') || image.getAttribute('data-original') || image.getAttribute('data-lazy-src');
    const remoteURL = absoluteURL(source, canonicalURL);
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
    image.removeAttribute('loading');
    if (!remoteURL) {
      image.remove();
      continue;
    }
    sourceURLs.add(remoteURL);
    let token = imageTokens.get(remoteURL);
    if (!token && inlineImages.length < MAX_INLINE_IMAGES) {
      token = `__READER_LOCAL_IMAGE_${inlineImages.length}__`;
      imageTokens.set(remoteURL, token);
      inlineImages.push({ token, url: remoteURL, alt: image.getAttribute('alt')?.trim().slice(0, 180) || '' });
    }
    image.setAttribute('src', token || remoteURL);
  }
  for (const source of document.querySelectorAll('picture source')) source.remove();

  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '_',
    strongDelimiter: '**'
  });
  turndown.use(gfm);
  turndown.addRule('readerImages', {
    filter: 'img',
    replacement(_content, node) {
      const src = node.getAttribute('src') || '';
      const alt = (node.getAttribute('alt') || '').replaceAll('[', '\\[').replaceAll(']', '\\]');
      return src ? `\n\n![${alt}](${src})\n\n` : '';
    }
  });
  return {
    markdown: turndown.turndown(document.body.innerHTML).replace(/\n{3,}/g, '\n\n').trim(),
    inlineImages,
    inlineImageTotal: sourceURLs.size
  };
}

export function extractWeChatArticle(html, canonicalURL) {
  const { document } = parseHTML(html);
  const contentRoot = document.querySelector('#js_content');
  const title = document.querySelector('#activity-name .js_title_inner')?.textContent?.trim() || metaContent(document, ['meta[property="og:title"]']);
  if (!contentRoot || !title) throw new Error('微信文章正文结构不完整，请稍后重试或改用粘贴正文导入');
  const contentClone = contentRoot.cloneNode(true);
  for (const element of contentClone.querySelectorAll('script,style,iframe,mp-style-type,[style*="display: none"]')) element.remove();
  const prepared = prepareReadableMarkdown(contentClone.innerHTML, canonicalURL);
  const readableText = contentClone.textContent?.replace(/\s+/g, ' ').trim() || '';
  if (prepared.markdown.length < 80 || readableText.length < 60) throw new Error('微信文章没有提取到足够的正文内容');
  const author = (document.querySelector('#js_author_name_text')?.textContent || metaContent(document, ['meta[name="author"]'])).trim();
  const accountName = (document.querySelector('#js_name')?.textContent || '').replace(/\s+/g, ' ').trim() || '微信公众号';
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']);
  const leadImage = absoluteURL(metaContent(document, ['meta[property="og:image"]', 'meta[name="twitter:image"]']), canonicalURL);
  const timestamp = Number(html.match(/var\s+(?:ct|create_time)\s*=\s*["']?(\d{10})/)?.[1] || 0);
  return {
    url: normalizeWeChatURL(canonicalURL),
    title: title.slice(0, 500),
    source: accountName.slice(0, 200),
    author: author.slice(0, 200),
    type: 'article',
    language: detectLanguage(readableText),
    published_at: timestamp ? new Date(timestamp * 1000).toISOString() : null,
    excerpt: (description || readableText.slice(0, 180)).slice(0, 500),
    content: prepared.markdown,
    metadata: {
      importedAt: new Date().toISOString(),
      extractor: 'wechat-article-v1',
      platform: 'wechat',
      accountName,
      leadImage,
      inlineImages: prepared.inlineImages,
      inlineImageCount: prepared.inlineImageTotal,
      inlineImageQueued: prepared.inlineImages.length,
      readabilityLength: readableText.length
    }
  };
}

export function extractArticle(html, canonicalURL) {
  if (new URL(canonicalURL).hostname.toLowerCase() === 'mp.weixin.qq.com' && /id=["']js_content["']/i.test(html)) return extractWeChatArticle(html, canonicalURL);
  const safeBase = canonicalURL.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  const withBase = /<base\b/i.test(html) ? html : html.replace(/<head([^>]*)>/i, `<head$1><base href="${safeBase}">`);
  const { document } = parseHTML(withBase);
  if (!document.querySelector('base')) {
    const base = document.createElement('base');
    base.setAttribute('href', canonicalURL);
    document.head?.prepend(base);
  }
  const readable = new Readability(document.cloneNode(true), { charThreshold: 80, keepClasses: false }).parse();
  const rawFallback = htmlToText(document.querySelector('article')?.innerHTML || document.querySelector('main')?.innerHTML || document.body?.innerHTML || html);
  const readableText = readable?.textContent?.replace(/\s+/g, ' ').trim() || rawFallback;
  const prepared = readable?.content ? prepareReadableMarkdown(readable.content, canonicalURL) : { markdown: rawFallback, inlineImages: [], inlineImageTotal: 0 };
  const content = prepared.markdown || rawFallback;
  if (content.length < 80) throw new Error('没有提取到足够的正文内容');
  const title = (readable?.title || document.title || document.querySelector('h1')?.textContent || new URL(canonicalURL).hostname).trim();
  const description = metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']);
  const author = (readable?.byline || metaContent(document, ['meta[name="author"]', 'meta[property="article:author"]'])).trim();
  const leadImage = absoluteURL(metaContent(document, ['meta[property="og:image:secure_url"]', 'meta[property="og:image"]', 'meta[name="twitter:image"]']), canonicalURL);
  return {
    url: canonicalURL,
    title: title.slice(0, 500),
    source: new URL(canonicalURL).hostname.replace(/^www\./, ''),
    author: author.slice(0, 200),
    type: 'article',
    language: detectLanguage(content),
    excerpt: (readable?.excerpt || description || readableText.slice(0, 180)).trim().slice(0, 500),
    content,
    metadata: {
      importedAt: new Date().toISOString(),
      extractor: 'mozilla-readability-v1',
      leadImage,
      inlineImages: prepared.inlineImages,
      inlineImageCount: prepared.inlineImageTotal,
      inlineImageQueued: prepared.inlineImages.length,
      readabilityLength: readable?.length || readableText.length,
      siteName: readable?.siteName || ''
    }
  };
}

export async function importURL(value) {
  const requestedURL = new URL(value);
  const response = await safeFetchText(value);
  if (requestedURL.hostname.toLowerCase() === 'mp.weixin.qq.com' && isWeChatVerificationPage(response.text, response.url)) {
    throw new Error('微信暂时要求环境验证，Reader 没有保存验证页。请稍后重试，或在微信中复制正文后用 Markdown 导入');
  }
  if (!/html|xhtml/i.test(response.contentType) && !/<html/i.test(response.text)) throw new Error('该地址不是可阅读的网页');
  const canonicalURL = requestedURL.hostname.toLowerCase() === 'mp.weixin.qq.com' ? normalizeWeChatURL(value) : response.url;
  return extractArticle(response.text, canonicalURL);
}

function tagValue(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return decodeEntities((match?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim());
}

export function parseRSS(xml, feedURL) {
  const feedTitle = tagValue(xml, 'title') || new URL(feedURL).hostname;
  const blocks = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) => match[2]).slice(0, 50);
  return {
    title: feedTitle,
    items: blocks.map((block) => {
      const title = tagValue(block, 'title') || '未命名条目';
      const linkTag = tagValue(block, 'link');
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
      const url = linkTag || hrefMatch?.[1] || '';
      const description = tagValue(block, 'content:encoded') || tagValue(block, 'content') || tagValue(block, 'description') || tagValue(block, 'summary');
      const content = htmlToText(description);
      const idSeed = tagValue(block, 'guid') || tagValue(block, 'id') || url || `${feedTitle}:${title}`;
      return {
        id: `rss-${createHash('sha256').update(idSeed).digest('hex').slice(0, 24)}`,
        url: url || null,
        title,
        source: feedTitle,
        author: tagValue(block, 'author') || tagValue(block, 'dc:creator'),
        type: 'rss',
        language: detectLanguage(content || title),
        published_at: tagValue(block, 'pubDate') || tagValue(block, 'published') || tagValue(block, 'updated') || null,
        excerpt: content.slice(0, 240),
        content: content || title,
        metadata: { feedURL }
      };
    })
  };
}

export async function fetchRSS(value, { etag = '', lastModified = '' } = {}) {
  const headers = {};
  if (etag) headers['if-none-match'] = etag;
  if (lastModified) headers['if-modified-since'] = lastModified;
  const response = await safeFetchText(value, {
    accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
    headers,
    allowNotModified: true
  });
  if (response.status === 304) return { title: '', items: [], notModified: true, response };
  return { ...parseRSS(response.text, response.url), notModified: false, response };
}

import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const MAX_REMOTE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_INLINE_IMAGES = 16;
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const NON_PUBLIC_IPV4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];
const NON_PUBLIC_IPV6 = [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['5f00::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
];

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

function ipv4Number(address) {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0) >>> 0;
}

function inIPv4Range(address, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) >>> 0 === (ipv4Number(base) & mask) >>> 0;
}

function ipv6Number(address) {
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const ipv4 = ipv4Number(value.slice(separator + 1));
    value = `${value.slice(0, separator)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parts = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part || '0'}`), 0n);
}

function inIPv6Range(address, base, prefix) {
  const shift = 128n - BigInt(prefix);
  return (ipv6Number(address) >> shift) === (ipv6Number(base) >> shift);
}

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return NON_PUBLIC_IPV4.some(([base, prefix]) => inIPv4Range(address, base, prefix));
  if (family !== 6) return true;
  const value = ipv6Number(address);
  const mappedPrefix = ipv6Number('::ffff:0:0');
  if ((value >> 32n) === (mappedPrefix >> 32n)) {
    const embedded = Number(value & 0xffffffffn);
    return isPrivateAddress([embedded >>> 24, (embedded >>> 16) & 255, (embedded >>> 8) & 255, embedded & 255].join('.'));
  }
  return value === 1n || NON_PUBLIC_IPV6.some(([base, prefix]) => inIPv6Range(address, base, prefix));
}

function normalizedHostname(url) {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
}

function isBenchmarkAddress(address) {
  return net.isIPv4(address) && inIPv4Range(address, '198.18.0.0', 15);
}

function isMacOSTunnelAddress(address) {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('/sbin/route', ['-n', 'get', address], { encoding: 'utf8', timeout: 1000, maxBuffer: 16 * 1024 }, (error, stdout) => {
      resolve(!error && /^\s*interface:\s*utun\d+\s*$/m.test(stdout));
    });
  });
}

export async function resolvePublicURL(value, { lookup = dns.lookup, isTunnelAddress = isMacOSTunnelAddress } = {}) {
  let url;
  try { url = new URL(value); }
  catch { throw new Error('URL 格式不正确'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 http/https 地址');
  if (url.username || url.password) throw new Error('URL 不能包含用户名或密码');
  const hostname = normalizedHostname(url).toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) throw new Error('不允许访问本机或局域网地址');
  const directIP = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : [];
  const resolved = directIP.length ? directIP : await lookup(hostname, { all: true, verbatim: true });
  const addresses = [...new Map(resolved.map((entry) => {
    const address = String(entry?.address || '');
    return [address, { address, family: net.isIP(address) }];
  })).values()].filter((entry) => entry.family);
  const nonPublic = addresses.filter((entry) => isPrivateAddress(entry.address));
  const tunneledFakeIP = !directIP.length && url.protocol === 'https:' && nonPublic.length === addresses.length
    && nonPublic.every((entry) => isBenchmarkAddress(entry.address))
    && (await Promise.all(nonPublic.map((entry) => isTunnelAddress(entry.address)))).every(Boolean);
  if (!addresses.length || (nonPublic.length && !tunneledFakeIP)) {
    throw new Error(directIP.length ? '不允许访问非公网网络地址' : '域名当前解析到非公网地址；请检查代理或 DNS 设置');
  }
  url.hash = '';
  return { url, addresses };
}

export async function assertPublicURL(value, options) {
  return (await resolvePublicURL(value, options)).url;
}

function responseHeader(headers, name) {
  const value = headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

function decodedBody(response) {
  const encoding = responseHeader(response.headers, 'content-encoding').trim().toLowerCase();
  if (!encoding || encoding === 'identity') return response;
  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(createGunzip());
  if (encoding === 'deflate') return response.pipe(createInflate());
  if (encoding === 'br') return response.pipe(createBrotliDecompress());
  throw new Error('远程服务器使用了不受支持的压缩格式');
}

async function readLimitedBytes(response, maxBytes, label) {
  const declared = Number(responseHeader(response.headers, 'content-length') || 0);
  if (declared > maxBytes) {
    response.destroy();
    throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
  }
  let body;
  try { body = decodedBody(response); }
  catch (error) {
    response.destroy();
    throw error;
  }
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`${label}超过 ${Math.round(maxBytes / 1024 / 1024)} MB 限制`);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    body.destroy();
    response.destroy();
    throw error;
  }
  return Buffer.concat(chunks);
}

export function createPinnedLookup({ address, family }) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options ? options : {};
    if (settings.all) done(null, [{ address, family }]);
    else done(null, address, family);
  };
}

export function requestPinnedAddress(url, target, {
  headers,
  maxBytes,
  label,
  timeoutMs = REQUEST_TIMEOUT_MS,
  requestImpl = url.protocol === 'https:' ? https.request : http.request
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    let timer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const hostname = normalizedHostname(url);
    const request = requestImpl({
      protocol: url.protocol,
      hostname,
      port: url.port || undefined,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      agent: false,
      lookup: createPinnedLookup(target),
      ...(url.protocol === 'https:' && !net.isIP(hostname) ? { servername: hostname } : {})
    }, (response) => {
      responseStarted = true;
      const status = Number(response.statusCode || 0);
      if (status < 200 || status >= 300) {
        finish(resolve, { status, headers: response.headers, bytes: Buffer.alloc(0) });
        response.destroy();
        return;
      }
      readLimitedBytes(response, maxBytes, label)
        .then((bytes) => finish(resolve, { status, headers: response.headers, bytes }))
        .catch((error) => {
          error.readerResponseStarted = true;
          finish(reject, error);
        });
    });
    timer = setTimeout(() => {
      const error = Object.assign(new Error('远程请求超时'), { code: 'ETIMEDOUT' });
      request.destroy(error);
    }, timeoutMs);
    request.once('error', (error) => {
      if (responseStarted) error.readerResponseStarted = true;
      finish(reject, error);
    });
    request.end();
  });
}

async function requestPublicTarget(target, options) {
  const deadline = Date.now() + (options.timeoutMs || REQUEST_TIMEOUT_MS);
  let lastError;
  for (const address of target.addresses) {
    try {
      return await requestPinnedAddress(target.url, address, {
        ...options,
        timeoutMs: Math.max(1, deadline - Date.now())
      });
    } catch (error) {
      lastError = error;
      if (error.readerResponseStarted) throw error;
      if (Date.now() >= deadline) break;
    }
  }
  throw lastError || new Error('远程地址不可用');
}

export async function safeFetchText(value, {
  accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
  headers = {},
  allowNotModified = false
} = {}) {
  let target = await resolvePublicURL(value);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const response = await requestPublicTarget(target, {
      headers: browserHeaders(accept, target.url, headers),
      maxBytes: MAX_REMOTE_BYTES,
      label: '远程内容'
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeader(response.headers, 'location');
      if (!location) throw new Error('重定向缺少目标地址');
      target = await resolvePublicURL(new URL(location, target.url).toString());
      continue;
    }
    if (allowNotModified && response.status === 304) {
      return {
        text: '', url: target.url.toString(), contentType: responseHeader(response.headers, 'content-type'), status: 304,
        etag: responseHeader(response.headers, 'etag') || null,
        lastModified: responseHeader(response.headers, 'last-modified') || null
      };
    }
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`远程服务器返回 ${response.status}`);
      error.httpStatus = response.status;
      throw error;
    }
    return {
      text: response.bytes.toString('utf8'),
      url: target.url.toString(),
      contentType: responseHeader(response.headers, 'content-type'),
      status: response.status,
      etag: responseHeader(response.headers, 'etag') || null,
      lastModified: responseHeader(response.headers, 'last-modified') || null
    };
  }
  throw new Error('重定向次数过多');
}

export async function safeFetchImage(value) {
  let target = await resolvePublicURL(value);
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const response = await requestPublicTarget(target, {
      headers: browserHeaders('image/avif,image/webp,image/png,image/jpeg,image/gif,image/heic;q=0.8', target.url),
      maxBytes: MAX_IMAGE_BYTES,
      label: '远程主图'
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeader(response.headers, 'location');
      if (!location) throw new Error('图片重定向缺少目标地址');
      target = await resolvePublicURL(new URL(location, target.url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`图片服务器返回 ${response.status}`);
    const contentType = responseHeader(response.headers, 'content-type').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif|avif|heic)$/.test(contentType)) throw new Error('远程主图格式不受支持');
    const bytes = response.bytes;
    if (!validateImageSignature(bytes, contentType)) throw new Error('远程主图内容与 MIME 类型不一致');
    return { bytes, url: target.url.toString(), contentType };
  }
  throw new Error('图片重定向次数过多');
}

export async function safeFetchMedia(value, { maxBytes = 100 * 1024 * 1024 } = {}) {
  let target = await resolvePublicURL(value);
  if (target.url.protocol !== 'https:') throw new Error('媒体下载仅允许 HTTPS');
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const response = await requestPublicTarget(target, {
      headers: browserHeaders('video/mp4,audio/*,image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5', target.url, {
        referer: 'https://www.douyin.com/'
      }),
      maxBytes,
      label: '媒体文件',
      timeoutMs: 60_000
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeader(response.headers, 'location');
      if (!location) throw new Error('媒体重定向缺少目标地址');
      target = await resolvePublicURL(new URL(location, target.url).toString());
      if (target.url.protocol !== 'https:') throw new Error('媒体重定向只能使用 HTTPS');
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`媒体服务器返回 ${response.status}`);
    const contentType = responseHeader(response.headers, 'content-type').split(';')[0].trim().toLowerCase();
    const bytes = response.bytes;
    const isImage = /^image\/(png|jpe?g|webp|gif|avif|heic)$/.test(contentType) && validateImageSignature(bytes, contentType);
    const isMP4 = (contentType === 'video/mp4' || contentType === 'audio/mp4' || contentType === 'audio/x-m4a')
      && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
    const isMP3 = (contentType === 'audio/mpeg' || contentType === 'audio/mp3')
      && (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
    const isAAC = contentType === 'audio/aac' && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    const isWAV = (contentType === 'audio/wav' || contentType === 'audio/x-wav')
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE';
    if (!isImage && !isMP4 && !isMP3 && !isAAC && !isWAV) throw new Error('媒体内容、MIME 类型或文件签名不受支持');
    return { bytes, contentType };
  }
  throw new Error('媒体重定向次数过多');
}

export async function safeFetchCaption(value, { maxBytes = 2 * 1024 * 1024 } = {}) {
  let target = await resolvePublicURL(value);
  if (target.url.protocol !== 'https:') throw new Error('字幕下载仅允许 HTTPS');
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const response = await requestPublicTarget(target, {
      headers: browserHeaders('text/vtt,application/json,text/plain,application/x-subrip;q=0.9', target.url, {
        referer: 'https://www.douyin.com/'
      }),
      maxBytes,
      label: '字幕文件',
      timeoutMs: 30_000
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = responseHeader(response.headers, 'location');
      if (!location) throw new Error('字幕重定向缺少目标地址');
      target = await resolvePublicURL(new URL(location, target.url).toString());
      if (target.url.protocol !== 'https:') throw new Error('字幕重定向只能使用 HTTPS');
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`字幕服务器返回 ${response.status}`);
    const contentType = responseHeader(response.headers, 'content-type').split(';')[0].trim().toLowerCase();
    if (!['text/vtt', 'application/json', 'text/plain', 'application/x-subrip', 'text/srt'].includes(contentType)) {
      throw new Error('字幕 MIME 类型不受支持');
    }
    if (response.bytes.includes(0)) throw new Error('字幕内容不是受支持的文本');
    return { text: response.bytes.toString('utf8'), contentType };
  }
  throw new Error('字幕重定向次数过多');
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
  const tablePipeToken = '\uE000';
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

  // WeChat code samples use <br> elements inside nested spans. linkedom's
  // textContent intentionally omits those visual line breaks, so preserve them
  // before Turndown reads the <pre><code> text.
  for (const pre of document.querySelectorAll('pre')) {
    for (const lineBreak of pre.querySelectorAll('br')) lineBreak.replaceWith(document.createTextNode('\n'));
  }

  // WeChat tables wrap cell text in block-level sections. GFM tables cannot
  // contain those internal newlines, so reduce each cell to its displayed text
  // while retaining the table's rows, header cells and column boundaries.
  for (const cell of document.querySelectorAll('th,td')) {
    for (const lineBreak of cell.querySelectorAll('br')) lineBreak.replaceWith(document.createTextNode(' '));
    cell.textContent = (cell.textContent || '').replace(/\s+/g, ' ').trim().replaceAll('|', tablePipeToken);
  }

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
    markdown: turndown.turndown(document.body.innerHTML).replaceAll(tablePipeToken, '\\|').replace(/\n{3,}/g, '\n\n').trim(),
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
  const leadImage = prepared.inlineImages.length
    ? null
    : absoluteURL(metaContent(document, ['meta[property="og:image"]', 'meta[name="twitter:image"]']), canonicalURL);
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
      extractor: 'wechat-article-v2',
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
  const { parseArticleInProcess } = await import('./parser-process.mjs');
  return await parseArticleInProcess(response.text, canonicalURL);
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

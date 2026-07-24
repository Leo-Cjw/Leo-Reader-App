import { spawn } from 'node:child_process';
import { access, readdir, realpath } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const X_API_BASE = 'https://api.x.com';
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const WEIBO_HOSTS = new Set(['weibo.com', 'www.weibo.com', 'm.weibo.cn']);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function connectorError(message, status = 400, httpStatus = null) {
  return Object.assign(new Error(message), { status, expected: true, httpStatus });
}

function compareSnowflakes(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return a.length - b.length;
  return a.localeCompare(b);
}

function newestId(values) {
  return values.map(String).filter((value) => /^\d+$/.test(value)).sort(compareSnowflakes).at(-1) || '';
}

function cleanText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleFromText(text, fallback) {
  const compact = cleanText(text).replace(/\s+/g, ' ').trim();
  return (compact || fallback).slice(0, 96);
}

function excerptFromText(text) {
  return cleanText(text).replace(/\s+/g, ' ').slice(0, 220);
}

function languageFromText(text, provided = '') {
  if (provided) return String(provided).toLowerCase().startsWith('zh') ? 'zh' : String(provided).slice(0, 12);
  return /[\u3400-\u9fff]/.test(String(text).slice(0, 1000)) ? 'zh' : 'en';
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function xHandle(value) {
  const input = String(value || '').trim();
  if (/^@?[A-Za-z0-9_]{1,15}$/.test(input)) return input.replace(/^@/, '');
  let url;
  try { url = new URL(input); }
  catch { throw connectorError('请输入 X 用户名或个人主页地址'); }
  if (!X_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) throw connectorError('请输入 x.com 上的个人主页地址');
  const match = url.pathname.match(/^\/@?([A-Za-z0-9_]{1,15})\/?$/);
  if (!match) throw connectorError('X 订阅只支持用户主页，不支持单条动态、列表或搜索页');
  return match[1];
}

function weiboUid(value) {
  const input = String(value || '').trim();
  if (/^\d{5,20}$/.test(input)) return input;
  let url;
  try { url = new URL(input); }
  catch { throw connectorError('请输入微博数字 UID 或个人主页地址'); }
  if (!WEIBO_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash) throw connectorError('请输入 weibo.com 上的个人主页地址');
  const match = url.pathname.match(/^\/(?:u\/)?(\d{5,20})\/?$/);
  if (!match) throw connectorError('微博订阅需要数字 UID，可在个人主页地址中找到');
  return match[1];
}

export function normalizeSocialSourceURL(kind, value) {
  if (kind === 'x') return `https://x.com/${xHandle(value)}`;
  if (kind === 'weibo') return `https://weibo.com/u/${weiboUid(value)}`;
  throw connectorError('未知社交平台');
}

function expandXText(post) {
  let text = cleanText(post?.text);
  const urls = Array.isArray(post?.entities?.urls) ? post.entities.urls : [];
  for (const entity of urls) {
    if (!entity?.url || !entity?.expanded_url) continue;
    text = text.split(entity.url).join(entity.expanded_url);
  }
  return text;
}

function xMedia(post, mediaByKey) {
  const keys = Array.isArray(post?.attachments?.media_keys) ? post.attachments.media_keys : [];
  return keys.map((key) => mediaByKey.get(key)).filter(Boolean).map((media) => media.url || media.preview_image_url).filter(Boolean).slice(0, 4);
}

export function xPostsToItems(payload, profile, source) {
  const posts = Array.isArray(payload?.data) ? payload.data : [];
  const mediaByKey = new Map((payload?.includes?.media || []).map((media) => [media.media_key, media]));
  return posts.map((post) => {
    const text = expandXText(post);
    const media = xMedia(post, mediaByKey);
    const inlineImages = media.map((url, index) => ({ token: `reader-social-image://x/${post.id}/${index}`, url, alt: `@${profile.username} 的图片 ${index + 1}` }));
    const content = `${text}${inlineImages.map((image) => `\n\n![${image.alt}](${image.token})`).join('')}`;
    return {
      id: `x-${post.id}`,
      url: `https://x.com/${profile.username}/status/${post.id}`,
      title: titleFromText(text, `@${profile.username} 的动态`),
      source: `@${profile.username} · X`,
      author: profile.name || profile.username,
      type: 'x',
      language: languageFromText(text, post.lang),
      published_at: post.created_at || null,
      excerpt: excerptFromText(text),
      content,
      metadata: {
        sourceId: source.id,
        sourceKind: 'x',
        platformPostId: String(post.id),
        platformUserId: String(profile.id),
        username: profile.username,
        publicMetrics: post.public_metrics || {},
        inlineImageCount: inlineImages.length,
        inlineImages
      }
    };
  });
}

function weiboImages(status) {
  const urls = [];
  if (status?.pic_infos && typeof status.pic_infos === 'object') {
    for (const info of Object.values(status.pic_infos)) urls.push(info?.largest?.url || info?.large?.url || info?.original?.url || info?.thumbnail?.url);
  }
  if (Array.isArray(status?.pics)) for (const image of status.pics) urls.push(image?.large?.url || image?.url);
  if (status?.original_pic) urls.push(status.original_pic);
  return [...new Set(urls.filter(Boolean))].slice(0, 9);
}

export function weiboStatusesToItems(payload, source) {
  const statuses = Array.isArray(payload) ? payload : Array.isArray(payload?.statuses) ? payload.statuses : Array.isArray(payload?.data) ? payload.data : [];
  return statuses.map((status) => {
    const id = String(status.idstr || status.id || '');
    if (!/^\d+$/.test(id)) return null;
    const user = status.user || {};
    const uid = String(user.idstr || user.id || weiboUid(source.url));
    const name = String(user.screen_name || user.name || source.title || uid);
    const text = cleanText(status.text_raw || status.longTextContent || status.text);
    const images = weiboImages(status);
    const inlineImages = images.map((url, index) => ({ token: `reader-social-image://weibo/${id}/${index}`, url, alt: `${name} 的图片 ${index + 1}` }));
    const content = `${text}${inlineImages.map((image) => `\n\n![${image.alt}](${image.token})`).join('')}`;
    const postKey = status.bid || status.mblogid || id;
    return {
      id: `weibo-${id}`,
      url: `https://weibo.com/${uid}/${postKey}`,
      title: titleFromText(text, `${name} 的微博`),
      source: `@${name} · 微博`,
      author: name,
      type: 'weibo',
      language: languageFromText(text),
      published_at: safeDate(status.created_at),
      excerpt: excerptFromText(text),
      content,
      metadata: {
        sourceId: source.id,
        sourceKind: 'weibo',
        platformPostId: id,
        platformUserId: uid,
        username: name,
        repostsCount: Number(status.reposts_count || 0),
        commentsCount: Number(status.comments_count || 0),
        attitudesCount: Number(status.attitudes_count || 0),
        inlineImageCount: inlineImages.length,
        inlineImages
      }
    };
  }).filter(Boolean);
}

async function responseJSON(response) {
  const length = Number(response.headers?.get?.('content-length') || 0);
  if (length > MAX_RESPONSE_BYTES) throw connectorError('社交平台响应过大', 502, response.status);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw connectorError('社交平台响应过大', 502, response.status);
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw connectorError(`社交平台返回了无效 JSON (${response.status})`, 502, response.status); }
  if (!response.ok) {
    const message = payload?.detail || payload?.title || payload?.error?.message || payload?.error || `HTTP ${response.status}`;
    throw connectorError(`X API：${message}`, response.status === 401 || response.status === 403 ? 401 : response.status === 429 ? 429 : 502, response.status);
  }
  return payload;
}

async function xRequest(fetchImpl, pathname, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetchImpl(`${X_API_BASE}${pathname}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'Reader/0.16' },
      signal: controller.signal,
      redirect: 'error'
    });
    const remaining = Number(response.headers?.get?.('x-rate-limit-remaining') || NaN);
    const resetAt = /^\d+$/.test(String(response.headers?.get?.('x-rate-limit-reset') || '')) ? new Date(Number(response.headers.get('x-rate-limit-reset')) * 1000).toISOString() : null;
    let payload;
    try { payload = await responseJSON(response); }
    catch (error) {
      error.rateLimitRemaining = Number.isFinite(remaining) ? remaining : null;
      error.rateLimitResetAt = resetAt;
      throw error;
    }
    return {
      payload,
      status: response.status,
      remaining,
      resetAt
    };
  } catch (error) {
    if (error?.name === 'AbortError') throw connectorError('X API 请求超时', 504);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function pathExecutable(candidate) {
  try { await access(candidate, fsConstants.X_OK); return await realpath(candidate); }
  catch { return null; }
}

export async function findWeiboCLI(environment = process.env) {
  const override = String(environment.READER_WEIBO_CLI || '').trim();
  if (override) {
    if (!path.isAbsolute(override)) throw connectorError('READER_WEIBO_CLI 必须是绝对路径');
    return await pathExecutable(override);
  }
  const candidates = ['/opt/homebrew/bin/weibo', '/usr/local/bin/weibo', path.join(os.homedir(), '.local', 'bin', 'weibo')];
  for (const segment of String(environment.PATH || '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(segment, 'weibo'));
  const nvmRoot = path.join(os.homedir(), '.nvm', 'versions', 'node');
  try {
    for (const version of await readdir(nvmRoot)) candidates.push(path.join(nvmRoot, version, 'bin', 'weibo'));
  } catch {}
  for (const candidate of [...new Set(candidates)]) {
    const executable = await pathExecutable(candidate);
    if (executable) return executable;
  }
  return null;
}

export function createWeiboRunner({ environment = process.env, executableResolver = findWeiboCLI } = {}) {
  return async function runWeibo(args, { timeoutMs = 35_000 } = {}) {
    const executable = await executableResolver(environment);
    if (!executable) throw connectorError('未安装微博官方 CLI。请先运行 npm install -g @weibo-ai/weibo-cli', 412);
    return await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...environment, PATH: `${path.dirname(executable)}${path.delimiter}${String(environment.PATH || '/usr/bin:/bin:/usr/sbin:/sbin')}` }
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      const collect = (target) => (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) target.push(chunk);
        else child.kill();
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', reject);
      const timer = setTimeout(() => { child.kill(); reject(connectorError('微博 CLI 请求超时', 504)); }, timeoutMs);
      child.once('close', (code) => {
        clearTimeout(timer);
        if (bytes > MAX_RESPONSE_BYTES) return reject(connectorError('微博 CLI 响应过大', 502));
        const output = Buffer.concat(stdout).toString('utf8').trim();
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) return reject(connectorError(errorText || output || `微博 CLI 退出码 ${code}`, /登录|token|unauthorized|认证/i.test(`${errorText} ${output}`) ? 401 : 502));
        try { resolve(output ? JSON.parse(output) : {}); }
        catch { reject(connectorError('微博 CLI 没有返回有效 JSON', 502)); }
      });
    });
  };
}

export class SocialConnectorManager {
  constructor({ xCredentialStore, fetchImpl = fetch, weiboRunner = createWeiboRunner(), environment = process.env } = {}) {
    this.xCredentialStore = xCredentialStore;
    this.fetchImpl = fetchImpl;
    this.weiboRunner = weiboRunner;
    this.environment = environment || {};
  }

  async xToken(override = '') {
    if (override) return String(override);
    const stored = String(await this.xCredentialStore.get() || '');
    return stored || String(this.environment.READER_X_BEARER_TOKEN || '');
  }

  async publicStatus() {
    const storedXToken = String(await this.xCredentialStore.get() || '');
    const token = storedXToken || String(this.environment.READER_X_BEARER_TOKEN || '');
    let weibo = { installed: true, authenticated: false, account: null, error: null };
    try {
      const profile = await this.weiboRunner(['auth', 'whoami', '--output', 'json'], { timeoutMs: 12_000 });
      weibo = { installed: true, authenticated: true, account: profile?.screen_name || profile?.name || profile?.data?.screen_name || profile?.data?.name || null, error: null };
    } catch (error) {
      weibo = { installed: error.status !== 412, authenticated: false, account: null, error: error.message };
    }
    const credential = this.xCredentialStore.describe();
    return {
      x: {
        configured: Boolean(token),
        credentialSource: token ? (storedXToken ? 'keychain' : 'environment') : 'none',
        credentialBackend: credential.backend,
        credentialWritable: credential.writable,
        environmentAvailable: Boolean(this.environment.READER_X_BEARER_TOKEN)
      },
      weibo
    };
  }

  async saveXToken(token) {
    const value = String(token || '');
    if (value.length < 20 || value.length > 8192 || value.trim() !== value || /[\s\0]/.test(value)) throw connectorError('X Bearer Token 格式无效');
    await this.xCredentialStore.set(value);
    return await this.publicStatus();
  }

  async clearXToken() {
    await this.xCredentialStore.delete();
    return await this.publicStatus();
  }

  async testX(token = '') {
    const credential = await this.xToken(token);
    if (!credential) throw connectorError('请先填写 X Bearer Token', 412);
    const result = await xRequest(this.fetchImpl, '/2/users/by/username/XDevelopers?user.fields=id,name,username', credential);
    return { ok: true, account: result.payload?.data?.username || 'XDevelopers', remaining: Number.isFinite(result.remaining) ? result.remaining : null, resetAt: result.resetAt };
  }

  async testWeibo() {
    const profile = await this.weiboRunner(['auth', 'whoami', '--output', 'json'], { timeoutMs: 12_000 });
    return { ok: true, account: profile?.screen_name || profile?.name || profile?.data?.screen_name || profile?.data?.name || null };
  }

  async logoutWeibo() {
    await this.weiboRunner(['auth', 'logout', '--output', 'json'], { timeoutMs: 12_000 });
    return await this.publicStatus();
  }

  async assertReady(kind) {
    if (kind === 'x' && !(await this.xToken())) throw connectorError('请先在连接器设置中保存 X Bearer Token', 412);
    if (kind === 'weibo') await this.testWeibo();
  }

  async fetchSource(source) {
    if (source.kind === 'x') return await this.fetchX(source);
    if (source.kind === 'weibo') return await this.fetchWeibo(source);
    throw connectorError('未知社交平台连接器');
  }

  async fetchX(source) {
    const token = await this.xToken();
    if (!token) throw connectorError('X 连接器尚未配置 Bearer Token', 412);
    const handle = xHandle(source.url);
    let profile = null;
    if (source.external_id) profile = { id: source.external_id, username: handle, name: source.title };
    else {
      const lookup = await xRequest(this.fetchImpl, `/2/users/by/username/${encodeURIComponent(handle)}?user.fields=id,name,username,protected`, token);
      profile = lookup.payload?.data;
      if (!profile?.id) throw connectorError(`X 用户 @${handle} 不存在或不可访问`, 404, lookup.status);
      if (profile.protected) throw connectorError('暂不支持受保护的 X 账号', 403, lookup.status);
    }

    const posts = [];
    const media = [];
    let paginationToken = '';
    let remaining = null;
    let resetAt = null;
    let httpStatus = 200;
    for (let page = 0; page < 5; page += 1) {
      const params = new URLSearchParams({
        max_results: source.sync_cursor ? '100' : '20',
        'tweet.fields': 'id,text,created_at,lang,author_id,entities,attachments,public_metrics',
        expansions: 'attachments.media_keys',
        'media.fields': 'media_key,type,url,preview_image_url,width,height'
      });
      if (source.sync_cursor) params.set('since_id', source.sync_cursor);
      if (paginationToken) params.set('pagination_token', paginationToken);
      const result = await xRequest(this.fetchImpl, `/2/users/${encodeURIComponent(profile.id)}/tweets?${params}`, token);
      httpStatus = result.status;
      remaining = Number.isFinite(result.remaining) ? result.remaining : remaining;
      resetAt = result.resetAt || resetAt;
      if (Array.isArray(result.payload?.data)) posts.push(...result.payload.data);
      if (Array.isArray(result.payload?.includes?.media)) media.push(...result.payload.includes.media);
      paginationToken = result.payload?.meta?.next_token || '';
      if (!paginationToken || !source.sync_cursor) break;
    }
    const payload = { data: posts, includes: { media } };
    const items = xPostsToItems(payload, profile, source);
    return {
      title: `${profile.name || profile.username} · X`,
      items,
      notModified: items.length === 0,
      cursor: newestId([source.sync_cursor, ...posts.map((post) => post.id)]),
      externalId: String(profile.id),
      response: { status: httpStatus, remaining, resetAt }
    };
  }

  async fetchWeibo(source) {
    const uid = weiboUid(source.url);
    const args = ['statuses', 'user_timeline', '--uid', uid, '--count', source.sync_cursor ? '100' : '20'];
    if (source.sync_cursor) args.push('--since_id', source.sync_cursor);
    args.push('--output', 'json');
    let payload;
    try { payload = await this.weiboRunner(args); }
    catch (error) {
      if (!source.sync_cursor || !/since_id|unknown flag|未知参数/i.test(error.message || '')) throw error;
      payload = await this.weiboRunner(['statuses', 'user_timeline', '--uid', uid, '--count', '100', '--output', 'json']);
    }
    const items = weiboStatusesToItems(payload, source);
    return {
      title: source.title,
      items,
      notModified: items.length === 0,
      cursor: newestId([source.sync_cursor, ...items.map((item) => item.metadata.platformPostId)]),
      externalId: uid,
      response: { status: 200, remaining: null, resetAt: null }
    };
  }
}

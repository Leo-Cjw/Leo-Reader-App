import path from 'node:path';

export const READER_PROTOCOL_SCHEME = 'reader-local';
export const MAX_READER_SHARED_TEXT_BYTES = 4_096;

export const DESKTOP_COMMANDS = new Set([
  'new',
  'search',
  'edit',
  'settings',
  'import-queue',
  'sources',
  'data-safety',
  'toggle-ai'
]);

export function isAllowedAppURL(candidate, appOrigin) {
  try {
    const url = new URL(candidate);
    return url.origin === appOrigin && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}
export function isSafeExternalURL(candidate) {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function normalizeArticleWindowId(candidate) {
  if (typeof candidate !== 'string' || !candidate || candidate.length > 200 || /[\u0000-\u001f\u007f]/.test(candidate)) return null;
  return candidate;
}

function parseSharedText(value) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (!bytes.length
      || bytes.length > MAX_READER_SHARED_TEXT_BYTES
      || bytes.toString('base64url') !== value) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

export function parseReaderAddDeepLink(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 8192) return null;
  try {
    const deepLink = new URL(candidate);
    if (deepLink.protocol !== `${READER_PROTOCOL_SCHEME}:`
      || deepLink.hostname !== 'add'
      || (deepLink.pathname !== '' && deepLink.pathname !== '/')
      || deepLink.username
      || deepLink.password
      || deepLink.port
      || deepLink.hash
      || [...deepLink.searchParams.keys()].some((key) => key !== 'url' && key !== 'text')) return null;
    const urls = deepLink.searchParams.getAll('url');
    const texts = deepLink.searchParams.getAll('text');
    if (urls.length === 1 && texts.length === 0) {
      const targetValue = urls[0].trim();
      if (!targetValue || targetValue.length > 2048) return null;
      const target = new URL(targetValue);
      if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
      return { kind: 'url', url: target.toString() };
    }
    if (texts.length === 1 && urls.length === 0) {
      const text = parseSharedText(texts[0]);
      return text === null ? null : { kind: 'text', text };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseReaderDeepLink(candidate) {
  const request = parseReaderAddDeepLink(candidate);
  return request?.kind === 'url' ? request.url : null;
}

export function parseReaderOpenDeepLink(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 8192) return null;
  try {
    const deepLink = new URL(candidate);
    if (deepLink.protocol !== `${READER_PROTOCOL_SCHEME}:`
      || deepLink.hostname !== 'open'
      || (deepLink.pathname !== '' && deepLink.pathname !== '/')
      || deepLink.username
      || deepLink.password
      || deepLink.port
      || deepLink.hash
      || [...deepLink.searchParams.keys()].some((key) => key !== 'article')) return null;
    const values = deepLink.searchParams.getAll('article');
    if (values.length !== 1) return null;
    return normalizeArticleWindowId(values[0]);
  } catch {
    return null;
  }
}

export function extractReaderDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  for (const candidate of argv) {
    const target = parseReaderDeepLink(candidate);
    if (target) return target;
  }
  return null;
}

export function extractReaderAddDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  for (const candidate of argv) {
    const request = parseReaderAddDeepLink(candidate);
    if (request) return request;
  }
  return null;
}

export function extractReaderOpenDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  for (const candidate of argv) {
    const articleID = parseReaderOpenDeepLink(candidate);
    if (articleID) return articleID;
  }
  return null;
}

export function resolveDesktopDataRoot(userDataPath, override = '') {
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('READER_DESKTOP_DATA_ROOT 必须是绝对路径');
    return path.resolve(override);
  }
  return path.join(path.resolve(userDataPath), 'ReaderData');
}

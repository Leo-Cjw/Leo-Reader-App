import path from 'node:path';

export const READER_PROTOCOL_SCHEME = 'reader-local';

export const DESKTOP_COMMANDS = new Set([
  'new',
  'search',
  'edit',
  'settings',
  'import-queue',
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

export function parseReaderDeepLink(candidate) {
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
      || [...deepLink.searchParams.keys()].some((key) => key !== 'url')) return null;
    const values = deepLink.searchParams.getAll('url');
    if (values.length !== 1) return null;
    const targetValue = values[0].trim();
    if (!targetValue || targetValue.length > 2048) return null;
    const target = new URL(targetValue);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    return target.toString();
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

export function resolveDesktopDataRoot(userDataPath, override = '') {
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('READER_DESKTOP_DATA_ROOT 必须是绝对路径');
    return path.resolve(override);
  }
  return path.join(path.resolve(userDataPath), 'ReaderData');
}

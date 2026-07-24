import path from 'node:path';

export const DESKTOP_COMMANDS = new Set([
  'new',
  'search',
  'edit',
  'settings',
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

export function resolveDesktopDataRoot(userDataPath, override = '') {
  if (override) {
    if (!path.isAbsolute(override)) throw new Error('READER_DESKTOP_DATA_ROOT 必须是绝对路径');
    return path.resolve(override);
  }
  return path.join(path.resolve(userDataPath), 'ReaderData');
}

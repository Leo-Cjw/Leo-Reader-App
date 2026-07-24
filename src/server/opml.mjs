function escapeXML(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function decodeXML(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function attributes(tag) {
  const result = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) result[match[1].toLowerCase()] = decodeXML(match[3]);
  return result;
}

function inferKind(attrs) {
  const explicit = String(attrs.readerkind || attrs.kind || '').toLowerCase();
  if (['youtube', 'x', 'weibo'].includes(explicit)) return explicit;
  try {
    const url = new URL(attrs.xmlurl);
    if (/youtube\.com$/i.test(url.hostname) && url.pathname === '/feeds/videos.xml') return 'youtube';
  } catch {}
  return 'rss';
}

export function parseOPML(xml, { maxSources = 500 } = {}) {
  const text = String(xml || '');
  if (!/<opml\b/i.test(text) || !/<body\b/i.test(text)) throw new Error('不是有效的 OPML 文件');
  const sources = [];
  for (const match of text.matchAll(/<outline\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (!attrs.xmlurl) continue;
    if (sources.length >= maxSources) throw new Error(`OPML 最多导入 ${maxSources} 个订阅源`);
    const interval = Math.min(Math.max(Number(attrs.readerintervalminutes) || 60, 15), 10080);
    sources.push({
      kind: inferKind(attrs),
      title: String(attrs.title || attrs.text || attrs.xmlurl).trim().slice(0, 200),
      url: attrs.xmlurl,
      enabled: attrs.readerenabled !== 'false' && attrs.readerenabled !== '0',
      syncIntervalMinutes: interval
    });
  }
  if (!sources.length) throw new Error('OPML 中没有可导入的订阅源');
  return sources;
}

export function exportOPML(sources, { title = 'Reader 订阅' } = {}) {
  const outlines = sources
    .filter((source) => ['rss', 'youtube', 'x', 'weibo'].includes(source.kind))
    .map((source) => `    <outline text="${escapeXML(source.title)}" title="${escapeXML(source.title)}" type="rss" xmlUrl="${escapeXML(source.url)}" readerKind="${escapeXML(source.kind)}" readerEnabled="${source.enabled ? 'true' : 'false'}" readerIntervalMinutes="${Number(source.sync_interval_minutes) || 60}"/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escapeXML(title)}</title>\n    <dateCreated>${escapeXML(new Date().toISOString())}</dateCreated>\n  </head>\n  <body>\n${outlines}\n  </body>\n</opml>\n`;
}

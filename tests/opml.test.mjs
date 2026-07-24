import test from 'node:test';
import assert from 'node:assert/strict';
import { exportOPML, parseOPML } from '../src/server/opml.mjs';

test('OPML export and import preserve local subscription settings', () => {
  const xml = exportOPML([
    { kind: 'rss', title: '设计 & 工程', url: 'https://example.com/feed.xml?a=1&b=2', enabled: true, sync_interval_minutes: 30 },
    { kind: 'youtube', title: '频道', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC12345678901234567890', enabled: false, sync_interval_minutes: 1440 }
  ]);
  assert.match(xml, /设计 &amp; 工程/);
  const sources = parseOPML(xml);
  assert.deepEqual(sources, [
    { kind: 'rss', title: '设计 & 工程', url: 'https://example.com/feed.xml?a=1&b=2', enabled: true, syncIntervalMinutes: 30 },
    { kind: 'youtube', title: '频道', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC12345678901234567890', enabled: false, syncIntervalMinutes: 1440 }
  ]);
});

test('OPML parser rejects malformed and empty documents', () => {
  assert.throws(() => parseOPML('<html></html>'), /有效的 OPML/);
  assert.throws(() => parseOPML('<?xml version="1.0"?><opml><body><outline text="folder"/></body></opml>'), /没有可导入/);
});

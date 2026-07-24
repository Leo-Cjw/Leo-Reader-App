import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { assertPublicURL, createPinnedLookup, extractArticle, extractWeChatArticle, isPrivateAddress, isWeChatVerificationPage, normalizeWeChatURL, parseRSS, requestPinnedAddress, resolvePublicURL, safeFetchImage, validateImageSignature } from '../src/server/importers.mjs';

test('private network addresses are rejected', async () => {
  for (const address of [
    '127.0.0.1', '10.0.0.8', '100.64.0.1', '100.127.255.254', '172.20.0.1', '192.168.1.2',
    '169.254.169.254', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
    '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe90::1', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1'
  ]) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  await assert.rejects(() => assertPublicURL('http://localhost/private'));
  await assert.rejects(() => assertPublicURL('file:///etc/passwd'));
  await assert.rejects(() => safeFetchImage('http://127.0.0.1/private-image.png'));
});

test('public URL resolution rejects credentials and any mixed private DNS answer', async () => {
  const publicLookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ];
  const target = await resolvePublicURL('https://example.test/article#fragment', { lookup: publicLookup });
  assert.equal(target.url.toString(), 'https://example.test/article');
  assert.deepEqual(target.addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }
  ]);
  await assert.rejects(
    resolvePublicURL('https://rebind.test/article', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]
    }),
    /私有网络/
  );
  await assert.rejects(assertPublicURL('https://user:secret@example.test/article', { lookup: publicLookup }), /用户名或密码/);
  assert.equal((await resolvePublicURL('https://[2606:4700:4700::1111]/dns-query')).addresses[0].family, 6);
});

test('pinned requests keep the original host and TLS identity while connecting only to the verified address', async () => {
  const compressed = gzipSync(Buffer.from('Reader pinned transport'));
  let captured;
  const requestImpl = (options, onResponse) => {
    captured = options;
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([compressed]);
      response.statusCode = 200;
      response.headers = { 'content-encoding': 'gzip', 'content-length': String(compressed.length), 'content-type': 'text/plain' };
      onResponse(response);
    });
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
    return request;
  };
  const result = await requestPinnedAddress(
    new URL('https://rebind.test:8443/article?q=reader#ignored'),
    { address: '93.184.216.34', family: 4 },
    { headers: { accept: 'text/plain' }, maxBytes: 1024, label: '测试内容', requestImpl }
  );
  assert.equal(result.bytes.toString(), 'Reader pinned transport');
  assert.equal(captured.hostname, 'rebind.test');
  assert.equal(captured.servername, 'rebind.test');
  assert.equal(captured.port, '8443');
  assert.equal(captured.path, '/article?q=reader');
  assert.equal(captured.agent, false);

  const single = await new Promise((resolve, reject) => captured.lookup('rebind.test', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(single, { address: '93.184.216.34', family: 4 });
  const all = await new Promise((resolve, reject) => createPinnedLookup({ address: '93.184.216.34', family: 4 })('rebind.test', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);

  let receivedHost = '';
  const server = http.createServer((request, response) => {
    receivedHost = request.headers.host || '';
    response.end('actual pinned lookup');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    const actual = await requestPinnedAddress(
      new URL(`http://public-name.test:${address.port}/reader`),
      { address: '127.0.0.1', family: 4 },
      { headers: {}, maxBytes: 1024, label: '测试内容' }
    );
    assert.equal(actual.bytes.toString(), 'actual pinned lookup');
    assert.equal(receivedHost, `public-name.test:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('pinned response limits and timeout cover the full response body', async () => {
  let redirectResponse;
  const redirectRequest = (_options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      redirectResponse = Readable.from([Buffer.from('redirect body must not be drained')]);
      redirectResponse.statusCode = 302;
      redirectResponse.headers = { location: 'https://example.test/next' };
      onResponse(redirectResponse);
    });
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
    return request;
  };
  const redirect = await requestPinnedAddress(new URL('http://example.test/start'), { address: '93.184.216.34', family: 4 }, {
    headers: {}, maxBytes: 8, label: '测试内容', requestImpl: redirectRequest
  });
  assert.equal(redirect.status, 302);
  assert.equal(redirectResponse.destroyed, true);

  const oversizedRequest = (_options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.alloc(6), Buffer.alloc(6)]);
      response.statusCode = 200;
      response.headers = {};
      onResponse(response);
    });
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
    return request;
  };
  await assert.rejects(
    requestPinnedAddress(new URL('http://example.test/large'), { address: '93.184.216.34', family: 4 }, {
      headers: {}, maxBytes: 8, label: '测试内容', requestImpl: oversizedRequest
    }),
    /超过 0 MB 限制/
  );

  const stalledRequest = () => {
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
    return request;
  };
  await assert.rejects(
    requestPinnedAddress(new URL('http://example.test/stalled'), { address: '93.184.216.34', family: 4 }, {
      headers: {}, maxBytes: 8, label: '测试内容', timeoutMs: 20, requestImpl: stalledRequest
    }),
    /超时/
  );
});

test('remote image signatures must match their declared MIME type', () => {
  const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
  assert.equal(validateImageSignature(png, 'image/png'), true);
  assert.equal(validateImageSignature(Buffer.from('<html>'), 'image/png'), false);
});

test('article extractor creates readable Markdown and queues inline images', () => {
  const article = extractArticle(`<!doctype html><html><head><title>测试文章</title><meta name="author" content="林默"><meta name="description" content="一篇用于测试的文章"><meta property="og:image" content="/images/cover.jpg"></head><body><nav>菜单</nav><article><h1>测试文章</h1><p>这是第一段足够长的正文，用于验证正文提取流程是否正常工作，也用于确认中文内容可以正确保留。</p><figure><img src="/images/chart.png" alt="离线架构图"><figcaption>本地优先架构</figcaption></figure><p>这是第二段，它会被保留，同时脚本和导航不会进入最终内容。最终提取结果应当适合在阅读器中排版。</p><script>window.bad=true</script></article></body></html>`, 'https://example.com/read');
  assert.equal(article.title, '测试文章');
  assert.equal(article.author, '林默');
  assert.match(article.content, /第一段/);
  assert.match(article.content, /!\[离线架构图\]\(__READER_LOCAL_IMAGE_0__\)/);
  assert.doesNotMatch(article.content, /window\.bad/);
  assert.equal(article.language, 'zh');
  assert.equal(article.metadata.leadImage, 'https://example.com/images/cover.jpg');
  assert.equal(article.metadata.extractor, 'mozilla-readability-v1');
  assert.equal(article.metadata.inlineImageCount, 1);
  assert.deepEqual(article.metadata.inlineImages[0], { token: '__READER_LOCAL_IMAGE_0__', url: 'https://example.com/images/chart.png', alt: '离线架构图' });
});

test('WeChat extractor reads the dedicated article container and lazy images', () => {
  const html = `<!doctype html><html><head><meta name="description" content="AI 编程第三次革命"><meta name="author" content="腾讯程序员"><meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg"></head><body><h1 id="activity-name"><span class="js_title_inner">Loop Engineering 实践指南</span></h1><span id="js_author_name_text">腾讯程序员</span><a id="js_name">腾讯技术工程</a><div id="js_content" style="visibility:hidden"><p>这是一段足够长的微信文章正文，用于验证专用提取器不会把环境验证页、菜单或页面脚本误认为文章内容。</p><h2>自主循环系统</h2><p>Reader 应保留标题、段落与图片，并把图片排入安全的本地化队列。</p><img data-src="https://mmbiz.qpic.cn/body.png" alt="循环架构图"><p style="display: none">隐藏噪声</p></div><script>var ct = "1760000000";</script></body></html>`;
  const article = extractWeChatArticle(html, 'https://mp.weixin.qq.com/s/test-token?from=share');
  assert.equal(article.url, 'https://mp.weixin.qq.com/s/test-token');
  assert.equal(article.title, 'Loop Engineering 实践指南');
  assert.equal(article.source, '腾讯技术工程');
  assert.equal(article.author, '腾讯程序员');
  assert.equal(article.metadata.extractor, 'wechat-article-v1');
  assert.equal(article.metadata.platform, 'wechat');
  assert.match(article.content, /## 自主循环系统/);
  assert.match(article.content, /!\[循环架构图\]\(__READER_LOCAL_IMAGE_0__\)/);
  assert.doesNotMatch(article.content, /隐藏噪声/);
  assert.deepEqual(article.metadata.inlineImages[0], { token: '__READER_LOCAL_IMAGE_0__', url: 'https://mmbiz.qpic.cn/body.png', alt: '循环架构图' });
});

test('WeChat verification pages are rejected and share URLs are canonicalized', () => {
  const challenge = '<html><body><h1>环境异常</h1><p>当前环境异常，完成验证后即可继续访问。</p><button>去验证</button></body></html>';
  assert.equal(isWeChatVerificationPage(challenge, 'https://mp.weixin.qq.com/mp/wappoc_appmsgcaptcha?target_url=x'), true);
  assert.equal(isWeChatVerificationPage('<h1 id="activity-name">标题</h1><div id="js_content">正文</div>', 'https://mp.weixin.qq.com/s/token'), false);
  assert.equal(normalizeWeChatURL('https://mp.weixin.qq.com/s/token/?from=timeline#wechat_redirect'), 'https://mp.weixin.qq.com/s/token');
});

test('RSS parser handles RSS items and stable IDs', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>示例订阅</title><item><title>第一篇</title><link>https://example.com/1</link><description><![CDATA[<p>第一篇文章的正文内容，用来测试 RSS 解析。</p>]]></description><guid>item-1</guid></item></channel></rss>`;
  const feed = parseRSS(xml, 'https://example.com/feed.xml');
  assert.equal(feed.title, '示例订阅');
  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0].title, '第一篇');
  assert.match(feed.items[0].id, /^rss-/);
});

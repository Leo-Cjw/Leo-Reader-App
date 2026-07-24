import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicURL, extractArticle, extractWeChatArticle, isPrivateAddress, isWeChatVerificationPage, normalizeWeChatURL, parseRSS, safeFetchImage, validateImageSignature } from '../src/server/importers.mjs';

test('private network addresses are rejected', async () => {
  for (const address of ['127.0.0.1', '10.0.0.8', '172.20.0.1', '192.168.1.2', '169.254.169.254', '::1', 'fd00::1']) assert.equal(isPrivateAddress(address), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(() => assertPublicURL('http://localhost/private'));
  await assert.rejects(() => assertPublicURL('file:///etc/passwd'));
  await assert.rejects(() => safeFetchImage('http://127.0.0.1/private-image.png'));
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

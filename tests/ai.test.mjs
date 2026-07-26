import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AIService } from '../src/server/ai.mjs';

const article = {
  id: 'source-1', title: 'Local-first Reader', excerpt: 'Reader keeps ownership local.',
  content: 'Reader 将[文章与附件](https://reader.example/docs/local-first)保存在本机。用户可以导出内容，并明确控制何时把正文发送给 AI 服务。',
  language: 'zh-CN', source: 'Reader Notes'
};

test('local AI reports privacy-safe capabilities and never simulates translation', async () => {
  const service = new AIService({ endpoint: '' });
  assert.deepEqual(service.status().capabilities, { summary: true, chat: true, rag: true, compose: true, translate: false });
  await assert.rejects(() => service.translate(article, 'en'), (error) => error.status === 503 && /不会/.test(error.message));
  const draft = await service.compose([article], { format: 'outline', language: 'zh-CN', prompt: '提炼产品原则' });
  assert.equal(draft.provider, 'local-structured');
  assert.match(draft.content, /Reader 来源 ID：source-1/);
  assert.match(draft.content, /提炼产品原则/);
  assert.doesNotMatch(draft.content, /https:\/\//);
  const versioned = await service.compose([{ ...article, id: 'source-2', content: 'Safari 18.2 shipped a feature. Safari 17.4 shipped another feature.' }], { format: 'brief', language: 'en' });
  assert.match(versioned.content, /Safari 18\.2 shipped a feature/);
});

test('configured AI uses the action contract and validates translate and compose results', async (t) => {
  const requests = [];
  const gateway = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ body, authorization: request.headers.authorization });
    const result = body.action === 'translate'
      ? { model: 'reader-test-model', language: 'en', title: 'Translated title', excerpt: 'Translated excerpt', content: '# Translation\n\nLocal data stays owned by the reader.' }
      : body.action === 'chat'
        ? { model: 'reader-test-model', answer: 'Reader keeps ownership local. [1]', citationIds: [body.context[0].id] }
        : { model: 'reader-test-model', language: 'en', title: 'Synthesis', excerpt: 'A source-backed synthesis.', content: '# Synthesis\n\nThe draft cites its supplied sources.' };
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result));
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => gateway.close(resolve)));
  const endpoint = `http://127.0.0.1:${gateway.address().port}`;
  const service = new AIService({ endpoint, apiKey: 'secret-test-key' });
  const translated = await service.translate(article, 'en');
  const composed = await service.compose([article], { format: 'brief', language: 'en', prompt: 'Compare ownership models' });
  const chatted = await service.chat(article, 'Where is ownership kept?', { scope: 'library', context: [{ id: 'chunk-1', articleId: article.id, articleTitle: article.title, articleSource: article.source, heading: 'Ownership', quote: 'Reader keeps ownership local.' }] });
  assert.equal(translated.title, 'Translated title');
  assert.equal(composed.title, 'Synthesis');
  assert.equal(chatted.answer, 'Reader keeps ownership local. [1]');
  assert.deepEqual(chatted.citationIds, ['chunk-1']);
  assert.deepEqual(requests.map((item) => item.body.action), ['translate', 'compose', 'chat']);
  assert.equal(requests[0].body.targetLanguage, 'en');
  assert.equal(requests[1].body.articles[0].id, article.id);
  assert.equal(requests[2].body.scope, 'library');
  assert.equal(requests[2].body.context[0].quote, 'Reader keeps ownership local.');
  assert.equal('article' in requests[2].body, false);
  assert.doesNotMatch(JSON.stringify(requests[2].body), /明确控制何时把正文发送/);
  assert.ok(requests.every((item) => item.authorization === 'Bearer secret-test-key'));
});

test('OpenAI-compatible providers discover a bounded model catalog and use chat completions', async (t) => {
  const requests = [];
  const provider = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'zeta-model', owned_by: 'local' },
          { id: 'alpha/model:latest', owned_by: 'local' },
          { id: 'bad model', owned_by: 'ignored' }
        ]
      }));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    const action = JSON.parse(body.messages[1].content).action;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-reader',
      model: 'alpha/model:latest',
      choices: [{
        message: {
          role: 'assistant',
          content: JSON.stringify(action === 'summarize'
            ? { summary: 'Reader compatible connection is healthy.', points: [] }
            : {
                language: 'en',
                title: 'Translated through a compatible provider',
                excerpt: 'Private and editable.',
                content: '# Translation\n\nReader remains local-first.'
              })
        },
        finish_reason: 'stop'
      }]
    }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const endpoint = `http://127.0.0.1:${provider.address().port}/v1/`;
  const service = new AIService({
    provider: 'openai-compatible',
    endpoint,
    model: 'alpha/model:latest',
    apiKey: 'compatible-secret'
  });

  assert.deepEqual(await service.listModels(), [
    { id: 'alpha/model:latest', ownedBy: 'local' },
    { id: 'zeta-model', ownedBy: 'local' }
  ]);
  const connection = await service.testConnection();
  assert.equal(connection.summary, 'Reader compatible connection is healthy.');
  assert.equal(connection.provider, 'openai-compatible');
  const translated = await service.translate(article, 'en');
  assert.equal(translated.provider, 'openai-compatible');
  assert.equal(translated.model, 'alpha/model:latest');
  assert.equal(translated.title, 'Translated through a compatible provider');
  assert.deepEqual(requests.map((item) => `${item.method} ${item.url}`), [
    'GET /v1/models',
    'POST /v1/chat/completions',
    'POST /v1/chat/completions'
  ]);
  assert.ok(requests.every((item) => item.authorization === 'Bearer compatible-secret'));
  assert.ok(requests.slice(1).every((item) => item.body.model === 'alpha/model:latest'));
  assert.ok(requests.slice(1).every((item) => JSON.stringify(item.body.response_format) === '{"type":"json_object"}'));
  assert.ok(requests.slice(1).every((item) => item.body.messages[0].role === 'system'));
  assert.equal(JSON.parse(requests[2].body.messages[1].content).action, 'translate');
  assert.equal(JSON.parse(requests[2].body.messages[1].content).article.id, undefined);
});

test('AI requests reject redirects before a credential can reach another endpoint', async (t) => {
  const targetRequests = [];
  const target = http.createServer((request, response) => {
    targetRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ summary: 'must not be reached' }));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => target.close(resolve)));

  const redirect = http.createServer((_request, response) => {
    response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/redirected` });
    response.end();
  });
  await new Promise((resolve) => redirect.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => redirect.close(resolve)));

  const service = new AIService({
    endpoint: `http://127.0.0.1:${redirect.address().port}/gateway`,
    apiKey: 'redirect-secret'
  });
  await assert.rejects(() => service.testConnection(), /连接失败/);
  assert.deepEqual(targetRequests, []);
});

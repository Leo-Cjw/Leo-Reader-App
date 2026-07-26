import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { extractPDFTextInProcess, parseArticleInProcess, runParserTask } from '../src/server/parser-process.mjs';

const fixtureWorker = fileURLToPath(new URL('./fixtures/parser-fixture-worker.mjs', import.meta.url));

function minimalPDF(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 14 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return body;
}

test('untrusted HTML is parsed in a bounded child process without changing article output', async () => {
  const article = await parseArticleInProcess(`<!doctype html><html><head><title>隔离解析</title><meta name="author" content="Reader QA"></head><body><article><h1>隔离解析</h1><p>这是一段足够长的正文，用来证明 Reader 会在独立解析进程中运行 Readability 和 Markdown 转换，而不是让不受信任的网页结构进入长期运行的本地服务进程。</p><p>解析结果仍保持原有文章字段、来源、语言和正文格式。</p></article></body></html>`, 'https://example.com/isolated');
  assert.equal(article.title, '隔离解析');
  assert.equal(article.author, 'Reader QA');
  assert.equal(article.source, 'example.com');
  assert.equal(article.metadata.extractor, 'mozilla-readability-v1');
  assert.match(article.content, /独立解析进程/);
});

test('parser child has a 256 MB old-space cap, bounded heap and clean launch environment', async () => {
  process.env.READER_PARSER_SECRET = 'must-not-cross-parser-boundary';
  try {
    const result = await runParserTask({ task: 'echo' }, { workerPath: fixtureWorker });
    assert.notEqual(result.pid, process.pid);
    assert.equal(result.execArgv.includes('--max-old-space-size=256'), true);
    assert.ok(result.heapLimit <= 512 * 1024 * 1024, `unexpected heap limit ${result.heapLimit}`);
    assert.equal(result.electronRunAsNode, '1');
    assert.equal(result.nodeOptions, '');
    assert.equal(result.parserWorker, '1');
    assert.equal(result.inheritedSecret, undefined);
    assert.equal(result.permissionsEnabled, true);
    assert.equal(result.fsWriteAllowed, false);
    assert.equal(result.arbitraryReadAllowed, false);
    assert.equal(result.nestedProcessBlocked, true);
  } finally {
    delete process.env.READER_PARSER_SECRET;
  }
});

test('parser grants the canonical source path when macOS resolves /tmp through /private/tmp', async (t) => {
  const root = await mkdtemp('/tmp/reader-parser-canonical-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'canonical.pdf');
  await writeFile(sourcePath, minimalPDF('Reader canonical parser path'));
  assert.match(await extractPDFTextInProcess(sourcePath), /Reader canonical parser path/);
});

test('parser timeout, crash and oversized output fail closed without poisoning later work', async () => {
  await assert.rejects(
    runParserTask({ task: 'hang' }, { workerPath: fixtureWorker, timeoutMs: 80 }),
    /解析超时/
  );
  await assert.rejects(
    runParserTask({ task: 'crash' }, { workerPath: fixtureWorker }),
    /异常退出/
  );
  await assert.rejects(
    runParserTask({ task: 'oversize' }, { workerPath: fixtureWorker, maxOutputBytes: 512 }),
    /结果超过安全限制/
  );
  await assert.rejects(
    runParserTask({ task: 'echo', value: 'x'.repeat(1000) }, { workerPath: fixtureWorker, maxInputBytes: 128 }),
    /输入超过安全限制/
  );
  const recovered = await runParserTask({ task: 'echo' }, { workerPath: fixtureWorker });
  assert.notEqual(recovered.pid, process.pid);
});

test('parser queue caps concurrent and pending untrusted work', async () => {
  const results = await Promise.allSettled(
    Array.from({ length: 35 }, () => runParserTask({ task: 'hang' }, { workerPath: fixtureWorker, timeoutMs: 60 }))
  );
  const reasons = results.filter((result) => result.status === 'rejected').map((result) => result.reason?.message || '');
  assert.equal(reasons.filter((message) => /解析超时/.test(message)).length, 34);
  assert.equal(reasons.filter((message) => /解析队列繁忙/.test(message)).length, 1);
  const recovered = await runParserTask({ task: 'echo' }, { workerPath: fixtureWorker });
  assert.notEqual(recovered.pid, process.pid);
});

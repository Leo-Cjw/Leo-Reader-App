const MAX_STDIN_BYTES = 12 * 1024 * 1024;
let responseMarker = '__READER_PARSER_INVALID_RESPONSE__';

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) throw new Error('解析输入超过安全限制');
    chunks.push(Buffer.from(chunk));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!request || request.version !== 1 || typeof request.task !== 'string' || !/^[0-9a-f]{32}$/.test(request.nonce || '')) throw new Error('解析请求无效');
  responseMarker = `__READER_PARSER_RESPONSE_${request.nonce}__`;
  return request;
}

async function execute(request) {
  if (request.task === 'html') {
    const { extractArticle } = await import('./importers.mjs');
    return extractArticle(request.html, request.canonicalURL);
  }
  if (request.task === 'pdf-text') {
    const { extractPDFText } = await import('./parser-tasks.mjs');
    return await extractPDFText(request.sourcePath);
  }
  if (request.task === 'thumbnail') {
    const { renderThumbnail } = await import('./parser-tasks.mjs');
    const output = await renderThumbnail(request.sourcePath, request.mimeType);
    return { base64: output.toString('base64') };
  }
  throw new Error('未知解析任务');
}

try {
  const request = await readRequest();
  const result = await execute(request);
  process.stdout.write(`${responseMarker}${JSON.stringify({ version: 1, ok: true, result })}`);
} catch (error) {
  process.stdout.write(`${responseMarker}${JSON.stringify({
    version: 1,
    ok: false,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    status: Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 422
  })}`);
  process.exitCode = 1;
}

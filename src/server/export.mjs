import path from 'node:path';
import { access, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { once } from 'node:events';
import archiver from 'archiver';

const MAX_EXPORT_ARTICLES = 500;

function safeSegment(value, fallback = 'untitled', maxLength = 88) {
  const clean = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, maxLength)
    .trim();
  return clean || fallback;
}

function yamlString(value) {
  return JSON.stringify(value === null || value === undefined ? '' : String(value));
}

function articleMarkdown(article, markdownPathByAttachment) {
  let content = String(article.content || '');
  for (const attachment of article.attachments || []) {
    const relativePath = markdownPathByAttachment.get(attachment.id);
    if (!relativePath) continue;
    content = content.replaceAll(`/api/attachments/${attachment.id}/content`, relativePath);
    content = content.replaceAll(`/api/attachments/${attachment.id}/thumbnail`, relativePath);
  }
  const unreferencedAttachments = (article.attachments || []).filter((attachment) => {
    const relativePath = markdownPathByAttachment.get(attachment.id);
    return relativePath && !content.includes(relativePath);
  });
  if (unreferencedAttachments.length) {
    const attachmentLines = unreferencedAttachments.map((attachment) => {
      const label = String(attachment.file_name || '附件').replace(/[\[\]]/g, '');
      const relativePath = markdownPathByAttachment.get(attachment.id);
      return attachment.mime_type.startsWith('image/') ? `![${label}](${relativePath})` : `- [${label}](${relativePath})`;
    });
    content = `${content.trim()}${content.trim() ? '\n\n' : ''}## 附件\n\n${attachmentLines.join('\n\n')}`;
  }
  if (article.highlights?.length) {
    const annotations = article.highlights.map((highlight, index) => {
      const quote = String(highlight.quote || '').replaceAll('\n', '\n> ');
      const note = String(highlight.note || '').trim();
      return `### 高亮 ${index + 1}\n\n> ${quote}\n\n${note ? `批注：${note}\n\n` : ''}_颜色：${highlight.color} · 创建于 ${highlight.created_at}_`;
    });
    content = `${content.trim()}${content.trim() ? '\n\n' : ''}## 高亮与批注\n\n${annotations.join('\n\n')}`;
  }
  const tagLines = article.tags?.length ? ['tags:', ...article.tags.map((tag) => `  - ${yamlString(tag)}`)] : ['tags: []'];
  const lines = [
    '---',
    `reader_id: ${yamlString(article.id)}`,
    `title: ${yamlString(article.title)}`,
    `source: ${yamlString(article.source)}`,
    `author: ${yamlString(article.author)}`,
    `type: ${yamlString(article.type)}`,
    `language: ${yamlString(article.language)}`,
    `collection: ${yamlString(article.collection_name || '')}`,
    `original_url: ${yamlString(article.url || '')}`,
    `published_at: ${yamlString(article.published_at || '')}`,
    `created_at: ${yamlString(article.created_at)}`,
    `exported_at: ${yamlString(new Date().toISOString())}`,
    ...tagLines,
    '---',
    '',
    `# ${article.title}`,
    '',
    article.excerpt ? `> ${String(article.excerpt).replaceAll('\n', '\n> ')}` : '',
    '',
    content,
    ''
  ];
  return lines.join('\n');
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function prepareMarkdownExport({ database, filesDir, ids, includeAttachments = true }) {
  const normalizedIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean))];
  if (!normalizedIds.length) throw Object.assign(new Error('请选择至少一条内容'), { status: 400 });
  if (normalizedIds.length > MAX_EXPORT_ARTICLES) throw Object.assign(new Error(`一次最多导出 ${MAX_EXPORT_ARTICLES} 条内容`), { status: 400 });
  const articles = await database.getArticlesForExport(normalizedIds);
  if (articles.length !== normalizedIds.length) throw Object.assign(new Error('部分内容不存在，无法完成导出'), { status: 404 });

  const resolvedFilesRoot = path.resolve(filesDir);
  const entries = [];
  const manifestArticles = [];
  let attachmentCount = 0;
  let attachmentBytes = 0;
  let highlightCount = 0;

  for (const article of articles) {
    const articleStem = `${safeSegment(article.title)}-${article.id.slice(0, 8)}`;
    const markdownArchivePath = path.posix.join('articles', `${articleStem}.md`);
    const attachmentPaths = new Map();
    const manifestAttachments = [];
    const usedNames = new Set();
    if (includeAttachments) {
      for (const attachment of article.attachments || []) {
        let fileName = safeSegment(attachment.file_name, `attachment-${attachment.id.slice(0, 8)}`, 110);
        const parsed = path.parse(fileName);
        let suffix = 2;
        while (usedNames.has(fileName.toLocaleLowerCase())) fileName = `${parsed.name}-${suffix++}${parsed.ext}`;
        usedNames.add(fileName.toLocaleLowerCase());
        const sourcePath = path.resolve(filesDir, attachment.storage_name);
        if (!sourcePath.startsWith(`${resolvedFilesRoot}${path.sep}`)) throw Object.assign(new Error('附件路径无效'), { status: 400 });
        try { await access(sourcePath); } catch { throw Object.assign(new Error(`附件缺失：${attachment.file_name}`), { status: 409 }); }
        const info = await stat(sourcePath);
        const archivePath = path.posix.join('attachments', articleStem, fileName);
        const markdownRelativePath = `../${archivePath}`;
        attachmentPaths.set(attachment.id, markdownRelativePath);
        entries.push({ kind: 'file', sourcePath, archivePath });
        manifestAttachments.push({ id: attachment.id, path: archivePath, fileName: attachment.file_name, mimeType: attachment.mime_type, byteSize: info.size, sha256: attachment.sha256 });
        attachmentCount += 1;
        attachmentBytes += info.size;
      }
    }
    entries.push({ kind: 'buffer', archivePath: markdownArchivePath, content: articleMarkdown(article, attachmentPaths) });
    highlightCount += article.highlights?.length || 0;
    manifestArticles.push({
      id: article.id, title: article.title, path: markdownArchivePath, type: article.type, language: article.language,
      originalURL: article.url || null, collection: article.collection_name || null, tags: article.tags || [],
      highlights: (article.highlights || []).map((highlight) => ({
        id: highlight.id, quote: highlight.quote, note: highlight.note, color: highlight.color,
        startOffset: highlight.start_offset, endOffset: highlight.end_offset, createdAt: highlight.created_at, updatedAt: highlight.updated_at
      })),
      attachments: manifestAttachments
    });
  }

  const createdAt = new Date().toISOString();
  const manifest = {
    format: 'reader-markdown-export', formatVersion: 2, appVersion: '0.17.0', createdAt,
    options: { includeAttachments: Boolean(includeAttachments) },
    counts: { articles: articles.length, highlights: highlightCount, attachments: attachmentCount, attachmentBytes },
    articles: manifestArticles
  };
  entries.push({ kind: 'buffer', archivePath: 'manifest.json', content: JSON.stringify(manifest, null, 2) });
  entries.push({ kind: 'buffer', archivePath: 'README.md', content: '# Reader Markdown Export\n\n`articles/` 中的内容是标准 Markdown，文章末尾保留高亮与批注；`attachments/` 保存原始附件。正文使用相对路径，可直接复制到其他笔记或知识库工具。`manifest.json` 记录来源、标签、高亮锚点与附件 SHA-256。\n' });
  return { fileName: `Reader-Markdown-${timestampSlug()}.zip`, manifest, entries };
}

export async function streamMarkdownExport(response, prepared) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('warning', (error) => { if (error.code !== 'ENOENT') response.destroy(error); });
  archive.on('error', (error) => response.destroy(error));
  response.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(prepared.fileName)}`,
    'x-reader-filename': encodeURIComponent(prepared.fileName),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  });
  archive.pipe(response);
  for (const entry of prepared.entries) {
    if (entry.kind === 'file') archive.append(createReadStream(entry.sourcePath), { name: entry.archivePath });
    else archive.append(entry.content, { name: entry.archivePath });
  }
  const finished = once(response, 'finish');
  await archive.finalize();
  await finished;
}

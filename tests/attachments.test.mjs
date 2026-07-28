import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { ReaderDatabase } from '../src/server/db.mjs';
import { attachStagedImage, importStagedAttachment, localizeRemoteImage, sanitizeFileName, stageAttachment, storeRemoteImage, validateAttachmentType, validateAudioSignature } from '../src/server/attachments.mjs';

function createMinimalPDF(text) {
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
  return Buffer.from(body);
}

test('attachment validation sanitizes names and blocks executable formats', () => {
  assert.equal(sanitizeFileName('../draft:reader.md'), 'draft-reader.md');
  assert.equal(validateAttachmentType('photo.png', 'image/png'), 'image/png');
  assert.throws(() => validateAttachmentType('payload.app', 'application/octet-stream'), /不支持/);
});

test('audio attachments validate MP3, M4A, AAC and WAV signatures and become playable media articles', async (t) => {
  const fixtures = [
    ['voice.mp3', 'audio/mpeg', Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)])],
    ['voice.m4a', 'audio/mp4', Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(24)])],
    ['voice.aac', 'audio/aac', Buffer.from([0xff, 0xf1, ...Array(30).fill(0)])],
    ['voice.wav', 'audio/wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(24)])]
  ];
  for (const [, mimeType, bytes] of fixtures) assert.equal(validateAudioSignature(bytes, mimeType), true);
  assert.equal(validateAudioSignature(Buffer.from('not audio'), 'audio/mpeg'), false);

  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-audio-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'data', 'imports');
  const filesDir = path.join(root, 'data', 'files');
  const database = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const [fileName, mimeType, bytes] = fixtures[0];
  const staged = await stageAttachment(Readable.from([bytes]), { stagingDir, fileName, mimeType });
  const article = await importStagedAttachment(database, staged, { stagingDir, filesDir });
  assert.equal(article.type, 'audio');
  assert.equal(article.attachments[0].mime_type, 'audio/mpeg');
  await assert.rejects(stageAttachment(Readable.from([Buffer.from('spoof')]), { stagingDir, fileName: 'spoof.mp3', mimeType: 'audio/mpeg' }), /MIME/);
});

test('PDF attachment is streamed, indexed and extracted into a local article', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'data', 'imports');
  const filesDir = path.join(root, 'data', 'files');
  const db = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const pdf = createMinimalPDF('Reader PDF attachment test');
  const staged = await stageAttachment(Readable.from([pdf]), { stagingDir, fileName: 'Reader Guide.pdf', mimeType: 'application/pdf' });
  assert.equal(staged.byteSize, pdf.length);
  assert.equal(staged.sha256.length, 64);

  const article = await importStagedAttachment(db, { ...staged, collectionId: 'papers' }, { stagingDir, filesDir });
  assert.equal(article.type, 'pdf');
  assert.match(article.content, /Reader PDF attachment test/);
  assert.equal(article.attachments.length, 1);
  assert.equal(article.attachments[0].file_name, 'Reader Guide.pdf');

  const stagedAgain = await stageAttachment(Readable.from([pdf]), { stagingDir, fileName: 'Reader Guide.pdf', mimeType: 'application/pdf' });
  const duplicate = await importStagedAttachment(db, { ...stagedAgain, collectionId: 'inbox' }, { stagingDir, filesDir });
  assert.equal(duplicate.id, article.id);
  assert.equal(duplicate.attachments.length, 1);
});

test('remote lead image is localized once and attached to the article', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesDir = path.join(root, 'data', 'files');
  const db = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const article = await db.createArticle({ title: 'Offline image article', content: 'An article with a locally stored lead image.' });
  const imageBytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);
  const fetchImage = async () => ({ bytes: imageBytes, contentType: 'image/png', url: 'https://example.com/cover.png' });
  const localized = await localizeRemoteImage(db, article, 'https://example.com/cover.png', { filesDir, fetchImage });
  assert.equal(localized.attachments.length, 1);
  assert.equal(localized.attachments[0].mime_type, 'image/png');
  assert.equal((await readdir(filesDir)).length, 1);
  const duplicate = await localizeRemoteImage(db, localized, 'https://example.com/cover.png', { filesDir, fetchImage });
  assert.equal(duplicate.attachments.length, 1);
});

test('multiple remote body images are deduplicated by content and keep local URLs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-inline-images-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filesDir = path.join(root, 'data', 'files');
  const db = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const article = await db.createArticle({ title: 'Inline images', content: 'Body images are stored locally.' });
  const firstBytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
  const secondBytes = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,2]);
  const first = await storeRemoteImage(db, article, 'https://example.com/one.png', { filesDir, fileName: '示意图', fetchImage: async () => ({ bytes: firstBytes, contentType: 'image/png' }) });
  const duplicate = await storeRemoteImage(db, article, 'https://example.com/one-copy.png', { filesDir, fileName: '重复图', fetchImage: async () => ({ bytes: firstBytes, contentType: 'image/png' }) });
  const second = await storeRemoteImage(db, article, 'https://example.com/two.png', { filesDir, fileName: '流程图', fetchImage: async () => ({ bytes: secondBytes, contentType: 'image/png' }) });
  assert.equal(first.id, duplicate.id);
  assert.notEqual(first.id, second.id);
  assert.match(first.url, /^\/api\/attachments\//);
  assert.equal((await db.getArticle(article.id)).attachments.length, 2);
  assert.equal((await readdir(filesDir)).length, 2);
});

test('editor images attach to an existing article, validate signatures and deduplicate safely', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-editor-image-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stagingDir = path.join(root, 'data', 'imports');
  const filesDir = path.join(root, 'data', 'files');
  const db = await new ReaderDatabase(path.join(root, 'reader.sqlite3')).initialize();
  const article = await db.createArticle({ title: '图文笔记', content: '# 正文' });
  const canvas = createCanvas(320, 180);
  const context = canvas.getContext('2d');
  context.fillStyle = '#bd6845'; context.fillRect(0, 0, 320, 180);
  const bytes = canvas.toBuffer('image/png');
  const staged = await stageAttachment(Readable.from([bytes]), { stagingDir, fileName: '写作配图.png', mimeType: 'image/png' });
  const attached = await attachStagedImage(db, article.id, staged, { stagingDir, filesDir });
  assert.equal(attached.duplicate, false);
  assert.equal(attached.article.id, article.id);
  assert.equal(attached.article.attachments.length, 1);
  assert.match(attached.attachment.url, /^\/api\/attachments\//);

  const stagedAgain = await stageAttachment(Readable.from([bytes]), { stagingDir, fileName: '同一配图.png', mimeType: 'image/png' });
  const duplicate = await attachStagedImage(db, article.id, stagedAgain, { stagingDir, filesDir });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.attachment.id, attached.attachment.id);
  assert.equal((await readdir(filesDir)).length, 1);

  const spoofed = await stageAttachment(Readable.from([Buffer.from('not a png')]), { stagingDir, fileName: '伪造图片.png', mimeType: 'image/png' });
  await assert.rejects(() => attachStagedImage(db, article.id, spoofed, { stagingDir, filesDir }), /MIME 类型不一致/);
  assert.equal((await readdir(stagingDir)).length, 0);
});

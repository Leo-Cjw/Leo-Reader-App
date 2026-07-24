import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { getAttachmentThumbnail, supportsAttachmentThumbnail } from '../src/server/thumbnails.mjs';

function createMinimalPDF() {
  const stream = '0.15 0.24 0.31 rg 72 500 468 200 re f 0.82 0.46 0.28 rg 150 555 312 90 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
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

test('image and PDF thumbnails are rendered locally and cached by content hash', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reader-thumbnails-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const thumbnailsDir = path.join(root, 'thumbnails');
  const canvas = createCanvas(1200, 700);
  const context = canvas.getContext('2d');
  context.fillStyle = '#24303a'; context.fillRect(0, 0, 1200, 700);
  context.fillStyle = '#d08b5b'; context.fillRect(220, 140, 760, 420);
  const imagePath = path.join(root, 'source.png');
  await writeFile(imagePath, canvas.toBuffer('image/png'));
  const imageAttachment = { mime_type: 'image/png', sha256: 'a'.repeat(64) };
  const imageThumbnail = await getAttachmentThumbnail({ attachment: imageAttachment, sourcePath: imagePath, thumbnailsDir });
  const imageThumbnailBytes = await readFile(imageThumbnail.path);
  assert.equal(imageThumbnailBytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(imageThumbnailBytes.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.equal((await getAttachmentThumbnail({ attachment: imageAttachment, sourcePath: imagePath, thumbnailsDir })).path, imageThumbnail.path);
  await assert.rejects(getAttachmentThumbnail({ attachment: { ...imageAttachment, sha256: '../outside' }, sourcePath: imagePath, thumbnailsDir }), /哈希无效/);

  const pdfPath = path.join(root, 'source.pdf');
  await writeFile(pdfPath, createMinimalPDF());
  const pdfAttachment = { mime_type: 'application/pdf', sha256: 'b'.repeat(64) };
  const pdfThumbnail = await getAttachmentThumbnail({ attachment: pdfAttachment, sourcePath: pdfPath, thumbnailsDir });
  const pdfThumbnailBytes = await readFile(pdfThumbnail.path);
  assert.equal(pdfThumbnailBytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(pdfThumbnailBytes.subarray(8, 12).toString('ascii'), 'WEBP');
  assert.equal(supportsAttachmentThumbnail('video/mp4'), false);
});

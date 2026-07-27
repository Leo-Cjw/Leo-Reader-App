import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(projectRoot, 'design', 'logo', 'reader-logo-future-v1-1024.png');
const outputPath = path.join(projectRoot, 'build', 'Reader.icns');
await mkdir(path.dirname(outputPath), { recursive: true });
const sourceImage = await loadImage(sourcePath);

const variants = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024]
];

const chunks = [];
for (const [type, size] of variants) {
  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(sourceImage, 0, 0, size, size);
  const png = canvas.toBuffer('image/png');
  const chunk = Buffer.alloc(8);
  chunk.write(type, 0, 4, 'ascii');
  chunk.writeUInt32BE(png.length + 8, 4);
  chunks.push(chunk, png);
}

const contents = Buffer.concat(chunks);
const header = Buffer.alloc(8);
header.write('icns', 0, 4, 'ascii');
header.writeUInt32BE(contents.length + 8, 4);
await writeFile(outputPath, Buffer.concat([header, contents]));
console.log(outputPath);

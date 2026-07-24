import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsetDir = path.join(projectRoot, 'build', 'Reader.iconset');
const outputPath = path.join(projectRoot, 'build', 'Reader.icns');
await mkdir(iconsetDir, { recursive: true });

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
  context.closePath();
}

function renderIcon(size) {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  const scale = size / 1024;

  context.scale(scale, scale);
  const background = context.createLinearGradient(128, 90, 896, 936);
  background.addColorStop(0, '#f4efe4');
  background.addColorStop(1, '#d9cdbc');
  roundedRect(context, 54, 54, 916, 916, 210);
  context.fillStyle = background;
  context.fill();

  context.shadowColor = 'rgba(32, 28, 23, .25)';
  context.shadowBlur = 48;
  context.shadowOffsetY = 24;
  roundedRect(context, 166, 146, 692, 716, 164);
  context.fillStyle = '#252521';
  context.fill();
  context.shadowColor = 'transparent';

  context.strokeStyle = '#b86a48';
  context.lineWidth = 22;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(252, 264);
  context.lineTo(772, 264);
  context.stroke();

  context.fillStyle = '#f8f4ea';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = 'italic 700 520px Georgia';
  context.fillText('R', 491, 585);

  context.fillStyle = '#b86a48';
  context.beginPath();
  context.arc(758, 758, 32, 0, Math.PI * 2);
  context.fill();
  return canvas.toBuffer('image/png');
}

const variants = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
];

for (const [name, size] of variants) await writeFile(path.join(iconsetDir, name), renderIcon(size));

const result = spawnSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', outputPath], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'iconutil failed');
console.log(outputPath);

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SCHEMA_VERSION } from '../src/server/schema.mjs';
import {
  RELEASE_SIGNATURES,
  writeMacReleaseManifest
} from './lib/release-manifest.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const releaseRoot = path.join(projectRoot, 'release');
const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const electronMetadata = JSON.parse(
  await readFile(path.join(projectRoot, 'node_modules', 'electron', 'package.json'), 'utf8')
);

const { manifest, manifestPath } = await writeMacReleaseManifest({
  projectRoot,
  releaseRoot,
  packageMetadata,
  schemaVersion: SCHEMA_VERSION,
  electronVersion: electronMetadata.version,
  signature: RELEASE_SIGNATURES.AD_HOC
});

console.log('Reader ad-hoc 发行清单已生成并复验：');
console.log(manifestPath);
for (const artifact of manifest.artifacts) {
  console.log(`${artifact.fileName}: ${artifact.sha256}`);
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(projectRoot, '.github', 'workflows', 'ci.yml');

test('macOS CI verifies every main push and pull request without release credentials', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /^name: CI$/m);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /verify:\n\s+runs-on: macos-15\n\s+timeout-minutes: 20/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /node-version: '24'/);
  assert.match(workflow, /cache: npm/);

  const steps = ['npm ci', 'npm run audit:dependencies', 'npm test', 'npm run build'];
  let previous = -1;
  for (const step of steps) {
    const index = workflow.indexOf(step);
    assert.ok(index > previous, `${step} should run in order`);
    previous = index;
  }

  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|desktop:pack|notary|publish/i);
});

test('the project declares the Node version used by CI', async () => {
  const packageJSON = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJSON.engines.node, '>=24 <25');
});

test('the SQLite shell enables trusted schema for Reader-managed FTS triggers', async () => {
  const database = await readFile(path.join(projectRoot, 'src', 'server', 'db.mjs'), 'utf8');
  assert.match(database, /PRAGMA foreign_keys = ON;\\nPRAGMA trusted_schema = ON;/);
});

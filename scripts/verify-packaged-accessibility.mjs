import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const projectRoot = path.resolve(import.meta.dirname, '..');
const appPath = path.resolve(process.argv[2] || path.join(projectRoot, 'release', 'mac-universal', 'Reader.app'));
const executable = path.join(appPath, 'Contents', 'MacOS', 'Reader');
const interactiveRoles = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'
]);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(label, operation, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  let lastResult;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      lastResult = result;
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${label}超时${lastError ? `：${lastError.message}` : lastResult !== undefined ? `；最终状态 ${JSON.stringify(lastResult)}` : ''}`);
}

class CDPClient {
  constructor(socket) {
    this.socket = socket;
    this.nextID = 0;
    this.pending = new Map();
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new CDPClient(socket);
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextID;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async value(expression) {
    const result = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
    }
    return result.result.value;
  }

  async tree() {
    const result = await this.call('Accessibility.getFullAXTree', { depth: -1 });
    return result.nodes.filter((node) => !node.ignored);
  }

  close() {
    this.socket.close();
  }
}

function nodeName(node) {
  return String(node.name?.value || '').trim();
}

function assertNamedControls(nodes, context) {
  const unnamed = nodes
    .filter((node) => interactiveRoles.has(node.role?.value) && !nodeName(node))
    .map((node) => `${node.role?.value}:${node.nodeId}`);
  assert.deepEqual(unnamed, [], `${context}存在无可访问名称的控件`);
}

function roleNames(nodes, role) {
  return nodes.filter((node) => node.role?.value === role).map(nodeName);
}

async function dispatchKey(client, key, code, nativeVirtualKeyCode) {
  const params = { key, code, windowsVirtualKeyCode: nativeVirtualKeyCode, nativeVirtualKeyCode };
  await client.call('Input.dispatchKeyEvent', { ...params, type: 'keyDown' });
  await client.call('Input.dispatchKeyEvent', { ...params, type: 'keyUp' });
}

async function verifyDialog(client, specification) {
  const opened = await client.value(`(() => {
    const candidate = ${specification.find};
    if (!(candidate instanceof HTMLElement)) return { found: false, focused: false };
    candidate.focus();
    const focused = document.activeElement === candidate;
    candidate.click();
    return { found: true, focused };
  })()`);
  assert.equal(opened.found, true, `找不到“${specification.name}”入口`);
  assert.equal(opened.focused, true, `“${specification.name}”入口无法获得焦点`);

  const state = await waitFor(`${specification.name}对话框`, async () => {
    const value = await client.value(`(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
      const dialog = dialogs.at(-1);
      if (!dialog) return null;
      const labelledBy = (dialog.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
      const label = dialog.getAttribute('aria-label')
        || labelledBy.map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
      return {
        count: dialogs.length,
        label,
        appInert: document.querySelector('.app-window')?.hasAttribute('inert') === true,
        focusInside: dialog.contains(document.activeElement),
        closable: dialog.querySelector('button[aria-label^="关闭"]:not([disabled])') !== null,
        activeTag: document.activeElement?.tagName || '',
        activeText: document.activeElement?.textContent?.trim().slice(0, 200) || ''
      };
    })()`);
    return value?.count && value.appInert && value.focusInside && value.closable ? value : null;
  });

  assert.equal(state.count, 1, `${specification.name}打开后只能有一个活动模态框`);
  assert.equal(state.label, specification.dialogLabel);
  assert.equal(state.appInert, true, `${specification.name}打开后背景必须 inert`);
  assert.equal(state.focusInside, true, `${specification.name}打开后焦点必须进入对话框`);
  if (specification.initialFocus) {
    assert.deepEqual(
      { tag: state.activeTag, text: state.activeText },
      specification.initialFocus,
      `${specification.name}没有把初始焦点放到命名标题`
    );
  }

  const modalTree = await client.tree();
  assert.equal(roleNames(modalTree, 'dialog').length, 1, `${specification.name}必须暴露一个 dialog`);
  assert.equal(roleNames(modalTree, 'main').length, 0, `${specification.name}打开后不能暴露背景 main`);
  assertNamedControls(modalTree, `${specification.name}对话框`);

  await dispatchKey(client, 'Tab', 'Tab', 9);
  assert.equal(
    await client.value("document.querySelector('[role=\"dialog\"][aria-modal=\"true\"]')?.contains(document.activeElement) === true"),
    true,
    `${specification.name}中的 Tab 不能逃出对话框`
  );
  const escape = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await client.call('Input.dispatchKeyEvent', { ...escape, type: 'keyDown' });
  const closed = await waitFor(`${specification.name}关闭`, async () => {
    const value = await client.value(`(() => ({
      dialogs: document.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
      appInert: document.querySelector('.app-window')?.hasAttribute('inert') === true,
      openerFocused: document.activeElement?.matches(${JSON.stringify(specification.openerMatch)}) === true,
      activeTag: document.activeElement?.tagName || '',
      activeText: document.activeElement?.textContent?.trim().slice(0, 120) || '',
      activeClass: document.activeElement?.className || ''
    }))()`);
    if (value.dialogs === 0 && !value.appInert && value.openerFocused) return value;
    throw new Error(`最终状态 ${JSON.stringify(value)}`);
  });
  assert.equal(closed.appInert, false, `${specification.name}关闭后必须恢复背景`);
  assert.equal(closed.openerFocused, true, `${specification.name}关闭后必须把焦点还给入口`);
  await client.call('Input.dispatchKeyEvent', { ...escape, type: 'keyUp' });
  assert.equal(
    await client.value(`document.activeElement?.matches(${JSON.stringify(specification.openerMatch)}) === true`),
    true,
    `${specification.name}的 Escape keyup 不能移走返回焦点`
  );
}

if (process.platform !== 'darwin') throw new Error('打包可访问性门禁仅支持 macOS');
await access(executable);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'reader-accessibility-'));
const chromiumRoot = path.join(temporaryRoot, 'chromium');
const readerRoot = path.join(temporaryRoot, 'reader-data');
await mkdir(chromiumRoot, { recursive: true });

let stderr = '';
let client;
let spawnError;
const child = spawn(executable, [
  `--user-data-dir=${chromiumRoot}`,
  '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0',
  '--force-renderer-accessibility'
], {
  env: {
    ...process.env,
    READER_DESKTOP_DATA_ROOT: readerRoot,
    READER_RELEASE_QA: '1'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
child.stderr.on('data', (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-16_384);
});
child.once('error', (error) => {
  spawnError = error;
});

try {
  const activePortPath = path.join(chromiumRoot, 'DevToolsActivePort');
  const port = await waitFor('DevTools 端口', async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Reader 提前退出（${child.exitCode}）\n${stderr}`);
    const value = Number(String(await readFile(activePortPath, 'utf8')).split(/\r?\n/, 1)[0]);
    return Number.isInteger(value) && value > 0 ? value : null;
  });
  const target = await waitFor('Reader 页面', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((item) => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(item.url));
  });
  client = await CDPClient.connect(target.webSocketDebuggerUrl);
  await client.call('Accessibility.enable');
  await waitFor('Reader 工作区', async () => client.value(
    "document.readyState === 'complete' && document.querySelector('.app-window') !== null && document.querySelector('[aria-busy=\"true\"]') === null"
  ));
  await client.value("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");

  const health = await client.value("fetch('/api/health').then((response) => response.json())");
  assert.equal(health.ok, true);
  assert.equal(health.schemaVersion, 11);

  const ids = await client.value(`(() => {
    const values = [...document.querySelectorAll('[id]')].map((element) => element.id);
    return values.filter((id, index) => values.indexOf(id) !== index);
  })()`);
  assert.deepEqual(ids, [], '打包页面不能包含重复 DOM id');

  const workspaceTree = await client.tree();
  assert.equal(roleNames(workspaceTree, 'RootWebArea')[0], 'Reader — 本地阅读工作台');
  assert.equal(roleNames(workspaceTree, 'banner').length, 1);
  assert.ok(roleNames(workspaceTree, 'complementary').includes('产品导航'));
  assert.ok(roleNames(workspaceTree, 'complementary').includes('AI 文章助手'));
  assert.ok(roleNames(workspaceTree, 'region').includes('收件箱'));
  assert.ok(roleNames(workspaceTree, 'main').some((name) => name.startsWith('阅读器：')));
  assert.ok(roleNames(workspaceTree, 'treeitem').length >= 5);
  assertNamedControls(workspaceTree, '主工作区');

  const dialogs = [
    {
      name: '设置',
      find: "[...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '设置')",
      dialogLabel: '应用设置与 AI 隐私',
      openerMatch: '.title-actions button:nth-of-type(2)',
      initialFocus: { tag: 'H2', text: '应用设置与 AI 隐私' }
    },
    {
      name: '添加内容',
      find: "document.querySelector('.brand-row button[aria-label=\"添加内容\"]')",
      dialogLabel: '添加内容',
      openerMatch: '.brand-row button[aria-label="添加内容"]'
    },
    {
      name: '订阅管理',
      find: "document.querySelector('button[aria-label=\"管理订阅\"]')",
      dialogLabel: '订阅管理',
      openerMatch: 'button[aria-label="管理订阅"]'
    },
    {
      name: '资料夹管理',
      find: "document.querySelector('button[aria-label=\"管理资料夹\"]')",
      dialogLabel: '资料夹管理',
      openerMatch: 'button[aria-label="管理资料夹"]'
    },
    {
      name: '智能资料夹管理',
      find: "document.querySelector('button[aria-label=\"管理智能资料夹\"]')",
      dialogLabel: '智能资料夹管理',
      openerMatch: 'button[aria-label="管理智能资料夹"]'
    },
    {
      name: '重复内容治理',
      find: "document.querySelector('button[aria-label=\"检查重复内容\"]')",
      dialogLabel: '重复内容治理',
      openerMatch: 'button[aria-label="检查重复内容"]'
    },
    {
      name: '导入队列',
      find: "document.querySelector('.queue-button')",
      dialogLabel: '导入队列',
      openerMatch: '.queue-button'
    },
    {
      name: '数据安全中心',
      find: "document.querySelector('.local-status')",
      dialogLabel: '数据安全中心',
      openerMatch: '.local-status'
    }
  ];
  for (const dialog of dialogs) await verifyDialog(client, dialog);

  console.log(`Reader ${health.version} 打包可访问性门禁通过`);
  console.log(`AX exposed nodes=${workspaceTree.length}`);
  console.log(`dialogs=${dialogs.length}`);
  console.log('unnamed interactive controls=0');
  console.log('temporary data isolated=true');
} finally {
  client?.close();
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)]);
    if (!graceful && child.exitCode === null) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(2_000)]);
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

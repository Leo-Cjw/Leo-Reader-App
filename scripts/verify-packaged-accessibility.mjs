import assert from 'node:assert/strict';
import { launchPackagedReader, packagedReaderApp, waitFor } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
const interactiveRoles = new Set([
  'button', 'checkbox', 'combobox', 'link', 'listbox', 'menuitem', 'radio',
  'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem'
]);

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

async function openIntermediateDialog(client, name, find, dialogLabel) {
  const opened = await client.value(`(() => {
    const candidate = ${find};
    if (!(candidate instanceof HTMLElement)) return { found: false, focused: false };
    candidate.focus();
    const focused = document.activeElement === candidate;
    candidate.click();
    return { found: true, focused };
  })()`);
  assert.equal(opened.found, true, `找不到“${name}”入口`);
  assert.equal(opened.focused, true, `“${name}”入口无法获得焦点`);
  await waitFor(`${name}中间对话框`, async () => client.value(`(() => {
    const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')];
    const dialog = dialogs.at(-1);
    const label = dialog?.getAttribute('aria-label')
      || (dialog?.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ');
    return dialogs.length === 1 && label === ${JSON.stringify(dialogLabel)}
      && dialog.contains(document.activeElement);
  })()`));
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

const session = await launchPackagedReader({
  appPath,
  prefix: 'reader-accessibility-',
  forceRendererAccessibility: true
});
const { client } = session;

try {
  await client.call('Accessibility.enable');
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

  const additionalDialogs = [
    {
      name: 'Markdown 编辑器',
      find: "document.querySelector('.reader-toolbar button[aria-label=\"编辑文章\"]')",
      dialogLabel: 'Markdown 编辑器',
      openerMatch: '.reader-toolbar button[aria-label="编辑文章"]'
    },
    {
      name: '版本历史',
      find: "document.querySelector('.reader-toolbar button[aria-label=\"查看版本历史\"]')",
      dialogLabel: '版本历史',
      openerMatch: '.reader-toolbar button[aria-label="查看版本历史"]'
    }
  ];
  for (const dialog of additionalDialogs) await verifyDialog(client, dialog);

  const selected = await client.value(`(() => {
    const button = document.querySelector('button[aria-label="选择已加载内容"]');
    if (!(button instanceof HTMLButtonElement)) return false;
    button.focus();
    button.click();
    return true;
  })()`);
  assert.equal(selected, true, '无法进入批量选择以验证创作与导出窗口');
  await waitFor('批量工具栏', async () => client.value(
    "document.querySelector('.batch-toolbar') !== null && document.querySelector('button[aria-label=\"取消选择\"]') !== null"
  ));
  await verifyDialog(client, {
    name: '二次创作',
    find: "document.querySelector('.batch-toolbar > button[aria-label=\"使用已选内容创作\"]')",
    dialogLabel: '从 3 篇资料开始创作',
    openerMatch: '.batch-toolbar > button[aria-label="使用已选内容创作"]',
    initialFocus: { tag: 'H2', text: '从 3 篇资料开始创作' }
  });
  await verifyDialog(client, {
    name: '导出资料包',
    find: "document.querySelector('.batch-toolbar > button[aria-label=\"导出已选内容\"]')",
    dialogLabel: '导出资料包',
    openerMatch: '.batch-toolbar > button[aria-label="导出已选内容"]'
  });
  await client.value(`(() => {
    const button = document.querySelector('button[aria-label="取消选择"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('找不到取消选择按钮');
    button.click();
    return true;
  })()`);
  await waitFor('退出批量选择', async () => client.value("document.querySelector('.batch-toolbar') === null"));

  await openIntermediateDialog(
    client,
    '订阅管理',
    "document.querySelector('button[aria-label=\"管理订阅\"]')",
    '订阅管理'
  );
  await verifyDialog(client, {
    name: '社交连接器',
    find: "[...document.querySelectorAll('[role=\"dialog\"] button')].find((button) => button.textContent?.trim() === '连接器')",
    dialogLabel: '社交连接器',
    openerMatch: 'button[aria-label="管理订阅"]',
    initialFocus: { tag: 'H2', text: '社交连接器' }
  });

  await openIntermediateDialog(
    client,
    '数据安全中心',
    "document.querySelector('.local-status')",
    '数据安全中心'
  );
  await verifyDialog(client, {
    name: '本地运行日志',
    find: "[...document.querySelectorAll('[role=\"dialog\"] button')].find((button) => button.textContent?.trim() === '查看本地日志')",
    dialogLabel: '本地运行日志',
    openerMatch: '.local-status'
  });

  assert.equal(dialogs.length + additionalDialogs.length + 4, 14, '最终包必须覆盖全部 14 个顶层模态框');
  console.log(`Reader ${health.version} 打包可访问性门禁通过`);
  console.log(`AX exposed nodes=${workspaceTree.length}`);
  console.log('dialogs=14');
  console.log('unnamed interactive controls=0');
  console.log('temporary data isolated=true');
} finally {
  await session.close();
}

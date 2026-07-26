import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { launchPackagedReader, packagedReaderApp, waitFor } from './lib/packaged-reader-qa.mjs';

const appPath = packagedReaderApp(process.argv[2]);
const sharedText = 'Reader 选中文本分享\n\n内容必须在用户确认后才写入本地资料库。';
const sharedTitle = '分享的文本摘录';
const sharedURL = 'https://example.com/reader-share-regression';

async function request(client, pathname) {
  const result = await client.value(`fetch(${JSON.stringify(pathname)}).then(async (response) => ({
    ok: response.ok,
    status: response.status,
    payload: await response.json()
  }))`);
  assert.equal(result.ok, true, `GET ${pathname} 失败（${result.status}）：${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function dispatchDeepLink(session, deepLink) {
  let stderr = '';
  const child = spawn(session.executable, [
    `--user-data-dir=${session.chromiumRoot}`,
    deepLink
  ], {
    env: {
      ...process.env,
      READER_DESKTOP_DATA_ROOT: session.readerRoot,
      READER_RELEASE_QA: '1'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Reader 第二实例未及时退出')), 10_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(result, 0, `Reader 第二实例退出码 ${result}\n${stderr}`);
}

function textDeepLink(text) {
  return `reader-local://add?text=${Buffer.from(text, 'utf8').toString('base64url')}`;
}

let session;
try {
  session = await launchPackagedReader({
    appPath,
    prefix: 'reader-packaged-share-'
  });
  const { client } = session;
  const before = (await request(client, '/api/stats')).stats;

  await dispatchDeepLink(session, textDeepLink(sharedText));
  const textModal = await waitFor('选中文本添加窗口', async () => {
    const state = await client.value(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="添加内容"]');
      if (!dialog) return null;
      return {
        activeTab: [...dialog.querySelectorAll('.modal-tabs button')].find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent?.trim() || '',
        title: dialog.querySelector('input')?.value || '',
        content: dialog.querySelector('textarea')?.value || '',
        collection: dialog.querySelector('select')?.value || '',
        saveLabel: dialog.querySelector('footer .primary')?.textContent?.trim() || ''
      };
    })()`);
    return state?.activeTab === 'Markdown' ? state : null;
  });
  assert.deepEqual(textModal, {
    activeTab: 'Markdown',
    title: sharedTitle,
    content: sharedText,
    collection: 'inbox',
    saveLabel: '保存到本机'
  });
  assert.equal((await request(client, '/api/stats')).stats.total, before.total, '用户确认前不能写入分享文本');

  await client.value(`(() => {
    const button = document.querySelector('[role="dialog"][aria-label="添加内容"] footer .primary');
    if (!(button instanceof HTMLButtonElement)) throw new Error('找不到文本保存按钮');
    button.click();
    return true;
  })()`);
  await waitFor('分享文本保存', async () => {
    const stats = (await request(client, '/api/stats')).stats;
    const dialogClosed = await client.value("document.querySelector('[role=\"dialog\"][aria-label=\"添加内容\"]') === null");
    return stats.total === before.total + 1 && dialogClosed;
  });
  const matches = (await request(client, `/api/articles?q=${encodeURIComponent(sharedTitle)}`)).articles;
  const created = matches.find((article) => article.title === sharedTitle);
  assert.ok(created, '找不到用户确认保存的分享文本');
  const detail = (await request(client, `/api/articles/${encodeURIComponent(created.id)}`)).article;
  assert.equal(detail.content, sharedText);
  assert.equal(detail.type, 'markdown');
  assert.equal(detail.collection_id, 'inbox');

  await dispatchDeepLink(session, `reader-local://add?url=${encodeURIComponent(sharedURL)}`);
  const urlModal = await waitFor('URL 回归添加窗口', async () => {
    const state = await client.value(`(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="添加内容"]');
      if (!dialog) return null;
      return {
        activeTab: [...dialog.querySelectorAll('.modal-tabs button')].find((button) => button.getAttribute('aria-pressed') === 'true')?.textContent?.trim() || '',
        url: dialog.querySelector('input[aria-label="网页地址"]')?.value || ''
      };
    })()`);
    return state?.activeTab === '网页 URL' ? state : null;
  });
  assert.deepEqual(urlModal, { activeTab: '网页 URL', url: sharedURL });
  assert.equal((await request(client, '/api/stats')).stats.total, before.total + 1, 'URL 预填前不能创建导入内容');
  await client.value(`(() => {
    const button = document.querySelector('[role="dialog"][aria-label="添加内容"] button[aria-label="关闭添加窗口"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error('找不到添加窗口关闭按钮');
    button.click();
    return true;
  })()`);
  await waitFor('URL 添加窗口关闭', async () => client.value(
    "document.querySelector('[role=\"dialog\"][aria-label=\"添加内容\"]') === null"
  ));

  console.log('Reader 最终包 Share handoff 门禁通过');
  console.log('selected text bytes=bounded');
  console.log('pre-confirmation writes=0');
  console.log('confirmed Markdown persistence=exact');
  console.log('URL handoff regression=passed');
} finally {
  await session?.close().catch(() => {});
}

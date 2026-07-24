import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  createUpdateController,
  isDeveloperIDSignature,
  macAppPath,
  readerUpdateFeed
} from '../desktop/updates.mjs';

function flushEvents() {
  return new Promise((resolve) => setImmediate(resolve));
}

function updateHarness({ signed = true } = {}) {
  const updater = new EventEmitter();
  const feedURLs = [];
  let checks = 0;
  let installs = 0;
  updater.setFeedURL = (options) => feedURLs.push(options);
  updater.checkForUpdates = () => { checks += 1; };
  const installOrder = [];
  updater.quitAndInstall = () => {
    installs += 1;
    installOrder.push('install');
  };

  const messages = [];
  const installResponses = [1, 0];
  const dialog = {
    showMessageBox: async (...args) => {
      const options = args.at(-1);
      messages.push(options);
      return {
        response: options.buttons?.includes('重启并安装') ? installResponses.shift() ?? 1 : 0
      };
    }
  };
  const timers = [];
  const cleared = [];
  const makeTimer = (kind, callback, delay) => {
    const timer = { kind, callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
    timers.push(timer);
    return timer;
  };
  const app = {
    isPackaged: true,
    getPath: () => '/Applications/Reader.app/Contents/MacOS/Reader',
    getVersion: () => '0.28.0'
  };
  const controller = createUpdateController({
    app,
    autoUpdater: updater,
    dialog,
    getWindow: () => null,
    platform: 'darwin',
    inspectSignature: async () => signed,
    beforeInstall: async () => { installOrder.push('cleanup'); },
    setTimeoutImpl: (callback, delay) => makeTimer('timeout', callback, delay),
    clearTimeoutImpl: (timer) => cleared.push(timer),
    setIntervalImpl: (callback, delay) => makeTimer('interval', callback, delay),
    clearIntervalImpl: (timer) => cleared.push(timer)
  });
  return {
    app,
    controller,
    feedURLs,
    messages,
    installOrder,
    timers,
    cleared,
    updater,
    get checks() { return checks; },
    get installs() { return installs; }
  };
}

test('automatic updates accept only a Developer ID application signature', () => {
  assert.equal(isDeveloperIDSignature(`
Authority=Developer ID Application: Reader Team (A1B2C3D4E5)
TeamIdentifier=A1B2C3D4E5
  `), true);
  assert.equal(isDeveloperIDSignature('Signature=adhoc\nTeamIdentifier=not set'), false);
  assert.equal(isDeveloperIDSignature('Authority=Apple Development: Example\nTeamIdentifier=A1B2C3D4E5'), false);
});

test('update feed and app path use the public universal mac release contract', () => {
  assert.equal(
    readerUpdateFeed('0.28.0'),
    'https://update.electronjs.org/Leo-Cjw/Leo-Reader-App/darwin-universal/0.28.0'
  );
  assert.equal(
    macAppPath('/Applications/Reader.app/Contents/MacOS/Reader'),
    '/Applications/Reader.app'
  );
});

test('ad-hoc builds never configure or contact the update service', async () => {
  const harness = updateHarness({ signed: false });
  assert.equal(await harness.controller.start(), false);
  assert.equal(harness.controller.isEligible(), false);
  assert.deepEqual(harness.feedURLs, []);
  assert.deepEqual(harness.timers, []);
  assert.equal(harness.checks, 0);

  assert.equal(await harness.controller.check(true), false);
  assert.match(harness.messages.at(-1).message, /未使用 Apple Developer ID/);
  assert.equal(harness.checks, 0);
});

test('a broken update feed fails closed without blocking app startup', async () => {
  const harness = updateHarness();
  harness.updater.setFeedURL = () => { throw new Error('invalid feed'); };
  assert.equal(await harness.controller.start(), false);
  assert.equal(harness.controller.isEligible(), false);
  assert.deepEqual(harness.timers, []);
  for (const event of [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'error',
    'update-downloaded'
  ]) assert.equal(harness.updater.listenerCount(event), 0);
});

test('signed builds schedule one update stream and install only after confirmation', async () => {
  const harness = updateHarness();
  assert.equal(await harness.controller.start(), true);
  assert.equal(harness.controller.isEligible(), true);
  assert.deepEqual(harness.feedURLs, [{
    url: 'https://update.electronjs.org/Leo-Cjw/Leo-Reader-App/darwin-universal/0.28.0'
  }]);
  assert.deepEqual(harness.timers.map(({ kind, delay }) => [kind, delay]), [
    ['timeout', 60_000],
    ['interval', 6 * 60 * 60 * 1000]
  ]);
  assert.equal(harness.timers.every((timer) => timer.unrefCalled), true);

  assert.equal(await harness.controller.check(true), true);
  assert.equal(harness.checks, 1);
  harness.updater.emit('update-not-available');
  await flushEvents();
  assert.match(harness.messages.at(-1).message, /0\.28\.0 已是最新版本/);

  harness.updater.emit('update-downloaded', {}, '', 'Reader 0.29.0');
  await flushEvents();
  assert.equal(harness.installs, 0);
  assert.match(harness.messages.at(-1).message, /Reader 0\.29\.0 已安全下载/);

  assert.equal(await harness.controller.check(true), true);
  assert.equal(harness.installs, 1);
  assert.deepEqual(harness.installOrder, ['cleanup', 'install']);
  harness.controller.stop();
  assert.equal(harness.cleared.length, 2);
  for (const event of [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'error',
    'update-downloaded'
  ]) assert.equal(harness.updater.listenerCount(event), 0);
});

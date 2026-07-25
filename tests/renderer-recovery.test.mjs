import assert from 'node:assert/strict';
import test from 'node:test';
import { createRendererRecoveryController } from '../desktop/renderer-recovery.mjs';

function recoveryHarness({ response = 0 } = {}) {
  const messages = [];
  const diagnostics = [];
  let quits = 0;
  let reloads = 0;
  const window = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: {
      reload() { reloads += 1; }
    }
  };
  const controller = createRendererRecoveryController({
    app: { quit() { quits += 1; } },
    dialog: {
      async showMessageBox(parent, options) {
        messages.push({ parent, options });
        return { response };
      }
    },
    getWindow: () => window,
    isShuttingDown: () => false,
    recordDiagnostic: (event, details) => diagnostics.push({ event, details })
  });
  return {
    controller,
    diagnostics,
    messages,
    window,
    get quits() { return quits; },
    get reloads() { return reloads; }
  };
}

test('renderer recovery records a bounded reason and reloads only after confirmation', async () => {
  const harness = recoveryHarness();

  assert.equal(await harness.controller.handle(harness.window, {
    reason: 'oom',
    exitCode: 137,
    privatePath: '/Users/private/article.md'
  }), true);

  assert.deepEqual(harness.diagnostics, [{
    event: 'renderer_gone',
    details: { reason: 'oom' }
  }]);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].parent, harness.window);
  assert.match(harness.messages[0].options.message, /界面意外停止/);
  assert.match(harness.messages[0].options.detail, /尚未自动保存/);
  assert.equal(harness.reloads, 1);
  assert.equal(harness.quits, 0);
});

test('renderer recovery can quit safely and ignores stale, duplicate or shutdown events', async () => {
  const quitHarness = recoveryHarness({ response: 1 });
  assert.equal(await quitHarness.controller.handle(quitHarness.window, { reason: 'crashed' }), false);
  assert.equal(quitHarness.reloads, 0);
  assert.equal(quitHarness.quits, 1);

  let resolveDialog;
  const window = { isDestroyed: () => false, webContents: { reload() {} } };
  const messages = [];
  const controller = createRendererRecoveryController({
    app: { quit() {} },
    dialog: {
      showMessageBox() {
        messages.push(true);
        return new Promise((resolve) => { resolveDialog = resolve; });
      }
    },
    getWindow: () => window,
    isShuttingDown: () => false
  });
  const first = controller.handle(window, { reason: 'killed' });
  assert.equal(await controller.handle(window, { reason: 'crashed' }), false);
  assert.equal(messages.length, 1);
  resolveDialog({ response: 0 });
  assert.equal(await first, true);

  const stale = createRendererRecoveryController({
    app: { quit() { assert.fail('stale event must not quit'); } },
    dialog: { showMessageBox() { assert.fail('stale event must not prompt'); } },
    getWindow: () => null,
    isShuttingDown: () => false
  });
  assert.equal(await stale.handle(window, { reason: 'crashed' }), false);

  const shuttingDown = createRendererRecoveryController({
    app: { quit() { assert.fail('shutdown event must not quit again'); } },
    dialog: { showMessageBox() { assert.fail('shutdown event must not prompt'); } },
    getWindow: () => window,
    isShuttingDown: () => true
  });
  assert.equal(await shuttingDown.handle(window, { reason: 'crashed' }), false);
});

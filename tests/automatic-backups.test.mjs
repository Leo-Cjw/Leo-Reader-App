import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMATIC_BACKUP_INTERVAL_MS, createAutomaticBackupService } from '../src/server/automatic-backups.mjs';

function settingsStore() {
  let value = { enabled: false, updatedAt: null };
  return {
    getAutomaticBackups() { return { ...value }; },
    async saveAutomaticBackups(enabled) {
      value = { enabled, updatedAt: '2026-07-26T00:00:00.000Z' };
      return { ...value };
    }
  };
}

test('automatic backups are opt-in, run at most daily and expose bounded status', async () => {
  let clock = Date.parse('2026-07-26T00:00:00.000Z');
  const backups = [];
  const created = [];
  const pruned = [];
  const timers = [];
  const service = createAutomaticBackupService({
    database: { async listImportJobs() { return []; } },
    rootDir: '/test-reader',
    settingsStore: settingsStore(),
    appVersion: '0.51.0',
    now: () => clock,
    setIntervalImpl(callback, interval) {
      const timer = { callback, interval, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl() {},
    listBackupsImpl: async () => backups,
    createBackupImpl: async (input) => {
      const backup = {
        id: `automatic-${created.length}`,
        automatic: true,
        created_at: new Date(clock).toISOString(),
        byte_size: 100 + created.length
      };
      assert.equal(input.reason, 'automatic');
      assert.equal('passphrase' in input, false);
      backups.unshift(backup);
      created.push(backup);
      return backup;
    },
    pruneImpl: async (_root, retain) => { pruned.push(retain); }
  });

  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.length, 0);
  assert.equal(timers[0].interval, 60 * 60 * 1000);

  const enabled = await service.updateEnabled(true);
  assert.equal(created.length, 1);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.retention, 3);
  assert.equal(enabled.interval_hours, 24);
  assert.equal(enabled.last_backup_at, '2026-07-26T00:00:00.000Z');
  assert.deepEqual(pruned, [3]);

  await service.runIfDue();
  assert.equal(created.length, 1);
  clock += AUTOMATIC_BACKUP_INTERVAL_MS;
  await service.runIfDue();
  assert.equal(created.length, 2);
  await service.stop();
});

test('automatic backups defer for imports and pause safely before creating', async () => {
  let importing = true;
  let releaseList;
  let listBlocked = false;
  const backups = [];
  const store = settingsStore();
  await store.saveAutomaticBackups(true);
  const service = createAutomaticBackupService({
    database: { async listImportJobs() { return importing ? [{ status: 'running' }] : []; } },
    rootDir: '/test-reader',
    settingsStore: store,
    appVersion: '0.51.0',
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {},
    listBackupsImpl: async () => {
      if (!listBlocked) return backups;
      await new Promise((resolve) => { releaseList = resolve; });
      return backups;
    },
    createBackupImpl: async () => {
      const backup = { id: 'created', automatic: true, created_at: new Date().toISOString(), byte_size: 1 };
      backups.push(backup);
      return backup;
    },
    pruneImpl: async () => []
  });

  service.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backups.length, 0);
  importing = false;
  listBlocked = true;
  const running = service.runIfDue();
  const pausing = service.pause();
  releaseList();
  await Promise.all([running, pausing]);
  assert.equal(backups.length, 0);
  assert.equal((await service.status(backups)).paused, true);
  listBlocked = false;
  service.resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backups.length, 1);
  await service.stop();
});

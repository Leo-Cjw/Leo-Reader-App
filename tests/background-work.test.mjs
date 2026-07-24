import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDesktopBackgroundCoordinator, parseMacOSBatteryStatus } from '../desktop/background-state.mjs';
import { createBackgroundWorkPolicy } from '../src/server/background-work.mjs';

function worker() {
  return {
    pauses: 0,
    resumes: 0,
    async pause() { this.pauses += 1; },
    resume() { this.resumes += 1; }
  };
}

test('background policy combines restore, sleep, connectivity and power constraints without premature resume', async () => {
  const imports = worker();
  const sources = worker();
  const policy = createBackgroundWorkPolicy(imports, sources);

  assert.deepEqual(policy.snapshot().sourceSyncPauseReasons, []);
  await policy.update({ online: false });
  assert.equal(imports.pauses, 0);
  assert.equal(sources.pauses, 1);
  assert.deepEqual(policy.snapshot().sourceSyncPauseReasons, ['offline']);

  await policy.update({ lowBattery: true, suspended: true });
  assert.equal(imports.pauses, 1);
  assert.equal(sources.pauses, 1);
  assert.deepEqual(policy.snapshot().sourceSyncPauseReasons, ['suspended', 'offline', 'low-battery']);

  await policy.update({ online: true, lowBattery: false, restoreLocked: true, suspended: false });
  assert.equal(imports.resumes, 0);
  assert.equal(sources.resumes, 0);
  assert.deepEqual(policy.snapshot().sourceSyncPauseReasons, ['restore']);

  await policy.update({ restoreLocked: false });
  assert.equal(imports.resumes, 1);
  assert.equal(sources.resumes, 1);
  assert.equal(policy.snapshot().importsPaused, false);
  assert.equal(policy.snapshot().sourceSyncPaused, false);
});

test('user pause affects imports only and cannot bypass a restore lock', async () => {
  const imports = worker();
  const sources = worker();
  const policy = createBackgroundWorkPolicy(imports, sources);

  await policy.update({ importUserPaused: true });
  assert.equal(imports.pauses, 1);
  assert.equal(sources.pauses, 0);
  assert.equal(policy.snapshot().importUserPaused, true);
  assert.deepEqual(policy.snapshot().importPauseReasons, ['user']);

  await policy.update({ restoreLocked: true });
  await policy.update({ importUserPaused: false });
  assert.equal(imports.resumes, 0);
  assert.equal(policy.snapshot().importsPaused, true);
  assert.deepEqual(policy.snapshot().importPauseReasons, ['restore']);

  await policy.update({ restoreLocked: false });
  assert.equal(imports.resumes, 1);
  assert.equal(policy.snapshot().importsPaused, false);
});

test('macOS battery parser only constrains a low discharging battery', () => {
  assert.deepEqual(
    parseMacOSBatteryStatus("Now drawing from 'Battery Power'\n -InternalBattery-0\t19%; discharging; 1:12 remaining present: true"),
    { percentage: 19, onBattery: true, lowBattery: true }
  );
  assert.deepEqual(
    parseMacOSBatteryStatus("Now drawing from 'AC Power'\n -InternalBattery-0\t12%; charging; 0:24 remaining present: true"),
    { percentage: 12, onBattery: false, lowBattery: false }
  );
  assert.equal(parseMacOSBatteryStatus('No battery data'), null);
});

test('desktop coordinator publishes an offline startup before a slow battery query finishes', async () => {
  const monitor = new EventEmitter();
  monitor.getCurrentThermalState = () => 'nominal';
  monitor.isOnBatteryPower = () => true;
  let resolveBattery;
  const batteryResult = new Promise((resolve) => { resolveBattery = resolve; });
  const published = [];
  const coordinator = createDesktopBackgroundCoordinator({
    powerMonitor: monitor,
    net: { isOnline: () => false },
    server: { async setBackgroundWorkState(state) { published.push({ ...state }); } },
    platform: 'darwin',
    readBattery: () => batteryResult,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl() {}
  });

  const starting = coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(published.at(-1).online, false);
  resolveBattery({ percentage: 80, onBattery: true, lowBattery: false });
  await starting;
  coordinator.stop();
});

test('desktop coordinator publishes sleep, network, battery and thermal state and removes listeners', async () => {
  const monitor = new EventEmitter();
  monitor.getCurrentThermalState = () => 'nominal';
  let online = true;
  let battery = { percentage: 80, onBattery: true, lowBattery: false };
  monitor.isOnBatteryPower = () => battery.onBattery;
  const published = [];
  const timers = [];
  const cleared = [];
  const coordinator = createDesktopBackgroundCoordinator({
    powerMonitor: monitor,
    net: { isOnline: () => online },
    server: { async setBackgroundWorkState(state) { published.push({ ...state }); } },
    platform: 'darwin',
    readBattery: async () => battery,
    setIntervalImpl(callback, interval) {
      const timer = { callback, interval, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl(timer) { cleared.push(timer); }
  });

  await coordinator.start();
  assert.deepEqual(published.at(-1), { suspended: false, online: true, lowBattery: false, powerConstrained: false });
  assert.deepEqual(timers.map((timer) => timer.interval), [30_000, 300_000]);

  online = false;
  timers[0].callback();
  await coordinator.flush();
  assert.equal(published.at(-1).online, false);

  battery = { percentage: 18, onBattery: true, lowBattery: true };
  monitor.emit('on-battery');
  await coordinator.flush();
  assert.equal(published.at(-1).lowBattery, true);

  monitor.emit('suspend');
  await coordinator.flush();
  assert.equal(published.at(-1).suspended, true);

  monitor.emit('thermal-state-change', { state: 'critical' });
  await coordinator.flush();
  assert.equal(published.at(-1).powerConstrained, true);

  online = true;
  battery = { percentage: 60, onBattery: false, lowBattery: false };
  monitor.emit('resume');
  await coordinator.flush();
  assert.deepEqual(published.at(-1), { suspended: false, online: true, lowBattery: false, powerConstrained: true });

  monitor.emit('thermal-state-change', { state: 'nominal' });
  await coordinator.flush();
  assert.equal(published.at(-1).powerConstrained, false);

  coordinator.stop();
  assert.equal(monitor.listenerCount('suspend'), 0);
  assert.equal(monitor.listenerCount('resume'), 0);
  assert.deepEqual(cleared, timers);
});

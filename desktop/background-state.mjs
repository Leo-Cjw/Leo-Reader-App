import { execFile } from 'node:child_process';

const LOW_BATTERY_PERCENT = 20;
const NETWORK_POLL_INTERVAL_MS = 30_000;
const BATTERY_POLL_INTERVAL_MS = 5 * 60_000;

export function parseMacOSBatteryStatus(output) {
  const text = String(output || '');
  const percentage = Number(text.match(/\b(\d{1,3})%;/)?.[1]);
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) return null;
  const onBattery = /Now drawing from 'Battery Power'/.test(text);
  return { percentage, onBattery, lowBattery: onBattery && percentage <= LOW_BATTERY_PERCENT };
}

export function readMacOSBatteryStatus(execFileImpl = execFile) {
  return new Promise((resolve) => {
    execFileImpl('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error ? null : parseMacOSBatteryStatus(stdout));
    });
  });
}

function constrainedThermalState(state) {
  return state === 'serious' || state === 'critical';
}

export function createDesktopBackgroundCoordinator({
  powerMonitor,
  net,
  server,
  platform = process.platform,
  readBattery = readMacOSBatteryStatus,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
}) {
  const state = {
    suspended: false,
    online: true,
    lowBattery: false,
    thermalConstrained: false,
    speedConstrained: false
  };
  let networkTimer = null;
  let batteryTimer = null;
  let started = false;
  let stopped = false;
  let lastPublished = '';
  let taskQueue = Promise.resolve();

  const publicState = () => ({
    suspended: state.suspended,
    online: state.online,
    lowBattery: state.lowBattery,
    powerConstrained: state.thermalConstrained || state.speedConstrained
  });

  async function publish() {
    const next = publicState();
    const serialized = JSON.stringify(next);
    if (serialized === lastPublished) return;
    await server.setBackgroundWorkState(next);
    lastPublished = serialized;
  }

  function enqueue(task) {
    taskQueue = taskQueue.then(task, task);
    void taskQueue.catch((error) => console.warn(`Reader 后台状态更新失败：${error.message || error}`));
    return taskQueue;
  }

  async function refreshBattery() {
    if (platform !== 'darwin') return;
    if (!powerMonitor.isOnBatteryPower()) {
      state.lowBattery = false;
      return;
    }
    const battery = await readBattery();
    if (battery) state.lowBattery = battery.lowBattery;
  }

  const onSuspend = () => {
    void enqueue(async () => {
      state.suspended = true;
      await publish();
    });
  };
  const onResume = () => {
    void enqueue(async () => {
      state.suspended = false;
      state.online = net.isOnline();
      await refreshBattery();
      await publish();
    });
  };
  const onPowerSourceChange = () => {
    void enqueue(async () => {
      await refreshBattery();
      await publish();
    });
  };
  const onThermalStateChange = (details) => {
    void enqueue(async () => {
      state.thermalConstrained = constrainedThermalState(details.state);
      await publish();
    });
  };
  const onSpeedLimitChange = (details) => {
    void enqueue(async () => {
      state.speedConstrained = Number(details.limit) < 50;
      await publish();
    });
  };
  const pollNetwork = () => {
    void enqueue(async () => {
      state.online = net.isOnline();
      await publish();
    });
  };
  const pollBattery = () => {
    void enqueue(async () => {
      await refreshBattery();
      await publish();
    });
  };

  async function start() {
    if (started || stopped) return;
    started = true;
    powerMonitor.on('suspend', onSuspend);
    powerMonitor.on('resume', onResume);
    powerMonitor.on('on-ac', onPowerSourceChange);
    powerMonitor.on('on-battery', onPowerSourceChange);
    powerMonitor.on('thermal-state-change', onThermalStateChange);
    powerMonitor.on('speed-limit-change', onSpeedLimitChange);
    await enqueue(async () => {
      state.online = net.isOnline();
      state.thermalConstrained = platform === 'darwin' && constrainedThermalState(powerMonitor.getCurrentThermalState());
      await publish();
      await refreshBattery();
      await publish();
    });
    networkTimer = setIntervalImpl(pollNetwork, NETWORK_POLL_INTERVAL_MS);
    batteryTimer = setIntervalImpl(pollBattery, BATTERY_POLL_INTERVAL_MS);
    networkTimer?.unref?.();
    batteryTimer?.unref?.();
  }

  function stop() {
    if (!started || stopped) return;
    stopped = true;
    powerMonitor.off('suspend', onSuspend);
    powerMonitor.off('resume', onResume);
    powerMonitor.off('on-ac', onPowerSourceChange);
    powerMonitor.off('on-battery', onPowerSourceChange);
    powerMonitor.off('thermal-state-change', onThermalStateChange);
    powerMonitor.off('speed-limit-change', onSpeedLimitChange);
    if (networkTimer) clearIntervalImpl(networkTimer);
    if (batteryTimer) clearIntervalImpl(batteryTimer);
    networkTimer = null;
    batteryTimer = null;
  }

  return { start, stop, flush: () => taskQueue, snapshot: publicState };
}

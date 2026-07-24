const initialState = Object.freeze({
  restoreLocked: false,
  suspended: false,
  online: true,
  lowBattery: false,
  powerConstrained: false
});

function pauseReasons(state, sourceSync = false) {
  const reasons = [];
  if (state.restoreLocked) reasons.push('restore');
  if (state.suspended) reasons.push('suspended');
  if (state.powerConstrained) reasons.push('system-constrained');
  if (sourceSync && !state.online) reasons.push('offline');
  if (sourceSync && state.lowBattery) reasons.push('low-battery');
  return reasons;
}

export function createBackgroundWorkPolicy(importWorker, sourceScheduler) {
  let state = { ...initialState };
  let importsPaused = false;
  let sourceSyncPaused = false;
  let updateQueue = Promise.resolve();

  function snapshot() {
    const importPauseReasons = pauseReasons(state);
    const sourceSyncPauseReasons = pauseReasons(state, true);
    return {
      suspended: state.suspended,
      online: state.online,
      lowBattery: state.lowBattery,
      powerConstrained: state.powerConstrained,
      restoreLocked: state.restoreLocked,
      importsPaused,
      sourceSyncPaused,
      importPauseReasons,
      sourceSyncPauseReasons
    };
  }

  async function reconcile() {
    const shouldPauseImports = pauseReasons(state).length > 0;
    const shouldPauseSourceSync = pauseReasons(state, true).length > 0;

    if (shouldPauseSourceSync && !sourceSyncPaused) {
      await sourceScheduler.pause();
      sourceSyncPaused = true;
    }
    if (shouldPauseImports && !importsPaused) {
      await importWorker.pause();
      importsPaused = true;
    }
    if (!shouldPauseImports && importsPaused) {
      importWorker.resume();
      importsPaused = false;
    }
    if (!shouldPauseSourceSync && sourceSyncPaused) {
      sourceScheduler.resume();
      sourceSyncPaused = false;
    }
    return snapshot();
  }

  function update(patch) {
    for (const key of Object.keys(initialState)) {
      if (key in patch) state[key] = Boolean(patch[key]);
    }
    updateQueue = updateQueue.then(reconcile, reconcile);
    return updateQueue;
  }

  return { update, snapshot };
}

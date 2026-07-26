const initialState = Object.freeze({
  importUserPaused: false,
  restoreLocked: false,
  suspended: false,
  online: true,
  lowBattery: false,
  powerConstrained: false
});

function pauseReasons(state, sourceSync = false) {
  const reasons = [];
  if (!sourceSync && state.importUserPaused) reasons.push('user');
  if (state.restoreLocked) reasons.push('restore');
  if (state.suspended) reasons.push('suspended');
  if (state.powerConstrained) reasons.push('system-constrained');
  if (sourceSync && !state.online) reasons.push('offline');
  if (sourceSync && state.lowBattery) reasons.push('low-battery');
  return reasons;
}

function semanticPauseReasons(state) {
  const reasons = [];
  if (state.restoreLocked) reasons.push('restore');
  if (state.suspended) reasons.push('suspended');
  if (state.lowBattery) reasons.push('low-battery');
  if (state.powerConstrained) reasons.push('system-constrained');
  return reasons;
}

export function createBackgroundWorkPolicy(importWorker, sourceScheduler, semanticSearch = null) {
  let state = { ...initialState };
  let importsPaused = false;
  let sourceSyncPaused = false;
  let semanticSearchPaused = false;
  let updateQueue = Promise.resolve();

  function snapshot() {
    const importPauseReasons = pauseReasons(state);
    const sourceSyncPauseReasons = pauseReasons(state, true);
    const semanticSearchPauseReasons = semanticPauseReasons(state);
    return {
      suspended: state.suspended,
      online: state.online,
      lowBattery: state.lowBattery,
      powerConstrained: state.powerConstrained,
      restoreLocked: state.restoreLocked,
      importUserPaused: state.importUserPaused,
      importsPaused,
      sourceSyncPaused,
      semanticSearchPaused,
      importPauseReasons,
      sourceSyncPauseReasons,
      semanticSearchPauseReasons
    };
  }

  async function reconcile() {
    const shouldPauseImports = pauseReasons(state).length > 0;
    const shouldPauseSourceSync = pauseReasons(state, true).length > 0;
    const shouldPauseSemanticSearch = semanticPauseReasons(state).length > 0;

    if (shouldPauseSemanticSearch && !semanticSearchPaused) {
      await semanticSearch?.pause?.();
      semanticSearchPaused = true;
    }
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
    if (!shouldPauseSemanticSearch && semanticSearchPaused) {
      semanticSearch?.resume?.();
      semanticSearchPaused = false;
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

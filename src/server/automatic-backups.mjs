import { createBackup, listBackups, pruneAutomaticBackups } from './backup.mjs';

export const AUTOMATIC_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTOMATIC_BACKUP_RETENTION = 3;
const DEFAULT_POLL_INTERVAL_MS = 60 * 60 * 1000;

export function createAutomaticBackupService({
  database,
  rootDir,
  settingsStore,
  diagnostics = null,
  appVersion,
  now = () => Date.now(),
  intervalMs = AUTOMATIC_BACKUP_INTERVAL_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  createBackupImpl = createBackup,
  listBackupsImpl = listBackups,
  pruneImpl = pruneAutomaticBackups
}) {
  let started = false;
  let paused = false;
  let running = false;
  let active = null;
  let timer = null;
  let lastErrorAt = null;

  function automaticOnly(backups) {
    return backups.filter((backup) => backup.automatic).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  function publicStatus(backups = []) {
    const automatic = automaticOnly(backups);
    const latest = automatic[0] || null;
    const latestTime = latest ? new Date(latest.created_at).getTime() : null;
    return {
      enabled: settingsStore.getAutomaticBackups().enabled,
      paused,
      running,
      interval_hours: Math.round(intervalMs / (60 * 60 * 1000)),
      retention: AUTOMATIC_BACKUP_RETENTION,
      retained_count: automatic.length,
      last_backup_at: latest?.created_at || null,
      next_backup_at: latestTime === null || !Number.isFinite(latestTime) ? null : new Date(latestTime + intervalMs).toISOString(),
      last_error_at: lastErrorAt
    };
  }

  async function status(backups = null) {
    return publicStatus(backups || await listBackupsImpl(rootDir));
  }

  async function runIfDue() {
    if (!started || paused || running || !settingsStore.getAutomaticBackups().enabled) return false;
    running = true;
    active = (async () => {
      try {
        const backups = await listBackupsImpl(rootDir);
        if (!started || paused || !settingsStore.getAutomaticBackups().enabled) return false;
        const latest = automaticOnly(backups)[0];
        if (latest && now() - new Date(latest.created_at).getTime() < intervalMs) return false;
        const activeJobs = (await database.listImportJobs(200)).filter((job) => job.status === 'pending' || job.status === 'running');
        if (!started || paused || !settingsStore.getAutomaticBackups().enabled || activeJobs.length) return false;
        const backup = await createBackupImpl({ database, rootDir, appVersion, reason: 'automatic' });
        await pruneImpl(rootDir, AUTOMATIC_BACKUP_RETENTION);
        lastErrorAt = null;
        await diagnostics?.record?.('backup_created', { encrypted: false, byteSize: backup.byte_size, automatic: true });
        return true;
      } catch {
        lastErrorAt = new Date(now()).toISOString();
        return false;
      } finally {
        running = false;
        active = null;
      }
    })();
    return await active;
  }

  function requestRun() {
    void runIfDue();
  }

  function start() {
    if (started) return;
    started = true;
    timer = setIntervalImpl(requestRun, pollIntervalMs);
    timer?.unref?.();
    requestRun();
  }

  async function stop() {
    started = false;
    if (timer) clearIntervalImpl(timer);
    timer = null;
    await active;
  }

  async function pause() {
    paused = true;
    await active;
  }

  function resume() {
    paused = false;
    requestRun();
  }

  async function updateEnabled(enabled) {
    await settingsStore.saveAutomaticBackups(enabled);
    if (enabled) await runIfDue();
    else await active;
    return await status();
  }

  return { start, stop, pause, resume, status, updateEnabled, runIfDue };
}

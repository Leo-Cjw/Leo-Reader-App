function notificationCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.min(Math.max(Math.trunc(count), 0), 99) : 0;
}

function importNotificationOptions(summary = {}) {
  const completed = notificationCount(summary.completed);
  const failed = notificationCount(summary.failed);
  if (!completed && !failed) return null;
  if (completed && failed) return {
    title: 'Reader 导入任务已处理',
    body: `已保存 ${completed} 项，${failed} 项失败；可打开导入队列查看详情。`,
    silent: true
  };
  if (completed) return {
    title: 'Reader 导入完成',
    body: `已将 ${completed} 项保存到本地资料库。`,
    silent: true
  };
  return {
    title: 'Reader 导入需要处理',
    body: `${failed} 项导入失败；可打开导入队列查看原因并重试。`,
    silent: true
  };
}

function sourceSyncNotificationOptions(summary = {}) {
  const imported = notificationCount(summary.imported);
  const failed = notificationCount(summary.failed);
  if (!imported && !failed) return null;
  if (imported && failed) return {
    title: 'Reader 订阅已更新',
    body: `已保存 ${imported} 条新内容，${failed} 个订阅同步失败；可打开内容来源查看详情。`,
    silent: true
  };
  if (imported) return {
    title: 'Reader 订阅已更新',
    body: `已将 ${imported} 条新内容保存到本地资料库。`,
    silent: true
  };
  return {
    title: 'Reader 订阅需要处理',
    body: `${failed} 个订阅同步失败；可打开内容来源查看状态。`,
    silent: true
  };
}

function createNotificationController({
  Notification,
  optionsForSummary,
  shouldNotify = () => true,
  onClick = () => {}
}) {
  let activeNotification = null;

  function show(summary) {
    const options = optionsForSummary(summary);
    if (!options || !shouldNotify() || !Notification?.isSupported?.()) return false;
    if (activeNotification) {
      try { activeNotification.close(); }
      catch { activeNotification = null; }
    }
    let notification;
    try {
      notification = new Notification(options);
      activeNotification = notification;
      const release = () => {
        if (activeNotification === notification) activeNotification = null;
      };
      notification.once('close', release);
      notification.once('failed', release);
      notification.once('click', () => {
        try { notification.close(); }
        catch {}
        onClick();
      });
      notification.show();
      return true;
    } catch {
      if (activeNotification === notification) activeNotification = null;
      return false;
    }
  }

  return { show };
}

export function createImportNotificationController(options) {
  return createNotificationController({ ...options, optionsForSummary: importNotificationOptions });
}

export function createSourceSyncNotificationController(options) {
  return createNotificationController({ ...options, optionsForSummary: sourceSyncNotificationOptions });
}

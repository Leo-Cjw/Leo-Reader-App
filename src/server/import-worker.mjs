import { importURL } from './importers.mjs';
import { importStagedAttachment, localizeRemoteImage, storeRemoteImage } from './attachments.mjs';

const MAX_LOCALIZED_IMAGE_BYTES = 48 * 1024 * 1024;

export function replaceLocalizedImageToken(content, token, replacement) {
  return String(content || '').split(token).join(replacement);
}

export function replaceUnlocalizedImage(content, descriptor) {
  const escapedToken = String(descriptor.token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const remoteURL = String(descriptor.url || '').replaceAll('>', '%3E');
  return String(content || '').replace(new RegExp(`!\\[([^\\]]*)\\]\\(${escapedToken}\\)`, 'g'), (_match, alt) => `[${alt || '在线图片'} · 未离线保存](<${remoteURL}>)`);
}

export function isBrokenImportedArticle(article) {
  const body = `${article?.title || ''}\n${article?.content || ''}`;
  return article?.metadata?.importState === 'needs-reimport' || (/mp\.weixin\.qq\.com/i.test(`${article?.source || ''} ${article?.url || ''}`) && /环境异常|去验证/.test(body));
}

export async function localizeImportedResources(database, article, imported, paths) {
  const imageDescriptors = Array.isArray(imported.metadata?.inlineImages) ? imported.metadata.inlineImages : [];
  const inlineTotal = Number(imported.metadata?.inlineImageCount || imageDescriptors.length);
  const embeddedAttachmentIds = [];
  const localizedAttachmentIds = new Set();
  const failures = [];
  let localizedBytes = 0;
  let localizedImageCount = 0;
  let content = imported.content;
  let leadAttachmentId = null;

  if (imported.metadata?.leadImage) {
    try {
      const attachment = await storeRemoteImage(database, article, imported.metadata.leadImage, { ...paths, fileName: '网页主图' });
      leadAttachmentId = attachment?.id || null;
      localizedImageCount += 1;
      if (attachment?.id && !localizedAttachmentIds.has(attachment.id)) {
        localizedAttachmentIds.add(attachment.id);
        localizedBytes += Number(attachment.byte_size || 0);
      }
    } catch (error) {
      failures.push({ kind: 'lead', url: imported.metadata.leadImage, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const [index, descriptor] of imageDescriptors.entries()) {
    if (!descriptor?.token || !descriptor?.url) continue;
    if (localizedBytes >= MAX_LOCALIZED_IMAGE_BYTES) {
      failures.push({ kind: 'inline', url: descriptor.url, error: '正文图片已达到 48 MB 本地化上限' });
      content = replaceUnlocalizedImage(content, descriptor);
      continue;
    }
    try {
      const attachment = await storeRemoteImage(database, article, descriptor.url, { ...paths, fileName: descriptor.alt || `正文图片 ${index + 1}` });
      if (!attachment?.url) throw new Error('正文图片附件创建失败');
      content = replaceLocalizedImageToken(content, descriptor.token, attachment.url);
      if (!embeddedAttachmentIds.includes(attachment.id)) embeddedAttachmentIds.push(attachment.id);
      localizedImageCount += 1;
      if (!localizedAttachmentIds.has(attachment.id)) {
        localizedAttachmentIds.add(attachment.id);
        localizedBytes += Number(attachment.byte_size || 0);
      }
    } catch (error) {
      content = replaceUnlocalizedImage(content, descriptor);
      failures.push({ kind: 'inline', url: descriptor.url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const notQueued = Math.max(0, inlineTotal - imageDescriptors.length);
  if (notQueued) failures.push({ kind: 'inline-limit', count: notQueued, error: `另有 ${notQueued} 张图片超过单篇 16 张上限` });
  const expectedResources = inlineTotal + (imported.metadata?.leadImage ? 1 : 0);
  const offlineResourceStatus = failures.length === 0 ? 'complete' : localizedImageCount > 0 ? 'partial' : expectedResources > 0 ? 'text-only' : 'complete';
  const { inlineImages: _inlineImages, ...baseMetadata } = imported.metadata || {};
  return {
    content,
    metadata: {
      ...baseMetadata,
      leadImageLocalized: Boolean(leadAttachmentId) || !imported.metadata?.leadImage,
      leadAttachmentId,
      embeddedAttachmentIds,
      localizedImageCount,
      localizedAttachmentCount: localizedAttachmentIds.size,
      localizedImageBytes: localizedBytes,
      offlineResourceStatus,
      offlineResourceFailures: failures.slice(0, 12)
    }
  };
}

export async function processImportJob(database, job, paths) {
  if (job.kind === 'url') {
    const imported = await importURL(job.payload.url);
    let article;
    let created = false;
    try {
      article = await database.createArticle({ ...imported, collection_id: job.payload.collectionId || 'inbox' });
      created = true;
    }
    catch (error) {
      if (!/UNIQUE constraint failed/.test(error.message || '')) throw error;
      const existing = await database.getArticleByURL(imported.url);
      if (!existing) throw error;
      article = existing;
    }
    if (created) {
      const finalized = await localizeImportedResources(database, article, imported, paths);
      article = await database.finalizeImportedArticle(article.id, finalized);
    } else if (isBrokenImportedArticle(article)) {
      const finalized = await localizeImportedResources(database, article, imported, paths);
      article = await database.updateArticle(article.id, {
        title: imported.title,
        excerpt: imported.excerpt,
        content: finalized.content,
        author: imported.author,
        source: imported.source,
        language: imported.language
      }, { revisionReason: 'reimport' });
      article = await database.updateArticleMetadata(article.id, { ...finalized.metadata, importState: 'ready', importError: null, repairedAt: new Date().toISOString() });
    } else if (imported.metadata?.leadImage) {
      try {
        article = await localizeRemoteImage(database, article, imported.metadata.leadImage, paths);
        await database.updateArticleMetadata(article.id, { leadImageLocalized: true, leadImageError: null });
      } catch (error) {
        await database.updateArticleMetadata(article.id, { leadImageLocalized: false, leadImageError: error instanceof Error ? error.message : String(error) });
      }
    }
    return await database.getArticle(article.id);
  }
  if (job.kind === 'attachment') return await importStagedAttachment(database, job.payload, paths);
  throw new Error(`未知导入任务类型：${job.kind}`);
}

export function createImportWorker(database, paths, { idleIntervalMs = 4000, initiallyPaused = false } = {}) {
  let active = false;
  let paused = Boolean(initiallyPaused);
  let stopped = false;
  let timer;
  let activeRun = null;

  const schedule = (delay) => {
    if (stopped || paused) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void run(); }, delay);
    timer.unref?.();
  };

  const run = () => {
    if (activeRun) return activeRun;
    if (stopped || paused) return Promise.resolve();
    active = true;
    activeRun = (async () => {
      let processed = 0;
      try {
        for (let index = 0; index < 20 && !stopped && !paused; index += 1) {
          const job = await database.claimImportJob();
          if (!job) break;
          processed += 1;
          try {
            const article = await processImportJob(database, job, paths);
            await database.completeImportJob(job.id, article.id);
          } catch (error) {
            await database.failImportJob(job.id, error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        if (!stopped) console.warn(`导入队列处理失败：${error.message}`);
      } finally {
        active = false;
        activeRun = null;
        schedule(processed === 20 ? 20 : idleIntervalMs);
      }
    })();
    return activeRun;
  };

  schedule(0);
  return {
    poke() { if (!active) schedule(0); },
    async pause() {
      paused = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (activeRun) await activeRun;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      schedule(0);
    },
    async stop() { stopped = true; if (timer) clearTimeout(timer); timer = undefined; if (activeRun) await activeRun; }
  };
}

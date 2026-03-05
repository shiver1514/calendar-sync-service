'use strict';

const {
  CaldavClient,
  normalizeHref,
  joinHref,
  sanitizeForFileName,
  parseIcsField
} = require('../lib/caldav');
const {
  loadState,
  saveState,
  getMapping,
  setMapping
} = require('./state-store');

const ICLOUD_READ_ONLY_NAME_HINTS = [/提醒/i, /reminder/i, /birthdays?/i, /holiday/i, /节假日/i];

function isLikelyReadOnlyCalendar(displayName) {
  const text = displayName || '';
  return ICLOUD_READ_ONLY_NAME_HINTS.some((re) => re.test(text));
}

function uniqueCalendars(calendars) {
  const seen = new Set();
  const result = [];
  for (const calendar of calendars) {
    const key = normalizeHref(calendar.href);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(calendar);
  }
  return result;
}

function pickDingtalkCalendars(calendars, preferredNames = [], preferredHrefs = []) {
  if (!calendars.length) {
    throw new Error('钉钉 calendar-home-set 下未发现日历');
  }

  const normalizedHrefs = preferredHrefs
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => normalizeHref(item));
  if (normalizedHrefs.length) {
    const selected = normalizedHrefs.map((targetHref) => {
      const found = calendars.find((item) => normalizeHref(item.href) === targetHref);
      if (!found) {
        throw new Error(`未找到钉钉来源日历 href: ${targetHref}`);
      }
      return found;
    });
    return uniqueCalendars(selected);
  }

  const normalizedNames = preferredNames
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (normalizedNames.length) {
    const selected = normalizedNames.map((targetName) => {
      const found = calendars.find((item) => item.displayName === targetName);
      if (!found) {
        throw new Error(`未找到钉钉来源日历名称: ${targetName}`);
      }
      return found;
    });
    return uniqueCalendars(selected);
  }

  // 默认读取全部来源日历
  return uniqueCalendars(calendars);
}

function pickDingtalkCalendar(calendars, preferredName, preferredHref) {
  const selected = pickDingtalkCalendars(
    calendars,
    preferredName ? [preferredName] : [],
    preferredHref ? [preferredHref] : []
  );
  return selected[0];
}

function pickIcloudCalendar(calendars, preferredName, preferredHref) {
  if (preferredHref) {
    const targetHref = normalizeHref(preferredHref);
    const found = calendars.find((item) => normalizeHref(item.href) === targetHref);
    if (!found) {
      throw new Error(`未找到 iCloud 目标日历 href: ${preferredHref}`);
    }
    return found;
  }

  if (preferredName) {
    const found = calendars.find((item) => item.displayName === preferredName);
    if (!found) {
      throw new Error(`未找到 iCloud 目标日历名称: ${preferredName}`);
    }
    return found;
  }

  const writableCandidate = calendars.find((item) => !isLikelyReadOnlyCalendar(item.displayName));
  if (writableCandidate) {
    return writableCandidate;
  }

  if (!calendars.length) {
    throw new Error('iCloud calendar-home-set 下未发现日历');
  }

  return calendars[0];
}

function buildTargetHref(calendarHref, sourceUid) {
  const safeUid = sanitizeForFileName(sourceUid || `event_${Date.now()}`);
  return joinHref(calendarHref, `dingtalk-${safeUid}.ics`);
}

function mapByUid(events) {
  const result = new Map();
  for (const event of events) {
    if (!event.uid) {
      continue;
    }
    if (!result.has(event.uid)) {
      result.set(event.uid, event);
    }
  }
  return result;
}

function mergeSourceEvents(sourceEvents) {
  const byUid = new Map();
  const noUid = [];
  for (const event of sourceEvents) {
    if (!event.uid) {
      noUid.push(event);
      continue;
    }
    if (!byUid.has(event.uid)) {
      byUid.set(event.uid, event);
    }
  }
  return [...byUid.values(), ...noUid];
}

function isSameCalendarHref(calendarHref, targetHref) {
  return normalizeHref(calendarHref) === normalizeHref(targetHref);
}

function isMappingInTargetCalendar(mapping, targetCalendarHref) {
  if (!mapping || !mapping.targetHref) {
    return false;
  }

  if (mapping.targetCalendarHref) {
    return isSameCalendarHref(mapping.targetCalendarHref, targetCalendarHref);
  }

  const eventHref = normalizeHref(mapping.targetHref);
  const calendarHref = normalizeHref(targetCalendarHref);
  return eventHref.startsWith(calendarHref);
}

async function safePutWithFallback(client, href, body, opts = {}) {
  const first = await client.put(href, body, opts);
  if ([200, 201, 204].includes(first.status)) {
    return first;
  }

  if ([404, 409, 412].includes(first.status)) {
    const second = await client.put(href, body, {});
    return second;
  }

  return first;
}

async function safeDeleteWithFallback(client, href, etag) {
  const first = await client.delete(href, etag ? { ifMatch: etag } : {});
  if ([200, 202, 204, 404].includes(first.status)) {
    return first;
  }

  if ([412].includes(first.status)) {
    const second = await client.delete(href, {});
    return second;
  }

  return first;
}

async function probeSourceExists(dingtalkClient, sourceHref) {
  if (!sourceHref) {
    return {
      exists: false,
      uncertain: true,
      reason: 'missing_source_href'
    };
  }

  const resp = await dingtalkClient.request('GET', sourceHref);
  if (resp.status === 200) {
    const status = parseIcsField(resp.body || '', 'STATUS').toUpperCase();
    if (status === 'CANCELLED') {
      return {
        exists: false,
        uncertain: false,
        reason: 'status_cancelled'
      };
    }
    return {
      exists: true,
      uncertain: false
    };
  }

  if ([404, 410].includes(resp.status)) {
    return {
      exists: false,
      uncertain: false
    };
  }

  return {
    exists: false,
    uncertain: true,
    reason: `http_${resp.status}`
  };
}

// 执行一次“钉钉 -> iCloud”单向同步
async function syncOnce(config, options = {}) {
  const logger = options.logger || null;
  const trigger = options.trigger || 'manual';
  const log = {
    info(message, context = {}) {
      if (logger && typeof logger.info === 'function') {
        logger.info(message, context);
      }
    },
    warn(message, context = {}) {
      if (logger && typeof logger.warn === 'function') {
        logger.warn(message, context);
      }
    },
    error(message, context = {}) {
      if (logger && typeof logger.error === 'function') {
        logger.error(message, context);
      } else {
        console.error(`[sync][error] ${message}`, context);
      }
    }
  };

  const startTime = Date.now();
  const now = new Date();

  const rangeStart = new Date(now.getTime() - config.service.syncPastDays * 24 * 3600 * 1000);
  const rangeEnd = new Date(now.getTime() + config.service.syncFutureDays * 24 * 3600 * 1000);

  const dingtalkClient = new CaldavClient({
    baseUrl: config.dingtalk.baseUrl,
    username: config.dingtalk.username,
    password: config.dingtalk.password,
    timeoutMs: config.dingtalk.timeoutMs,
    userAgent: config.dingtalk.userAgent
  });

  const icloudClient = new CaldavClient({
    baseUrl: config.icloud.baseUrl,
    username: config.icloud.username,
    password: config.icloud.password,
    timeoutMs: config.icloud.timeoutMs,
    userAgent: config.icloud.userAgent
  });

  const state = loadState(config.service.stateFile);
  const stats = {
    sourceCount: 0,
    skipped: 0,
    created: 0,
    updated: 0,
    deleteCandidates: 0,
    deletePendingConfirm: 0,
    deletePlanned: 0,
    deleted: 0,
    deleteSkippedByGuard: 0,
    deleteSourceAlive: 0,
    deleteSourceProbeFailed: 0,
    failed: 0,
    dryRun: Boolean(config.service.dryRun)
  };
  let stateDirty = false;

  function updateMapping(sourceUid, patch) {
    if (config.service.dryRun) {
      return;
    }
    setMapping(state, sourceUid, patch);
    stateDirty = true;
  }

  const dingtalkDiscovery = await dingtalkClient.discoverCalendarHome();
  const dingtalkCalendars = await dingtalkClient.listCalendars(dingtalkDiscovery.calendarHomeHref);
  const dingtalkSourceCalendars = pickDingtalkCalendars(
    dingtalkCalendars,
    config.dingtalk.sourceCalendarNames || (config.dingtalk.calendarName ? [config.dingtalk.calendarName] : []),
    config.dingtalk.sourceCalendarHrefs || (config.dingtalk.calendarHref ? [config.dingtalk.calendarHref] : [])
  );

  const icloudDiscovery = await icloudClient.discoverCalendarHome();
  const icloudCalendars = await icloudClient.listCalendars(icloudDiscovery.calendarHomeHref);
  const icloudCalendar = pickIcloudCalendar(
    icloudCalendars,
    config.icloud.targetCalendarName,
    config.icloud.targetCalendarHref
  );

  const sourceEventsMerged = [];
  for (const sourceCalendar of dingtalkSourceCalendars) {
    const sourceEvents = await dingtalkClient.calendarQuery(sourceCalendar.href, rangeStart, rangeEnd);
    for (const sourceEvent of sourceEvents) {
      sourceEventsMerged.push({
        ...sourceEvent,
        sourceCalendarHref: sourceCalendar.href,
        sourceCalendarName: sourceCalendar.displayName || ''
      });
    }
  }
  const sourceEvents = mergeSourceEvents(sourceEventsMerged);
  const targetEvents = await icloudClient.calendarQuery(icloudCalendar.href, rangeStart, rangeEnd);

  const targetByUid = mapByUid(targetEvents);
  const sourceUidSet = new Set(sourceEvents.map((item) => item.uid).filter(Boolean));
  stats.sourceCount = sourceEvents.length;
  log.info('开始执行同步任务', {
    trigger,
    sourceCount: stats.sourceCount,
    dryRun: stats.dryRun,
    enableDelete: config.service.enableDelete,
    dingtalkCalendarHrefs: dingtalkSourceCalendars.map((item) => item.href),
    icloudCalendarHref: icloudCalendar.href
  });

  for (const sourceEvent of sourceEvents) {
    try {
      if (!sourceEvent.uid) {
        stats.skipped += 1;
        continue;
      }

      const mapping = getMapping(state, sourceEvent.uid);
      const unchanged =
        mapping &&
        !mapping.isDeleted &&
        mapping.targetHref &&
        mapping.targetEtag &&
        mapping.sourceEtag &&
        sourceEvent.etag &&
        mapping.sourceEtag === sourceEvent.etag;

      if (unchanged) {
        if (mapping.missingCount || mapping.isDeleted || !isSameCalendarHref(mapping.targetCalendarHref || '', icloudCalendar.href)) {
          updateMapping(sourceEvent.uid, {
            sourceHref: sourceEvent.href,
            sourceEtag: sourceEvent.etag,
            targetCalendarHref: icloudCalendar.href,
            targetHref: mapping.targetHref,
            targetEtag: mapping.targetEtag,
            isDeleted: false,
            missingCount: 0,
            lastSeenAt: now.toISOString(),
            updatedAt: new Date().toISOString()
          });
        }
        stats.skipped += 1;
        continue;
      }

      const targetEvent = targetByUid.get(sourceEvent.uid);
      const targetHref =
        (mapping && mapping.targetHref) ||
        (targetEvent && targetEvent.href) ||
        buildTargetHref(icloudCalendar.href, sourceEvent.uid);

      const targetEtag =
        (mapping && mapping.targetEtag) ||
        (targetEvent && targetEvent.etag) ||
        '';

      const isExisting = Boolean(mapping || targetEvent);

      if (config.service.dryRun) {
        if (isExisting) {
          stats.updated += 1;
        } else {
          stats.created += 1;
        }
        continue;
      }

      const writeResp = await safePutWithFallback(
        icloudClient,
        targetHref,
        sourceEvent.calendarData,
        isExisting ? { ifMatch: targetEtag || undefined } : { ifNoneMatch: '*' }
      );

      if (![200, 201, 204].includes(writeResp.status)) {
        throw new Error(`PUT ${targetHref} failed: HTTP ${writeResp.status}`);
      }

      const latestTargetEtag = writeResp.headers.get('etag') || targetEtag;
      updateMapping(sourceEvent.uid, {
        sourceHref: sourceEvent.href,
        sourceEtag: sourceEvent.etag,
        targetCalendarHref: icloudCalendar.href,
        targetHref,
        targetEtag: latestTargetEtag,
        isDeleted: false,
        missingCount: 0,
        lastSeenAt: now.toISOString(),
        updatedAt: new Date().toISOString()
      });

      if (isExisting) {
        stats.updated += 1;
      } else {
        stats.created += 1;
      }
    } catch (error) {
      stats.failed += 1;
      log.error(`同步事件失败 uid=${sourceEvent.uid || '(empty)'}: ${error.message}`, {
        uid: sourceEvent.uid || '',
        href: sourceEvent.href || '',
        error
      });
    }
  }

  if (config.service.enableDelete) {
    const activeMappings = Object.values(state.mappings)
      .filter((item) => item && item.sourceUid)
      .filter((item) => !item.isDeleted)
      .filter((item) => isMappingInTargetCalendar(item, icloudCalendar.href));

    const missingMappings = activeMappings.filter((item) => !sourceUidSet.has(item.sourceUid));
    stats.deleteCandidates = missingMappings.length;

    const missingRatio = activeMappings.length ? missingMappings.length / activeMappings.length : 0;
    if (missingMappings.length > 0 && missingRatio > config.service.deleteMaxRatio) {
      stats.deleteSkippedByGuard = missingMappings.length;
      log.warn('删除保护触发，本轮跳过删除', {
        missing: missingMappings.length,
        active: activeMappings.length,
        ratio: Number(missingRatio.toFixed(4)),
        maxRatio: config.service.deleteMaxRatio
      });
    } else {
      for (const mapping of missingMappings) {
        try {
          const currentMissingCount = (mapping.missingCount || 0) + 1;
          updateMapping(mapping.sourceUid, {
            sourceHref: mapping.sourceHref || '',
            sourceEtag: mapping.sourceEtag || '',
            targetCalendarHref: mapping.targetCalendarHref || icloudCalendar.href,
            targetHref: mapping.targetHref,
            targetEtag: mapping.targetEtag || '',
            isDeleted: false,
            missingCount: currentMissingCount,
            lastMissingAt: now.toISOString(),
            updatedAt: new Date().toISOString()
          });

          if (currentMissingCount < config.service.deleteConfirmRuns) {
            stats.deletePendingConfirm += 1;
            continue;
          }

          const sourceProbe = await probeSourceExists(dingtalkClient, mapping.sourceHref);
          if (sourceProbe.uncertain) {
            stats.deleteSourceProbeFailed += 1;
            continue;
          }
          if (sourceProbe.exists) {
            stats.deleteSourceAlive += 1;
            updateMapping(mapping.sourceUid, {
              sourceHref: mapping.sourceHref || '',
              sourceEtag: mapping.sourceEtag || '',
              targetCalendarHref: mapping.targetCalendarHref || icloudCalendar.href,
              targetHref: mapping.targetHref,
              targetEtag: mapping.targetEtag || '',
              isDeleted: false,
              missingCount: 0,
              lastSeenAt: now.toISOString(),
              updatedAt: new Date().toISOString()
            });
            continue;
          }

          if (config.service.dryRun) {
            stats.deletePlanned += 1;
            continue;
          }

          const deleteResp = await safeDeleteWithFallback(icloudClient, mapping.targetHref, mapping.targetEtag || '');
          if (![200, 202, 204, 404].includes(deleteResp.status)) {
            throw new Error(`DELETE ${mapping.targetHref} failed: HTTP ${deleteResp.status}`);
          }

          const latestTargetEtag = deleteResp.headers.get('etag') || '';
          updateMapping(mapping.sourceUid, {
            sourceHref: mapping.sourceHref || '',
            sourceEtag: mapping.sourceEtag || '',
            targetCalendarHref: mapping.targetCalendarHref || icloudCalendar.href,
            targetHref: mapping.targetHref,
            targetEtag: latestTargetEtag,
            isDeleted: true,
            missingCount: currentMissingCount,
            deletedAt: now.toISOString(),
            updatedAt: new Date().toISOString()
          });
          stats.deleted += 1;
        } catch (error) {
          stats.failed += 1;
          log.error(`删除同步失败 uid=${mapping.sourceUid || '(empty)'}: ${error.message}`, {
            uid: mapping.sourceUid || '',
            targetHref: mapping.targetHref || '',
            error
          });
        }
      }
    }
  }

  if (!config.service.dryRun) {
    state.lastSyncAt = new Date().toISOString();
    stateDirty = true;
  }

  if (stateDirty) {
    saveState(config.service.stateFile, state);
  }

  log.info('同步任务完成', {
    trigger,
    elapsedMs: Date.now() - startTime,
    stats
  });

  return {
    stats,
    elapsedMs: Date.now() - startTime,
    window: {
      start: rangeStart.toISOString(),
      end: rangeEnd.toISOString()
    },
    selectedCalendars: {
      dingtalk: dingtalkSourceCalendars.map((item) => ({
        name: item.displayName || '',
        href: item.href
      })),
      icloud: {
        name: icloudCalendar.displayName || '',
        href: icloudCalendar.href
      }
    },
    stateFile: config.service.stateFile
  };
}

module.exports = {
  syncOnce,
  pickDingtalkCalendars,
  pickDingtalkCalendar,
  pickIcloudCalendar
};

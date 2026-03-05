'use strict';

const path = require('node:path');
const {
  loadEnvFile,
  getRequiredEnv,
  getEnv,
  getIntEnv,
  getBoolEnv,
  getCsvEnv
} = require('../lib/env');

// 加载同步服务配置
function loadSyncConfig() {
  // 兼容在不同目录启动服务
  loadEnvFile(path.join(process.cwd(), '.env'));

  const dingtalkLegacyCalendarName = getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '');
  const dingtalkLegacyCalendarHref = getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '');
  const dingtalkSourceCalendarNames = getCsvEnv(
    'DINGTALK_CALDAV_SOURCE_CALENDAR_NAMES',
    dingtalkLegacyCalendarName ? [dingtalkLegacyCalendarName] : []
  );
  const dingtalkSourceCalendarHrefs = getCsvEnv(
    'DINGTALK_CALDAV_SOURCE_CALENDAR_HREFS',
    dingtalkLegacyCalendarHref ? [dingtalkLegacyCalendarHref] : []
  );

  const dingtalk = {
    baseUrl: getRequiredEnv('DINGTALK_CALDAV_BASE_URL'),
    username: getRequiredEnv('DINGTALK_CALDAV_USERNAME'),
    password: getRequiredEnv('DINGTALK_CALDAV_PASSWORD'),
    // 兼容旧配置键，仍保留首个值
    calendarName: dingtalkLegacyCalendarName,
    calendarHref: dingtalkLegacyCalendarHref,
    sourceCalendarNames: dingtalkSourceCalendarNames,
    sourceCalendarHrefs: dingtalkSourceCalendarHrefs,
    userAgent: getEnv('DINGTALK_CALDAV_USER_AGENT', 'calendar-sync-dingtalk-sync/0.1'),
    timeoutMs: getIntEnv('DINGTALK_CALDAV_TIMEOUT_MS', 15000)
  };

  const icloud = {
    baseUrl: getEnv('ICLOUD_CALDAV_BASE_URL', 'https://caldav.icloud.com'),
    username: getRequiredEnv('ICLOUD_APPLE_ID'),
    password: getRequiredEnv('ICLOUD_APP_SPECIFIC_PASSWORD'),
    targetCalendarName: getEnv('ICLOUD_TARGET_CALENDAR_NAME', ''),
    targetCalendarHref: getEnv('ICLOUD_TARGET_CALENDAR_HREF', ''),
    userAgent: getEnv('ICLOUD_CALDAV_USER_AGENT', 'calendar-sync-icloud-sync/0.1'),
    timeoutMs: getIntEnv('ICLOUD_CALDAV_TIMEOUT_MS', 15000)
  };

  const service = {
    stateFile: getEnv('SYNC_STATE_FILE', path.resolve(process.cwd(), 'data/sync-state.json')),
    logFile: getEnv('LOG_FILE', path.resolve(process.cwd(), 'data/logs/calendar-sync.log')),
    logLevel: getEnv('LOG_LEVEL', 'info'),
    syncPastDays: getIntEnv('SYNC_PAST_DAYS', 7),
    syncFutureDays: getIntEnv('SYNC_FUTURE_DAYS', 180),
    dryRun: getBoolEnv('SYNC_DRY_RUN', false),
    enableDelete: getBoolEnv('SYNC_ENABLE_DELETE', false),
    deleteConfirmRuns: getIntEnv('SYNC_DELETE_CONFIRM_RUNS', 2),
    deleteMaxRatio: Number.parseFloat(getEnv('SYNC_DELETE_MAX_RATIO', '0.9'))
  };

  if (!Number.isFinite(service.deleteMaxRatio) || service.deleteMaxRatio <= 0 || service.deleteMaxRatio > 1) {
    throw new Error(`SYNC_DELETE_MAX_RATIO 必须在 (0, 1] 区间，当前值: ${service.deleteMaxRatio}`);
  }
  if (service.deleteConfirmRuns <= 0) {
    throw new Error(`SYNC_DELETE_CONFIRM_RUNS 必须为正整数，当前值: ${service.deleteConfirmRuns}`);
  }

  return {
    dingtalk,
    icloud,
    service
  };
}

module.exports = {
  loadSyncConfig
};

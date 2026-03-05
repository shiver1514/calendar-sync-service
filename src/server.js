'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadSyncConfig } = require('./sync/config');
const { syncOnce } = require('./sync/sync-once');
const { loadState } = require('./sync/state-store');
const { loadStandardEnv } = require('./lib/runtime-env');
const { CaldavClient, normalizeHref } = require('./lib/caldav');
const { getEnv, getIntEnv, getBoolEnv, getCsvEnv } = require('./lib/env');
const { createLogger, readLogEntries } = require('./lib/logger');

loadStandardEnv();

const host = getEnv('HOST', '0.0.0.0');
const port = getIntEnv('PORT', 8787);
const syncIntervalSeconds = getIntEnv('SYNC_INTERVAL_SECONDS', 300);
const heartbeatIntervalSeconds = Math.max(5, getIntEnv('HEARTBEAT_INTERVAL_SECONDS', 30));
const syncApiToken = getEnv('SYNC_API_TOKEN', '');
const runStartupSync = getBoolEnv('SYNC_RUN_ON_STARTUP', true);
const uiRoot = path.resolve(__dirname, 'ui');

const defaultLogFile = getEnv('LOG_FILE', path.resolve(process.cwd(), 'data/logs/calendar-sync.log'));
const defaultLogLevel = getEnv('LOG_LEVEL', 'info');
const logger = createLogger({
  component: 'server',
  logFile: defaultLogFile,
  minLevel: defaultLogLevel
});

const runtime = {
  startedAt: new Date().toISOString(),
  lastHeartbeatAt: '',
  nextSyncAt: '',
  lastRunAt: '',
  lastSuccessAt: '',
  lastError: '',
  lastResult: null,
  running: false
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function text(res, statusCode, payload, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType
  });
  res.end(payload);
}

function isAuthorized(reqUrl, reqHeaders) {
  if (!syncApiToken) {
    return true;
  }

  const authHeader = reqHeaders.authorization || '';
  if (authHeader === `Bearer ${syncApiToken}`) {
    return true;
  }

  return reqUrl.searchParams.get('token') === syncApiToken;
}

function maskSecret(value) {
  const textValue = String(value || '');
  if (!textValue) {
    return '';
  }
  if (textValue.length <= 6) {
    return '*'.repeat(textValue.length);
  }
  return `${textValue.slice(0, 2)}***${textValue.slice(-2)}`;
}

function maskAccount(value) {
  const textValue = String(value || '');
  if (!textValue) {
    return '';
  }

  const atIndex = textValue.indexOf('@');
  if (atIndex <= 0) {
    return maskSecret(textValue);
  }

  const name = textValue.slice(0, atIndex);
  const domain = textValue.slice(atIndex + 1);
  if (name.length <= 2) {
    return `${'*'.repeat(name.length)}@${domain}`;
  }

  return `${name.slice(0, 1)}***${name.slice(-1)}@${domain}`;
}

function redactSyncConfig(config) {
  const sourceNames = Array.isArray(config.dingtalk.sourceCalendarNames) ? config.dingtalk.sourceCalendarNames : [];
  const sourceHrefs = Array.isArray(config.dingtalk.sourceCalendarHrefs) ? config.dingtalk.sourceCalendarHrefs : [];
  return {
    dingtalk: {
      baseUrl: config.dingtalk.baseUrl,
      username: maskAccount(config.dingtalk.username),
      password: maskSecret(config.dingtalk.password),
      calendarName: config.dingtalk.calendarName,
      calendarHref: config.dingtalk.calendarHref,
      sourceCalendarNames: sourceNames,
      sourceCalendarHrefs: sourceHrefs,
      userAgent: config.dingtalk.userAgent,
      timeoutMs: config.dingtalk.timeoutMs
    },
    icloud: {
      baseUrl: config.icloud.baseUrl,
      username: maskAccount(config.icloud.username),
      password: maskSecret(config.icloud.password),
      targetCalendarName: config.icloud.targetCalendarName,
      targetCalendarHref: config.icloud.targetCalendarHref,
      userAgent: config.icloud.userAgent,
      timeoutMs: config.icloud.timeoutMs
    },
    service: {
      stateFile: config.service.stateFile,
      logFile: config.service.logFile,
      logLevel: config.service.logLevel,
      syncPastDays: config.service.syncPastDays,
      syncFutureDays: config.service.syncFutureDays,
      dryRun: config.service.dryRun,
      enableDelete: config.service.enableDelete,
      deleteConfirmRuns: config.service.deleteConfirmRuns,
      deleteMaxRatio: config.service.deleteMaxRatio
    }
  };
}

function loadConfigSnapshot() {
  try {
    const config = loadSyncConfig();
    return {
      ok: true,
      config: redactSyncConfig(config)
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error),
      config: {
        dingtalk: {
          baseUrl: getEnv('DINGTALK_CALDAV_BASE_URL', ''),
          username: maskAccount(getEnv('DINGTALK_CALDAV_USERNAME', '')),
          password: maskSecret(getEnv('DINGTALK_CALDAV_PASSWORD', '')),
          calendarName: getEnv('DINGTALK_CALDAV_CALENDAR_NAME', ''),
          calendarHref: getEnv('DINGTALK_CALDAV_CALENDAR_HREF', ''),
          sourceCalendarNames: getCsvEnv(
            'DINGTALK_CALDAV_SOURCE_CALENDAR_NAMES',
            getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '') ? [getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '')] : []
          ),
          sourceCalendarHrefs: getCsvEnv(
            'DINGTALK_CALDAV_SOURCE_CALENDAR_HREFS',
            getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '') ? [getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '')] : []
          ),
          userAgent: getEnv('DINGTALK_CALDAV_USER_AGENT', ''),
          timeoutMs: getIntEnvSafe('DINGTALK_CALDAV_TIMEOUT_MS', 15000)
        },
        icloud: {
          baseUrl: getEnv('ICLOUD_CALDAV_BASE_URL', 'https://caldav.icloud.com'),
          username: maskAccount(getEnv('ICLOUD_APPLE_ID', '')),
          password: maskSecret(getEnv('ICLOUD_APP_SPECIFIC_PASSWORD', '')),
          targetCalendarName: getEnv('ICLOUD_TARGET_CALENDAR_NAME', ''),
          targetCalendarHref: getEnv('ICLOUD_TARGET_CALENDAR_HREF', ''),
          userAgent: getEnv('ICLOUD_CALDAV_USER_AGENT', ''),
          timeoutMs: getIntEnvSafe('ICLOUD_CALDAV_TIMEOUT_MS', 15000)
        },
        service: {
          stateFile: getEnv('SYNC_STATE_FILE', path.resolve(process.cwd(), 'data/sync-state.json')),
          logFile: getEnv('LOG_FILE', defaultLogFile),
          logLevel: getEnv('LOG_LEVEL', defaultLogLevel),
          syncPastDays: getIntEnv('SYNC_PAST_DAYS', 7),
          syncFutureDays: getIntEnv('SYNC_FUTURE_DAYS', 180),
          dryRun: getBoolEnv('SYNC_DRY_RUN', false),
          enableDelete: getBoolEnv('SYNC_ENABLE_DELETE', false),
          deleteConfirmRuns: getIntEnv('SYNC_DELETE_CONFIRM_RUNS', 2),
          deleteMaxRatio: Number.parseFloat(getEnv('SYNC_DELETE_MAX_RATIO', '0.9'))
        }
      }
    };
  }
}

function getIntEnvSafe(name, fallback) {
  try {
    return getIntEnv(name, fallback);
  } catch (_) {
    return fallback;
  }
}

function buildConfigEditorSnapshot() {
  const selectedSourceNames = getCsvEnv(
    'DINGTALK_CALDAV_SOURCE_CALENDAR_NAMES',
    getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '') ? [getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '')] : []
  );
  const selectedSourceHrefs = getCsvEnv(
    'DINGTALK_CALDAV_SOURCE_CALENDAR_HREFS',
    getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '') ? [getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '')] : []
  );

  return {
    ok: true,
    envFile: path.resolve(process.cwd(), '.env'),
    dingtalk: {
      baseUrl: getEnv('DINGTALK_CALDAV_BASE_URL', ''),
      sourceCalendarNames: selectedSourceNames,
      sourceCalendarHrefs: selectedSourceHrefs,
      userAgent: getEnv('DINGTALK_CALDAV_USER_AGENT', 'calendar-sync-dingtalk-sync/0.1'),
      timeoutMs: getIntEnvSafe('DINGTALK_CALDAV_TIMEOUT_MS', 15000),
      usernameMasked: maskAccount(getEnv('DINGTALK_CALDAV_USERNAME', '')),
      passwordMasked: maskSecret(getEnv('DINGTALK_CALDAV_PASSWORD', ''))
    },
    icloud: {
      baseUrl: getEnv('ICLOUD_CALDAV_BASE_URL', 'https://caldav.icloud.com'),
      targetCalendarHref: getEnv('ICLOUD_TARGET_CALENDAR_HREF', ''),
      targetCalendarName: getEnv('ICLOUD_TARGET_CALENDAR_NAME', ''),
      userAgent: getEnv('ICLOUD_CALDAV_USER_AGENT', 'calendar-sync-icloud-sync/0.1'),
      timeoutMs: getIntEnvSafe('ICLOUD_CALDAV_TIMEOUT_MS', 15000),
      usernameMasked: maskAccount(getEnv('ICLOUD_APPLE_ID', '')),
      passwordMasked: maskSecret(getEnv('ICLOUD_APP_SPECIFIC_PASSWORD', ''))
    }
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatEnvValue(value) {
  const textValue = String(value);
  if (!textValue) {
    return '';
  }
  if (/[\s#"'`]/.test(textValue)) {
    return `"${textValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return textValue;
}

function upsertEnvKey(envFile, key, value) {
  const envPath = path.resolve(process.cwd(), envFile || '.env');
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = content ? content.split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const nextLine = `${key}=${formatEnvValue(value)}`;

  let updated = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (re.test(lines[i])) {
      lines[i] = nextLine;
      updated = true;
      break;
    }
  }

  if (!updated) {
    if (lines.length && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(nextLine);
  }

  const output = `${lines.join('\n').replace(/\n*$/, '\n')}`;
  fs.writeFileSync(envPath, output, 'utf8');
  return envPath;
}

function readJsonBody(req, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`请求体过大，限制 ${maxBytes} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON: ${error.message}`));
      }
    });

    req.on('error', (error) => reject(error));
  });
}

function requireNonEmptyString(value, label) {
  const textValue = String(value || '').trim();
  if (!textValue) {
    throw new Error(`${label}不能为空`);
  }
  return textValue;
}

function parseTimeoutMs(value, label) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1000) {
    throw new Error(`${label}必须是 >= 1000 的整数`);
  }
  return parsed;
}

function parseOptionalTimeoutMs(value, fallback = 15000) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return parseTimeoutMs(value, '超时');
}

function uniqueCsvValues(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const textValue = String(item || '').trim();
    if (!textValue || seen.has(textValue)) {
      continue;
    }
    seen.add(textValue);
    result.push(textValue);
  }
  return result;
}

function normalizeCalendarRows(calendars) {
  const rows = calendars.map((item) => ({
    name: item.displayName || '',
    href: item.href,
    normalizedHref: normalizeHref(item.href || '')
  }));

  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    if (!row.href || seen.has(row.normalizedHref)) {
      continue;
    }
    seen.add(row.normalizedHref);
    deduped.push(row);
  }
  return deduped;
}

async function discoverCalendarsByCredential(body = {}) {
  const inputDingtalk = body.dingtalk || {};
  const inputIcloud = body.icloud || {};

  const dingtalkConfig = {
    baseUrl: String(inputDingtalk.baseUrl || getEnv('DINGTALK_CALDAV_BASE_URL', '')).trim(),
    username: String(inputDingtalk.username || getEnv('DINGTALK_CALDAV_USERNAME', '')).trim(),
    password: String(inputDingtalk.password || getEnv('DINGTALK_CALDAV_PASSWORD', '')).trim(),
    timeoutMs: parseOptionalTimeoutMs(inputDingtalk.timeoutMs, getIntEnvSafe('DINGTALK_CALDAV_TIMEOUT_MS', 15000)),
    userAgent: String(inputDingtalk.userAgent || getEnv('DINGTALK_CALDAV_USER_AGENT', 'calendar-sync-dingtalk-sync/0.1')).trim()
  };
  const icloudConfig = {
    baseUrl: String(inputIcloud.baseUrl || getEnv('ICLOUD_CALDAV_BASE_URL', 'https://caldav.icloud.com')).trim(),
    username: String(inputIcloud.appleId || getEnv('ICLOUD_APPLE_ID', '')).trim(),
    password: String(inputIcloud.appPassword || getEnv('ICLOUD_APP_SPECIFIC_PASSWORD', '')).trim(),
    timeoutMs: parseOptionalTimeoutMs(inputIcloud.timeoutMs, getIntEnvSafe('ICLOUD_CALDAV_TIMEOUT_MS', 15000)),
    userAgent: String(inputIcloud.userAgent || getEnv('ICLOUD_CALDAV_USER_AGENT', 'calendar-sync-icloud-sync/0.1')).trim()
  };

  if (!dingtalkConfig.baseUrl || !dingtalkConfig.username || !dingtalkConfig.password) {
    throw new Error('钉钉 Base URL / 账号 / 密码不能为空（用于发现来源日历）');
  }
  if (!icloudConfig.baseUrl || !icloudConfig.username || !icloudConfig.password) {
    throw new Error('iCloud Base URL / Apple ID / App 专用密码不能为空（用于发现目标日历）');
  }

  const dingtalkClient = new CaldavClient(dingtalkConfig);
  const dingtalkDiscovery = await dingtalkClient.discoverCalendarHome();
  const dingtalkCalendars = await dingtalkClient.listCalendars(dingtalkDiscovery.calendarHomeHref);

  const icloudClient = new CaldavClient(icloudConfig);
  const icloudDiscovery = await icloudClient.discoverCalendarHome();
  const icloudCalendars = await icloudClient.listCalendars(icloudDiscovery.calendarHomeHref);

  return {
    dingtalkCalendars: normalizeCalendarRows(dingtalkCalendars),
    icloudCalendars: normalizeCalendarRows(icloudCalendars)
  };
}

function applyWebConfigUpdate(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('请求体不能为空');
  }

  const dingtalk = body.dingtalk || {};
  const icloud = body.icloud || {};
  if (typeof dingtalk !== 'object' || typeof icloud !== 'object') {
    throw new Error('配置结构错误');
  }

  const dingtalkBaseUrl = requireNonEmptyString(dingtalk.baseUrl, '钉钉 Base URL');
  const icloudBaseUrl = requireNonEmptyString(icloud.baseUrl, 'iCloud Base URL');
  const dingtalkTimeoutMs = parseTimeoutMs(dingtalk.timeoutMs, '钉钉超时');
  const icloudTimeoutMs = parseTimeoutMs(icloud.timeoutMs, 'iCloud 超时');

  const nextDingtalkUser = String(dingtalk.username || '').trim() || getEnv('DINGTALK_CALDAV_USERNAME', '');
  const nextDingtalkPassword = String(dingtalk.password || '').trim() || getEnv('DINGTALK_CALDAV_PASSWORD', '');
  const nextAppleId = String(icloud.appleId || '').trim() || getEnv('ICLOUD_APPLE_ID', '');
  const nextAppPassword = String(icloud.appPassword || '').trim() || getEnv('ICLOUD_APP_SPECIFIC_PASSWORD', '');
  if (!nextDingtalkUser || !nextDingtalkPassword) {
    throw new Error('钉钉账号和密码不能为空');
  }
  if (!nextAppleId || !nextAppPassword) {
    throw new Error('iCloud Apple ID 和 App 专用密码不能为空');
  }

  const selectedSourceHrefs = uniqueCsvValues([
    ...(Array.isArray(dingtalk.sourceCalendarHrefs) ? dingtalk.sourceCalendarHrefs : []),
    ...String(dingtalk.sourceCalendarHrefsCsv || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  ]);
  const selectedSourceNames = uniqueCsvValues([
    ...(Array.isArray(dingtalk.sourceCalendarNames) ? dingtalk.sourceCalendarNames : []),
    ...String(dingtalk.sourceCalendarNamesCsv || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  ]);

  const nextTargetCalendarName = String(icloud.targetCalendarName || '').trim();
  const nextTargetCalendarHref = String(icloud.targetCalendarHref || '').trim();

  const updates = {
    DINGTALK_CALDAV_BASE_URL: dingtalkBaseUrl,
    DINGTALK_CALDAV_SOURCE_CALENDAR_NAMES: selectedSourceNames.join(','),
    DINGTALK_CALDAV_SOURCE_CALENDAR_HREFS: selectedSourceHrefs.join(','),
    // 兼容旧键，保留首个来源选择
    DINGTALK_CALDAV_CALENDAR_NAME: selectedSourceNames[0] || '',
    DINGTALK_CALDAV_CALENDAR_HREF: selectedSourceHrefs[0] || '',
    DINGTALK_CALDAV_USER_AGENT: String(dingtalk.userAgent || '').trim(),
    DINGTALK_CALDAV_TIMEOUT_MS: String(dingtalkTimeoutMs),
    ICLOUD_CALDAV_BASE_URL: icloudBaseUrl,
    ICLOUD_TARGET_CALENDAR_NAME: nextTargetCalendarName,
    ICLOUD_TARGET_CALENDAR_HREF: nextTargetCalendarHref,
    ICLOUD_CALDAV_USER_AGENT: String(icloud.userAgent || '').trim(),
    ICLOUD_CALDAV_TIMEOUT_MS: String(icloudTimeoutMs)
  };

  const inputDingtalkUser = String(dingtalk.username || '').trim();
  const inputDingtalkPassword = String(dingtalk.password || '').trim();
  const inputAppleId = String(icloud.appleId || '').trim();
  const inputAppPassword = String(icloud.appPassword || '').trim();
  if (inputDingtalkUser) {
    updates.DINGTALK_CALDAV_USERNAME = inputDingtalkUser;
  }
  if (inputDingtalkPassword) {
    updates.DINGTALK_CALDAV_PASSWORD = inputDingtalkPassword;
  }
  if (inputAppleId) {
    updates.ICLOUD_APPLE_ID = inputAppleId;
  }
  if (inputAppPassword) {
    updates.ICLOUD_APP_SPECIFIC_PASSWORD = inputAppPassword;
  }

  let envPath = '';
  for (const [key, value] of Object.entries(updates)) {
    envPath = upsertEnvKey('.env', key, value);
    process.env[key] = String(value);
  }

  return {
    envPath,
    updatedKeys: Object.keys(updates)
  };
}

function asBoolQuery(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function resolveScopeStart(scope) {
  if (scope === 'startup') {
    return runtime.startedAt || '';
  }
  if (scope === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.toISOString();
  }
  return '';
}

function getLogFile(configSnapshot) {
  if (configSnapshot.ok && configSnapshot.config && configSnapshot.config.service) {
    return configSnapshot.config.service.logFile || defaultLogFile;
  }
  return getEnv('LOG_FILE', defaultLogFile);
}

function getStateFile(configSnapshot) {
  if (configSnapshot.ok && configSnapshot.config && configSnapshot.config.service) {
    return configSnapshot.config.service.stateFile || path.resolve(process.cwd(), 'data/sync-state.json');
  }
  return getEnv('SYNC_STATE_FILE', path.resolve(process.cwd(), 'data/sync-state.json'));
}

function buildStateSummary(stateFile) {
  try {
    const syncState = loadState(stateFile);
    const mappings = Object.values(syncState.mappings || {});
    const deletedCount = mappings.filter((item) => item && item.isDeleted).length;
    const activeCount = mappings.length - deletedCount;
    return {
      ok: true,
      stateFile,
      lastSyncAt: syncState.lastSyncAt || '',
      mappingCount: mappings.length,
      activeCount,
      deletedCount
    };
  } catch (error) {
    return {
      ok: false,
      stateFile,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function serveStaticFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    return json(res, 404, {
      ok: false,
      error: 'not_found'
    });
  }
  const body = fs.readFileSync(filePath);
  return text(res, 200, body, contentType);
}

function heartbeat(source = 'timer') {
  runtime.lastHeartbeatAt = new Date().toISOString();
  logger.debug('服务心跳', {
    source,
    running: runtime.running
  });
}

function planNextSync() {
  runtime.nextSyncAt = new Date(Date.now() + syncIntervalSeconds * 1000).toISOString();
}

async function runSync(trigger) {
  if (runtime.running) {
    logger.warn('同步请求被跳过，已有任务正在执行', { trigger });
    return {
      skipped: true,
      reason: 'running'
    };
  }

  runtime.running = true;
  runtime.lastRunAt = new Date().toISOString();

  try {
    const config = loadSyncConfig();
    const result = await syncOnce(config, {
      logger: logger.child(`sync.${trigger}`),
      trigger
    });
    runtime.lastResult = {
      trigger,
      at: new Date().toISOString(),
      ...result
    };
    runtime.lastSuccessAt = new Date().toISOString();
    runtime.lastError = '';

    logger.info('同步执行完成', {
      trigger,
      elapsedMs: result.elapsedMs,
      stats: result.stats
    });
    return {
      skipped: false,
      result: runtime.lastResult
    };
  } catch (error) {
    runtime.lastError = error && error.stack ? error.stack : String(error);
    logger.error('同步执行失败', {
      trigger,
      error
    });
    throw error;
  } finally {
    runtime.running = false;
  }
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = reqUrl.pathname;

  if (req.method === 'GET' && pathname === '/health') {
    return json(res, 200, {
      ok: true,
      online: true,
      startedAt: runtime.startedAt,
      lastHeartbeatAt: runtime.lastHeartbeatAt,
      nextSyncAt: runtime.nextSyncAt,
      running: runtime.running,
      lastRunAt: runtime.lastRunAt,
      lastSuccessAt: runtime.lastSuccessAt,
      lastError: runtime.lastError,
      lastResult: runtime.lastResult
    });
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const configSnapshot = loadConfigSnapshot();
    return json(res, 200, {
      ok: true,
      online: true,
      runtime: {
        startedAt: runtime.startedAt,
        lastHeartbeatAt: runtime.lastHeartbeatAt,
        nextSyncAt: runtime.nextSyncAt,
        running: runtime.running,
        lastRunAt: runtime.lastRunAt,
        lastSuccessAt: runtime.lastSuccessAt,
        lastError: runtime.lastError,
        lastResult: runtime.lastResult
      },
      service: {
        host,
        port,
        syncIntervalSeconds,
        heartbeatIntervalSeconds,
        runStartupSync
      },
      state: buildStateSummary(getStateFile(configSnapshot)),
      logFile: getLogFile(configSnapshot)
    });
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    const configSnapshot = loadConfigSnapshot();
    const lines = Number.parseInt(reqUrl.searchParams.get('lines') || '200', 10);
    const level = reqUrl.searchParams.get('level') || '';
    const component = reqUrl.searchParams.get('component') || '';
    const mode = (reqUrl.searchParams.get('mode') || '').toLowerCase();
    const summary = mode === 'summary' || asBoolQuery(reqUrl.searchParams.get('summary'), false);
    const includeContext = mode === 'detail'
      ? true
      : asBoolQuery(reqUrl.searchParams.get('includeContext'), !summary);
    const scope = (reqUrl.searchParams.get('scope') || 'all').toLowerCase();
    const from = reqUrl.searchParams.get('from') || resolveScopeStart(scope);
    const to = reqUrl.searchParams.get('to') || '';
    const order = (reqUrl.searchParams.get('order') || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const idList = [
      ...reqUrl.searchParams.getAll('id'),
      reqUrl.searchParams.get('ids') || ''
    ].filter(Boolean).join(',');

    const result = readLogEntries({
      logFile: getLogFile(configSnapshot),
      lines: Number.isFinite(lines) ? lines : 200,
      level,
      component,
      from,
      to,
      id: idList,
      order,
      summary,
      includeContext
    });
    return json(res, 200, {
      ...result,
      scopeApplied: scope,
      runtimeStartedAt: runtime.startedAt
    });
  }

  if (req.method === 'GET' && pathname.startsWith('/api/logs/')) {
    const configSnapshot = loadConfigSnapshot();
    const id = decodeURIComponent(pathname.slice('/api/logs/'.length)).trim();
    if (!id) {
      return json(res, 400, {
        ok: false,
        error: 'missing_log_id'
      });
    }

    const result = readLogEntries({
      logFile: getLogFile(configSnapshot),
      id,
      lines: 1,
      summary: false,
      includeContext: true,
      order: 'desc'
    });
    if (!result.entries.length) {
      return json(res, 404, {
        ok: false,
        error: 'log_not_found',
        id
      });
    }
    return json(res, 200, {
      ok: true,
      entry: result.entries[0]
    });
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return json(res, 200, loadConfigSnapshot());
  }

  if (req.method === 'GET' && pathname === '/api/config/form') {
    return json(res, 200, buildConfigEditorSnapshot());
  }

  if (req.method === 'POST' && pathname === '/api/config/discover-calendars') {
    if (!isAuthorized(reqUrl, req.headers)) {
      return json(res, 401, {
        ok: false,
        error: 'unauthorized'
      });
    }

    try {
      const body = await readJsonBody(req);
      const discovered = await discoverCalendarsByCredential(body);
      return json(res, 200, {
        ok: true,
        ...discovered
      });
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  if (req.method === 'POST' && pathname === '/api/config') {
    if (!isAuthorized(reqUrl, req.headers)) {
      return json(res, 401, {
        ok: false,
        error: 'unauthorized'
      });
    }

    try {
      const body = await readJsonBody(req);
      const updateResult = applyWebConfigUpdate(body);
      const snapshot = loadConfigSnapshot();
      if (!snapshot.ok) {
        return json(res, 400, {
          ok: false,
          error: snapshot.error || '配置保存后校验失败',
          envFile: updateResult.envPath,
          updatedKeys: updateResult.updatedKeys
        });
      }

      logger.info('通过 Web 更新配置', {
        envFile: updateResult.envPath,
        updatedKeys: updateResult.updatedKeys
      });
      return json(res, 200, {
        ok: true,
        envFile: updateResult.envPath,
        updatedKeys: updateResult.updatedKeys,
        config: snapshot.config
      });
    } catch (error) {
      return json(res, 400, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  if (req.method === 'POST' && (pathname === '/api/sync' || pathname === '/sync')) {
    if (!isAuthorized(reqUrl, req.headers)) {
      return json(res, 401, {
        ok: false,
        error: 'unauthorized'
      });
    }

    try {
      const runResult = await runSync('manual');
      return json(res, 200, {
        ok: true,
        ...runResult
      });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveStaticFile(res, path.join(uiRoot, 'index.html'), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/assets/styles.css') {
    return serveStaticFile(res, path.join(uiRoot, 'styles.css'), 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/assets/app.js') {
    return serveStaticFile(res, path.join(uiRoot, 'app.js'), 'application/javascript; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    return text(res, 204, '');
  }

  return json(res, 404, {
    ok: false,
    error: 'not_found'
  });
});

server.listen(port, host, () => {
  logger.info('服务启动完成', {
    host,
    port,
    syncIntervalSeconds,
    heartbeatIntervalSeconds,
    runStartupSync
  });
});

heartbeat('startup');
planNextSync();

setInterval(() => {
  runSync('timer').catch(() => {
    // 失败信息已在 runSync 中记录
  }).finally(() => {
    planNextSync();
  });
}, syncIntervalSeconds * 1000);

setInterval(() => {
  heartbeat('timer');
}, heartbeatIntervalSeconds * 1000);

if (runStartupSync) {
  runSync('startup').catch(() => {
    // 失败信息已在 runSync 中记录
  });
}

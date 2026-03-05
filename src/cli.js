'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  getEnv,
  getIntEnv,
  getBoolEnv,
  getCsvEnv
} = require('./lib/env');
const { loadStandardEnv } = require('./lib/runtime-env');
const { createLogger, readLogEntries } = require('./lib/logger');
const { loadSyncConfig } = require('./sync/config');
const { syncOnce } = require('./sync/sync-once');
const {
  buildIcloudConfigFromEnv,
  createIcloudClient,
  discoverCalendars,
  pickCalendar,
  parseDateRange,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent
} = require('./icloud/service');

function parseFlags(argv) {
  const positional = [];
  const flags = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return {
    positional,
    flags
  };
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function asNumber(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`无效数字参数: ${value}`);
  }
  return parsed;
}

function printJsonOrTable(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      console.log(item);
    }
    return;
  }

  console.log(value);
}

async function fetchWithTimeout(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function maskSecret(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  if (text.length <= 6) {
    return '*'.repeat(text.length);
  }
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}

function maskAccount(value) {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  const atIndex = text.indexOf('@');
  if (atIndex <= 0) {
    return maskSecret(text);
  }
  const name = text.slice(0, atIndex);
  const domain = text.slice(atIndex + 1);
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

function fallbackConfigSnapshot() {
  const sourceCalendarNames = getCsvEnv(
    'DINGTALK_CALDAV_SOURCE_CALENDAR_NAMES',
    getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '') ? [getEnv('DINGTALK_CALDAV_CALENDAR_NAME', '')] : []
  );
  const sourceCalendarHrefs = getCsvEnv(
    'DINGTALK_CALDAV_SOURCE_CALENDAR_HREFS',
    getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '') ? [getEnv('DINGTALK_CALDAV_CALENDAR_HREF', '')] : []
  );

  return {
    dingtalk: {
      baseUrl: getEnv('DINGTALK_CALDAV_BASE_URL', ''),
      username: maskAccount(getEnv('DINGTALK_CALDAV_USERNAME', '')),
      password: maskSecret(getEnv('DINGTALK_CALDAV_PASSWORD', '')),
      calendarName: getEnv('DINGTALK_CALDAV_CALENDAR_NAME', ''),
      calendarHref: getEnv('DINGTALK_CALDAV_CALENDAR_HREF', ''),
      sourceCalendarNames,
      sourceCalendarHrefs,
      userAgent: getEnv('DINGTALK_CALDAV_USER_AGENT', ''),
      timeoutMs: getIntEnv('DINGTALK_CALDAV_TIMEOUT_MS', 15000)
    },
    icloud: {
      baseUrl: getEnv('ICLOUD_CALDAV_BASE_URL', ''),
      username: maskAccount(getEnv('ICLOUD_APPLE_ID', '')),
      password: maskSecret(getEnv('ICLOUD_APP_SPECIFIC_PASSWORD', '')),
      targetCalendarName: getEnv('ICLOUD_TARGET_CALENDAR_NAME', ''),
      targetCalendarHref: getEnv('ICLOUD_TARGET_CALENDAR_HREF', ''),
      userAgent: getEnv('ICLOUD_CALDAV_USER_AGENT', ''),
      timeoutMs: getIntEnv('ICLOUD_CALDAV_TIMEOUT_MS', 15000)
    },
    service: {
      stateFile: getEnv('SYNC_STATE_FILE', path.resolve(process.cwd(), 'data/sync-state.json')),
      logFile: getEnv('LOG_FILE', path.resolve(process.cwd(), 'data/logs/calendar-sync.log')),
      logLevel: getEnv('LOG_LEVEL', 'info'),
      syncPastDays: getIntEnv('SYNC_PAST_DAYS', 7),
      syncFutureDays: getIntEnv('SYNC_FUTURE_DAYS', 180),
      dryRun: getBoolEnv('SYNC_DRY_RUN', false),
      enableDelete: getBoolEnv('SYNC_ENABLE_DELETE', false),
      deleteConfirmRuns: getIntEnv('SYNC_DELETE_CONFIRM_RUNS', 2),
      deleteMaxRatio: Number.parseFloat(getEnv('SYNC_DELETE_MAX_RATIO', '0.9'))
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
      config: fallbackConfigSnapshot()
    };
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatEnvValue(value) {
  const text = String(value);
  if (!text) {
    return '';
  }
  if (/[\s#"'`]/.test(text)) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return text;
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

function removeEnvKey(envFile, key) {
  const envPath = path.resolve(process.cwd(), envFile || '.env');
  if (!fs.existsSync(envPath)) {
    return envPath;
  }
  const re = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  const lines = fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !re.test(line));
  const hasAnyContent = lines.some((line) => line.trim() !== '');
  const output = hasAnyContent
    ? `${lines.join('\n').replace(/\n*$/, '\n')}`
    : '';
  fs.writeFileSync(envPath, output, 'utf8');
  return envPath;
}

function renderSyncResult(result) {
  const sourceCalendars = Array.isArray(result.selectedCalendars && result.selectedCalendars.dingtalk)
    ? result.selectedCalendars.dingtalk
    : [result.selectedCalendars && result.selectedCalendars.dingtalk].filter(Boolean);
  const sourceSummary = sourceCalendars.length
    ? sourceCalendars.map((item) => `${item.name || '(无名称)'} (${item.href})`).join(' | ')
    : '-';

  console.log('\n同步完成：');
  console.log(`  时间窗: ${result.window.start} ~ ${result.window.end}`);
  console.log(`  钉钉来源日历: ${sourceSummary}`);
  console.log(`  iCloud 日历: ${result.selectedCalendars.icloud.name} (${result.selectedCalendars.icloud.href})`);
  console.log(`  总数: ${result.stats.sourceCount}`);
  console.log(`  新建: ${result.stats.created}`);
  console.log(`  更新: ${result.stats.updated}`);
  console.log(`  跳过: ${result.stats.skipped}`);
  console.log(`  删除候选: ${result.stats.deleteCandidates}`);
  console.log(`  删除待确认: ${result.stats.deletePendingConfirm}`);
  console.log(`  计划删除(DryRun): ${result.stats.deletePlanned}`);
  console.log(`  已删除: ${result.stats.deleted}`);
  console.log(`  删除保护跳过: ${result.stats.deleteSkippedByGuard}`);
  console.log(`  源端仍存在: ${result.stats.deleteSourceAlive}`);
  console.log(`  源端探测失败: ${result.stats.deleteSourceProbeFailed}`);
  console.log(`  失败: ${result.stats.failed}`);
  console.log(`  DryRun: ${result.stats.dryRun}`);
  console.log(`  状态文件: ${result.stateFile}`);
  console.log(`  耗时: ${result.elapsedMs}ms`);
}

async function cmdSync(args) {
  const { positional, flags } = parseFlags(args);
  const action = positional[0] || 'once';
  if (action !== 'once') {
    throw new Error(`不支持的 sync 子命令: ${action}`);
  }

  const config = loadSyncConfig();
  if (flags['dry-run'] !== undefined) {
    config.service.dryRun = asBool(flags['dry-run']);
  }
  if (flags['enable-delete'] !== undefined) {
    config.service.enableDelete = asBool(flags['enable-delete']);
  }
  if (flags['delete-confirm-runs'] !== undefined) {
    config.service.deleteConfirmRuns = Number.parseInt(flags['delete-confirm-runs'], 10);
  }
  if (flags['delete-max-ratio'] !== undefined) {
    config.service.deleteMaxRatio = asNumber(flags['delete-max-ratio'], config.service.deleteMaxRatio);
  }
  if (flags['target-calendar-name']) {
    config.icloud.targetCalendarName = flags['target-calendar-name'];
    config.icloud.targetCalendarHref = '';
  }
  if (flags['target-calendar-href']) {
    config.icloud.targetCalendarHref = flags['target-calendar-href'];
    config.icloud.targetCalendarName = '';
  }

  const logger = createLogger({
    component: 'cli.sync',
    logFile: config.service.logFile,
    minLevel: config.service.logLevel
  });

  const result = await syncOnce(config, {
    logger,
    trigger: 'cli'
  });

  if (asBool(flags.json, false)) {
    printJsonOrTable(result, true);
  } else {
    renderSyncResult(result);
  }
}

async function cmdStatus(args) {
  const { flags } = parseFlags(args);
  const json = asBool(flags.json, false);

  loadStandardEnv();
  const rawHost = getEnv('HOST', '127.0.0.1');
  const host = ['0.0.0.0', '::'].includes(rawHost) ? '127.0.0.1' : rawHost;
  const port = getIntEnv('PORT', 8787);
  const apiStatusUrl = `http://${host}:${port}/api/status`;

  try {
    const resp = await fetchWithTimeout(apiStatusUrl, 2500);
    if (resp.ok) {
      const data = await resp.json();
      if (json) {
        printJsonOrTable(data, true);
      } else {
        console.log('服务状态（在线）:');
        console.log(`  online: ${data.online !== false}`);
        console.log(`  running: ${data.runtime.running}`);
        console.log(`  lastHeartbeatAt: ${data.runtime.lastHeartbeatAt || ''}`);
        console.log(`  nextSyncAt: ${data.runtime.nextSyncAt || ''}`);
        console.log(`  lastRunAt: ${data.runtime.lastRunAt || ''}`);
        console.log(`  lastSuccessAt: ${data.runtime.lastSuccessAt || ''}`);
        console.log(`  lastError: ${data.runtime.lastError ? '有' : '无'}`);
        console.log(`  syncIntervalSeconds: ${(data.service && data.service.syncIntervalSeconds) || ''}`);
        console.log(`  heartbeatIntervalSeconds: ${(data.service && data.service.heartbeatIntervalSeconds) || ''}`);
        console.log(`  logFile: ${data.logFile || ''}`);
      }
      return;
    }
  } catch (_) {
    // API 未启动时走本地兜底
  }

  const stateFile = getEnv('SYNC_STATE_FILE', path.resolve(process.cwd(), 'data/sync-state.json'));
  let lastSyncAt = '';
  let mappingCount = 0;

  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    lastSyncAt = parsed.lastSyncAt || '';
    mappingCount = Object.keys(parsed.mappings || {}).length;
  } catch (_) {
    // ignore
  }

  const payload = {
    online: false,
    stateFile,
    lastSyncAt,
    mappingCount
  };

  if (json) {
    printJsonOrTable(payload, true);
  } else {
    console.log('服务状态（离线/本地兜底）:');
    console.log(`  stateFile: ${payload.stateFile}`);
    console.log(`  lastSyncAt: ${payload.lastSyncAt}`);
    console.log(`  mappingCount: ${payload.mappingCount}`);
  }
}

async function cmdLogs(args) {
  const { positional, flags } = parseFlags(args);
  loadStandardEnv();

  const logFile = getEnv('LOG_FILE', path.resolve(process.cwd(), 'data/logs/calendar-sync.log'));
  const lines = Number.parseInt(flags.lines || '200', 10);
  const level = flags.level || '';
  const component = flags.component || '';
  const ids = [flags.id || '', flags.ids || ''].filter(Boolean).join(',');
  const scope = String(flags.scope || 'all').toLowerCase();
  const from = flags.from || await resolveLogScopeStart(scope);
  const to = flags.to || '';
  const modeFlag = String(flags.mode || positional[0] || '').toLowerCase();
  const mode = ['summary', 'detail'].includes(modeFlag)
    ? modeFlag
    : (asBool(flags.detail, false) ? 'detail' : 'summary');
  const summary = mode === 'summary';
  const includeContext = mode === 'detail';
  const asJsonOutput = asBool(flags.json, false);

  const result = readLogEntries({
    logFile,
    lines,
    level,
    component,
    id: ids,
    from,
    to,
    order: String(flags.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc',
    summary,
    includeContext
  });

  if (asJsonOutput) {
    printJsonOrTable(result, true);
    return;
  }

  console.log(`日志文件: ${result.logFile}`);
  console.log(`模式: ${mode}`);
  console.log(`范围: ${scope}`);
  if (result.query && result.query.from) {
    console.log(`from: ${result.query.from}`);
  }
  if (result.query && result.query.to) {
    console.log(`to: ${result.query.to}`);
  }
  console.log(`条数: ${result.entries.length}`);
  for (const entry of result.entries) {
    if (summary) {
      console.log(`${entry.id} | ${entry.ts} | ${String(entry.level || '').toUpperCase()} | ${entry.message}`);
      continue;
    }
    console.log(`[${entry.id}] [${entry.ts}] [${String(entry.level || '').toUpperCase()}] [${entry.component}] ${entry.message}`);
    const contextText = entry.context && Object.keys(entry.context).length ? JSON.stringify(entry.context, null, 2) : '{}';
    console.log(contextText);
  }
}

async function resolveLogScopeStart(scope) {
  if (scope === 'today') {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now.toISOString();
  }

  if (scope !== 'startup') {
    return '';
  }

  const rawHost = getEnv('HOST', '127.0.0.1');
  const host = ['0.0.0.0', '::'].includes(rawHost) ? '127.0.0.1' : rawHost;
  const port = getIntEnv('PORT', 8787);
  const apiStatusUrl = `http://${host}:${port}/api/status`;
  try {
    const resp = await fetchWithTimeout(apiStatusUrl, 2500);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json();
    return (data.runtime && data.runtime.startedAt) || '';
  } catch (error) {
    throw new Error(`scope=startup 需要服务在线并可访问 /api/status: ${error.message}`);
  }
}

async function cmdConfig(args) {
  const { positional, flags } = parseFlags(args);
  const action = positional[0] || 'get';
  const asJsonOutput = asBool(flags.json, false);

  if (action === 'get') {
    const payload = loadConfigSnapshot();
    if (asJsonOutput) {
      printJsonOrTable(payload, true);
      return;
    }

    console.log('当前配置（脱敏）:');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (action === 'set') {
    const key = requireFlag(flags, 'key', '配置键名');
    const value = requireFlag(flags, 'value', '配置值');
    const envFile = flags.file || flags['env-file'] || '.env';
    const envPath = upsertEnvKey(envFile, key, value);

    const payload = {
      ok: true,
      action: 'set',
      envFile: envPath,
      key,
      value
    };

    if (asJsonOutput) {
      printJsonOrTable(payload, true);
      return;
    }
    console.log(`配置已更新: ${key}=${value}`);
    console.log(`环境文件: ${envPath}`);
    console.log('提示: 若服务已在运行，请重启服务使配置生效。');
    return;
  }

  if (action === 'unset') {
    const key = requireFlag(flags, 'key', '配置键名');
    const envFile = flags.file || flags['env-file'] || '.env';
    const envPath = removeEnvKey(envFile, key);

    const payload = {
      ok: true,
      action: 'unset',
      envFile: envPath,
      key
    };

    if (asJsonOutput) {
      printJsonOrTable(payload, true);
      return;
    }
    console.log(`配置已删除: ${key}`);
    console.log(`环境文件: ${envPath}`);
    console.log('提示: 若服务已在运行，请重启服务使配置生效。');
    return;
  }

  throw new Error(`不支持的 config 子命令: ${action}`);
}

function requireFlag(flags, key, label) {
  const value = flags[key];
  if (value === undefined || value === null || value === '') {
    throw new Error(`缺少参数 --${key}（${label}）`);
  }
  return value;
}

async function withIcloudContext(flags, fn) {
  const icloudConfig = buildIcloudConfigFromEnv();
  if (flags['calendar-name']) {
    icloudConfig.calendarName = flags['calendar-name'];
    icloudConfig.calendarHref = '';
  }
  if (flags['calendar-href']) {
    icloudConfig.calendarHref = flags['calendar-href'];
    icloudConfig.calendarName = '';
  }

  const client = createIcloudClient(icloudConfig);
  const { calendars } = await discoverCalendars(client);
  const calendar = pickCalendar(calendars, icloudConfig.calendarName, icloudConfig.calendarHref, false);

  return fn({
    client,
    calendar,
    calendars,
    icloudConfig
  });
}

function toDateValue(value, name) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${name} 不是有效时间: ${value}`);
  }
  return date.toISOString();
}

async function cmdIcloud(args) {
  const { positional, flags } = parseFlags(args);
  const action = positional[0] || 'list';
  const asJsonOutput = asBool(flags.json, false);

  if (action === 'calendars') {
    const icloudConfig = buildIcloudConfigFromEnv();
    const client = createIcloudClient(icloudConfig);
    const { calendars } = await discoverCalendars(client);

    const payload = calendars.map((item) => ({
      name: item.displayName || '',
      href: item.href,
      readOnlyHint: isLikelyReadOnlyName(item.displayName)
    }));

    if (asJsonOutput) {
      printJsonOrTable(payload, true);
      return;
    }

    console.log('iCloud 日历列表:');
    payload.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.name || '(无名称)'} -> ${item.href}${item.readOnlyHint ? ' [可能只读]' : ''}`);
    });
    return;
  }

  if (action === 'list') {
    await withIcloudContext(flags, async ({ client, calendar }) => {
      const range = parseDateRange(flags.start, flags.end);
      const events = await listEvents(client, calendar.href, range.start, range.end, flags.q || '');

      if (asJsonOutput) {
        printJsonOrTable({
          calendar: { name: calendar.displayName || '', href: calendar.href },
          count: events.length,
          events
        }, true);
        return;
      }

      console.log(`日历: ${calendar.displayName || '(无名称)'} (${calendar.href})`);
      console.log(`事件数: ${events.length}`);
      events.forEach((item, index) => {
        console.log(`  ${index + 1}. [${item.uid}] ${item.summary || '(无标题)'} ${item.startAt || ''} ~ ${item.endAt || ''}`);
      });
    });
    return;
  }

  if (action === 'create') {
    await withIcloudContext(flags, async ({ client, calendar }) => {
      const title = requireFlag(flags, 'title', '标题');
      const start = requireFlag(flags, 'start', '开始时间');
      const end = requireFlag(flags, 'end', '结束时间');

      const created = await createEvent(client, calendar.href, {
        summary: title,
        description: flags.description || '',
        location: flags.location || '',
        startAt: toDateValue(start, 'start'),
        endAt: toDateValue(end, 'end'),
        rrule: flags.rrule || ''
      });

      if (asJsonOutput) {
        printJsonOrTable(created, true);
        return;
      }

      console.log('创建成功:');
      console.log(`  uid: ${created.uid}`);
      console.log(`  href: ${created.href}`);
      console.log(`  etag: ${created.etag}`);
    });
    return;
  }

  if (action === 'update') {
    await withIcloudContext(flags, async ({ client, calendar }) => {
      const uid = flags.uid || '';
      const href = flags.href || '';
      if (!uid && !href) {
        throw new Error('更新必须提供 --uid 或 --href');
      }

      const range = parseDateRange(flags['range-start'], flags['range-end']);
      const updated = await updateEvent(client, calendar.href, {
        uid,
        href,
        summary: flags.title,
        description: flags.description,
        location: flags.location,
        startAt: flags.start ? toDateValue(flags.start, 'start') : '',
        endAt: flags.end ? toDateValue(flags.end, 'end') : '',
        rrule: flags.rrule,
        rangeStart: range.start,
        rangeEnd: range.end
      });

      if (asJsonOutput) {
        printJsonOrTable(updated, true);
        return;
      }

      console.log('更新成功:');
      console.log(`  uid: ${updated.uid}`);
      console.log(`  href: ${updated.href}`);
      console.log(`  etag: ${updated.etag}`);
    });
    return;
  }

  if (action === 'delete') {
    await withIcloudContext(flags, async ({ client, calendar }) => {
      const uid = flags.uid || '';
      const href = flags.href || '';
      if (!uid && !href) {
        throw new Error('删除必须提供 --uid 或 --href');
      }

      const range = parseDateRange(flags['range-start'], flags['range-end']);
      const deleted = await deleteEvent(client, calendar.href, {
        uid,
        href,
        rangeStart: range.start,
        rangeEnd: range.end
      });

      if (asJsonOutput) {
        printJsonOrTable(deleted, true);
        return;
      }

      console.log('删除结果:');
      console.log(`  deleted: ${deleted.deleted}`);
      console.log(`  status: ${deleted.status}`);
      console.log(`  uid: ${deleted.uid || ''}`);
      console.log(`  href: ${deleted.href || ''}`);
    });
    return;
  }

  throw new Error(`不支持的 icloud 子命令: ${action}`);
}

function isLikelyReadOnlyName(name) {
  const text = String(name || '');
  return [/提醒/i, /reminder/i, /birthdays?/i, /holiday/i, /节假日/i].some((re) => re.test(text));
}

function printHelp() {
  console.log(`
calendar-sync CLI

用法:
  node src/cli.js <command> [subcommand] [--flags]

命令:
  sync once                          执行一次同步
  status                             读取服务状态（优先 API，失败后本地兜底）
  logs [summary|detail]              读取本地日志（支持级别/ID/时间段）
  config get                         获取当前配置（脱敏）
  config set                         更新 .env 配置键值
  config unset                       删除 .env 配置键
  icloud calendars                   列出 iCloud 日历
  icloud list                        列出事件
  icloud create                      创建事件
  icloud update                      更新事件
  icloud delete                      删除事件

常用示例:
  node src/cli.js sync once --dry-run false --enable-delete true
  node src/cli.js status --json
  node src/cli.js logs summary --scope today --lines 100
  node src/cli.js logs summary --level error --lines 50
  node src/cli.js logs detail --id m8v7p2-000a
  node src/cli.js logs detail --from 2026-03-05T00:00:00Z --to 2026-03-05T12:00:00Z
  node src/cli.js config get --json
  node src/cli.js config set --key SYNC_INTERVAL_SECONDS --value 120
  node src/cli.js config unset --key SYNC_API_TOKEN
  node src/cli.js config set --file /tmp/test.env --key LOG_LEVEL --value debug
  node src/cli.js icloud list --start 2026-03-01T00:00:00Z --end 2026-03-31T23:59:59Z
  node src/cli.js icloud create --title "会诊" --start 2026-03-10T01:00:00Z --end 2026-03-10T02:00:00Z
  node src/cli.js icloud update --uid <UID> --title "新标题"
  node src/cli.js icloud delete --uid <UID>
`);
}

async function main() {
  loadStandardEnv();
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  const args = argv.slice(1);

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'sync') {
    await cmdSync(args);
    return;
  }

  if (command === 'status') {
    await cmdStatus(args);
    return;
  }

  if (command === 'logs') {
    await cmdLogs(args);
    return;
  }

  if (command === 'config') {
    await cmdConfig(args);
    return;
  }

  if (command === 'icloud') {
    await cmdIcloud(args);
    return;
  }

  throw new Error(`未知命令: ${command}`);
}

main().catch((error) => {
  console.error('\nCLI 执行失败：');
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});

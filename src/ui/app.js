'use strict';

let autoRefreshTimer = null;
let refreshInFlight = false;
let syncStatusPollTimer = null;

async function fetchJson(url, options = {}) {
  const resp = await fetch(url, {
    cache: 'no-store',
    ...options
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${text}`);
  }
  return resp.json();
}

function formatDateTime(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function safeText(value) {
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function safeSeconds(value, fallback = 10) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(5, Math.min(300, parsed));
}

function renderRuntimeMeta(payload) {
  const runtime = payload.runtime || {};
  const service = payload.service || {};
  const state = payload.state || {};

  const items = [
    ['同步间隔', service.syncIntervalSeconds ? `${service.syncIntervalSeconds}s` : '-'],
    ['心跳间隔', service.heartbeatIntervalSeconds ? `${service.heartbeatIntervalSeconds}s` : '-'],
    ['下次计划同步', formatDateTime(runtime.nextSyncAt)],
    ['最近触发来源', safeText(runtime.lastResult && runtime.lastResult.trigger)],
    ['状态文件', safeText(state.stateFile)],
    ['映射总数', safeText(state.mappingCount)]
  ];

  const html = items
    .map(([key, value]) => `<div class="meta-item"><p class="k">${key}</p><p class="v">${safeText(value)}</p></div>`)
    .join('');
  document.getElementById('runtime-meta').innerHTML = html;
}

function renderStatus(payload) {
  const runtime = payload.runtime || {};
  const stats = (runtime.lastResult && runtime.lastResult.stats) || {};
  const online = payload.online !== false;

  document.getElementById('m-online').textContent = online ? '是' : '否';
  document.getElementById('m-running').textContent = runtime.running ? '是' : '否';
  document.getElementById('m-last-success').textContent = formatDateTime(runtime.lastSuccessAt);
  document.getElementById('m-heartbeat').textContent = formatDateTime(runtime.lastHeartbeatAt);
  document.getElementById('m-elapsed').textContent = runtime.lastResult ? `${runtime.lastResult.elapsedMs}ms` : '-';
  const lastErrorEl = document.getElementById('m-last-error');
  if (runtime.lastError) {
    lastErrorEl.textContent = String(runtime.lastError).slice(0, 160);
    lastErrorEl.classList.add('is-error');
  } else {
    lastErrorEl.textContent = '无';
    lastErrorEl.classList.remove('is-error');
  }

  const statKeys = [
    ['源事件总数', stats.sourceCount],
    ['新建', stats.created],
    ['更新', stats.updated],
    ['跳过', stats.skipped],
    ['删除候选', stats.deleteCandidates],
    ['已删除', stats.deleted],
    ['失败', stats.failed],
    ['演练模式', stats.dryRun === true ? '是（仅预演，不写入）' : stats.dryRun === false ? '否（真实写入）' : '-']
  ];

  const html = statKeys
    .map(([key, value]) => `<div class="stat"><p class="k">${key}</p><p class="v">${safeText(value)}</p></div>`)
    .join('');
  document.getElementById('sync-stats').innerHTML = html;
  renderRuntimeMeta(payload);
}

function levelClass(level) {
  const normalized = String(level || '').toLowerCase();
  if (['error', 'warn', 'info', 'debug'].includes(normalized)) {
    return `level-${normalized}`;
  }
  return 'level-info';
}

function countByLevel(entries) {
  const counts = {
    total: entries.length,
    error: 0,
    warn: 0,
    info: 0,
    debug: 0
  };

  for (const entry of entries) {
    const level = String(entry.level || '').toLowerCase();
    if (Object.hasOwn(counts, level)) {
      counts[level] += 1;
    }
  }
  return counts;
}

function renderLogs(payload) {
  const entries = payload.entries || [];
  const bodyEl = document.getElementById('log-table-body');
  const hintEl = document.getElementById('log-summary-hint');
  const kpiEl = document.getElementById('log-kpis');

  if (!entries.length) {
    bodyEl.innerHTML = '<tr><td colspan="6" class="log-empty">暂无日志。</td></tr>';
    kpiEl.innerHTML = '<span class="kpi">Total: 0</span><span class="kpi kpi-error">Error: 0</span><span class="kpi kpi-warn">Warn: 0</span><span class="kpi kpi-info">Info: 0</span><span class="kpi kpi-debug">Debug: 0</span>';
    hintEl.textContent = '当前筛选下没有日志。';
    return;
  }

  const counts = countByLevel(entries);
  kpiEl.innerHTML = `<span class="kpi">Total: ${counts.total}</span><span class="kpi kpi-error">Error: ${counts.error}</span><span class="kpi kpi-warn">Warn: ${counts.warn}</span><span class="kpi kpi-info">Info: ${counts.info}</span><span class="kpi kpi-debug">Debug: ${counts.debug}</span>`;

  const html = entries.map((entry) => {
    const ts = escapeHtml(formatDateTime(entry.ts));
    const level = escapeHtml(String(entry.level || '').toUpperCase());
    const component = escapeHtml(safeText(entry.component));
    const message = escapeHtml(safeText(entry.message));
    const id = escapeHtml(safeText(entry.id));
    return `<tr class="log-row ${levelClass(entry.level)}">
      <td class="log-col-time">${ts}</td>
      <td class="log-col-level"><span class="log-level-pill ${levelClass(entry.level)}">${level}</span></td>
      <td class="log-col-component"><span class="log-component">${component}</span></td>
      <td class="log-col-message"><div class="log-message">${message}</div></td>
      <td class="log-col-id"><div class="log-id">${id}</div></td>
      <td class="log-col-action"><button class="btn btn-small btn-log-detail" data-log-id="${id}">详情</button></td>
    </tr>`;
  }).join('');

  bodyEl.innerHTML = html;
  hintEl.textContent = `已加载 ${entries.length} 条简要日志。默认按时间倒序，点击“详情”按 ID 拉取完整上下文。`;
}

function renderConfig(payload) {
  const root = document.getElementById('config-panels');
  const config = (payload && payload.config) || {};
  const dingtalk = config.dingtalk || {};
  const icloud = config.icloud || {};
  const dingtalkSources = Array.isArray(dingtalk.sourceCalendarHrefs) ? dingtalk.sourceCalendarHrefs : [];
  const dingtalkSourceNames = Array.isArray(dingtalk.sourceCalendarNames) ? dingtalk.sourceCalendarNames : [];
  const sourceText = dingtalkSources.length
    ? dingtalkSources.join(', ')
    : (dingtalk.calendarHref || '全部可用日历（自动）');
  const sourceNameText = dingtalkSourceNames.length
    ? dingtalkSourceNames.join(', ')
    : (dingtalk.calendarName || '-');

  const buildConfigBlock = (title, rows) => {
    const body = rows
      .map(([k, v]) => `<p class="k">${k}</p><p class="v">${safeText(v)}</p>`)
      .join('');
    return `<section class="config-block"><h3>${title}</h3><div class="config-grid">${body}</div></section>`;
  };

  const html = [
    buildConfigBlock('钉钉', [
      ['Base URL', dingtalk.baseUrl],
      ['账号', dingtalk.username],
      ['密码', dingtalk.password],
      ['来源日历名称', sourceNameText],
      ['来源日历 HREF', sourceText],
      ['User Agent', dingtalk.userAgent],
      ['超时(ms)', dingtalk.timeoutMs]
    ]),
    buildConfigBlock('iCloud', [
      ['Base URL', icloud.baseUrl],
      ['账号', icloud.username],
      ['密码', icloud.password],
      ['目标日历名称', icloud.targetCalendarName],
      ['目标日历 HREF', icloud.targetCalendarHref],
      ['User Agent', icloud.userAgent],
      ['超时(ms)', icloud.timeoutMs]
    ])
  ].join('');

  root.innerHTML = html;

  if (payload && payload.ok === false && payload.error) {
    const hint = document.getElementById('config-save-hint');
    hint.classList.add('is-error');
    hint.classList.remove('is-ok');
    hint.textContent = `当前配置存在错误: ${payload.error}`;
  }
}

async function loadStatus() {
  const data = await fetchJson(`/api/status?_=${Date.now()}`);
  renderStatus(data);
}

function currentLogFilters() {
  const linesInput = document.getElementById('log-lines');
  const levelSelect = document.getElementById('log-level');
  const scopeSelect = document.getElementById('log-scope');

  const lines = Number.parseInt(linesInput.value || '200', 10);
  const safeLines = Number.isFinite(lines) ? Math.max(1, Math.min(2000, lines)) : 200;
  linesInput.value = String(safeLines);

  return {
    lines: safeLines,
    level: levelSelect.value || '',
    scope: scopeSelect.value || 'startup'
  };
}

async function loadLogs() {
  const filters = currentLogFilters();
  const query = new URLSearchParams();
  query.set('lines', String(filters.lines));
  query.set('mode', 'summary');
  query.set('scope', filters.scope);
  if (filters.level) {
    query.set('level', filters.level);
  }
  query.set('_', String(Date.now()));

  const data = await fetchJson(`/api/logs?${query.toString()}`);
  renderLogs(data);
}

async function loadConfig() {
  const data = await fetchJson(`/api/config?_=${Date.now()}`);
  renderConfig(data);
}

async function openLogDetail(logId) {
  if (!logId) {
    return;
  }

  const dialog = document.getElementById('log-detail-dialog');
  const metaEl = document.getElementById('log-detail-meta');
  const contextEl = document.getElementById('log-detail-context');
  metaEl.textContent = `日志 ID: ${logId}`;
  contextEl.textContent = '加载中...';

  if (!dialog.open) {
    dialog.showModal();
  }

  try {
    const payload = await fetchJson(`/api/logs/${encodeURIComponent(logId)}?_=${Date.now()}`);
    const entry = payload.entry || {};
    metaEl.textContent = `${formatDateTime(entry.ts)} | ${String(entry.level || '').toUpperCase()} | ${safeText(entry.component)} | ${safeText(entry.id)}`;
    contextEl.textContent = JSON.stringify(entry, null, 2);
  } catch (error) {
    contextEl.textContent = `读取详情失败: ${error.message}`;
  }
}

function closeLogDetail() {
  const dialog = document.getElementById('log-detail-dialog');
  if (dialog.open) {
    dialog.close();
  }
}

function getSelectedValues(selectElement) {
  return Array.from(selectElement.selectedOptions || [])
    .map((option) => String(option.value || '').trim())
    .filter(Boolean);
}

function renderDingtalkSourceOptions(options, selectedHrefs = []) {
  const select = document.getElementById('dingtalk-source-calendars');
  const selectedSet = new Set(selectedHrefs);

  const rows = options.length ? options : selectedHrefs.map((href) => ({ name: '(已保存来源日历)', href }));
  const html = rows.map((item) => {
    const href = safeText(item.href);
    const name = safeText(item.name || item.displayName || '(无名称)');
    const selected = selectedSet.has(href) ? ' selected' : '';
    return `<option value="${escapeHtml(href)}"${selected}>${escapeHtml(name)} | ${escapeHtml(href)}</option>`;
  }).join('');

  select.innerHTML = html || '<option value="">无可用来源日历，请先点击“加载日历列表”</option>';
}

function renderIcloudTargetOptions(options, selectedHref = '') {
  const select = document.getElementById('icloud-target-calendar');
  const normalizedSelected = String(selectedHref || '').trim();

  const baseOptions = ['<option value="">自动选择可写日历（推荐）</option>'];
  const rows = options.length ? options : (normalizedSelected ? [{ name: '(已保存目标日历)', href: normalizedSelected }] : []);
  for (const item of rows) {
    const href = safeText(item.href);
    const name = safeText(item.name || item.displayName || '(无名称)');
    const selected = normalizedSelected && normalizedSelected === href ? ' selected' : '';
    baseOptions.push(`<option value="${escapeHtml(href)}"${selected}>${escapeHtml(name)} | ${escapeHtml(href)}</option>`);
  }

  select.innerHTML = baseOptions.join('');
  if (!normalizedSelected) {
    select.value = '';
  }
}

function fillConfigForm(payload) {
  const dingtalk = payload.dingtalk || {};
  const icloud = payload.icloud || {};
  const sourceHrefs = Array.isArray(dingtalk.sourceCalendarHrefs)
    ? dingtalk.sourceCalendarHrefs
    : (dingtalk.calendarHref ? [dingtalk.calendarHref] : []);
  const targetHref = icloud.targetCalendarHref || '';

  document.getElementById('dingtalk-base-url').value = dingtalk.baseUrl || '';
  document.getElementById('dingtalk-user-agent').value = dingtalk.userAgent || '';
  document.getElementById('dingtalk-timeout-ms').value = String(dingtalk.timeoutMs || 15000);
  document.getElementById('dingtalk-username').value = '';
  document.getElementById('dingtalk-password').value = '';
  document.getElementById('dingtalk-current-username').textContent = safeText(dingtalk.usernameMasked);
  document.getElementById('dingtalk-current-password').textContent = safeText(dingtalk.passwordMasked);
  renderDingtalkSourceOptions([], sourceHrefs);

  document.getElementById('icloud-base-url').value = icloud.baseUrl || '';
  document.getElementById('icloud-user-agent').value = icloud.userAgent || '';
  document.getElementById('icloud-timeout-ms').value = String(icloud.timeoutMs || 15000);
  document.getElementById('icloud-apple-id').value = '';
  document.getElementById('icloud-app-password').value = '';
  document.getElementById('icloud-current-username').textContent = safeText(icloud.usernameMasked);
  document.getElementById('icloud-current-password').textContent = safeText(icloud.passwordMasked);
  renderIcloudTargetOptions([], targetHref);

  const hint = document.getElementById('config-save-hint');
  hint.classList.remove('is-error');
  hint.classList.remove('is-ok');
  hint.textContent = `保存后立即写入 ${safeText(payload.envFile)}。`;

  const calendarHint = document.getElementById('calendar-load-hint');
  calendarHint.classList.remove('is-error');
  calendarHint.classList.remove('is-ok');
  calendarHint.textContent = '点击“加载日历列表”后选择来源与目标日历。';
}

function buildCalendarDiscoverPayload() {
  return {
    dingtalk: {
      baseUrl: document.getElementById('dingtalk-base-url').value.trim(),
      username: document.getElementById('dingtalk-username').value.trim(),
      password: document.getElementById('dingtalk-password').value.trim(),
      userAgent: document.getElementById('dingtalk-user-agent').value.trim(),
      timeoutMs: Number.parseInt(document.getElementById('dingtalk-timeout-ms').value || '15000', 10)
    },
    icloud: {
      baseUrl: document.getElementById('icloud-base-url').value.trim(),
      appleId: document.getElementById('icloud-apple-id').value.trim(),
      appPassword: document.getElementById('icloud-app-password').value.trim(),
      userAgent: document.getElementById('icloud-user-agent').value.trim(),
      timeoutMs: Number.parseInt(document.getElementById('icloud-timeout-ms').value || '15000', 10)
    }
  };
}

async function loadCalendarOptions() {
  const hintEl = document.getElementById('calendar-load-hint');
  const btn = document.getElementById('btn-load-calendars');
  btn.disabled = true;
  hintEl.classList.remove('is-error');
  hintEl.classList.remove('is-ok');
  hintEl.textContent = '加载日历列表中...';

  const sourceSelect = document.getElementById('dingtalk-source-calendars');
  const targetSelect = document.getElementById('icloud-target-calendar');
  const beforeSourceValues = getSelectedValues(sourceSelect);
  const beforeTargetValue = String(targetSelect.value || '').trim();

  try {
    const discoverPayload = buildCalendarDiscoverPayload();
    const result = await fetchJson(`/api/config/discover-calendars?_=${Date.now()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(discoverPayload)
    });

    const dingtalkCalendars = Array.isArray(result.dingtalkCalendars) ? result.dingtalkCalendars : [];
    const icloudCalendars = Array.isArray(result.icloudCalendars) ? result.icloudCalendars : [];

    const sourceSelection = beforeSourceValues.length
      ? beforeSourceValues
      : dingtalkCalendars.map((item) => item.href);
    renderDingtalkSourceOptions(dingtalkCalendars, sourceSelection);
    renderIcloudTargetOptions(icloudCalendars, beforeTargetValue);

    hintEl.classList.add('is-ok');
    hintEl.textContent = `已加载钉钉 ${dingtalkCalendars.length} 个来源日历、iCloud ${icloudCalendars.length} 个目标日历。`;
  } catch (error) {
    hintEl.classList.add('is-error');
    hintEl.textContent = `加载失败: ${error.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function openConfigDialog() {
  try {
    const data = await fetchJson(`/api/config/form?_=${Date.now()}`);
    fillConfigForm(data);

    const dialog = document.getElementById('config-dialog');
    dialog.showModal();
    loadCalendarOptions().catch(() => {
      // 错误已在 loadCalendarOptions 中处理
    });
  } catch (error) {
    const lastErrorEl = document.getElementById('m-last-error');
    lastErrorEl.classList.add('is-error');
    lastErrorEl.textContent = `读取配置失败: ${error.message}`;
    alert(`读取配置失败: ${error.message}`);
  }
}

function closeConfigDialog() {
  const dialog = document.getElementById('config-dialog');
  if (dialog.open) {
    dialog.close();
  }
}

function buildConfigSavePayload() {
  const dingtalkBaseUrl = document.getElementById('dingtalk-base-url').value.trim();
  const icloudBaseUrl = document.getElementById('icloud-base-url').value.trim();
  if (!dingtalkBaseUrl) {
    throw new Error('钉钉 Base URL 不能为空');
  }
  if (!icloudBaseUrl) {
    throw new Error('iCloud Base URL 不能为空');
  }

  const dingtalkTimeoutMs = Number.parseInt(document.getElementById('dingtalk-timeout-ms').value || '15000', 10);
  const icloudTimeoutMs = Number.parseInt(document.getElementById('icloud-timeout-ms').value || '15000', 10);
  if (!Number.isFinite(dingtalkTimeoutMs) || dingtalkTimeoutMs < 1000) {
    throw new Error('钉钉超时必须是 >= 1000 的整数');
  }
  if (!Number.isFinite(icloudTimeoutMs) || icloudTimeoutMs < 1000) {
    throw new Error('iCloud 超时必须是 >= 1000 的整数');
  }

  const sourceSelect = document.getElementById('dingtalk-source-calendars');
  const selectedSourceOptions = Array.from(sourceSelect.selectedOptions || []);
  const selectedSourceHrefs = selectedSourceOptions
    .map((option) => String(option.value || '').trim())
    .filter(Boolean);
  const selectedSourceNames = selectedSourceOptions
    .map((option) => String(option.textContent || '').split(' | ')[0].trim())
    .filter(Boolean);

  const targetSelect = document.getElementById('icloud-target-calendar');
  const targetOption = targetSelect.selectedOptions && targetSelect.selectedOptions[0]
    ? targetSelect.selectedOptions[0]
    : null;
  const icloudTargetCalendarHref = targetOption ? String(targetOption.value || '').trim() : '';
  const icloudTargetCalendarName = targetOption && icloudTargetCalendarHref
    ? String(targetOption.textContent || '').split(' | ')[0].trim()
    : '';

  return {
    dingtalk: {
      baseUrl: dingtalkBaseUrl,
      sourceCalendarNames: selectedSourceNames,
      sourceCalendarHrefs: selectedSourceHrefs,
      userAgent: document.getElementById('dingtalk-user-agent').value.trim(),
      timeoutMs: dingtalkTimeoutMs,
      username: document.getElementById('dingtalk-username').value.trim(),
      password: document.getElementById('dingtalk-password').value.trim()
    },
    icloud: {
      baseUrl: icloudBaseUrl,
      targetCalendarName: icloudTargetCalendarName,
      targetCalendarHref: icloudTargetCalendarHref,
      userAgent: document.getElementById('icloud-user-agent').value.trim(),
      timeoutMs: icloudTimeoutMs,
      appleId: document.getElementById('icloud-apple-id').value.trim(),
      appPassword: document.getElementById('icloud-app-password').value.trim()
    }
  };
}

async function saveConfig(event) {
  event.preventDefault();

  const hint = document.getElementById('config-save-hint');
  const saveBtn = document.getElementById('btn-config-save');
  saveBtn.disabled = true;
  hint.classList.remove('is-error');
  hint.classList.remove('is-ok');
  hint.textContent = '保存中...';

  try {
    const payload = buildConfigSavePayload();
    await fetchJson(`/api/config?_=${Date.now()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(payload)
    });

    hint.classList.add('is-ok');
    hint.textContent = '配置已保存。';

    await Promise.all([loadConfig(), loadStatus()]);
    closeConfigDialog();
  } catch (error) {
    hint.classList.add('is-error');
    hint.textContent = `保存失败: ${error.message}`;
  } finally {
    saveBtn.disabled = false;
  }
}

function stopSyncStatusPolling() {
  if (syncStatusPollTimer) {
    clearInterval(syncStatusPollTimer);
    syncStatusPollTimer = null;
  }
}

function startSyncStatusPolling() {
  stopSyncStatusPolling();
  syncStatusPollTimer = setInterval(() => {
    loadStatus().catch((error) => {
      const lastErrorEl = document.getElementById('m-last-error');
      lastErrorEl.textContent = `状态刷新失败: ${error.message}`;
      lastErrorEl.classList.add('is-error');
    });
  }, 700);
}

async function triggerSync() {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '同步中...';
  document.getElementById('m-running').textContent = '是';
  startSyncStatusPolling();

  try {
    const result = await fetchJson(`/api/sync?_=${Date.now()}`, { method: 'POST' });
    if (result && result.skipped && result.reason === 'running') {
      alert('已有同步任务在执行，本次请求已跳过。');
    }
    await Promise.all([loadStatus(), loadLogs()]);
  } catch (error) {
    const lastErrorEl = document.getElementById('m-last-error');
    lastErrorEl.classList.add('is-error');
    lastErrorEl.textContent = `触发同步失败: ${error.message}`;
    alert(`触发同步失败: ${error.message}`);
  } finally {
    stopSyncStatusPolling();
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

async function refreshDynamic() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  try {
    await Promise.all([loadStatus(), loadLogs()]);
  } catch (error) {
    const lastErrorEl = document.getElementById('m-last-error');
    lastErrorEl.classList.add('is-error');
    lastErrorEl.textContent = `刷新失败: ${error.message}`;
  } finally {
    refreshInFlight = false;
  }
}

async function refreshAll() {
  if (refreshInFlight) {
    return;
  }

  refreshInFlight = true;
  try {
    await Promise.all([loadStatus(), loadLogs(), loadConfig()]);
  } catch (error) {
    const lastErrorEl = document.getElementById('m-last-error');
    lastErrorEl.classList.add('is-error');
    lastErrorEl.textContent = `加载失败: ${error.message}`;
  } finally {
    refreshInFlight = false;
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function restartAutoRefresh() {
  stopAutoRefresh();

  const enabled = document.getElementById('auto-refresh-enabled').checked;
  if (!enabled) {
    return;
  }

  const secondsInput = document.getElementById('auto-refresh-seconds');
  const seconds = safeSeconds(secondsInput.value, 10);
  secondsInput.value = String(seconds);

  autoRefreshTimer = setInterval(() => {
    refreshDynamic().catch(() => {
      // 错误已在 refreshDynamic 中处理
    });
  }, seconds * 1000);
}

function bindEvents() {
  document.getElementById('btn-sync').addEventListener('click', triggerSync);
  document.getElementById('btn-refresh').addEventListener('click', refreshAll);
  document.getElementById('btn-load-logs').addEventListener('click', loadLogs);
  document.getElementById('log-level').addEventListener('change', loadLogs);
  document.getElementById('log-scope').addEventListener('change', loadLogs);

  const logBody = document.getElementById('log-table-body');
  logBody.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) {
      return;
    }
    const btn = target.closest('.btn-log-detail');
    if (!btn) {
      return;
    }
    openLogDetail(btn.getAttribute('data-log-id') || '');
  });

  document.getElementById('btn-log-detail-close').addEventListener('click', closeLogDetail);

  document.getElementById('btn-edit-config').addEventListener('click', openConfigDialog);
  document.getElementById('btn-load-calendars').addEventListener('click', loadCalendarOptions);
  document.getElementById('btn-config-cancel').addEventListener('click', closeConfigDialog);
  document.getElementById('config-form').addEventListener('submit', saveConfig);

  document.getElementById('auto-refresh-enabled').addEventListener('change', restartAutoRefresh);
  document.getElementById('auto-refresh-seconds').addEventListener('change', restartAutoRefresh);
}

bindEvents();
refreshAll();
restartAutoRefresh();

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function buildInitialState() {
  return {
    version: 1,
    lastSyncAt: '',
    mappings: {}
  };
}

// 从本地 JSON 文件读取同步状态
function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    return buildInitialState();
  }

  const raw = fs.readFileSync(stateFile, 'utf8').trim();
  if (!raw) {
    return buildInitialState();
  }

  const parsed = JSON.parse(raw);
  return {
    version: 1,
    lastSyncAt: parsed.lastSyncAt || '',
    mappings: parsed.mappings && typeof parsed.mappings === 'object' ? parsed.mappings : {}
  };
}

// 持久化同步状态（原子写入）
function saveState(stateFile, state) {
  const dir = path.dirname(stateFile);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${stateFile}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, stateFile);
}

function getMapping(state, sourceUid) {
  return state.mappings[sourceUid] || null;
}

function setMapping(state, sourceUid, mapping) {
  const previous = state.mappings[sourceUid] || {};
  state.mappings[sourceUid] = {
    sourceUid,
    sourceEtag: mapping.sourceEtag || '',
    sourceHref: mapping.sourceHref || '',
    targetCalendarHref: mapping.targetCalendarHref || previous.targetCalendarHref || '',
    targetHref: mapping.targetHref || '',
    targetEtag: mapping.targetEtag || '',
    isDeleted: Boolean(mapping.isDeleted),
    missingCount: Number.isFinite(mapping.missingCount) ? mapping.missingCount : previous.missingCount || 0,
    lastSeenAt: mapping.lastSeenAt || previous.lastSeenAt || '',
    lastMissingAt: mapping.lastMissingAt || previous.lastMissingAt || '',
    deletedAt: mapping.deletedAt || previous.deletedAt || '',
    updatedAt: mapping.updatedAt || new Date().toISOString()
  };
}

module.exports = {
  buildInitialState,
  loadState,
  saveState,
  getMapping,
  setMapping
};

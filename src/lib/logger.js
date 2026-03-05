'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LEVEL_WEIGHT = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let logSeq = 0;

function normalizeLevel(level) {
  const value = String(level || 'info').toLowerCase();
  return LEVEL_WEIGHT[value] ? value : 'info';
}

function safeContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  const cloned = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) {
      continue;
    }
    if (value instanceof Error) {
      cloned[key] = {
        message: value.message,
        stack: value.stack
      };
      continue;
    }
    cloned[key] = value;
  }
  return cloned;
}

function createLogId() {
  const nowPart = Date.now().toString(36);
  const seqPart = (logSeq % (36 ** 4)).toString(36).padStart(4, '0');
  logSeq += 1;
  return `${nowPart}-${seqPart}`;
}

function createLegacyId(line, lineNo) {
  const hash = crypto.createHash('sha1').update(String(line || '')).digest('hex').slice(0, 12);
  return `legacy-${String(lineNo).padStart(8, '0')}-${hash}`;
}

function normalizeIds(value) {
  if (!value) {
    return new Set();
  }

  if (Array.isArray(value)) {
    return new Set(value.map((item) => String(item || '').trim()).filter(Boolean));
  }

  return new Set(String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean));
}

function parseTimeMs(value) {
  if (!value) {
    return NaN;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : NaN;
}

function formatConsoleLine(entry) {
  const base = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.component}] ${entry.message}`;
  const contextKeys = Object.keys(entry.context || {});
  if (!contextKeys.length) {
    return base;
  }
  return `${base} ${JSON.stringify(entry.context)}`;
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeLogLine(filePath, line) {
  ensureParentDir(filePath);
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
}

function mapResultEntry(rawEntry, options = {}) {
  const includeContext = options.includeContext !== false;
  const summary = options.summary === true;
  const context = rawEntry.context && typeof rawEntry.context === 'object' ? rawEntry.context : {};
  const base = {
    id: rawEntry.id,
    ts: rawEntry.ts,
    level: normalizeLevel(rawEntry.level),
    component: String(rawEntry.component || ''),
    message: String(rawEntry.message || '')
  };

  if (summary) {
    return {
      ...base,
      hasContext: Object.keys(context).length > 0,
      contextKeys: Object.keys(context)
    };
  }

  if (!includeContext) {
    return base;
  }

  return {
    ...base,
    context
  };
}

function createLogger(options = {}) {
  const component = String(options.component || 'app');
  const logFile = String(options.logFile || path.resolve(process.cwd(), 'data/logs/calendar-sync.log'));
  const minLevel = normalizeLevel(options.minLevel || 'info');
  const minWeight = LEVEL_WEIGHT[minLevel];

  function emit(level, message, context = {}) {
    const normalizedLevel = normalizeLevel(level);
    const weight = LEVEL_WEIGHT[normalizedLevel];
    if (weight < minWeight) {
      return;
    }

    const entry = {
      id: createLogId(),
      ts: new Date().toISOString(),
      level: normalizedLevel,
      component,
      message: String(message || ''),
      context: safeContext(context)
    };

    writeLogLine(logFile, JSON.stringify(entry));

    const line = formatConsoleLine(entry);
    if (normalizedLevel === 'error') {
      console.error(line);
    } else if (normalizedLevel === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    component,
    logFile,
    minLevel,
    debug(message, context) {
      emit('debug', message, context);
    },
    info(message, context) {
      emit('info', message, context);
    },
    warn(message, context) {
      emit('warn', message, context);
    },
    error(message, context) {
      emit('error', message, context);
    },
    child(childComponent) {
      return createLogger({
        component: `${component}.${childComponent}`,
        logFile,
        minLevel
      });
    }
  };
}

function readLogEntries(options = {}) {
  const logFile = String(options.logFile || path.resolve(process.cwd(), 'data/logs/calendar-sync.log'));
  const linesLimit = Number.isFinite(options.lines) ? Math.max(1, Math.min(5000, options.lines)) : 200;
  const levelFilter = options.level ? normalizeLevel(options.level) : '';
  const componentFilter = options.component ? String(options.component) : '';
  const includeContext = options.includeContext !== false;
  const summary = options.summary === true;
  const order = String(options.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const fromMs = parseTimeMs(options.from);
  const toMs = parseTimeMs(options.to);
  const hasFrom = Number.isFinite(fromMs);
  const hasTo = Number.isFinite(toMs);
  const idSet = normalizeIds(options.ids || options.id);

  if (!fs.existsSync(logFile)) {
    return {
      logFile,
      entries: [],
      query: {
        lines: linesLimit,
        level: levelFilter,
        component: componentFilter,
        from: hasFrom ? new Date(fromMs).toISOString() : '',
        to: hasTo ? new Date(toMs).toISOString() : '',
        ids: Array.from(idSet),
        order,
        summary,
        includeContext
      }
    };
  }

  const content = fs.readFileSync(logFile, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);

  const collected = [];
  const hitIds = new Set();
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const entry = JSON.parse(lines[i]);
      if (!entry.id) {
        entry.id = createLegacyId(lines[i], i + 1);
      }

      const tsMs = parseTimeMs(entry.ts);
      if (hasFrom && (!Number.isFinite(tsMs) || tsMs < fromMs)) {
        continue;
      }
      if (hasTo && (!Number.isFinite(tsMs) || tsMs > toMs)) {
        continue;
      }
      if (levelFilter && normalizeLevel(entry.level) !== levelFilter) {
        continue;
      }
      if (componentFilter && String(entry.component || '').indexOf(componentFilter) < 0) {
        continue;
      }
      if (idSet.size && !idSet.has(String(entry.id))) {
        continue;
      }

      collected.push(mapResultEntry(entry, {
        includeContext,
        summary
      }));

      if (idSet.size) {
        hitIds.add(String(entry.id));
        if (hitIds.size >= idSet.size) {
          break;
        }
      } else if (collected.length >= linesLimit) {
        break;
      }
    } catch (_) {
      // 忽略非 JSON 日志行
    }
  }

  if (order === 'asc') {
    collected.reverse();
  }

  const entries = idSet.size ? collected : collected.slice(0, linesLimit);
  return {
    logFile,
    entries,
    query: {
      lines: linesLimit,
      level: levelFilter,
      component: componentFilter,
      from: hasFrom ? new Date(fromMs).toISOString() : '',
      to: hasTo ? new Date(toMs).toISOString() : '',
      ids: Array.from(idSet),
      order,
      summary,
      includeContext
    }
  };
}

module.exports = {
  createLogger,
  readLogEntries,
  normalizeLevel
};

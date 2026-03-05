'use strict';

const crypto = require('node:crypto');
const {
  CaldavClient,
  normalizeHref,
  joinHref,
  parseIcsField,
  sanitizeForFileName
} = require('../lib/caldav');
const { getRequiredEnv, getEnv, getIntEnv } = require('../lib/env');
const { loadStandardEnv } = require('../lib/runtime-env');

const ICLOUD_READ_ONLY_NAME_HINTS = [/提醒/i, /reminder/i, /birthdays?/i, /holiday/i, /节假日/i];

function isLikelyReadOnlyCalendar(displayName) {
  const text = displayName || '';
  return ICLOUD_READ_ONLY_NAME_HINTS.some((re) => re.test(text));
}

function toIcsDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`无效日期: ${input}`);
  }
  const pad = (v) => String(v).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function parseIcsDateTime(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00.000Z`;
  }

  if (/^\d{8}T\d{6}Z$/.test(text)) {
    const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(9, 11)}:${text.slice(11, 13)}:${text.slice(13, 15)}.000Z`;
    return iso;
  }

  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) {
    return '';
  }
  return parsed.toISOString();
}

function decodeIcsText(value) {
  return String(value || '')
    .replace(/\\n/g, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

function escapeIcsText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function buildEventIcs(input) {
  const uid = input.uid;
  const summary = input.summary || '';
  const description = input.description || '';
  const location = input.location || '';
  const startAt = input.startAt;
  const endAt = input.endAt;
  const rrule = input.rrule || '';

  if (!uid) {
    throw new Error('创建事件缺少 uid');
  }
  if (!startAt || !endAt) {
    throw new Error('创建事件缺少 startAt/endAt');
  }

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'PRODID:-//calendar-sync//iCloud CLI//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${toIcsDateTime(new Date())}`,
    `DTSTART:${toIcsDateTime(startAt)}`,
    `DTEND:${toIcsDateTime(endAt)}`,
    `SUMMARY:${escapeIcsText(summary)}`
  ];

  if (description) {
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
  }
  if (location) {
    lines.push(`LOCATION:${escapeIcsText(location)}`);
  }
  if (rrule) {
    lines.push(`RRULE:${rrule}`);
  }

  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  lines.push('');

  return lines.join('\r\n');
}

function parseEvent(item) {
  const calendarData = item.calendarData || '';
  const uid = parseIcsField(calendarData, 'UID');
  const summary = decodeIcsText(parseIcsField(calendarData, 'SUMMARY'));
  const description = decodeIcsText(parseIcsField(calendarData, 'DESCRIPTION'));
  const location = decodeIcsText(parseIcsField(calendarData, 'LOCATION'));
  const status = parseIcsField(calendarData, 'STATUS') || 'CONFIRMED';
  const dtstartRaw = parseIcsField(calendarData, 'DTSTART');
  const dtendRaw = parseIcsField(calendarData, 'DTEND');
  const rrule = parseIcsField(calendarData, 'RRULE');

  return {
    uid,
    href: item.href,
    etag: item.etag || '',
    summary,
    description,
    location,
    status,
    dtstartRaw,
    dtendRaw,
    startAt: parseIcsDateTime(dtstartRaw),
    endAt: parseIcsDateTime(dtendRaw),
    rrule,
    calendarData
  };
}

function defaultRange() {
  const now = Date.now();
  return {
    start: new Date(now - 30 * 24 * 3600 * 1000),
    end: new Date(now + 365 * 24 * 3600 * 1000)
  };
}

function parseDateRange(start, end) {
  if (!start && !end) {
    return defaultRange();
  }

  if (!start || !end) {
    throw new Error('必须同时提供 start 和 end');
  }

  const startDate = new Date(start);
  const endDate = new Date(end);

  if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(endDate.getTime())) {
    throw new Error('start/end 不是有效日期');
  }

  if (startDate.getTime() >= endDate.getTime()) {
    throw new Error('start 必须早于 end');
  }

  return {
    start: startDate,
    end: endDate
  };
}

function buildIcloudConfigFromEnv() {
  loadStandardEnv();
  return {
    baseUrl: getEnv('ICLOUD_CALDAV_BASE_URL', 'https://caldav.icloud.com'),
    username: getRequiredEnv('ICLOUD_APPLE_ID'),
    password: getRequiredEnv('ICLOUD_APP_SPECIFIC_PASSWORD'),
    calendarName: getEnv('ICLOUD_TARGET_CALENDAR_NAME', ''),
    calendarHref: getEnv('ICLOUD_TARGET_CALENDAR_HREF', ''),
    userAgent: getEnv('ICLOUD_CALDAV_USER_AGENT', 'calendar-sync-icloud-cli/0.1'),
    timeoutMs: getIntEnv('ICLOUD_CALDAV_TIMEOUT_MS', 15000)
  };
}

function createIcloudClient(config) {
  return new CaldavClient({
    baseUrl: config.baseUrl,
    username: config.username,
    password: config.password,
    timeoutMs: config.timeoutMs,
    userAgent: config.userAgent
  });
}

async function discoverCalendars(client) {
  const discovery = await client.discoverCalendarHome();
  const calendars = await client.listCalendars(discovery.calendarHomeHref);
  return {
    discovery,
    calendars
  };
}

function pickCalendar(calendars, preferredName, preferredHref, allowReadOnly = false) {
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

  if (!calendars.length) {
    throw new Error('iCloud calendar-home-set 下未发现日历');
  }

  if (allowReadOnly) {
    return calendars[0];
  }

  const writableCandidate = calendars.find((item) => !isLikelyReadOnlyCalendar(item.displayName));
  return writableCandidate || calendars[0];
}

async function listEvents(client, calendarHref, start, end, keyword = '') {
  const events = await client.calendarQuery(calendarHref, start, end);
  const parsed = events.map(parseEvent);

  if (!keyword) {
    return parsed;
  }

  const query = String(keyword).toLowerCase();
  return parsed.filter((item) => {
    const text = `${item.summary || ''} ${item.description || ''} ${item.location || ''}`.toLowerCase();
    return text.includes(query);
  });
}

function buildNewUid() {
  const random = crypto.randomBytes(4).toString('hex');
  return `manual-${Date.now()}-${random}@calendar-sync.local`;
}

function buildEventHref(calendarHref, uid) {
  return joinHref(calendarHref, `${sanitizeForFileName(uid)}.ics`);
}

async function createEvent(client, calendarHref, input) {
  const uid = input.uid || buildNewUid();
  const href = buildEventHref(calendarHref, uid);
  const ics = buildEventIcs({
    uid,
    summary: input.summary || '',
    description: input.description || '',
    location: input.location || '',
    startAt: input.startAt,
    endAt: input.endAt,
    rrule: input.rrule || ''
  });

  const putResp = await client.put(href, ics, { ifNoneMatch: '*' });
  if (![200, 201, 204].includes(putResp.status)) {
    throw new Error(`创建事件失败: HTTP ${putResp.status}`);
  }

  return {
    uid,
    href,
    etag: putResp.headers.get('etag') || ''
  };
}

async function findEventByUid(client, calendarHref, uid, rangeStart, rangeEnd) {
  const events = await listEvents(client, calendarHref, rangeStart, rangeEnd, '');
  return events.find((item) => item.uid === uid) || null;
}

async function updateEvent(client, calendarHref, options) {
  let event = null;

  if (options.href) {
    const getResp = await client.request('GET', options.href);
    if (getResp.status !== 200) {
      throw new Error(`读取待更新事件失败: HTTP ${getResp.status}`);
    }
    event = parseEvent({
      href: options.href,
      etag: getResp.headers.get('etag') || '',
      calendarData: getResp.body
    });
  } else {
    if (!options.uid) {
      throw new Error('更新事件必须提供 uid 或 href');
    }
    event = await findEventByUid(client, calendarHref, options.uid, options.rangeStart, options.rangeEnd);
    if (!event) {
      throw new Error(`未找到要更新的事件 uid=${options.uid}`);
    }
  }

  const next = {
    uid: event.uid,
    summary: options.summary !== undefined ? options.summary : event.summary,
    description: options.description !== undefined ? options.description : event.description,
    location: options.location !== undefined ? options.location : event.location,
    startAt: options.startAt || event.startAt,
    endAt: options.endAt || event.endAt,
    rrule: options.rrule !== undefined ? options.rrule : event.rrule
  };

  if (!next.startAt || !next.endAt) {
    throw new Error('更新后的 startAt/endAt 不能为空');
  }

  const ics = buildEventIcs(next);
  const putResp = await client.put(event.href, ics, event.etag ? { ifMatch: event.etag } : {});
  if (![200, 201, 204].includes(putResp.status)) {
    throw new Error(`更新事件失败: HTTP ${putResp.status}`);
  }

  return {
    uid: next.uid,
    href: event.href,
    etag: putResp.headers.get('etag') || event.etag || ''
  };
}

async function deleteEvent(client, calendarHref, options) {
  if (options.href) {
    const resp = await client.delete(options.href, options.etag ? { ifMatch: options.etag } : {});
    if (![200, 202, 204, 404].includes(resp.status)) {
      throw new Error(`删除事件失败: HTTP ${resp.status}`);
    }
    return {
      href: options.href,
      deleted: true,
      status: resp.status
    };
  }

  if (!options.uid) {
    throw new Error('删除事件必须提供 uid 或 href');
  }

  const event = await findEventByUid(client, calendarHref, options.uid, options.rangeStart, options.rangeEnd);
  if (!event) {
    return {
      uid: options.uid,
      deleted: false,
      status: 404
    };
  }

  const resp = await client.delete(event.href, event.etag ? { ifMatch: event.etag } : {});
  if (![200, 202, 204, 404].includes(resp.status)) {
    throw new Error(`删除事件失败: HTTP ${resp.status}`);
  }

  return {
    uid: options.uid,
    href: event.href,
    deleted: true,
    status: resp.status
  };
}

module.exports = {
  buildIcloudConfigFromEnv,
  createIcloudClient,
  discoverCalendars,
  pickCalendar,
  parseDateRange,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  findEventByUid,
  parseEvent,
  buildEventIcs,
  parseIcsDateTime,
  toIcsDateTime
};

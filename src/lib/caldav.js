'use strict';

const { Buffer } = require('node:buffer');

// 统一保证 href 以 / 结尾，便于后续 URL 拼接
function ensureTrailingSlash(value) {
  if (!value) {
    return '/';
  }
  return value.endsWith('/') ? value : `${value}/`;
}

// 将绝对 URL 或相对路径统一转换为标准路径形式
function normalizeHref(value) {
  if (!value) {
    return '/';
  }

  if (/^https?:\/\//i.test(value)) {
    const parsed = new URL(value);
    return ensureTrailingSlash(parsed.pathname || '/');
  }

  const asPath = value.startsWith('/') ? value : `/${value}`;
  return ensureTrailingSlash(asPath);
}

// 组合父级 href 与子资源 href
function joinHref(baseHref, child) {
  if (/^https?:\/\//i.test(baseHref)) {
    return new URL(child, ensureTrailingSlash(baseHref)).toString();
  }

  const base = normalizeHref(baseHref);
  return new URL(child, `https://placeholder.invalid${base}`).pathname;
}

// XML 文本解码（包含常见命名实体和数字实体）
function xmlDecode(value) {
  if (!value) {
    return '';
  }
  const decoded = value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  return decoded
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function firstTagText(xml, localTagName) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localTagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${localTagName}>`,
    'i'
  );
  const match = xml.match(re);
  if (!match) {
    return '';
  }
  return xmlDecode(match[1].trim());
}

function findTagBlock(xml, localTagName) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localTagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${localTagName}>`,
    'i'
  );
  const match = xml.match(re);
  return match ? match[1] : '';
}

function hasTag(xml, localTagName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${localTagName}\\b[^>]*/?>`, 'i');
  return re.test(xml);
}

function extractBlocks(xml, localTagName) {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_-]+:)?${localTagName}\\b[^>]*>[\\s\\S]*?<\\/(?:[A-Za-z0-9_-]+:)?${localTagName}>`,
    'gi'
  );
  return xml.match(re) || [];
}

function parseMultistatus(xml) {
  return extractBlocks(xml, 'response').map((responseXml) => {
    const href = firstTagText(responseXml, 'href');
    const propstatBlocks = extractBlocks(responseXml, 'propstat');

    let displayName = '';
    let etag = '';
    let calendarData = '';
    let currentUserPrincipalHref = '';
    let calendarHomeSetHref = '';
    let isCalendar = false;

    for (const propstat of propstatBlocks) {
      const status = firstTagText(propstat, 'status');
      if (!status.includes(' 200 ')) {
        continue;
      }

      const prop = findTagBlock(propstat, 'prop');
      if (!prop) {
        continue;
      }

      if (!displayName) {
        displayName = firstTagText(prop, 'displayname');
      }
      if (!etag) {
        etag = firstTagText(prop, 'getetag');
      }
      if (!calendarData) {
        calendarData = firstTagText(prop, 'calendar-data');
      }

      if (!currentUserPrincipalHref) {
        const currentUserPrincipalBlock = findTagBlock(prop, 'current-user-principal');
        if (currentUserPrincipalBlock) {
          currentUserPrincipalHref = firstTagText(currentUserPrincipalBlock, 'href');
        }
      }

      if (!calendarHomeSetHref) {
        const calendarHomeSetBlock = findTagBlock(prop, 'calendar-home-set');
        if (calendarHomeSetBlock) {
          calendarHomeSetHref = firstTagText(calendarHomeSetBlock, 'href');
        }
      }

      if (!isCalendar) {
        const resourceTypeBlock = findTagBlock(prop, 'resourcetype');
        if (resourceTypeBlock && hasTag(resourceTypeBlock, 'calendar')) {
          isCalendar = true;
        }
      }
    }

    return {
      href,
      displayName,
      etag,
      calendarData,
      currentUserPrincipalHref,
      calendarHomeSetHref,
      isCalendar
    };
  });
}

function toDavDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid date: ${input}`);
  }

  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}` +
    `${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function unfoldIcs(value) {
  return value.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseIcsField(ics, fieldName) {
  const text = unfoldIcs(ics);
  const re = new RegExp(`^${fieldName}(?:;[^:]*)?:(.*)$`, 'mi');
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

function sanitizeForFileName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 180);
}

class CaldavClient {
  constructor(options) {
    const { baseUrl, username, password, timeoutMs = 15000, userAgent = 'calendar-sync/0.1' } = options;

    if (!baseUrl) {
      throw new Error('Missing baseUrl');
    }
    if (!username) {
      throw new Error('Missing username');
    }
    if (!password) {
      throw new Error('Missing password');
    }

    // 兼容未带协议头的地址（例如 calendar.dingtalk.com）
    const rawBase = String(baseUrl).trim();
    const withProtocol = /^https?:\/\//i.test(rawBase) ? rawBase : `https://${rawBase}`;
    const parsedBase = new URL(withProtocol);
    const normalizedPath = normalizeHref(parsedBase.pathname || '/');

    this.baseUrl = `${parsedBase.origin}${normalizedPath}`.replace(/\/$/, '');
    this.baseResolveUrl = `${this.baseUrl}/`;
    this.discoveryHref = normalizedPath;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.userAgent = userAgent;

    this.authHeader = `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`;
  }

  async request(method, href, { headers = {}, body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const targetUrl = new URL(href, this.baseResolveUrl).toString();

    try {
      const response = await fetch(targetUrl, {
        method,
        headers: {
          Authorization: this.authHeader,
          'User-Agent': this.userAgent,
          ...headers
        },
        body,
        signal: controller.signal,
        redirect: 'follow'
      });

      return {
        ok: response.ok,
        status: response.status,
        headers: response.headers,
        body: await response.text(),
        url: targetUrl
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async propfind(href, xmlBody, depth = '0') {
    return this.request('PROPFIND', href, {
      headers: {
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: xmlBody
    });
  }

  async report(href, xmlBody, depth = '1') {
    return this.request('REPORT', href, {
      headers: {
        Depth: depth,
        'Content-Type': 'application/xml; charset=utf-8'
      },
      body: xmlBody
    });
  }

  async put(href, icsBody, opts = {}) {
    const headers = {
      'Content-Type': 'text/calendar; charset=utf-8'
    };
    if (opts.ifMatch) {
      headers['If-Match'] = opts.ifMatch;
    }
    if (opts.ifNoneMatch) {
      headers['If-None-Match'] = opts.ifNoneMatch;
    }

    return this.request('PUT', href, {
      headers,
      body: icsBody
    });
  }

  async delete(href, opts = {}) {
    const headers = {};
    if (opts.ifMatch) {
      headers['If-Match'] = opts.ifMatch;
    }

    return this.request('DELETE', href, {
      headers
    });
  }

  // 兼容不同服务端入口：先试用户配置地址，再试标准发现路径
  async discoverCalendarHome() {
    const principalBody =
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
      `<d:propfind xmlns:d="DAV:">\n` +
      `  <d:prop>\n` +
      `    <d:current-user-principal />\n` +
      `  </d:prop>\n` +
      `</d:propfind>`;

    const candidates = [];
    const pushCandidate = (href) => {
      if (href && !candidates.includes(href)) {
        candidates.push(href);
      }
    };

    pushCandidate(this.discoveryHref);
    pushCandidate('/.well-known/caldav');
    pushCandidate('/dav/principals/');

    let principalHref = '';
    const errors = [];

    for (const candidate of candidates) {
      const principalResp = await this.propfind(candidate, principalBody, '0');
      if (![200, 207].includes(principalResp.status)) {
        errors.push(`${candidate}:HTTP ${principalResp.status}`);
        continue;
      }

      const principalItems = parseMultistatus(principalResp.body);
      principalHref =
        principalItems.find((item) => item.currentUserPrincipalHref)?.currentUserPrincipalHref ||
        principalItems.find((item) => item.href)?.href;

      if (principalHref) {
        break;
      }
      errors.push(`${candidate}:no-principal-href`);
    }

    if (!principalHref) {
      throw new Error(`Cannot discover current-user-principal href, attempts=${errors.join('; ')}`);
    }

    const homeResp = await this.propfind(
      principalHref,
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
        `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\n` +
        `  <d:prop>\n` +
        `    <c:calendar-home-set />\n` +
        `  </d:prop>\n` +
        `</d:propfind>`,
      '0'
    );

    if (![200, 207].includes(homeResp.status)) {
      throw new Error(`PROPFIND calendar-home-set failed: HTTP ${homeResp.status}`);
    }

    const homeItems = parseMultistatus(homeResp.body);
    const calendarHomeHref = homeItems.find((item) => item.calendarHomeSetHref)?.calendarHomeSetHref;

    if (!calendarHomeHref) {
      throw new Error('Cannot discover calendar-home-set href');
    }

    return {
      principalHref,
      calendarHomeHref
    };
  }

  async listCalendars(calendarHomeHref) {
    const resp = await this.propfind(
      calendarHomeHref,
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
        `<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\n` +
        `  <d:prop>\n` +
        `    <d:displayname />\n` +
        `    <d:resourcetype />\n` +
        `  </d:prop>\n` +
        `</d:propfind>`,
      '1'
    );

    if (![200, 207].includes(resp.status)) {
      throw new Error(`PROPFIND list calendars failed: HTTP ${resp.status}`);
    }

    return parseMultistatus(resp.body)
      .filter((item) => item.href)
      .filter((item) => item.isCalendar)
      .filter((item) => normalizeHref(item.href) !== normalizeHref(calendarHomeHref));
  }

  async calendarQuery(calendarHref, rangeStart, rangeEnd) {
    const start = toDavDateTime(rangeStart);
    const end = toDavDateTime(rangeEnd);

    const resp = await this.report(
      calendarHref,
      `<?xml version="1.0" encoding="utf-8" ?>\n` +
        `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">\n` +
        `  <d:prop>\n` +
        `    <d:getetag />\n` +
        `    <c:calendar-data />\n` +
        `  </d:prop>\n` +
        `  <c:filter>\n` +
        `    <c:comp-filter name="VCALENDAR">\n` +
        `      <c:comp-filter name="VEVENT">\n` +
        `        <c:time-range start="${start}" end="${end}" />\n` +
        `      </c:comp-filter>\n` +
        `    </c:comp-filter>\n` +
        `  </c:filter>\n` +
        `</c:calendar-query>`,
      '1'
    );

    if (![200, 207].includes(resp.status)) {
      throw new Error(`REPORT calendar-query failed: HTTP ${resp.status}`);
    }

    return parseMultistatus(resp.body)
      .filter((item) => item.href && item.calendarData)
      .map((item) => ({
        href: item.href,
        etag: item.etag,
        uid: parseIcsField(item.calendarData, 'UID'),
        summary: parseIcsField(item.calendarData, 'SUMMARY'),
        calendarData: item.calendarData
      }));
  }
}

module.exports = {
  CaldavClient,
  ensureTrailingSlash,
  normalizeHref,
  joinHref,
  toDavDateTime,
  parseIcsField,
  sanitizeForFileName
};

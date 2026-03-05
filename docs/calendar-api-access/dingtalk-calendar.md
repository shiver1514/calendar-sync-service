# 钉钉（日历）API 获取方式

最后更新：2026-03-05

## 1. 官方入口

1. 钉钉开发者文档入口：https://developers.dingtalk.com/document
2. CalDAV 标准协议（RFC 4791）：https://www.rfc-editor.org/rfc/rfc4791
3. 钉钉文档分享页（你提供的参考链接，可能需要登录后查看正文）：
   - https://alidocs.dingtalk.com/i/p/Y7kmbokZp3pgGLq2/docs/jkB7yl4ZK3vV6qvBNMZgWPMX2O6oxqw0

## 2. 当前接入结论（基于公开资料检索 + 现有工程实践）

1. 本工程当前采用 CalDAV 方式接入钉钉日历。
2. 配置核心为：
   - `DINGTALK_CALDAV_BASE_URL`
   - `DINGTALK_CALDAV_USERNAME`
   - `DINGTALK_CALDAV_PASSWORD`
   - `DINGTALK_CALDAV_SOURCE_CALENDAR_NAMES/HREFS`（来源可多选）
3. 通过 CalDAV discovery + calendar-home + calendar-query 获取事件。

说明（推断结论）：

1. 截至 2026-03-05，在公开可检索的钉钉开发者文档中，未检索到稳定公开的“钉钉日历 REST API 全量目录”页面。
2. 因此当前工程继续采用标准 CalDAV 协议路径更稳妥。

## 3. 后续演进建议

1. 持续关注钉钉开放平台文档，若出现官方日历 REST API 再评估切换。
2. 即使未来引入 REST，也建议保留 CalDAV connector 作为兼容后备。

# Google Calendar API 获取方式

最后更新：2026-03-05

## 1. 官方接入入口

1. 快速开始（含开通步骤）：https://developers.google.com/workspace/calendar/api/quickstart
2. API 概览：https://developers.google.com/workspace/calendar/api/guides/overview
3. API 参考（calendarList.list）：https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
4. API 参考（events.list）：https://developers.google.com/workspace/calendar/api/v3/reference/events/list

## 2. 获取调用凭据（OAuth 2.0）

按官方 Quickstart 的流程：

1. 创建或选择 Google Cloud Project。
2. 启用 Google Calendar API。
3. 配置 OAuth consent screen。
4. 创建 OAuth Client（Web / Desktop / Server 按场景选择）。
5. 完成用户授权后拿到 access token / refresh token。

## 3. 最小可用接口建议

1. 读日历列表：`calendarList.list`
2. 读事件列表：`events.list`
3. 写入事件（后续）：`events.insert` / `events.update`

## 4. 对接注意事项

1. 先做只读接入，验证时区、分页、增量同步策略后再开写入。
2. 统一将 token 刷新失败、配额失败、429/5xx 重试记录到现有日志体系。

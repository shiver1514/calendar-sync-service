# Microsoft 365 / Outlook Calendar API 获取方式

最后更新：2026-03-05

## 1. 官方接入入口

1. 应用注册（Entra）：https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app
2. Graph 认证概览：https://learn.microsoft.com/en-us/graph/auth/auth-concepts
3. 列出日历：https://learn.microsoft.com/en-us/graph/api/user-list-calendars?view=graph-rest-1.0
4. 读取日程窗口：https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0
5. 创建事件：https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0

## 2. 获取调用凭据（OAuth 2.0）

1. 在 Microsoft Entra 注册应用。
2. 按场景配置 Redirect URI（Web/SPA/Native）。
3. 在 Graph 中申请 Calendar 相关权限（Delegated 或 Application）。
4. 完成管理员同意（若租户策略要求）。
5. 通过 OAuth 2.0 获取 access token 后调用 Graph API。

## 3. 最小可用接口建议

1. 读日历列表：`GET /me/calendars`
2. 读时间窗事件：`GET /me/calendarView?startDateTime=...&endDateTime=...`
3. 写入事件：`POST /me/events`

## 4. 对接注意事项

1. 权限选择应最小化，优先只读权限验证后再申请写权限。
2. 统一处理分页、时区和 delta/incremental 同步策略，避免重复拉全量。

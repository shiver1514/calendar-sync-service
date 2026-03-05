# iCloud 日历 API 获取方式（CalDAV）

最后更新：2026-03-05

## 1. 官方接入入口

1. 生成 App 专用密码：https://support.apple.com/zh-cn/102654
2. 使用 Apple 账户访问第三方应用与网站：https://support.apple.com/zh-cn/102379
3. CalDAV 标准协议（RFC 4791）：https://www.rfc-editor.org/rfc/rfc4791

## 2. 获取调用凭据

1. 准备 Apple Account。
2. 在 Apple 账户安全设置中生成 App 专用密码（用于第三方客户端访问日历数据）。
3. 在客户端/服务端使用 Apple 账号 + App 专用密码发起 CalDAV 认证。

## 3. 本工程落地方式

1. 协议：CalDAV。
2. 配置项：
   - `ICLOUD_APPLE_ID`
   - `ICLOUD_APP_SPECIFIC_PASSWORD`
   - `ICLOUD_TARGET_CALENDAR_NAME` 或 `ICLOUD_TARGET_CALENDAR_HREF`（可留空自动选可写日历）
3. 服务端通过 CalDAV discovery + calendar-home 获取可访问日历，再执行事件读写。

## 4. 对接注意事项

1. 先验证只读拉取，再开启写入。
2. App 专用密码应通过环境变量或密钥管理，不应写入代码仓库。

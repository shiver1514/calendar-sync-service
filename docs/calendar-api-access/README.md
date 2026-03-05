# 日历 API 获取方式总览

最后更新：2026-03-05

## 1. 目的

本目录用于沉淀各日历/日程平台的 API 接入方式，重点回答三件事：

1. 去哪里申请/开通接口权限。
2. 用什么鉴权方式拿到可调用凭据。
3. 首批建议调用哪些“最小可用”接口。

## 2. 平台清单

1. [钉钉（日历）](./dingtalk-calendar.md)
2. [iCloud（日历）](./icloud-calendar.md)
3. [Google Calendar](./google-calendar.md)
4. [Microsoft 365 / Outlook Calendar](./microsoft-calendar.md)
5. [腾讯会议（会议日程）](./tencent-meeting.md)

## 3. 快速对比

| 平台 | 接口形态 | 鉴权方式 | 官方入口 |
| --- | --- | --- | --- |
| 钉钉（日历） | CalDAV（当前工程实践） | 账号密码（CalDAV）/开放平台应用鉴权（非日历场景） | https://developers.dingtalk.com/document |
| iCloud（日历） | CalDAV | Apple Account + App 专用密码 | https://support.apple.com/zh-cn/102654 |
| Google Calendar | REST | OAuth 2.0（Google Cloud） | https://developers.google.com/workspace/calendar/api/quickstart |
| Microsoft Calendar | REST (Microsoft Graph) | OAuth 2.0（Entra 应用注册） | https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app |
| 腾讯会议 | REST | OAuth 2.0 或 JWT | https://meeting.tencent.com/support-topic?type=2&id=2095 |

## 4. 适配建议

1. 若平台支持 CalDAV（如 iCloud、钉钉当前实践），优先复用现有 CalDAV 同步链路。
2. 若平台提供 REST（Google、Microsoft、腾讯会议），建议新增独立 connector，并统一接入当前日志/重试/限流框架。
3. 新增平台时先实现“读取能力”再做“写入能力”，优先保障可观测性和回滚能力。

# 腾讯会议 API 获取方式（会议日程）

最后更新：2026-03-05

## 1. 官方接入入口

1. 开放平台总览：https://meeting.tencent.com/support-topic?type=2&id=2095
2. 开发者指引（含 Host 与认证说明）：https://meeting.tencent.com/support-topic?type=2&id=1904
3. 鉴权方式说明（OAuth 2.0 / JWT）：https://meeting.tencent.com/support-topic?type=2&id=1931
4. 常用会议接口示例集合：https://meeting.tencent.com/support-topic?type=2&id=1934

## 2. 获取调用凭据

按官方文档，腾讯会议开放平台支持两种方式：

1. OAuth 2.0（第三方应用授权）。
2. JWT（企业内部应用，服务端签名调用）。

建议：

1. 多租户/第三方集成优先 OAuth 2.0。
2. 企业内系统优先 JWT，便于服务端自动化调用。

## 3. 最小可用接口建议

1. 读取用户会议列表：`GET /v1/users/{userid}/meetings`
2. 读取会议详情：`GET /v1/meetings/{meetingid}`
3. 创建会议（后续）：`POST /v1/meetings`

文档示例 Host：`https://api.meeting.qq.com`

## 4. 对接注意事项

1. 会议接口与“日历事件”模型不完全一致，建议先做字段映射层（时间、组织者、参会人、会议号）。
2. 先做“读”再做“写/改/删”，并将鉴权失败与限流信息接入现有分级日志。

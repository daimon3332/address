# Address API 文档

[English](API.md) · [简体中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

公开 API 位于 `/api/v1`，全部公开端点使用 `GET` 并返回 JSON。服务启动后，可在 `/en/api/` 或 `/zh-CN/api/` 查看交互参数说明。

## 基础地址

```text
https://YOUR_DOMAIN.example/api/v1
```

本地开发默认使用 `http://127.0.0.1:8787/api/v1`。

## 公开端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/health` | API 基础健康检查 |
| `GET` | `/countries` | 国家注册表、同步数量和住宅模式可用性 |
| `GET` | `/client-context` | 将请求 IP 或指定 IP 解析到支持地区 |
| `GET` | `/locations/search` | 搜索州省、城市和邮编选项 |
| `GET` | `/generate` | 生成地址和相关测试资料 |
| `GET` | `/data-health` | 检查地址池覆盖和就绪状态 |

## 健康检查

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/health
```

```json
{"status":"ok"}
```

## 国家注册表

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/countries
```

响应格式为 `{ "data": [...] }`。每个国家包含代码、本地化名称、支持的筛选条件、地址数量、住宅数量、住宅模式可用性和 `generationMode`。未连接数据库时，数量为 `null`。

## 客户端地区

解析当前请求：

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/client-context
```

解析指定 IPv4 或 IPv6：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/client-context?ip=8.8.8.8"
```

响应可能包含 `publicIp`、国家、州省、城市、邮编、纬度和经度。只有受控反向代理会覆盖转发 IP 请求头时，才配置 `TRUST_PROXY=true`。

## 地区搜索

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 项目支持的国家代码 |
| `field` | `city` | `region`、`city` 或 `postcode` |
| `q` | 空 | 搜索文本 |
| `region` | 空 | 上级州省文本 |
| `regionId` | 空 | 稳定州省 ID |
| `cityId` | 空 | 稳定城市 ID |
| `residential` | `false` | 只返回具备住宅覆盖的选项 |
| `cursor` | 空 | 上一页返回的分页游标 |
| `limit` | `100` | 请求页大小 |

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/locations/search?country=CN&field=city&q=南京"
```

响应包含 `regions`、`cities`、`postcodes` 和 `matches`。连接地区目录数据库后，还会提供 `total`、`nextCursor` 和 `source`。

## 地址与资料生成

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 国家代码；IP 模式成功解析国家时忽略 |
| `mode` | 普通模式 | 使用 `ip-region` 开启 IP 就近生成 |
| `ip` | 请求 IP | `mode=ip-region` 时使用的指定 IP |
| `residential` | 国家能力 | `true` 或 `false` |
| `region`、`city`、`postcode` | 空 | 可读地区筛选 |
| `regionId`、`cityId`、`postcodeId` | 空 | 稳定目录 ID |
| `q` | 空 | 自由文本地区提示 |
| `strategy` | `random` | `random` 或 `instant` |
| `seed` | 自动 UUID | 确定性生成种子 |
| `requestId` | 自动 UUID | 调用方关联 ID |
| `live` | `false` | 单次请求启用已配置实时服务 |

美国普通地址：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=US&residential=false"
```

中国城市筛选：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?country=CN&city=南京&residential=false"
```

IP 就近生成：

```bash
curl -fsS "https://YOUR_DOMAIN.example/api/v1/generate?mode=ip-region&ip=8.8.8.8"
```

响应外层为 `{ "data": { ... } }`。生成数据包含请求 ID、模式、国家、筛选、回退等级、尝试的数据源和耗时；其中 `result` 包含地址三语变体、邮政格式、来源证据、合成测试资料、沙盒银行卡、工作、财务、网络字段以及 Google/高德地图链接。

需要测试资料稳定复现时传入 `seed`。地址源同步后，底层地址池仍可能变化。

## 数据健康

```bash
curl -fsS https://YOUR_DOMAIN.example/api/v1/data-health
```

该端点返回配置国家、无效配置、热点池覆盖、低水位槽位和就绪状态，适合监控和部署检查。

## 错误格式

```json
{
  "error": {
    "code": "INVALID_COUNTRY",
    "message": "Unknown country code: ZZ"
  }
}
```

常见代码包括 `INVALID_COUNTRY`、`INVALID_FIELD`、`INVALID_LOCATION`、`INVALID_RESIDENTIAL`、`IP_LOCATION_UNAVAILABLE`、`NO_POOL_COVERAGE` 和 IP 参数校验错误。调用方应判断 `error.code`，不要依赖界面翻译文本。

## 同步管理 API

同步服务默认只监听 `127.0.0.1:8791`。任务端点要求 `Authorization: Bearer SYNC_ADMIN_TOKEN`。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/healthz` | `8791` 端口的本地同步服务健康检查 |
| `POST` | `/api/v1/sync/jobs` | 创建 `initial` 或 `manual` 任务 |
| `GET` | `/api/v1/sync/jobs/latest` | 查询最近任务 |
| `GET` | `/api/v1/sync/jobs/{id}` | 查询指定任务 |

```bash
curl -fsS -X POST http://127.0.0.1:8791/api/v1/sync/jobs \
  -H "Authorization: Bearer $SYNC_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"manual","shards":["CN"]}'
```

任务接受后返回 HTTP `202`、任务对象和 `Location` 请求头。已有任务运行时返回 `409`；JSON、模式或分片标识无效时返回 `400`。

主 API 默认隐藏 `/sync-control/*`。保持 `SYNC_CONTROL_PUBLIC=false`，通过本地端口或额外的私有访问边界进行管理。

## CORS 与隐私

- 生产环境将 `ALLOWED_ORIGIN` 设置为公开 HTTPS 来源。
- API Key 和 `SYNC_ADMIN_TOKEN` 不进入查询参数、浏览器代码、截图或日志。
- 生成的个人资料和银行卡号是测试数据，不对应真实个人或支付账户。
- 普通地址生成读取本地 SQLite；只有模式配置或 `live=true` 明确启用时才调用实时服务。

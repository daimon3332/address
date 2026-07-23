# Address 部署文档

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

本文说明私密配置、首次数据同步、VPS 部署、反向代理、升级与备份。生产脚本面向 Linux AMD64 和 ARM64，全部运行状态位于 `/root/address`。

## 运行要求

- Linux AMD64 或 ARM64 VPS
- 最低 4 GB 内存；完整首次导入建议 8 GB
- 应用卷至少预留 60 GiB
- `git`、`curl`、`ca-certificates`、`xz-utils`、Python 3 和 `venv`
- 已解析到 VPS 的域名，以及支持 HTTPS 的反向代理

安装脚本会下载项目固定的 Node.js 版本，无需在系统中预装 Node.js。

## 容量估算

以下数据于 2026-07-23、提交 `084805e`、27 国同步完成后实测：

| 内容 | 实测值 |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| 活跃 SQLite WAL | 0.68 GiB |
| 完整 `data/` 目录 | 7.89 GiB |
| 当前有效地址 | 722,950 条 |
| 中国小区记录 | 174,327 条 |

首次导入会临时保留源文件和中间结果，历史实测峰值约 11.2 GiB。上游版本、WAL 活跃度和可选保留设置会改变实际大小。建议 60 GiB 是为了给同步、备份和恢复留出余量：影子扩容在 40 GiB 停止，写入会在达到 45 GiB 前中止，项目绝对上限为 50 GiB。

## API Key 与密钥

离线地址池、Overture/Geofabrik 同步、SQLite 生成、OpenCC、拼音转换、Google 地图链接和高德网页链接均不需要第三方 API Key。

| 变量 | 是否必需 | 功能 | 获取方式 |
|---|---|---|---|
| `AMAP_API_KEY` | 可选 | 中国实时 POI 查询 | 按[高德官方文档](https://lbs.amap.com/api/webservice/guide/create-project/get-key)创建“Web 服务”类型 Key。 |
| `GEOAPIFY_API_KEY` | 可选 | 中国以外实时地理编码及部分反向本地化 | 按 [Geoapify 官方指南](https://www.geoapify.com/get-started-with-maps-api/)创建项目和 Key。 |
| `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET` | 成对可选 | 在线翻译备用通道 | 在[有道智云](https://ai.youdao.com/)创建自然语言翻译应用。 |
| `ONEMAP_ACCESS_TOKEN` | 可选 | 新加坡普通地址实时查询 | 按 [OneMap 认证文档](https://www.onemap.gov.sg/apidocs/authentication)获取；Token 到期后需要刷新。 |
| `SYNC_ADMIN_TOKEN` | VPS 必需 | 保护同步控制写操作 | 在本机随机生成，不属于第三方凭据。 |

保留 `LIVE_API_MODES=ip-region` 可把实时服务限制在 IP 就近生成；普通生成只查询本地数据库。除非明确需要在线翻译，否则保留 `GOOGLE_TRANSLATION_ENABLED=false`。

## 密钥保护

仓库只提供占位模板：

| 模板 | 用途 |
|---|---|
| `.env.example` | 本地 WebUI 与 API 开发 |
| `server/sync/.env.example` | 同步参数参考 |
| `ops/address.env.example` | VPS 组合运行配置 |
| `ops/deploy.env.example` | 私密 SSH 部署配置 |

`.env`、`.deploy.env`、数据库、日志、运行状态、缓存、私钥和 `plan.md` 均被 Git 忽略。真实值只写入被忽略的私密文件，不要放入浏览器变量、源码、截图、Issue、命令输出或 CI 日志。

VPS 使用权限为 `600` 的运行配置：

```bash
mkdir -p /root/address/runtime
cp /root/address/app/ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
```

生成同步 Token，过程中不输出具体值：

```bash
token="$(openssl rand -hex 32)"
sed -i "s/GENERATE_A_RANDOM_VALUE/$token/" /root/address/runtime/address.env
unset token
chmod 600 /root/address/runtime/address.env
```

至少需要替换 `YOUR_DOMAIN.example`、生成 `SYNC_ADMIN_TOKEN` 并检查 `TRUST_PROXY`。仅在启用对应功能时填写可选服务凭据。

## 运行配置

| 变量 | 生产默认值 | 作用 |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `/api` | 浏览器使用的 API 前缀 |
| `API_HOST` | `127.0.0.1` | Hono 监听地址 |
| `API_PORT` | `8787` | Hono 监听端口 |
| `STATIC_ROOT` | `/root/address/app/dist` | Astro 构建结果 |
| `ADDRESS_DATABASE_PATH` | `/root/address/data/address.sqlite` | SQLite 数据库 |
| `ALLOWED_ORIGIN` | 公开 HTTPS 来源 | CORS 白名单 |
| `TRUST_PROXY` | 代理后为 `true` | 是否信任转发的客户端 IP 请求头 |
| `SYNC_HOST` | `127.0.0.1` | 同步管理监听地址 |
| `SYNC_PORT` | `8791` | 同步管理端口 |
| `SYNC_CONTROL_PUBLIC` | `false` | 禁止主 API 公开同步管理入口 |
| `SYNC_UTC_HOUR` | `3` | 每日调度检查时间，UTC 小时 |

只有受控反向代理会覆盖转发 IP 请求头时才启用 `TRUST_PROXY`。端口 `8791` 始终保持私有。

## 首次部署

### 1. 准备 VPS

```bash
apt-get update
apt-get install -y git curl ca-certificates xz-utils python3 python3-venv nginx
mkdir -p /root/address
git clone https://github.com/daimon3332/address.git /root/address/app
cd /root/address/app
./ops/install-runtime.sh
```

`install-runtime.sh` 会把固定 Node.js、Python 虚拟环境、Python 依赖和 npm 依赖安装到 `/root/address` 内。

### 2. 创建私密配置

```bash
mkdir -p /root/address/runtime
cp ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
editor /root/address/runtime/address.env
```

填写 `ALLOWED_ORIGIN=https://YOUR_DOMAIN.example`，生成 `SYNC_ADMIN_TOKEN`，然后只添加需要的可选服务凭据。

### 3. 构建 WebUI

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
npm run build
```

### 4. 初始化全部国家

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

任务在后台执行，每个国家独立验证和发布，重启后可复用已完成缓存。耗时取决于 VPS CPU、磁盘、网络和上游状态。全部成功后自动启动 API 与调度服务。

### 5. 验证服务

```bash
/root/address/app/ops/status.sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/data-health
```

## Nginx 与 HTTPS

沿用现有证书流程，把公开域名代理到 API 进程：

```nginx
server {
    listen 80;
    server_name YOUR_DOMAIN.example;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

防火墙只公开 HTTP/HTTPS，API 和同步管理均监听回环地址。TLS 生效后，`ALLOWED_ORIGIN` 使用完全一致的 HTTPS 来源。

## 同步与运维

- 首次任务处理 27 国，支持断点续跑。
- 稳态调度在每天 03:00 UTC 检查，每天最多更新一个到期国家。
- 国家同步成功后，下一周期为 30 天。
- 新快照失败时继续保留旧 active 数据。
- 发布成功后默认删除原始源文件，除非明确开启保留。

```bash
# 服务启停与状态
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# 创建 SQLite 一致性备份
/root/address/app/ops/backup.sh

# 恢复 /root/address/backups 下的备份
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.sqlite
```

项目使用进程 supervisor，不安装 systemd 服务或 cron。需要 VPS 重启后自动启动时，把 `ops/start.sh` 接入主机已有的启动机制。

## 部署后续提交

在开发机执行：

```bash
cp ops/deploy.env.example .deploy.env
chmod 600 .deploy.env
editor .deploy.env
bash ops/deploy.sh --dist
```

部署脚本会归档当前 `HEAD`，通过 SSH 上传，保留 VPS 数据库、私密运行配置和服务器黑名单，重启 supervisor 并执行健康检查。纯文档变更可使用 `--no-restart`。

## 生产检查清单

- DNS 与 HTTPS 已生效。
- `ALLOWED_ORIGIN` 是完全一致的公开 HTTPS 来源。
- `TRUST_PROXY=true` 只用于受控代理后方。
- `SYNC_ADMIN_TOKEN` 随机且私密，Git 历史中没有具体值。
- `SYNC_CONTROL_PUBLIC=false`，端口 `8791` 未公开。
- 可选服务 Key 已在服务商侧设置限制和用量告警。
- 数据库初始化后，`npm run check:production` 通过。
- 已生成当前备份并验证恢复流程。
- 应用卷至少 60 GiB，并启用剩余空间监控。

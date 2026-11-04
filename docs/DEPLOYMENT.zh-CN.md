# 部署

[English](DEPLOYMENT.md) · 简体中文 · [繁體中文](DEPLOYMENT.zh-TW.md)

Address 只支持一种生产部署方式：**Docker Compose**。应用、PostgreSQL、数据库迁移和自动同步全部由仓库根目录的 `docker-compose.yml` 管理。

## 环境要求

| 项目 | 要求 |
|---|---|
| 系统 | Linux，AMD64 或 ARM64 |
| 运行时 | Docker Engine 24+、Docker Compose v2 |
| 内存 | 至少 4 GB；首次导入美国、法国等大型国家建议 8 GB 以上 |
| 磁盘 | 27 个国家完整同步后数据库约 15 GB，另需同步暂存与备份空间 |
| 网络 | 能访问 Docker Hub 与各数据源；对外服务需要 HTTPS 反向代理 |

## 安装

```bash
mkdir address && cd address
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/daimon3332/address/main/docker-compose.yml
docker compose up -d
```

查看状态：

```bash
docker compose ps                                  # 所有服务应为 running / healthy
curl -fsS http://127.0.0.1:8787/api/v1/ready       # 返回 {"status":"ready"} 即可使用
```

浏览器打开 `http://127.0.0.1:8787/admin/`，用初始密码 `admin` 登录并按提示修改密码。

## 服务组成

| 服务 | 作用 | 生命周期 |
|---|---|---|
| `bootstrap` | 生成并校验内部密钥 | 完成后退出 |
| `postgres` | PostgreSQL 16，只在内部网络可见 | 常驻 |
| `migrate` | 每次启动前执行数据库迁移 | 完成后退出 |
| `api` | 网页与 API，默认监听 `127.0.0.1:8787` | 常驻 |
| `sync` | 自动同步服务 | 常驻 |
| `credential-broker` | 平台密钥加密、轮换与额度协调 | 常驻 |

`sync` 首次启动需要加载行政目录，可能需要几分钟才会变为 healthy，期间不影响网页和 API。

## 目录结构

所有数据都保存在 Compose 文件所在目录，整体迁移或备份时直接打包该目录即可。

```text
address/
├── docker-compose.yml
├── .env                 # 可选，覆盖默认配置
├── data/
│   ├── secrets/         # 自动生成的内部密钥（务必备份）
│   ├── postgres/        # 数据库文件
│   └── address/         # 同步暂存
├── runtime/             # 同步运行状态
└── backups/             # 建议的备份位置
```

不要让两个 PostgreSQL 容器同时挂载同一个 `data/postgres`。

## 配置

默认配置可直接运行。需要调整时，在 Compose 文件旁创建 `.env`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADDRESS_IMAGE` | `daimon23/address:latest` | 应用镜像，可固定为某个版本标签 |
| `API_BIND_ADDRESS` | `127.0.0.1` | API 监听地址；直接对外时改为 `0.0.0.0`（不推荐） |
| `API_PORT` | `8787` | API 端口 |
| `ALLOWED_ORIGINS` | 空 | 允许跨域访问的来源，多个以逗号分隔 |
| `TRUST_PROXY` | `false` | 位于反向代理之后时设为 `true`，用于获取真实客户端 IP |
| `COOKIE_SECURE` | `false` | 使用 HTTPS 时设为 `true` |
| `ADMIN_INITIAL_PASSWORD` | `admin` | 首次启动时的管理员密码，仅首次生效 |
| `FRONTEND_INITIAL_PASSWORD` | 空 | 首次启动时的前端访问密码，留空表示不启用 |
| `TRANSLATION_BACKFILL_ENABLED` | `true` | 是否在后台为已发布地址补全多语言翻译 |

修改后执行 `docker compose up -d` 生效。前端密码、管理员密码、API 令牌、平台密钥和同步目标都在管理后台中设置，不需要写进 `.env`。

## 反向代理

正式环境请只对外开放 80/443 端口，由反向代理转发到 `127.0.0.1:8787`，并在 `.env` 中设置：

```dotenv
ALLOWED_ORIGINS=https://address.example.com
TRUST_PROXY=true
COOKIE_SECURE=true
```

**Caddy**（自动申请证书）：

```caddyfile
address.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

**Nginx**：

```nginx
server {
    listen 443 ssl http2;
    server_name address.example.com;

    ssl_certificate     /etc/ssl/address.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/address.example.com/privkey.pem;

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

不要对外暴露 PostgreSQL 或同步服务端口。

## 日常运维

```bash
docker compose ps                     # 服务状态
docker compose logs -f api sync       # 查看日志
docker compose restart api            # 重启单个服务
docker compose down                   # 停止（数据保留）
docker compose up -d                  # 启动
```

## 升级

```bash
# 1. 先备份（见下一节）
# 2. 拉取新镜像并重建
docker compose pull
docker compose up -d
docker compose ps
```

数据库迁移会在 `migrate` 服务中自动完成。生产蓝绿激活以 `--skip-coverage` 运行迁移，生成索引与覆盖统计由同步服务启动后在后台重建。激活在服务器端脱离会话运行并记录到 `runtime/deploy/activation-<release>.log`（退出码写入 `.exit`），SSH 断开不会中断切换。迁移仅在行政目录修正实际改动了香港地址时才重建香港生成索引并复核。激活成功后，自动删除不在保留版本内且没有容器使用的旧镜像，以及 24 小时前的构建缓存。若需要固定版本，将 `.env` 中的 `ADDRESS_IMAGE` 设为具体标签。

## 备份与恢复

备份：

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"
cp -r data/secrets backups/secrets-$(date -u +%Y%m%d)
```

恢复：

```bash
docker compose stop api sync credential-broker
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < backups/address-YYYYMMDDTHHMMSSZ.dump
docker compose up -d
```

> **`data/secrets/config_master_key` 必须与数据库备份一起保存。** 后台保存的平台密钥都用它加密，丢失后只能重新录入。

跨 PostgreSQL 主版本升级时只能使用 `pg_dump` / `pg_restore`，不能直接复用 `data/postgres`。

## 常见问题

**忘记管理员密码怎么办？**
重新生成初始密码并清除现有管理员账号，服务启动时会用新的初始密码重建管理员（新密码至少 10 位）：

```bash
docker compose stop api
rm data/secrets/admin_bootstrap_password
ADMIN_INITIAL_PASSWORD='your-new-password' docker compose run --rm bootstrap
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
DELETE FROM control.auth_identities WHERE kind = 'admin';
DELETE FROM control.auth_sessions WHERE role = 'admin';
SQL
docker compose up -d
```

**首次启动报 `service "migrate" didn't complete successfully: exit 1`？**
v2.4.0 及更早版本在空数据库上无法导入位置目录（报 `Use database.transaction() for PostgreSQL transactions`，或之后的 `Location catalog bootstrap incomplete: postcodes`）。升级到 v2.4.1 或更高版本后重新启动，目录导入会自动继续：

```bash
docker compose pull
docker compose up -d
```

**`sync` 一直显示 starting？**
`sync` 启动时要加载行政目录并校验已发布数据，数据量越大耗时越长，可能需要几分钟。用 `docker compose logs -f sync` 查看进度，日志持续输出即为正常；网页和 API 不受影响。

**某个国家长期“待补充”？**
在后台“地址数据”中打开该国家详情页，“概览”会显示当前状态和原因，例如等待额度重置、缺少平台密钥或来源已达上限。大部分国家不需要任何密钥即可同步；需要密钥的平台见 [API Key 配置](API_KEYS.zh-CN.md)。

**能否不用 Docker？**
生产环境只维护 Docker Compose 这一种方式。本地开发请参考[开发文档](DEVELOPMENT.zh-CN.md)。

## 镜像发布

推送版本标签（`v*`）时，GitHub Actions 会构建 AMD64/ARM64 镜像并发布到 Docker Hub：`daimon23/address`（版本号、`主.次` 版本和 `latest`）；推送 `main` 只运行验证。仓库需要配置 `DOCKERHUB_TOKEN` 机密（具有读写权限的 Docker Hub Access Token）。

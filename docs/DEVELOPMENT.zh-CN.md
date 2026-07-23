# Address 二次开发文档

[English](DEVELOPMENT.md) · [简体中文](DEVELOPMENT.zh-CN.md) · [繁體中文](DEVELOPMENT.zh-TW.md)

## 架构

```text
浏览器
  -> Astro 静态页面 + React WebUI
  -> Hono Node.js API
       -> SQLite WAL 地址池
       -> SQLite RTree 坐标索引
       -> 本地格式化与本地化
       -> 可选实时服务
  -> 同步 supervisor
       -> DuckDB 读取 Overture GeoParquet
       -> pyosmium 读取 Geofabrik/OSM PBF
       -> 验证并原子发布国家快照
```

普通生成查询本地 SQLite 地址池。实时服务需要通过 `LIVE_API_MODES` 或请求参数 `live=true` 显式开启。

## 目录职责

| 路径 | 职责 |
|---|---|
| `src/components/` | React WebUI 与同步管理界面 |
| `src/domain/` | 国家元数据、生成、格式化、本地化、资料与导出规则 |
| `src/pages/` | 本地化 WebUI 与 API 文档的 Astro 路由 |
| `server/api/` | Hono 应用、数据仓库与外部服务适配器 |
| `server/database/` | SQLite Schema 与迁移入口 |
| `server/sync/` | 数据源适配、ETL、调度、快照发布与同步管理 API |
| `scripts/` | 目录生成、验证、线上探测与发布审计 |
| `ops/` | Linux VPS 安装、进程、备份、恢复与部署脚本 |
| `tests/` | Vitest 单元、集成、数据质量与 UI 结构测试 |

## 本地环境

要求 Node.js 24 或更新版本。只有源数据同步需要 Python 3 和 `venv`。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

Astro 开发服务器将 `/api` 代理到 `127.0.0.1:8787` 的 Hono，将 `/sync-control` 代理到 `127.0.0.1:8791` 的本地同步服务。新迁移的数据库只有表结构，不包含地址池。

常用命令：

| 命令 | 用途 |
|---|---|
| `npm run dev` | 同时以监听模式运行 Astro 和 Hono |
| `npm run dev:web` | 只运行 Astro |
| `npm run dev:api` | 只运行 Hono |
| `npm run db:migrate` | 创建或迁移本地 SQLite Schema |
| `npm run data:regions` | 更新内置地区元数据 |
| `npm run data:catalog` | 同步位置目录 |
| `npm run data:address-pool:estimate` | 估算同步计划 |
| `npm run data:address-pool:sync:dry-run` | 只验证 ETL 计划，不发布数据 |
| `npm run data:address-pool:bootstrap` | 执行支持断点续跑的全部国家首次导入 |
| `npm run sync:serve` | 运行本地调度器与同步管理 API |

## 配置模型

把 `.env.example` 复制为被忽略的 `.env`。密钥始终留在服务端。只有明确用于 Astro 公开环境的变量才应进入浏览器构建；第三方服务 Key 和 `SYNC_ADMIN_TOKEN` 必须保留在 API 或同步进程环境中。

常规开发不需要第三方 API Key。可选实时服务参见[部署文档](DEPLOYMENT.zh-CN.md)。

## 数据库与同步

SQLite 使用 WAL 模式，保存地址、三语本地化、来源证据、国家状态和 RTree 坐标。国家发布是事务性的：候选快照通过验证后才替换 active 数据，失败的候选不会影响旧快照。

同步来源：

- Overture Maps：DuckDB 远程筛选并读取 GeoParquet。
- Geofabrik 提供的 OpenStreetMap：pyosmium 流式读取预筛选后的 PBF node 和 way。
- 本地地区与位置目录：约束选择器并验证行政区一致性。

管线会过滤机构和非地址要素、去重、检查住宅证据、验证本地化组件并执行容量门禁。API 或同步任务运行时不要手工修改 `data/address.sqlite`。

手工执行示例：

```bash
node server/sync/address-etl.mjs --initial --all
node server/sync/address-etl.mjs --daily --all
node server/sync/address-etl.mjs --manual --shard US
```

## 扩展公开 API

1. 在 `server/api/index.ts` 定义请求校验与路由。
2. 数据库访问统一放在 `server/api/repositories/`。
3. 服务商或网络逻辑放在 `server/api/services/`，并显式设置超时。
4. 沿用 `{ data: ... }` 或 `{ error: { code, message } }` 响应结构。
5. 添加 API 测试，并同步更新三语 API 文档。

公开错误使用稳定、机器可读的错误码，不要让调用方依赖本地化 UI 文案。

## 扩展国家或地址规则

国家行为涉及元数据、格式、位置选项、本地化、邮编规则、源分片计划和测试。添加国家前需要：

1. 在 `src/domain/` 定义元数据和支持的筛选项。
2. 添加地址格式与邮编规则。
3. 添加源分片并验证许可和署名元数据。
4. 分别验证普通地址与住宅证据。
5. 添加本地化、确定性、回退和邮编格式测试。
6. 只使用既有脚本重新生成目录。

生成的室内字段与合成测试资料必须始终能够和来源支持的地址组件明确区分。

## WebUI 开发

本地化页面从 `src/pages/[locale].astro` 进入并挂载 `src/components/App.tsx`。共享样式位于 `src/styles/global.css`；同步界面使用 `SyncAdmin.tsx` 和 `admin.css`。

修改结果字段时，先更新领域类型，再把生成、API 序列化、UI、导出、翻译与测试作为同一契约一起更新。保持结果区尺寸稳定，并验证英文和中文值。

## 验证与发布门禁

每次提交前运行：

```bash
npm test
npm run check
npm run build
npm run check:public
```

这些命令覆盖 Vitest、Astro 诊断、TypeScript、生产构建、忽略文件策略、必需公开文件和常见密钥形态。Linux CI 还会检查 Shell 语法并编译 Python 文件。

完整数据库同步后运行：

```bash
npm run check:production
```

该命令检查数据库完整性、必需表、国家就绪状态和容量上限。线上环境探测使用独立命令，因为它们要求已有运行中的部署。

## 贡献检查清单

- 保持改动范围清晰，不引入无关依赖或格式化变更。
- 按行为影响补充相应测试。
- 英文、简体中文和繁体中文文档同步更新。
- 真实凭据、数据库、日志、含私密数据的截图和运行状态不进入 Git。
- 除项目命令外执行 `git diff --check`。
- 修改数据管线时保留来源署名和许可。

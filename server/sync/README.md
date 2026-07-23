# 地址数据同步

同步服务使用同一 SQLite 数据库和国家级事务，不依赖容器或系统数据库。

## 运行模式

- `node server/sync/address-etl.mjs --initial --all`：断点完成 27 国首次初始化。
- `node server/sync/address-etl.mjs --daily --all`：选择失败优先或最早到期的一个国家。
- `node server/sync/address-etl.mjs --manual --shard US`：手动同步指定国家。
- `node server/sync/index.mjs`：启动每日调度和管理 API。

成功国家的 `next_sync_at` 为完成时间加 30 天。失败不会替换现有 active dataset。同步目录达到 40GB 后停止 shadow 扩容，预计达到 45GB 时中止写入。

## 数据处理

Overture 通过 DuckDB 远程读取 GeoParquet 并按国家、城市限量。Geofabrik PBF 通过 pyosmium `FileProcessor` 在 C++ 层预过滤并流式读取 node/way；初始化时可复用一天内已完整下载的旧版本，避免跨日重复下载，成功发布后删除原始文件。两类来源都经过机构过滤、去重、住宅证据校验和三语组件校验，再在单个国家事务中发布。Geofabrik 国家额外维护最多 1,000 条明确住宅 building reservoir，并以每城市约 10 条的分层样本扩大地区覆盖。

管理接口要求 `Authorization: Bearer <SYNC_ADMIN_TOKEN>`：

```text
POST /api/v1/sync/jobs
GET  /api/v1/sync/jobs/latest
GET  /api/v1/sync/jobs/{jobId}
```

独立同步服务仅监听 `127.0.0.1:8791`。主 API 默认不公开 `/sync-control/*`；只有显式设置 `SYNC_CONTROL_PUBLIC=true` 才会代理该路径，且必须配置 `SYNC_ADMIN_TOKEN`。

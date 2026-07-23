# 数据源与同步方案

状态基准:2026-07-17,服务器 `/root/address`,SQLite `data/address.sqlite`(788MB + WAL)。

## 0. 两层数据源(先分清)

项目有两套完全独立的数据源,不要混淆:

| | 主地址池(离线数据库) | IP 实时查询(在线兜底) |
|---|---|---|
| 触发 | 所有正常生成、筛选生成(占 99%+) | **仅**用户点"按 IP 区域生成" |
| 来源 | Overture Maps + Geofabrik OSM | 高德 / Geoapify / HK ALS |
| 需要 API key | **否**(全公开免费) | 是 |
| 自动同步 | **是**(每天 1 国,无人值守) | 不涉及(用户点击时实时调) |
| 速度 | 本地索引 <100ms | 外部 API,6.5s 超时,失败即降级本地池 |

**结论:正常生成完全走本地数据库,0 外部请求、无需任何 key、天然快。** 用户担心的"实时 API 慢"只发生在主动点 IP 生成时,且有超时保护。

### 实时 API 全局开关(2026-07-18 新增)

实时外部 API 不再是 IP 模式专享,改为**按生成模式全局可配置**。环境变量 `LIVE_API_MODES`(逗号分隔)控制哪些模式允许调外部 API:

| 值 | 含义 |
|---|---|
| `ip-region`(默认) | 仅"按 IP 生成"用实时 API;普通/住宅生成只查数据库 |
| `address,ip-region` | 普通生成也允许实时 API 兜底(先查数据库,空了再调) |
| `residential,ip-region` | 住宅生成也允许实时 API |
| `address,residential,ip-region` | 三种模式全部允许 |
| (空) | 全部只走数据库,永不调外部 API |

未列入的模式**始终只用本地数据库**(0 外部请求、快)。实时查询严格尊重当前页面模式:普通页找普通地址,住宅页找住宅地址(数据库与实时 API 两侧都按 residential 过滤)。IP 生成同理——普通页按 IP 找附近普通地址,住宅页按 IP 找附近住宅地址。

### 自定义黑名单(2026-07-18 新增)

除代码内置的各国机构规则(政府/学校/医院/银行/消防等)外,新增独立关键词文件 `config/blacklist.txt`(服务器路径 `/root/address/app/config/blacklist.txt`),一行一个关键词,`#` 开头为注释;命中(楼名/街道/完整地址任一包含,不区分大小写、全半角归一)即从所有生成结果排除。文件修改后约 10 秒内**热加载生效,无需重启**(按文件 mtime 缓存,未改动时零性能开销)。路径可用 `ADDRESS_BLACKLIST_FILE` 覆盖(改 env 需整体重启 supervisor)。

**注意**:部署代码时仓库内的 `config/blacklist.txt` 会覆盖服务器文件;需长期保留的关键词应加进仓库文件再部署。修改代码/env/前端后的重启步骤见 README「运维:黑名单、修改代码与重启」一节。


## 1. 每个国家的数据从哪里来

地址池只有两类**批量主源**,按国家二选一;目录、住宅证据、翻译是独立辅源。

### 1.1 门牌地址主源(逐国)

| 国家 | 主源 | 形式 | 单国原始包大小 |
|---|---|---|---:|
| 美国 US | Overture Maps addresses | 远程 GeoParquet(DuckDB 列裁剪) | 按需扫描,不落盘 |
| 加拿大 CA | Overture | 同上 | 同上 |
| 墨西哥 MX | Overture | 同上 | 同上 |
| 德国 DE | Overture | 同上 | 同上 |
| 法国 FR | Overture(内含 BAN 官方数据) | 同上 | 同上 |
| 意大利 IT | Overture | 同上 | 同上 |
| 西班牙 ES | Overture | 同上 | 同上 |
| 荷兰 NL | Overture(内含 BAG 官方数据) | 同上 | 同上 |
| 日本 JP | Overture | 同上 | 同上 |
| 香港 HK | Overture(覆盖差,仅 ~1k 条;计划接入官方 ALS) | 同上 | 同上 |
| 新加坡 SG | Overture(覆盖差,仅 ~63 条;计划接入 OneMap) | 同上 | 同上 |
| 台湾 TW | Overture | 同上 | 同上 |
| 澳大利亚 AU | Overture(内含 G-NAF 官方数据) | 同上 | 同上 |
| 英国 GB | Geofabrik OSM `united-kingdom` | PBF 全量下载后流式过滤 | ~1.8GB |
| 俄罗斯 RU | Geofabrik `russia` | 同上 | ~4.2GB |
| 中国 CN | Geofabrik `china`(**含港澳,必须边界过滤**) | 同上 | ~1.2GB |
| 韩国 KR | Geofabrik `south-korea` | 同上 | ~150MB |
| 马来西亚 MY | Geofabrik `malaysia-singapore-brunei` + MYS 边界 | 同上 | ~400MB |
| 泰国 TH | Geofabrik `thailand` | 同上 | ~500MB |
| 菲律宾 PH | Geofabrik `philippines` | 同上 | ~400MB |
| 越南 VN | Geofabrik `vietnam` | 同上 | ~300MB |
| 土耳其 TR | Geofabrik `turkey` | 同上 | ~600MB |
| 沙特 SA | Geofabrik `gcc-states` + SAU 边界 | 同上 | ~400MB |
| 印度 IN | Geofabrik `india` | 同上 | ~1.5GB |
| 尼日利亚 NG | Geofabrik `nigeria` | 同上 | ~300MB |
| 南非 ZA | Geofabrik `south-africa` | 同上 | ~300MB |
| 巴西 BR | Geofabrik `brazil` | 同上 | ~2GB |

选源规则:Overture 覆盖好且许可允许再分发的国家用 Overture;Overture 无覆盖或质量差的国家用 Geofabrik OSM。原始包处理完即删,不常驻磁盘。

### 1.2 辅源

| 用途 | 来源 | 落地表 |
|---|---|---|
| 州省/城市/邮编目录(筛选下拉框) | countries-states-cities + GeoNames + 邮编库 | `catalog_regions` / `catalog_cities` / `catalog_postcodes` |
| 住宅证据 | OSM `building=house/apartments/...` 标签;Overture buildings 主题抽查 | `address_pool_evidence(evidence_type='residential_use')` |
| 中国真实小区(2026-07-21 新增) | china.pbf 内 OSM `landuse=residential`/`place=neighbourhood` 带名住宅区,同一次流式导出顺带提取(零额外下载);约 17 万个;机构规则+自定义黑名单过滤;拼音英文名 | `cn_communities(name,name_en,latitude,longitude)`,随 CN 快照原子替换 |
| 三语翻译 | Google Translate(免费端点)→ 有道兜底 | `translation_cache` + 组件变体 JSON |
| IP 定位 | 本地/免密 IP 库 + TCP 源地址 | 运行时,不落库 |

## 2. 初始化用什么数据、怎么跑

首次部署按 27 国逐国执行(单写者,顺序处理):

```text
discover  确定上游不可变版本(Overture STAC release / Geofabrik etag)
download  原始包(curl、IPv4、断点续传;Overture 无需下载)
export    DuckDB 列裁剪+bbox 下推 / pyosmium C++ KeyFilter 流式过滤
normalize 清洗、去重(canonicalHash)、机构黑名单、边界过滤
sample    每国 ≤100,000 条、每城市/网格 ≤64 条,确定性哈希抽样
gate      最小行数、行政区覆盖、相对旧快照下降比例门禁
import    单事务写入 address_pool + evidence + coverage,新快照原子替换旧快照
cleanup   删原始包、checkpoint WAL、记录 sync_country_state
```

产出规模:27 国理论上限 270 万条;当前实测约 3.2KB/条,全量约 ≤10GB。

## 3. 部署后能自动同步吗 —— 能,机制已实现

服务器上由目录内 `supervisor.mjs` 常驻(不碰 systemd/crontab),拉起两个进程:API 服务和同步服务。同步服务包含三层调度,**无需人工干预**:

1. **初始化调度器**:启动时检查 27 国状态,只要有国家没成功过就持续补跑(指数退避重试),服务器重启后自动继续,直到全部 ready。
2. **每日调度器**:每天 03:00 UTC 触发,一次最多更新 1 个国家;失败国家优先,其次选择距上次成功最久的到期国家;每国成功后 30 天内不再更新;当天已成功则幂等跳过;单日最多重试 3 次。
3. **手动触发**:`POST /api/v1/sync/jobs`(admin token),可指定国家立即同步,用于修数据后强制重导。

可靠性机制:文件锁 + 心跳 + 孤儿任务清理(进程死亡后锁自动回收、running 任务标记 interrupted 并重排);每国独立提交,失败不影响已发布数据(旧快照保留);dataset 按"版本+校验和+导入修订号"幂等,重复触发自动跳过未变化的国家。

## 4. 同步策略(稳态)

- 节奏:1 国/天,每国 30 天周期 → 一轮 27 天,与上游更新频率(Overture 月度、Geofabrik 日度)匹配。
- 失败处理:failed 国家次日优先;连续失败有退避,不阻塞其他国家。
- 质量门禁:新快照行数/覆盖骤降超阈值时拒绝发布,保留旧 active 数据。
- 翻译回填(规划中):独立 worker 在同步空闲时分批补 zh-CN/en 组件,不阻塞地址主导入。
- 住宅富化(规划中):对 Overture 国家用 OSM building 标签二次标注,只 UPDATE 不新增行。

## 5. 容量红线(绝对 <50GB)

| 阈值 | 行为 |
|---|---|
| 40GiB(软限) | 停止 shadow 扩容、暂停低优先级富化/回填 |
| 45GiB(硬限) | 同步硬停止,保留现有 active 数据 |
| 预留 5GiB | WAL、临时文件、恢复操作 |

峰值构成:数据库(≤10GB)+ 单国暂存原始包(最大 RU ~4.2GB,处理完即删)+ WAL(每国导入后 checkpoint 截断)。全量稳态预计 <15GB,距 50GB 有 3 倍余量。

## 6. 当前各国数据快照(2026-07-18 坐标锚定二次验证后实测)

27/27 国 ready,active 池共 **724,023 条(住宅 97,224 条)**,数据目录 <6GB(上限 50GB)。每条地址均含完整行政区划;中国/台湾/俄罗斯经**坐标锚定二次验证**(geo-anchor-v12):丢弃源数据不可信的城市/区文本,用坐标反查权威分级目录重建省市区,跨境点与脏译名剔除。

| 国家 | 普通/住宅 | 国家 | 普通/住宅 | 国家 | 普通/住宅 |
|---|---|---|---|---|---|
| US 47,975/1,281 | GB 39,217/25,693 | CN 10,925/1,902 | HK 15,801/13,806 | DE 49,879/199 | FR 49,945/74 |
| ES 49,995/55 | IT 49,809/11 | JP 49,889/74 | TW 41,394/2,720 | RU 46,352/17,425 | AU 47,344/180 |
| CA 35,436/1,100 | NL 36,666/798 | MX 26,402/31 | BR 22,752/4,409 | IN 18,992/5,010 | KR 15,214/2,541 |
| ZA 12,572/5,162 | TR 11,779/2,734 | TH 11,306/3,120 | MY 10,527/4,174 | VN 10,524/769 | PH 8,915/2,748 |
| SG 1,488/494 | SA 1,462/493 | NG 1,463/221 | | | |

- 住宅是普通池子集;住宅 <100 条的国家(IT/ES/FR/JP/MX)前端隐藏住宅模式。
- 中国池经严格过滤(省+市+区县必须齐全且坐标验证),数量随每 30 天重同步回升。
- NG/SA/SG 总量受 OSM 门牌覆盖限制,每 30 天重同步随上游增长。
- 街道级 en/zh 翻译由回填 worker 持续补齐。

## 7. 外部 Provider(仅 IP 实时查询)与 key 处置(2026-07-17 决策)

| Provider | 用途 | key | 决策 |
|---|---|---|---|
| 高德 AMap | 中国 IP 模式住宅小区 POI | `AMAP_API_KEY`(已配 .env) | ✅ 启用,仅 CN 的 IP 生成用 |
| Geoapify | 全球 IP 模式地址兜底(3000/日免费) | `GEOAPIFY_API_KEY`(已配 .env) | ✅ 启用,全球 IP 生成兜底 |
| 香港 ALS | 香港 IP 模式官方地址 | 无需 key | ✅ 代码已支持,IP 模式自动用 |
| OneMap(新加坡) | — | token 易过期 | ❌ 弃用,SG 改由 Geofabrik 主池覆盖 |
| OS Data Hub(英国) | — | — | ❌ 弃用,GB 由 Geofabrik 主池覆盖 |
| Overpass / Photon | IP 模式最末兜底 | 无需 key | ✅ 保留,低频备用 |

`.env` 只写 `AMAP_API_KEY` 与 `GEOAPIFY_API_KEY` 两个;有道翻译 key 由服务器 `runtime/address.env` 单独持有,不入仓库。

### 未采纳的推荐源(评估结论)
- USDOT NAD / 法国 BAN / 澳洲 G-NAF / 日本 ABR:❌ Overture 已整合,实测 US/FR/AU/JP 主池均已填满;单独接入需逐个格式解析,G-NAF 5GB、ABR 试行版,不划算。
- OpenAddresses:❌ 与 Overture 高度重叠。
- GeoNames:✅ 已在用(行政区/城市/邮编目录)。
- libaddressinput:🔶 是"格式规则"非地址数据,已被 `address-formats.md` 覆盖,留作校验参考。

### SG / HK 覆盖修复(免 key、自动同步)
- **新加坡**:Geofabrik `malaysia-singapore-brunei` 包自带新加坡,新增 SG 分片用 SGP 边界提取。
- **香港**:Geofabrik `china` 包自带港澳。CN 分片用 HKG+MAC 排除边界剔除港澳,同一份下载再用 HKG 边界提取到 HK 分片,**一次下载两用**。

## 8. 真实住宅地址如何判断(离线,不实时,快)

**判断发生在同步入库时(离线),查询时 0 外部请求:**

1. **Geofabrik(OSM)国家**:导出器读 OSM `building` 标签,命中 `house / apartments / residential / detached / dormitory / terrace / bungalow / cabin / ger / semidetached_house` → 标记住宅。
2. **Overture 国家**:开启 `ADDRESS_SYNC_OVERTURE_BUILDINGS`,导出器按坐标网格加载 Overture buildings 主题,匹配建筑类别为住宅 → 标记住宅。
3. 住宅证据写入 `address_pool_evidence`(`evidence_type='residential_use'`),与地址主记录关联。
4. 用户选住宅模式 → SQL 直接筛"有住宅证据"的记录返回,**不调用任何 API**。

因此住宅判断**完全走数据库、查询快**。代价:Overture 国家住宅证据偏少(实测 US 仅 487 条),后续由 OSM building 富化扩充(见 optimization.md P1)。住宅池设最低水位(≥100)避免重复率过高;不足水位的国家前端不展示住宅模式。

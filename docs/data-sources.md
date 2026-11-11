# 数据源、准确性与自动同步

更新：2026-09-08。本文汇总各国家和地区当前实现的数据源、发布规则与自动同步流程。字段、坐标系、去重和验证细节见 [`strategies/`](strategies/)。

## 1. 发布原则

- **真实地址与有效数量优先**：中国保留住宅小区规则；其他国家允许有来源证据的真实街道级地址，并保留已有完整门牌地址。
- **按精度验证**：`street` 不强制门牌、楼栋、室号或住宅证据；行政归属、来源、语言和坐标仍必须有效。街道邮编无法唯一确定时留空。
- **地址字段不编造**：只允许可逆格式规范化；附近邮编、邻近地址、翻译反推和随机地址事实一律不用于补缺。
- **用途与精度分离**：街道记录标记 `matchLevel=street`、`propertyType=unknown`；只有独立住宅用途证据成立的门牌地址才标记住宅，不能把街道或公共建筑冒充住宅。
- **严格地区匹配**：城市/区县筛选无覆盖时返回空结果，不替换为附近、州省或全国地址。
- **来源冲突即隔离**：行政区、门牌或坐标冲突的记录不进入 active 池；非中国无法唯一确认的邮编留空，中国仍要求唯一有效六位邮编。

中国额外要求：AreaCity 行政区有效；高德候选必须是住宅小区分类、行政区一致、具有数字门牌且不命中机构黑名单。百度/腾讯可增加验证等级，但不作为发布必需条件。已发布记录只在来源新版本替换、证据失效或质量门禁变化时显式退休，不按固定天数自动过期。

## 2. 当前主源

以下住宅证据说明已有门牌来源的住宅分类，不是非中国街道记录的必备条件。

| 国家/地区 | 地址主源 | 邮编/行政区核验 | 住宅子集证据 | 策略 |
|---|---|---|---|---|
| 美国 US | Overture + Geofabrik 州级分片 | 源字段 + catalog；ZIP/ZIP+4 | OSM/Overture 住宅建筑 | [US](strategies/US-address-strategy.md) |
| 加拿大 CA | Statistics Canada NAR 2026-06 + Overture + Geofabrik Canada | NAR `ADDR_GUID/LOC_GUID`、CSD 和加拿大邮编；成员级 Range 断点读取 | NAR `BU_USE=1/2` 并通过 `LOC_GUID` 关联 WGS84 坐标；其他源仍需明确住宅建筑/用途 | [CA](strategies/CA-address-strategy.md) |
| 墨西哥 MX | INEGI 原始地址框架 + 同源标准化包 + Geofabrik/Overture | INEGI 原始字段；5 位非零邮编 | `TIPODOM=VIVIENDA` | [MX](strategies/MX-address-strategy.md) |
| 英国 GB | Geofabrik OSM | 源值 + Postcodes.io | OSM 住宅建筑 | [GB](strategies/GB-address-strategy.md) |
| 德国 DE | Overture + Geofabrik 16 州分片 | 源字段 + catalog；OpenPLZ 仅辅助 | 明确住宅建筑/用途 | [DE](strategies/DE-address-strategy.md) |
| 法国 FR | CSTB BDNB 23/33/69/75 + BAN + Overture + Geofabrik 区域分片 | BDNB/BAN `cle_interop_adr`、INSEE commune、5 位邮编、EPSG:2154→WGS84；其他源字段 + catalog | BDNB `usage_principal_bdnb_open` 住宅类别且 BAN 关联 `fiabilite>=17`；其他源明确住宅建筑/用途 | [FR](strategies/FR-address-strategy.md) |
| 意大利 IT | Overture + Geofabrik OSM | 源字段 + catalog；5 位 CAP | 明确住宅建筑/用途 | [IT](strategies/IT-address-strategy.md) |
| 西班牙 ES | Catastro INSPIRE municipality AD+BU + Overture + Geofabrik | Catastro `esp` 道路/门牌/municipality、5 位邮编、EPSG:25830→WGS84；其他源字段 + catalog | Catastro `currentUse=1_residential`、`numberOfDwellings>0`，14 位 referencia catastral 稳定关联地址；其他源明确住宅建筑/用途 | [ES](strategies/ES-address-strategy.md) |
| 荷兰 NL | Kadaster BAG（PDOK OGC Features）+ Overture | BAG 源字段 + catalog；`1234 AB` | BAG 严格在用 `woonfunctie`；Overture 明确住宅建筑/用途 | [NL](strategies/NL-address-strategy.md) |
| 俄罗斯 RU | Geofabrik OSM | 源字段 + catalog；6 位邮编 | OSM 住宅建筑 | [RU](strategies/RU-address-strategy.md) |
| 中国 CN | AreaCity 行政区 + 高德住宅小区；百度/腾讯只作可选增强验证 | AreaCity + 民政部版本对照；6 位源邮编 | 高德住宅分类、行政区一致、数字门牌和机构黑名单门禁 | [CN](strategies/CN-China-address-generation.md) |
| 中国香港 HK | 屋宇署住宅/综合用途 Tower；房委会单位 + ALS；Geofabrik/Overture | 官方 18 区双语映射与香港坐标；无通用邮编 | 屋宇署住宅用途或房委会公屋库存 | [HK](strategies/HK-address-strategy.md) |
| 中国台湾 TW | 内政部实价登录 + OA 官方门牌点；Geofabrik/Overture | 县市/区一致 + 中华邮政 3+3 完整门牌精确匹配 | 实价登录住宅主要用途与住宅建筑型态 | [TW](strategies/TW-address-strategy.md) |
| 日本 JP | 数字厅 ABR/Geolonia + PLATEAU；OSM 住宅轮廓补充（来源已于 2026-11-11 停用，仅保留已发布地址） | ABR 行政层级 + 日本邮便 7 位邮编唯一匹配 | ABR 点精确落入 PLATEAU/OSM 明确住宅建筑面 | [JP](strategies/JP-address-strategy.md) |
| 韩国 KR | K-apt + Geoapify；Juso/OpenAddresses 归档 + Geofabrik OSM | Juso 5 位邮编与行政层级；K-apt 地番地址 | K-apt 官方共同住宅标识；Juso 地址点须与明确住宅建筑相交 | [KR](strategies/KR-address-strategy.md) |
| 新加坡 SG | HDB Property Information + Existing Building；OneMap；Geofabrik OSM | HDB/OneMap 6 位邮编 | HDB 明确住宅字段与住宅单元数；OSM 住宅建筑 | [SG](strategies/SG-address-strategy.md) |
| 马来西亚 MY | Geofabrik OSM | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [MY](strategies/MY-address-strategy.md) |
| 泰国 TH | DPT 官方建筑图层 + Geofabrik OSM + Google Geocoding | DPT Tambon/Amphoe/Province + catalog；5 位邮编；polygon 转 WGS84 点 | DPT 明确住宅/公寓/集合住宅/宿舍分类；OSM 住宅建筑 | [TH](strategies/TH-address-strategy.md) |
| 菲律宾 PH | Geofabrik OSM + Google Geocoding | 源字段 + catalog；4 位邮编 | OSM 住宅建筑 | [PH](strategies/PH-address-strategy.md) |
| 越南 VN | Geofabrik OSM；Google Geocoding 补全 | 源字段 + catalog；五位邮编 | OSM 住宅建筑 | [VN](strategies/VN-address-strategy.md) |
| 土耳其 TR | Geofabrik OSM + Google Geocoding | 源字段 + catalog；5 位邮编 | OSM 住宅建筑 | [TR](strategies/TR-address-strategy.md) |
| 沙特阿拉伯 SA | Geofabrik OSM + Google Geocoding；可选 OpenAddresses 全国地址点 | 源字段 + catalog；5 位或 `5-4` 邮编 | 地址点精确落入明确住宅建筑面 | [SA](strategies/SA-address-strategy.md) |
| 印度 IN | Geofabrik OSM；Mappls Reverse Geocoding；Google Geocoding 补全 | OSM 门牌/道路 + 地理编码行政字段与 6 位 PIN | OSM 明确住宅建筑 | [IN](strategies/IN-address-strategy.md) |
| 澳大利亚 AU | Overture + Geofabrik OSM | 源字段 + catalog；4 位邮编 | 明确住宅建筑/用途 | [AU](strategies/AU-address-strategy.md) |
| 巴西 BR | Geofabrik OSM | 源字段 + catalog；CEP | OSM 住宅建筑 | [BR](strategies/BR-address-strategy.md) |
| 尼日利亚 NG | Geofabrik Nigeria 种子 + Google Geocoding | 来源字段；6 位邮编 | OSM 明确住宅建筑 | [NG](strategies/NG-address-strategy.md) |
| 南非 ZA | eThekwini 官方地址点 + Cape Town 官方地块 + Geofabrik OSM | SAPO 官方 4 位邮编精确唯一匹配 | 官方住宅分区精确点/地块关联；OSM 明确住宅建筑 | [ZA](strategies/ZA-address-strategy.md) |

OpenAddresses 归档沿用每个实际上游的许可；导入仍须通过对应来源的许可、字段和质量门禁，不能用平台元数据许可覆盖上游许可。libpostal 只用于解析和规范化，不证明地址真实或属于住宅。

### API 补全

Google Geocoding 与 Mappls Reverse Geocoding 消费既有 OSM 地址、住宅建筑及命名道路种子；目录中心点只用于排序，不能作为地址或行政字段。逐条处理同一次响应内的合格结果，要求国家正确、已有行政字段不冲突、坐标位于种子建筑几何内或距种子点不超过 15 米。Google 保留实际返回门牌，Mappls 保留 OSM 真实门牌；道路记录不生成门牌和住宅证据，非中国未知或歧义邮编留空。

K-apt 保留真实地番地址，Geoapify 可提供严格匹配行政层级与坐标的道路/门牌结果；HDB 双表优先，OneMap 可保留同道路的多个结构化结果。API 地址存在证据与 K-apt/HDB/OSM 住宅证据分别归属，组合来源保留适用许可及署名，不能把 API-only 地址标为官方住宅。

所有 Broker HTTP dispatch（包括轮换、失败和回退）单独计入预算；OneMap 每轮最多 500 次实际请求，逻辑查询数单独记录。缓存只保存规范化事实与来源能力指纹，失败/额度等待不写成永久无结果；已有来源只在自身版本或真实提取能力变化时恢复。

Broker 结果保存失败仍保留已发请求计数；OneMap 回执丢失或计数未知时停止本轮上游调用，并把未知请求量记录为 null，不能用零消耗继续重试。

## 3. 自动同步

国家完成条件为“总量目标 + 完整官方行政目录最低层覆盖率（零地址节点也计入分母）+ 最低层/一级/二级节点最低数 + 自定义节点目标”全部启用规则同时达标；任一规则未达标都保持未完成。

1. 最多 10 个国家并行发现、下载和准备；重型解析默认 4 路（可设 1–4），PostgreSQL 使用按国家隔离的事务发布。
2. 下载/调用上游到服务器 staging；相同 URL 与版本的原始包只下载一次，本地只做小型脱敏测试。
3. 解析并分离 `buildingName` 与 `unit`，执行全半角、大小写、空白和标准邮编分隔符等确定性规范化。
4. 按国家及实际精度检查必填项、已知邮编、国家边界、行政层级、语言和来源。声明住宅用途时需独立建筑证据，附近建筑不算证据；失败记录只保留拒绝统计，不进入发布池。
5. 候选按住宅证据、质量分和稳定哈希排序；每个最低行政节点先满足每节点、省市和单节点目标，再轮询分配额外记录；国家总量是完成下限，节点规则可以推动结果远超该数量，分片来源容量仍是技术硬限制。
6. 在影子表完成质量统计；全部门禁通过后仅切换同来源的旧快照。同一国家的多个来源保持 active，合并去重后重建覆盖统计。
7. 只比较最新候选与当前 active 快照；候选不足显示缺口，不放宽门禁。行政区划和邮编目录不受地址数量限制。
8. 发布后以官方行政区 ID 重建总地址覆盖及住宅子集覆盖；前端、后台、生成索引与同步目标使用相同合格总数。街道按国家、行政层级和规范街道名去重，不按采样坐标、邮编或提供商 ID 扩大数量。读取层再次检查，语言版本不全和历史不合格记录不返回；同步失败保留上一合格快照。
9. 默认执行一次自动初始化。未完成的 API/额度任务跨额度窗口从 checkpoint 继续；完整扫描或来源耗尽后停止，不按日/月重复同步。`ADDRESS_SYNC_ENABLE_SOURCE_PROBES=true` 仅供明确需要周期检查上游版本的部署启用，默认关闭。
10. 数据源确认耗尽的国家保持未完成但不进入执行队列，只有相同输入成功运行且所有未达规则均无进展时才锁定；总量不变但覆盖或节点达标数增加仍算进展。仅上游版本、新来源、确实改变严格候选集合的来源能力版本或管理员明确刷新可以解除对应来源；国家目标、覆盖目标和节点目标变化只重新计算完成状态。日/月额度和 QPS 冷却保留真实恢复时间并自动续跑，不伪造官方未公布的重置时刻。中国未完成时拥有最高调度优先级；后台同步队列使用独立页面。

国家与全局覆盖聚合均先将当前许可证据按地址去重，再集合关联计数，避免逐地址重复扫描全量住宅证据。重复证据不增加地址数，街道不计入住宅子集；此类查询性能修复不改变来源提取能力版本或解除耗尽状态。

同步进程启动时，对非中国发布池、生成索引、后台及同步总量/住宅子集执行一致性自检，仅重建有差异国家的派生统计，修复旧任务发布后超时或部署交叠留下的状态。不重抓来源、不重置验证断点，也不解除来源耗尽、失败或额度等待。

API Key 的申请、配置、轮换与冷却规则见 [API Key 配置文档](API_KEYS.zh-CN.md)。

## 4. 主要参考

- Overture: <https://docs.overturemaps.org/guides/addresses/>
- Geofabrik: <https://download.geofabrik.de/>
- AreaCity: <https://github.com/xiangyuecn/AreaCity-JsSpider-StatsGov>
- 民政部区划版本: <https://dmfw.mca.gov.cn/XzqhVersionPublish.html>
- 高德 JS 安全密钥: <https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode>
- Postcodes.io: <https://postcodes.io/>
- Geolonia Japanese Addresses v2: <https://github.com/geolonia/japanese-addresses-v2>
- Statistics Canada National Address Register: <https://www150.statcan.gc.ca/n1/en/catalogue/46260002>
- CSTB BDNB: <https://bdnb.io/download/>
- Spanish Catastro INSPIRE: <https://www.catastro.hacienda.gob.es/webinspire/index.html>
- Thailand DPT building layer: <https://bcbgis.dpt.go.th/arcgis/rest/services/DPTC_BCB_UAT/dptc_bldg/MapServer/2>
- Mappls Reverse Geocoding: <https://developer.mappls.com/documentation/sdk/rest-apis/mappls-maps-reverse-geocoding-rest-api-example/Readme/>
- OpenAddresses: <https://github.com/openaddresses/openaddresses>
- libpostal: <https://github.com/openvenues/libpostal>
## Translation recovery (2026-09-10)

Non-China published records use the existing Google keyless endpoint first, with the configured Youdao credential through Credential Broker as bounded fallback. Recovery only considers current, redistributable source evidence and rows retired by publication validation; it preserves native fields, identifiers, coordinates, postcodes and source timestamps. Translation progress, retry state and the separate 10,000-character daily Youdao backfill ceiling are persisted in PostgreSQL. Failed, revoked or otherwise invalid rows remain unpublished.

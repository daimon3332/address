# Bug 清单与修复状态

审计基准:2026-07-18,含本地代码审查 + 服务器实测。全部已修复并部署。

## 已修复(P0 用户可见)

| # | Bug | 根因 | 修复 | 状态 |
|---|---|---|---|---|
| B1 | 切换国家出上一国地址 | 前端闭包读旧国家 | selectionRef 同步守卫 | ✅ |
| B2 | 中国地址繁体/含港澳 | Geofabrik china 含港澳无过滤 | HKG+MAC 排除边界 + 地理编码器剔除港澳区域 + 导入端硬门禁 | ✅ 泄漏 1943→0 |
| B3 | 筛选后 404"暂无地址" | 无回退链 | 精确→就近→区域→全国回退,filterMatchLevel | ✅ |
| B4/B6 | 地址缺省/州/城市 | OSM 大量记录无 addr:city/state 标签 | 导入时坐标反查 catalog 补全,补不全则丢弃 | ✅ 全国 noRegion=0 noCity=0 |
| B5 | Geofabrik 国家数据量少 | importer 空 locality 塌缩 | 坐标网格分组键 | ✅ |
| B7 | 中文地址混英文 | 翻译未跑 | catalog 中文名富化 + 翻译回填 worker | ✅ |
| B8 | Overture unit 脏值 APT | 无数字 unit 入库 | 导入+读取双侧过滤 | ✅ |
| B9 | 台湾全角门牌 | 未归一 | NFKC 门牌号 | ✅ |
| B10 | 住宅池过小 | Overture 无 building | OSM 富化 + 最低水位 100 | ✅ |

## 本轮新增功能

- 银行卡:废弃 Stripe fixture,改 Luhn 合规多网络随机卡(Visa/MC/Amex/Discover/JCB/UnionPay)
- 实时 API 全局开关:LIVE_API_MODES 环境变量 + 前端勾选框(?live=true)
- 资料三语切换:基本/工作/财务/网络资料值可切 原文/English/中文,标签跟随页面语言
- 自定义黑名单:config/blacklist.txt 热加载
- 翻译回填 worker:空闲时补街道级翻译(TRANSLATION_BACKFILL_ENABLED)

## 最终数据(2026-07-18)
27/27 国 ready,~73 万条地址,全部含完整行政区划;CN 纯大陆简体无港澳;银行卡 Luhn 合规;数据 <6GB。

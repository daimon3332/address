# Address 二次開發文檔

[English](DEVELOPMENT.md) · [簡體中文](DEVELOPMENT.zh-CN.md) · [繁體中文](DEVELOPMENT.zh-TW.md)

## 架構

```text
瀏覽器
  -> Astro 靜態頁面 + React WebUI
  -> Hono Node.js API
       -> SQLite WAL 地址池
       -> SQLite RTree 座標索引
       -> 本地格式化與本地化
       -> 可選實時服務
  -> 同步 supervisor
       -> DuckDB 讀取 Overture GeoParquet
       -> pyosmium 讀取 Geofabrik/OSM PBF
       -> 驗證並原子發佈國家快照
```

普通生成查詢本地 SQLite 地址池。實時服務需要通過 `LIVE_API_MODES` 或請求參數 `live=true` 顯式開啟。

## 目錄職責

| 路徑 | 職責 |
|---|---|
| `src/components/` | React WebUI 與同步管理界面 |
| `src/domain/` | 國家元數據、生成、格式化、本地化、資料與導出規則 |
| `src/pages/` | 本地化 WebUI 與 API 文檔的 Astro 路由 |
| `server/api/` | Hono 應用、數據倉庫與外部服務適配器 |
| `server/database/` | SQLite Schema 與遷移入口 |
| `server/sync/` | 數據源適配、ETL、調度、快照發布與同步管理 API |
| `scripts/` | 目錄生成、驗證、線上探測與發佈審計 |
| `ops/` | Linux VPS 安裝、進程、備份、恢復與部署腳本 |
| `tests/` | Vitest 單元、集成、數據質量與 UI 結構測試 |

## 本地環境

要求 Node.js 24 或更新版本。只有源數據同步需要 Python 3 和 `venv`。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

Astro 開發服務器將 `/api` 代理到 `127.0.0.1:8787` 的 Hono，將 `/sync-control` 代理到 `127.0.0.1:8791` 的本地同步服務。新遷移的數據庫只有表結構，不包含地址池。

常用命令：

| 命令 | 用途 |
|---|---|
| `npm run dev` | 同時以監聽模式運行 Astro 和 Hono |
| `npm run dev:web` | 只運行 Astro |
| `npm run dev:api` | 只運行 Hono |
| `npm run db:migrate` | 創建或遷移本地 SQLite Schema |
| `npm run data:regions` | 更新內置地區元數據 |
| `npm run data:catalog` | 同步位置目錄 |
| `npm run data:address-pool:estimate` | 估算同步計劃 |
| `npm run data:address-pool:sync:dry-run` | 只驗證 ETL 計劃，不發佈數據 |
| `npm run data:address-pool:bootstrap` | 執行支持斷點續跑的全部國家首次導入 |
| `npm run sync:serve` | 運行本地調度器與同步管理 API |

## 配置模型

把 `.env.example` 複製為被忽略的 `.env`。密鑰始終留在服務端。只有明確用於 Astro 公開環境的變量才應進入瀏覽器構建；第三方服務 Key 和 `SYNC_ADMIN_TOKEN` 必須保留在 API 或同步進程環境中。

常規開發不需要第三方 API Key。可選實時服務參見[部署文檔](DEPLOYMENT.zh-TW.md)。

## 數據庫與同步

SQLite 使用 WAL 模式，保存地址、三語本地化、來源證據、國家狀態和 RTree 座標。國家發佈是事務性的：候選快照通過驗證後才替換 active 數據，失敗的候選不會影響舊快照。

同步來源：

- Overture Maps：DuckDB 遠程篩選並讀取 GeoParquet。
- Geofabrik 提供的 OpenStreetMap：pyosmium 流式讀取預篩選後的 PBF node 和 way。
- 本地地區與位置目錄：約束選擇器並驗證行政區一致性。

管線會過濾機構和非地址要素、去重、檢查住宅證據、驗證本地化組件並執行容量門禁。API 或同步任務運行時不要手工修改 `data/address.sqlite`。

手工執行示例：

```bash
node server/sync/address-etl.mjs --initial --all
node server/sync/address-etl.mjs --daily --all
node server/sync/address-etl.mjs --manual --shard US
```

## 擴展公開 API

1. 在 `server/api/index.ts` 定義請求校驗與路由。
2. 數據庫訪問統一放在 `server/api/repositories/`。
3. 服務商或網絡邏輯放在 `server/api/services/`，並顯式設置超時。
4. 沿用 `{ data: ... }` 或 `{ error: { code, message } }` 響應結構。
5. 添加 API 測試，並同步更新三語 API 文檔。

公開錯誤使用穩定、機器可讀的錯誤碼，不要讓調用方依賴本地化 UI 文案。

## 擴展國家或地址規則

國家行為涉及元數據、格式、位置選項、本地化、郵編規則、源分片計劃和測試。添加國家前需要：

1. 在 `src/domain/` 定義元數據和支持的篩選項。
2. 添加地址格式與郵編規則。
3. 添加源分片並驗證許可和署名元數據。
4. 分別驗證普通地址與住宅證據。
5. 添加本地化、確定性、回退和郵編格式測試。
6. 只使用既有腳本重新生成目錄。

生成的室內字段與合成測試資料必須始終能夠和來源支持的地址組件明確區分。

## WebUI 開發

本地化頁面從 `src/pages/[locale].astro` 進入並掛載 `src/components/App.tsx`。共享樣式位於 `src/styles/global.css`；同步界面使用 `SyncAdmin.tsx` 和 `admin.css`。

修改結果字段時，先更新領域類型，再把生成、API 序列化、UI、導出、翻譯與測試作為同一契約一起更新。保持結果區尺寸穩定，並驗證英文和中文值。

## 驗證與發佈門禁

每次提交前運行：

```bash
npm test
npm run check
npm run build
npm run check:public
```

這些命令覆蓋 Vitest、Astro 診斷、TypeScript、生產構建、忽略文件策略、必需公開文件和常見密鑰形態。Linux CI 還會檢查 Shell 語法並編譯 Python 文件。

完整數據庫同步後運行：

```bash
npm run check:production
```

該命令檢查數據庫完整性、必需表、國家就緒狀態和容量上限。線上環境探測使用獨立命令，因為它們要求已有運行中的部署。

## 貢獻檢查清單

- 保持改動範圍清晰，不引入無關依賴或格式化變更。
- 按行為影響補充相應測試。
- 英文、簡體中文和繁體中文文檔同步更新。
- 真實憑據、數據庫、日誌、含私密數據的截圖和運行狀態不進入 Git。
- 除項目命令外執行 `git diff --check`。
- 修改數據管線時保留來源署名和許可。

# Address 部署文檔

[English](DEPLOYMENT.md) · [簡體中文](DEPLOYMENT.zh-CN.md) · [繁體中文](DEPLOYMENT.zh-TW.md)

本文說明私密配置、首次數據同步、VPS 部署、反向代理、升級與備份。生產腳本面向 Linux AMD64 和 ARM64，全部運行狀態位於 `/root/address`。

## 運行要求

- Linux AMD64 或 ARM64 VPS
- 最低 4 GB 內存；完整首次導入建議 8 GB
- 應用卷至少預留 60 GiB
- `git`、`curl`、`ca-certificates`、`xz-utils`、Python 3 和 `venv`
- 已解析到 VPS 的域名，以及支持 HTTPS 的反向代理

安裝腳本會下載項目固定的 Node.js 版本，無需在系統中預裝 Node.js。

## 容量估算

以下數據於 2026-07-23、提交 `084805e`、27 國同步完成後實測：

| 內容 | 實測值 |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| 活躍 SQLite WAL | 0.68 GiB |
| 完整 `data/` 目錄 | 7.89 GiB |
| 當前有效地址 | 722,950 條 |
| 中國小區記錄 | 174,327 條 |

首次導入會臨時保留源文件和中間結果，歷史實測峰值約 11.2 GiB。上游版本、WAL 活躍度和可選保留設置會改變實際大小。建議 60 GiB 是為了給同步、備份和恢復留出餘量：影子擴容在 40 GiB 停止，寫入會在達到 45 GiB 前中止，項目絕對上限為 50 GiB。

## API Key 與密鑰

離線地址池、Overture/Geofabrik 同步、SQLite 生成、OpenCC、拼音轉換、Google 地圖鏈接和高德網頁鏈接均不需要第三方 API Key。

| 變量 | 是否必需 | 功能 | 獲取方式 |
|---|---|---|---|
| `AMAP_API_KEY` | 可選 | 中國實時 POI 查詢 | 按[高德官方文檔](https://lbs.amap.com/api/webservice/guide/create-project/get-key)創建“Web 服務”類型 Key。 |
| `GEOAPIFY_API_KEY` | 可選 | 中國以外實時地理編碼及部分反向本地化 | 按 [Geoapify 官方指南](https://www.geoapify.com/get-started-with-maps-api/)創建項目和 Key。 |
| `YOUDAO_APP_KEY`、`YOUDAO_APP_SECRET` | 成對可選 | 在線翻譯備用通道 | 在[有道智雲](https://ai.youdao.com/)創建自然語言翻譯應用。 |
| `ONEMAP_ACCESS_TOKEN` | 可選 | 新加坡普通地址實時查詢 | 按 [OneMap 認證文檔](https://www.onemap.gov.sg/apidocs/authentication)獲取；Token 到期後需要刷新。 |
| `SYNC_ADMIN_TOKEN` | VPS 必需 | 保護同步控制寫操作 | 在本機隨機生成，不屬於第三方憑據。 |

保留 `LIVE_API_MODES=ip-region` 可把實時服務限制在 IP 就近生成；普通生成只查詢本地數據庫。除非明確需要在線翻譯，否則保留 `GOOGLE_TRANSLATION_ENABLED=false`。

## 密鑰保護

倉庫只提供佔位模板：

| 模板 | 用途 |
|---|---|
| `.env.example` | 本地 WebUI 與 API 開發 |
| `server/sync/.env.example` | 同步參數參考 |
| `ops/address.env.example` | VPS 組合運行配置 |
| `ops/deploy.env.example` | 私密 SSH 部署配置 |

`.env`、`.deploy.env`、數據庫、日誌、運行狀態、緩存、私鑰和 `plan.md` 均被 Git 忽略。真實值只寫入被忽略的私密文件，不要放入瀏覽器變量、源碼、截圖、Issue、命令輸出或 CI 日誌。

VPS 使用權限為 `600` 的運行配置：

```bash
mkdir -p /root/address/runtime
cp /root/address/app/ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
```

生成同步 Token，過程中不輸出具體值：

```bash
token="$(openssl rand -hex 32)"
sed -i "s/GENERATE_A_RANDOM_VALUE/$token/" /root/address/runtime/address.env
unset token
chmod 600 /root/address/runtime/address.env
```

至少需要替換 `YOUR_DOMAIN.example`、生成 `SYNC_ADMIN_TOKEN` 並檢查 `TRUST_PROXY`。僅在啟用對應功能時填寫可選服務憑據。

## 運行配置

| 變量 | 生產默認值 | 作用 |
|---|---|---|
| `PUBLIC_API_BASE_URL` | `/api` | 瀏覽器使用的 API 前綴 |
| `API_HOST` | `127.0.0.1` | Hono 監聽地址 |
| `API_PORT` | `8787` | Hono 監聽端口 |
| `STATIC_ROOT` | `/root/address/app/dist` | Astro 構建結果 |
| `ADDRESS_DATABASE_PATH` | `/root/address/data/address.sqlite` | SQLite 數據庫 |
| `ALLOWED_ORIGIN` | 公開 HTTPS 來源 | CORS 白名單 |
| `TRUST_PROXY` | 代理後為 `true` | 是否信任轉發的客戶端 IP 請求頭 |
| `SYNC_HOST` | `127.0.0.1` | 同步管理監聽地址 |
| `SYNC_PORT` | `8791` | 同步管理端口 |
| `SYNC_CONTROL_PUBLIC` | `false` | 禁止主 API 公開同步管理入口 |
| `SYNC_UTC_HOUR` | `3` | 每日調度檢查時間，UTC 小時 |

只有受控反向代理會覆蓋轉發 IP 請求頭時才啟用 `TRUST_PROXY`。端口 `8791` 始終保持私有。

## 首次部署

### 1. 準備 VPS

```bash
apt-get update
apt-get install -y git curl ca-certificates xz-utils python3 python3-venv nginx
mkdir -p /root/address
git clone https://github.com/daimon3332/address.git /root/address/app
cd /root/address/app
./ops/install-runtime.sh
```

`install-runtime.sh` 會把固定 Node.js、Python 虛擬環境、Python 依賴和 npm 依賴安裝到 `/root/address` 內。

### 2. 創建私密配置

```bash
mkdir -p /root/address/runtime
cp ops/address.env.example /root/address/runtime/address.env
chmod 600 /root/address/runtime/address.env
editor /root/address/runtime/address.env
```

填寫 `ALLOWED_ORIGIN=https://YOUR_DOMAIN.example`，生成 `SYNC_ADMIN_TOKEN`，然後只添加需要的可選服務憑據。

### 3. 構建 WebUI

```bash
export PATH=/root/address/runtime/node/bin:$PATH
cd /root/address/app
npm run build
```

### 4. 初始化全部國家

```bash
/root/address/app/ops/initial-sync.sh
tail -f /root/address/logs/initial-sync.log
```

任務在後臺執行，每個國家獨立驗證和發佈，重啟後可複用已完成緩存。耗時取決於 VPS CPU、磁盤、網絡和上游狀態。全部成功後自動啟動 API 與調度服務。

### 5. 驗證服務

```bash
/root/address/app/ops/status.sh
curl -fsS http://127.0.0.1:8787/api/v1/health
curl -fsS http://127.0.0.1:8787/api/v1/data-health
```

## Nginx 與 HTTPS

沿用現有證書流程，把公開域名代理到 API 進程：

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

防火牆只公開 HTTP/HTTPS，API 和同步管理均監聽迴環地址。TLS 生效後，`ALLOWED_ORIGIN` 使用完全一致的 HTTPS 來源。

## 同步與運維

- 首次任務處理 27 國，支持斷點續跑。
- 穩態調度在每天 03:00 UTC 檢查，每天最多更新一個到期國家。
- 國家同步成功後，下一週期為 30 天。
- 新快照失敗時繼續保留舊 active 數據。
- 發佈成功後默認刪除原始源文件，除非明確開啟保留。

```bash
# 服務啟停與狀態
/root/address/app/ops/start.sh
/root/address/app/ops/stop.sh
/root/address/app/ops/status.sh

# 創建 SQLite 一致性備份
/root/address/app/ops/backup.sh

# 恢復 /root/address/backups 下的備份
/root/address/app/ops/restore.sh /root/address/backups/ADDRESS_BACKUP.sqlite
```

項目使用進程 supervisor，不安裝 systemd 服務或 cron。需要 VPS 重啟後自動啟動時，把 `ops/start.sh` 接入主機已有的啟動機制。

## 部署後續提交

在開發機執行：

```bash
cp ops/deploy.env.example .deploy.env
chmod 600 .deploy.env
editor .deploy.env
bash ops/deploy.sh --dist
```

部署腳本會歸檔當前 `HEAD`，通過 SSH 上傳，保留 VPS 數據庫、私密運行配置和服務器黑名單，重啟 supervisor 並執行健康檢查。純文檔變更可使用 `--no-restart`。

## 生產檢查清單

- DNS 與 HTTPS 已生效。
- `ALLOWED_ORIGIN` 是完全一致的公開 HTTPS 來源。
- `TRUST_PROXY=true` 只用於受控代理後方。
- `SYNC_ADMIN_TOKEN` 隨機且私密，Git 歷史中沒有具體值。
- `SYNC_CONTROL_PUBLIC=false`，端口 `8791` 未公開。
- 可選服務 Key 已在服務商側設置限制和用量告警。
- 數據庫初始化後，`npm run check:production` 通過。
- 已生成當前備份並驗證恢復流程。
- 應用卷至少 60 GiB，並啟用剩餘空間監控。

# 部署

[English](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · 繁體中文

Address 只支援一種生產部署方式：**Docker Compose**。應用、PostgreSQL、資料庫遷移和自動同步全部由倉庫根目錄的 `docker-compose.yml` 管理。

## 環境要求

| 專案 | 要求 |
|---|---|
| 系統 | Linux，AMD64 或 ARM64 |
| 執行時 | Docker Engine 24+、Docker Compose v2 |
| 記憶體 | 至少 4 GB；首次匯入美國、法國等大型國家建議 8 GB 以上 |
| 磁碟 | 27 個國家完整同步後資料庫約 15 GB，另需同步暫存與備份空間 |
| 網路 | 能訪問 Docker Hub 與各資料來源；對外服務需要 HTTPS 反向代理 |

## 安裝

```bash
mkdir address && cd address
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/daimon3332/address/main/docker-compose.yml
docker compose up -d
```

檢視狀態：

```bash
docker compose ps                                  # 所有服務應為 running / healthy
curl -fsS http://127.0.0.1:8787/api/v1/ready       # 返回 {"status":"ready"} 即可使用
```

瀏覽器開啟 `http://127.0.0.1:8787/admin/`，用初始密碼 `admin` 登入並按提示修改密碼。

## 服務組成

| 服務 | 作用 | 生命週期 |
|---|---|---|
| `bootstrap` | 生成並校驗內部金鑰 | 完成後退出 |
| `postgres` | PostgreSQL 16，只在內部網路可見 | 常駐 |
| `migrate` | 每次啟動前執行資料庫遷移 | 完成後退出 |
| `api` | 網頁與 API，預設監聽 `127.0.0.1:8787` | 常駐 |
| `sync` | 自動同步服務 | 常駐 |
| `credential-broker` | 平臺金鑰加密、輪換與額度協調 | 常駐 |

`sync` 首次啟動需要載入行政目錄，可能需要幾分鐘才會變為 healthy，期間不影響網頁和 API。

## 目錄結構

所有資料都儲存在 Compose 檔案所在目錄，整體遷移或備份時直接打包該目錄即可。

```text
address/
├── docker-compose.yml
├── .env                 # 可選，覆蓋預設配置
├── data/
│   ├── secrets/         # 自動生成的內部金鑰（務必備份）
│   ├── postgres/        # 資料庫檔案
│   └── address/         # 同步暫存
├── runtime/             # 同步執行狀態
└── backups/             # 建議的備份位置
```

不要讓兩個 PostgreSQL 容器同時掛載同一個 `data/postgres`。

## 配置

預設配置可直接執行。需要調整時，在 Compose 檔案旁建立 `.env`：

| 變數 | 預設值 | 說明 |
|---|---|---|
| `ADDRESS_IMAGE` | `daimon23/address:latest` | 應用映象，可固定為某個版本標籤 |
| `API_BIND_ADDRESS` | `127.0.0.1` | API 監聽地址；直接對外時改為 `0.0.0.0`（不推薦） |
| `API_PORT` | `8787` | API 埠 |
| `ALLOWED_ORIGINS` | 空 | 允許跨域訪問的來源，多個以逗號分隔 |
| `TRUST_PROXY` | `false` | 位於反向代理之後時設為 `true`，用於獲取真實客戶端 IP |
| `COOKIE_SECURE` | `false` | 使用 HTTPS 時設為 `true` |
| `ADMIN_INITIAL_PASSWORD` | `admin` | 首次啟動時的管理員密碼，僅首次生效 |
| `FRONTEND_INITIAL_PASSWORD` | 空 | 首次啟動時的前端訪問密碼，留空表示不啟用 |
| `TRANSLATION_BACKFILL_ENABLED` | `true` | 是否在後臺為已釋出地址補全多語言翻譯 |

修改後執行 `docker compose up -d` 生效。前端密碼、管理員密碼、API 令牌、平臺金鑰和同步目標都在管理後臺中設定，不需要寫進 `.env`。

## 反向代理

正式環境請只對外開放 80/443 埠，由反向代理轉發到 `127.0.0.1:8787`，並在 `.env` 中設定：

```dotenv
ALLOWED_ORIGINS=https://address.example.com
TRUST_PROXY=true
COOKIE_SECURE=true
```

**Caddy**（自動申請證書）：

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

不要對外暴露 PostgreSQL 或同步服務埠。

## 日常運維

```bash
docker compose ps                     # 服務狀態
docker compose logs -f api sync       # 檢視日誌
docker compose restart api            # 重啟單個服務
docker compose down                   # 停止（資料保留）
docker compose up -d                  # 啟動
```

## 升級

```bash
# 1. 先備份（見下一節）
# 2. 拉取新映象並重建
docker compose pull
docker compose up -d
docker compose ps
```

資料庫遷移會在 `migrate` 服務中自動完成。正式環境藍綠啟用以 `--skip-coverage` 執行遷移，產生索引與覆蓋統計由同步服務啟動後在背景重建。啟用在伺服器端脫離工作階段執行並記錄到 `runtime/deploy/activation-<release>.log`（結束碼寫入 `.exit`），SSH 中斷不會中斷切換。遷移僅在行政目錄修正實際改動了香港地址時才重建香港產生索引並複核。啟用成功後，自動刪除不在保留版本內且沒有容器使用的舊映像，以及 24 小時前的建置快取。若需要固定版本，將 `.env` 中的 `ADDRESS_IMAGE` 設為具體標籤。

## 備份與恢復

備份：

```bash
mkdir -p backups
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  > "backups/address-$(date -u +%Y%m%dT%H%M%SZ).dump"
cp -r data/secrets backups/secrets-$(date -u +%Y%m%d)
```

恢復：

```bash
docker compose stop api sync credential-broker
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < backups/address-YYYYMMDDTHHMMSSZ.dump
docker compose up -d
```

> **`data/secrets/config_master_key` 必須與資料庫備份一起儲存。** 後臺儲存的平臺金鑰都用它加密，丟失後只能重新錄入。

跨 PostgreSQL 主版本升級時只能使用 `pg_dump` / `pg_restore`，不能直接複用 `data/postgres`。

## 常見問題

**忘記管理員密碼怎麼辦？**
重新生成初始密碼並清除現有管理員賬號，服務啟動時會用新的初始密碼重建管理員（新密碼至少 10 位）：

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

**首次啟動報 `service "migrate" didn't complete successfully: exit 1`？**
v2.4.0 及更早版本在空資料庫上無法匯入位置目錄（報 `Use database.transaction() for PostgreSQL transactions`，或之後的 `Location catalog bootstrap incomplete: postcodes`）。升級到 v2.4.1 或更新版本後重新啟動，目錄匯入會自動繼續：

```bash
docker compose pull
docker compose up -d
```

**`sync` 一直顯示 starting？**
`sync` 啟動時要載入行政目錄並校驗已釋出資料，資料量越大耗時越長，可能需要幾分鐘。用 `docker compose logs -f sync` 檢視進度，日誌持續輸出即為正常；網頁和 API 不受影響。

**某個國家長期「待補充」？**
在後臺「地址資料」中開啟該國家詳情頁，「概覽」會顯示當前狀態和原因，例如等待額度重置、缺少平臺金鑰或來源已達上限。大部分國家不需要任何金鑰即可同步；需要金鑰的平臺見 [API Key 配置](API_KEYS.zh-TW.md)。

**能否不用 Docker？**
生產環境只維護 Docker Compose 這一種方式。本地開發請參考[開發文件](DEVELOPMENT.zh-TW.md)。

## 映象釋出

推送版本標籤（`v*`）時，GitHub Actions 會建置 AMD64/ARM64 映像並發布到 Docker Hub：`daimon23/address`（版本號、`主.次` 版本和 `latest`）；推送 `main` 只執行驗證。倉庫需要配置 `DOCKERHUB_TOKEN` 機密（具有讀寫許可權的 Docker Hub Access Token）。

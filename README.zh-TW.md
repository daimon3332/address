<p align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="Address Logo" />
</p>

<h1 align="center">Address</h1>

<p align="center">面向 27 個國家和地區的自託管地址與合成測試資料生成器</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">簡體中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/daimon3332/address/actions/workflows/ci.yml"><img src="https://github.com/daimon3332/address/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/daimon3332/address/releases"><img src="https://img.shields.io/github/v/release/daimon3332/address" alt="Release" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 24" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Code-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://address.333186.xyz"><img src="https://img.shields.io/badge/Live_Demo-address.333186.xyz-0f766e" alt="在線演示" /></a>
</p>

Address 把真實開放數據中的道路、行政區、座標和郵編與明確標記的合成室內字段結合，提供原文、英文和簡體中文地址，並生成適合表單與軟件測試的關聯資料。

> 生成結果屬於測試資料，不代表地址可投遞、真實居住、身份、支付賬戶有效性或所有權關係。

## 🚀 使用流程

選擇國家和地區 → 選擇普通或住宅證據模式 → 生成地址與測試資料 → 複製單項字段或導出結果。

## ✨ 核心功能

- 覆蓋 27 個國家和地區，支持州省、城市和郵編篩選。
- 精確 → 附近 → 同州省 → 全國分級回退，已同步國家持續有結果。
- 支持根據 IP 座標就近生成，並使用本地 SQLite RTree 兜底。
- 地址提供原文、英文和簡體中文三種表示。
- 來源支持的地址組件與明確標記的合成室內字段相互分離。
- 同時生成基本資料、沙盒銀行卡、工作、財務、網絡與擴展信息。
- 提供 Google 座標預覽、地址搜索和中國高德網頁鏈接。
- 自定義黑名單熱加載，並保留證據與來源署名。
- 首次導入支持斷點續跑，日常輪轉包含質量和容量門禁。

## 🧭 地址來源與字段真實性

默認同步地址池按下表使用對應來源。只有在啟用相應模式和憑據時才會調用實時服務；實時服務不會替代默認離線地址池。

| 國家/地區 | 默認來源 | 真實/來源地址字段 | 生成/虛構地址字段 |
|---|---|---|---|
| 美國（US） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、州、ZIP、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成 `Apt`/房間號 |
| 加拿大（CA） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成 `Unit`/房間號 |
| 墨西哥（MX） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、市鎮、州、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 英國（GB） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城鎮、Postcode、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成 `Flat` |
| 德國（DE） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 法國（FR） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 意大利（IT） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、大區、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 西班牙（ES） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 荷蘭（NL） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、城市、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 俄羅斯（RU） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、聯邦主體、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 中國（CN） | [Geofabrik OSM](https://download.geofabrik.de/) | 省/直轄市、城市、區縣、道路、來源幾何座標；有覆蓋時使用附近 OSM 小區 | 門牌號；無覆蓋時使用小區詞庫；缺失的樓棟/單元/房間信息 |
| 中國香港（HK） | [Geofabrik OSM](https://download.geofabrik.de/) | 大廈/道路、分區、地區、來源幾何座標 | 缺失的樓層/單位/房間信息可能生成 |
| 中國臺灣（TW） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、縣市、區、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 日本（JP） | [Overture Maps](https://overturemaps.org/) | 番地、道路、自治體、都道府縣、郵編、來源幾何座標 | 普通地址無；公寓缺少房間信息時可能生成房間號 |
| 韓國（KR） | [Geofabrik OSM](https://download.geofabrik.de/) | 道路、建築號、區、市/道、郵編、來源幾何座標 | 缺失的樓棟/單元/房間信息可能生成 |
| 新加坡（SG） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、地區、郵編、來源幾何座標 | 缺失的公寓單元可能生成 |
| 越南（VN） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、區、城市、省、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 泰國（TH） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 菲律賓（PH） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、描籠涯/區、城市、大區、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 馬來西亞（MY） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、縣/區、城市、州、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 印度（IN） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、縣區、城市、州、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 澳大利亞（AU） | [Overture Maps](https://overturemaps.org/) | 門牌、道路、郊區、州、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 土耳其（TR） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、省、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 沙特阿拉伯（SA） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 巴西（BR） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、州、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 尼日利亞（NG） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、城市、州、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |
| 南非（ZA） | [Geofabrik OSM](https://download.geofabrik.de/) | 門牌、道路、郊區、郵編、來源幾何座標 | 普通地址無；公寓缺少室內信息時可能生成室內字段 |

「普通地址無」表示街道級地址字段沒有被編造；如果是公寓記錄且來源沒有正式室內信息，仍可能生成測試用室內字段。

### 真實字段與合成字段

| 字段 | 來源說明 |
|---|---|
| 國家、地區、城市、區縣和道路 | 來自地址記錄並經過規範化；缺失的行政區名稱可能由本地目錄補全。 |
| 門牌號 | 中國以外國家使用來源門牌號；中國會有意替換為確定性測試門牌號。 |
| 郵編 | 優先使用有效來源郵編；缺失或格式錯誤時可能使用最近的目錄郵編補全。 |
| 座標 | 複製來源幾何位置，可能是地址點、建築點或 OSM 道路/建築 way 的幾何中心。 |
| 建築或小區 | 有來源值時優先使用。中國優先選擇附近有名稱的 OSM 住宅區，沒有覆蓋時才使用內置詞庫。 |
| 公寓、樓棟、單元和房間 | 有正式或來源標記值時保留；中國以及其他國家的公寓記錄在缺少室內信息時可能生成測試字段。 |
| 姓名、電話、郵箱、工作、財務、網絡和沙盒銀行卡 | 合成測試資料。 |

因此，中國地址應理解為：**真實行政區和道路環境，加來源座標，同時可能包含合成門牌號和室內層級**。其他國家保留來源門牌號，但缺少公寓/單元信息時仍可能補全。`verified` 表示通過來源證據和項目質量檢查，不代表地址當前存在、有人居住或可以投遞。

### Google 地圖與高德地圖說明

- **Google 座標預覽**直接打開來源幾何位置的 `latitude,longitude`，這是位置預覽，不是 Google 對投遞或居住狀態的證明。
- **Google 地址搜索**只使用地址骨架：中國會排除合成門牌號、小區名和室內單元；其他國家使用來源門牌、道路、地區、省州和郵編。
- **高德地圖**只為中國生成鏈接，打開前會把來源 WGS-84 座標轉換為 GCJ-02。
- 地圖點可能是地址點、建築中心或 way 的幾何中心，不保證是入口或具體房間。默認生成流程也不宣稱每條記錄都經過 Google Geocoding 獨立認證。

字段示例和來源細節請參閱[地址格式](docs/address-formats.md)、[數據來源](docs/data-sources.md)和 [API 文檔](docs/API.zh-TW.md)。

## 🖼️ Webui Preview (Webui 預覽)

<details>
<summary>展開查看美國與中國完整 WebUI 預覽</summary>

<br />

<table>
  <tr>
    <th width="50%">美國</th>
    <th width="50%">中國</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-overview.png" alt="美國 WebUI 總覽" /></td>
    <td><img src="image/webui-cn-overview.png" alt="中國 WebUI 總覽" /></td>
  </tr>
  <tr>
    <th>生成器</th>
    <th>生成器</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-generator.png" alt="美國地址生成器" /></td>
    <td><img src="image/webui-cn-generator.png" alt="中國地址生成器" /></td>
  </tr>
  <tr>
    <th>地址</th>
    <th>地址</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-address.png" alt="美國地址結果" /></td>
    <td><img src="image/webui-cn-address.png" alt="中國地址結果" /></td>
  </tr>
  <tr>
    <th>基本資料</th>
    <th>基本資料</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-profile.png" alt="美國基本測試資料" /></td>
    <td><img src="image/webui-cn-profile.png" alt="中國基本測試資料" /></td>
  </tr>
  <tr>
    <th>銀行卡測試資料</th>
    <th>銀行卡測試資料</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-test-card.png" alt="美國銀行卡測試資料" /></td>
    <td><img src="image/webui-cn-test-card.png" alt="中國銀行卡測試資料" /></td>
  </tr>
  <tr>
    <th>工作信息</th>
    <th>工作信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-employment.png" alt="美國工作信息" /></td>
    <td><img src="image/webui-cn-employment.png" alt="中國工作信息" /></td>
  </tr>
  <tr>
    <th>財務信息</th>
    <th>財務信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-finance.png" alt="美國財務信息" /></td>
    <td><img src="image/webui-cn-finance.png" alt="中國財務信息" /></td>
  </tr>
  <tr>
    <th>網絡與擴展信息</th>
    <th>網絡與擴展信息</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-network.png" alt="美國網絡與擴展信息" /></td>
    <td><img src="image/webui-cn-network.png" alt="中國網絡與擴展信息" /></td>
  </tr>
  <tr>
    <th>Google 地圖</th>
    <th>Google 地圖</th>
  </tr>
  <tr>
    <td><img src="image/webui-us-map.png" alt="美國 Google 地圖預覽" /></td>
    <td><img src="image/webui-cn-map.png" alt="中國 Google 地圖預覽" /></td>
  </tr>
</table>

</details>

## 📚 項目文檔

| 文檔 | 內容 |
|---|---|
| [API 文檔](docs/API.zh-TW.md) | 公開端點、參數、錯誤、同步管理、CORS 與示例 |
| [部署文檔](docs/DEPLOYMENT.zh-TW.md) | API Key、私密配置、VPS、Nginx、同步、備份與容量 |
| [二次開發文檔](docs/DEVELOPMENT.zh-TW.md) | 架構、本地環境、數據管線、擴展點、測試與發佈門禁 |

## ⚡ 快速開始

要求 Node.js 24 或更新版本。

```bash
git clone https://github.com/daimon3332/address.git
cd address
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

新數據庫只有表結構。執行 `npm run data:address-pool:bootstrap` 可開始支持斷點續跑的 27 國導入。生產 VPS 部署前請閱讀[部署文檔](docs/DEPLOYMENT.zh-TW.md)。

## 🔑 配置摘要

離線生成和數據同步不需要第三方 API Key。高德、Geoapify、有道和 OneMap 憑據只用於可選實時服務；`SYNC_ADMIN_TOKEN` 用於保護 VPS 同步管理。真實值只寫入被忽略的 `.env`、`.deploy.env` 或 `/root/address/runtime/address.env`，不要放入源碼、瀏覽器代碼、截圖、Issue 或 CI 日誌。

## 💾 數據庫大小

以下數據於 2026-07-23、提交 `084805e`、27 國同步完成後實測：

| 內容 | 實測值 |
|---|---:|
| `address.sqlite` | 6.90 GiB |
| 完整 `data/` 目錄 | 7.89 GiB |
| 首次導入峰值 | 約 11.2 GiB |

實際大小會隨上游版本和 WAL 活躍度變化。生產環境建議應用卷至少預留 **60 GiB**，用於同步、備份和恢復空間。

## 🌍 支持範圍

美國、加拿大、墨西哥、英國、德國、法國、意大利、西班牙、荷蘭、俄羅斯、中國、香港、臺灣、日本、韓國、新加坡、越南、泰國、菲律賓、馬來西亞、印度、澳大利亞、土耳其、沙特阿拉伯、巴西、尼日利亞和南非。

## 數據、隱私與許可

- [Overture Maps](https://overturemaps.org/) 提供部分地址記錄，並保留具體來源元數據與條款。
- [OpenStreetMap](https://www.openstreetmap.org/copyright) 和 [Geofabrik](https://download.geofabrik.de/) 根據 ODbL 1.0 提供其他源數據。
- 客戶端 IP 只用於用戶請求的定位查詢，不寫入地址數據庫。
- 室內字段、人物資料和銀行卡字段均為合成測試數據。

項目代碼使用 [MIT License](LICENSE)。重新分發的數據仍遵循對應來源的許可、署名和相同方式共享要求。倉庫與 Release 不包含生產數據庫或私密憑據。

# PACE 校園運動：我的 GPS 網站

這是部署在 GitHub Pages 的靜態網站。運動紀錄只存在你的手機或電腦瀏覽器中；即時位置分享另使用 Cloudflare Worker 同步。

## 開始使用

1. 將 `main` 分支推送到 GitHub，Pages 工作流程會自動發佈網站。第一次發佈時，請在 Settings → Pages 將 Source 設為 **GitHub Actions**。
2. 在 Actions 的 `Deploy GitHub Pages` 工作完成後，從摘要開啟網站，網址格式為 `https://你的帳號.github.io/倉庫名稱/`。
3. 用 VS Code 的 **Git: Clone** 把這個倉庫下載到電腦。
4. 在 Copilot Chat 輸入 `/explain-project`，認識檔案與流程。

## Copilot 指令

在 Copilot Chat 輸入下列指令（需要 VS Code 支援 prompt 檔案）：

| 指令 | 用途 |
| --- | --- |
| `/explain-project` | 用繁體中文認識專案檔案與資料流程 |
| `/preview-locally` | 在電腦啟動本機預覽，網址是 http://localhost:8000 |
| `/change-and-check` | 小步修改一個參數，並給出驗證步驟 |
| `/analyze-track` | 分析你匯出的軌跡 JSON，驗算距離、速度與熱量 |
| `/publish-changes` | 檢查變更、commit 並推送，讓網站自動更新 |

## 隱私

軌跡 JSON 與摘要 CSV 含有位置資料。請放在 `my-tracks/` 資料夾，不要推送到 GitHub，也不要公開分享。`.gitignore` 已經設定忽略這些檔案。

## 課程講義

完整的實作步驟、手機實測與實作紀錄表，請看課堂發下的《部署實作教學》。這個倉庫只放網站本身。

## 分享即時位置

運動進行中可按「分享即時位置」，勾選同意後複製連結。連結持有人只能看到分享期間的最新 GPS 位置，不會取得你的完整運動軌跡；分享者可隨時停止，連結最長一小時有效。分享者離開頁面時會送出停止訊息，運動結束時會立即關閉分享；若裝置突然離線，房間仍會在一小時內自動失效。請只把連結傳給你信任的人。

位置同步使用 Cloudflare Durable Objects WebSocket Worker。Worker 暫存分享權杖雜湊與有效期限；最新座標只附在即時連線中，供目前查看者與重新連線後的查看者使用，不形成歷史軌跡，也不寫入 D1 或運動紀錄。分享結束或逾期時會關閉連線並清除房間資料。部署方式：

1. 編輯 `share-worker/wrangler.jsonc` 的 `ALLOWED_ORIGINS`，只列出網站的 origin（例如 `https://你的帳號.github.io`）；本機測試可另外保留 `http://localhost:8000` 與 `http://127.0.0.1:8000`。
2. 使用已登入 Cloudflare 的 Wrangler 部署：`npx wrangler deploy --config share-worker/wrangler.jsonc`。
3. 若 Worker 使用獨立的 `workers.dev` 網址，把 `share-config.js` 的 `PACE_LOCATION_SHARE_ENDPOINT` 設為該網址。若已在網站網域掛上 `/api/location-share/*` Worker 路由，保留預設值即可。
4. 部署網站與 Worker 後，以 HTTPS 網址測試分享者和查看者兩台裝置。只在 `localhost` 預覽時，複製出的連結只供同一台電腦使用。

分享連結是持有人即可查看的私密連結。Worker 會在一小時後自動失效，停止分享會立即關閉連線並刪除房間資料。

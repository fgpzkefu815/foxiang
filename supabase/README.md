# 抽籤後端部署

本目錄提供 Supabase Edge Function 與資料庫交易函式。正式啟用前，需先建立 Supabase 專案並完成以下設定。

## 1. 建立資料庫

在 Supabase SQL Editor 執行：

`migrations/202611270001_draw_limits.sql`

此資料庫函式會以台灣時間判斷上午/中午場，並透過資料列鎖與使用者每日鎖，確保每場最多 108 次、每人每日最多 2 次。

## 2. 設定 Edge Function Secrets

使用 Supabase CLI 登入並連結專案後執行：

```sh
supabase secrets set LINE_CHANNEL_ID=2012808481
```

Supabase Edge Functions 會自動提供 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY`，不要將 service role key 放進前端或 GitHub。

## 3. 部署函式

```sh
supabase functions deploy draw
```

## 4. 前端設定

在 `index.html` 將以下兩個佔位值換成 Supabase 專案的公開設定：

- `SUPABASE_FUNCTION_URL`：`https://<project-ref>.supabase.co/functions/v1`
- `SUPABASE_ANON_KEY`：Supabase Project Settings > API 的 anon/publishable public key

這個公開 key 可放在前端；絕不可使用 service_role key。

## 5. 測試與上線

先以 LINE LIFF 正式入口測試登入、非開放時段拒絕、每日 2 次限制、單場 108 次限制與跨日重置。確認通過後才合併 Pull Request 並發布 GitHub Pages。

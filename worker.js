
export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors
      });
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        success: true,
        service: "佛菩薩聖像抽選 API",
        status: "online"
      }, 200, cors);
    }

    if (
      url.pathname !== "/api/status" &&
      url.pathname !== "/api/draw"
    ) {
      return json({
        success: false,
        error: "NOT_FOUND"
      }, 404, cors);
    }

    if (request.method !== "POST") {
      return json({
        success: false,
        error: "METHOD_NOT_ALLOWED"
      }, 405, cors);
    }

    let drawDate = "";
    let userHash = "";
    let session = "";

    try {
      const body = await request.json();

      const idToken = body.idToken;
      session = body.session;

      if (
        !idToken ||
        !["morning", "noon"].includes(session)
      ) {
        return json({
          success: false,
          error: "INVALID_PARAMS",
          message: "登入資料或抽選時段不正確"
        }, 400, cors);
      }

      if (
        !env.DB ||
        !env.LINE_CHANNEL_ID ||
        !env.USER_HASH_SECRET
      ) {
        return json({
          success: false,
          error: "SERVER_CONFIG",
          message: "伺服器設定不完整"
        }, 500, cors);
      }

      const verified = await verifyLineToken(
        idToken,
        env.LINE_CHANNEL_ID
      );

      if (!verified.ok || !verified.sub) {
        return json({
          success: false,
          error: "INVALID_TOKEN",
          message: "LINE 登入驗證失敗，請重新開啟"
        }, 401, cors);
      }

      userHash = await sha256(
        verified.sub + ":" + env.USER_HASH_SECRET
      );

      drawDate = taiwanDate();

      // 查詢目前名額及使用紀錄
      if (url.pathname === "/api/status") {
        const [countRow, mineRow, legacyRow] =
          await env.DB.batch([
            env.DB.prepare(`
              SELECT COUNT(*) AS total
              FROM session_draws
              WHERE draw_date = ?
              AND session = ?
            `).bind(drawDate, session),

            env.DB.prepare(`
              SELECT 1 AS used
              FROM session_draws
              WHERE draw_date = ?
              AND user_hash = ?
              LIMIT 1
            `).bind(drawDate, userHash),

            env.DB.prepare(`
              SELECT 1 AS used
              FROM daily_draws
              WHERE draw_date = ?
              AND user_hash = ?
              LIMIT 1
            `).bind(drawDate, userHash)
          ]);

        const total = Number(
          countRow.results?.[0]?.total || 0
        );

        const alreadyDrawn = Boolean(
          mineRow.results?.length ||
          legacyRow.results?.length
        );

        return json({
          success: true,
          alreadyDrawn,
          remaining: Math.max(0, 108 - total),
          quota: 108,
          session,
          drawDate
        }, 200, cors);
      }

      // 抽選時段檢查：台灣時間
      const minute = taiwanMinuteOfDay();

      const inWindow = session === "morning"
        ? minute >= 480 && minute < 510
        : minute >= 720 && minute < 750;

      if (!inWindow) {
        return json({
          success: false,
          drawn: false,
          error: "SESSION_CLOSED",
          message: "目前非開放抽選時段"
        }, 403, cors);
      }

      // 檢查是否已經使用每日名額
      const used = await env.DB.prepare(`
        SELECT 1 AS used
        FROM session_draws
        WHERE draw_date = ?
        AND user_hash = ?
        UNION ALL
        SELECT 1 AS used
        FROM daily_draws
        WHERE draw_date = ?
        AND user_hash = ?
        LIMIT 1
      `).bind(
        drawDate,
        userHash,
        drawDate,
        userHash
      ).first();

      if (used) {
        return json({
          success: false,
          drawn: false,
          alreadyDrawn: true,
          error: "DAILY_LIMIT",
          message: "今日已完成登記，每日限一次"
        }, 409, cors);
      }

      // 登記抽選名額
      // 資料表主鍵限制同一帳號每日只能登記一次
      // D1 trigger 限制每場最多 108 人
      await env.DB.prepare(`
        INSERT INTO session_draws
          (draw_date, session, user_hash)
        VALUES (?, ?, ?)
      `).bind(
        drawDate,
        session,
        userHash
      ).run();

      // 同步寫入每日使用紀錄
      await env.DB.prepare(`
        INSERT OR IGNORE INTO daily_draws
          (draw_date, user_hash)
        VALUES (?, ?)
      `).bind(
        drawDate,
        userHash
      ).run();

      const totalRow = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM session_draws
        WHERE draw_date = ?
        AND session = ?
      `).bind(
        drawDate,
        session
      ).first();

      const total = Number(totalRow?.total || 0);

      return json({
        success: true,
        drawn: true,
        alreadyDrawn: true,
        remaining: Math.max(0, 108 - total),
        quota: 108,
        session,
        drawDate,
        message: "登記成功"
      }, 200, cors);

    } catch (error) {
      const message = String(error?.message || "");

      console.error("佛菩薩抽選 API error:", message);

      if (message.includes("SESSION_FULL")) {
        return json({
          success: false,
          drawn: false,
          error: "SESSION_FULL",
          message: "本時段名額已滿"
        }, 409, cors);
      }

      if (
        message.includes("UNIQUE constraint") ||
        message.includes("PRIMARY KEY")
      ) {
        return json({
          success: false,
          drawn: false,
          alreadyDrawn: true,
          error: "DAILY_LIMIT",
          message: "今日已完成登記，每日限一次"
        }, 409, cors);
      }

      return json({
        success: false,
        error: "INTERNAL_ERROR",
        message: "伺服器暫時無法處理，請稍後再試"
      }, 500, cors);
    }
  }
};


// LINE ID Token 驗證
async function verifyLineToken(idToken, channelId) {
  const form = new URLSearchParams();

  form.set("id_token", idToken);
  form.set("client_id", channelId);

  const response = await fetch(
    "https://api.line.me/oauth2/v2.1/verify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: form.toString()
    }
  );

  if (!response.ok) {
    return { ok: false };
  }

  const data = await response.json();

  if (!data.sub) {
    return { ok: false };
  }

  return {
    ok: true,
    sub: data.sub
  };
}


// SHA-256 使用者雜湊
async function sha256(value) {
  const data = new TextEncoder().encode(value);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}


// 台灣日期 YYYY-MM-DD
function taiwanDate() {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }
  ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    values.year + "-" +
    values.month + "-" +
    values.day
  );
}


// 台灣當日分鐘數
function taiwanMinuteOfDay() {
  const parts = new Intl.DateTimeFormat(
    "en-GB",
    {
      timeZone: "Asia/Taipei",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }
  ).formatToParts(new Date());

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    Number(values.hour) * 60 +
    Number(values.minute)
  );
}


// JSON 回應
function json(data, status, cors) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

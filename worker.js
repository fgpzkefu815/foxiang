
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const MAX_PER_SESSION = 108;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return json({
        success: true,
        service: "佛菩薩聖像抽選 API",
        status: "online"
      });
    }

    if (request.method !== "POST") {
      return json({ success: false, error: "method not allowed" }, 405);
    }

    if (!env.DB) {
      return json({ success: false, error: "database not configured" }, 500);
    }

    if (!env.LINE_CHANNEL_ID || !env.USER_HASH_SECRET) {
      return json({ success: false, error: "server configuration missing" }, 500);
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ success: false, error: "invalid JSON" }, 400);
    }

    const idToken = body.idToken;
    const session = body.session;

    if (!idToken) {
      return json({ success: false, error: "missing LINE ID Token" }, 400);
    }

    if (!["morning", "noon"].includes(session)) {
      return json({ success: false, error: "invalid session" }, 400);
    }

    try {
      const lineUser = await verifyLineToken(
        idToken,
        env.LINE_CHANNEL_ID
      );

      const userHash = await sha256(
        lineUser.sub + ":" + env.USER_HASH_SECRET
      );

      const taiwan = getTaiwanTime();
      const drawDate = taiwan.date;

      if (url.pathname === "/api/status") {
        return await getStatus(
          env.DB,
          drawDate,
          userHash,
          session,
          taiwan
        );
      }

      if (url.pathname === "/api/draw") {
        return await makeDraw(
          env.DB,
          drawDate,
          userHash,
          session,
          taiwan
        );
      }

      return json({ success: false, error: "not found" }, 404);

    } catch (error) {
      console.error("API error:", error);

      return json({
        success: false,
        error: "server error"
      }, 500);
    }
  }
};

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
    throw new Error("LINE token verification failed");
  }

  const data = await response.json();

  if (!data.sub || data.aud !== channelId) {
    throw new Error("Invalid LINE identity");
  }

  return data;
}

async function sha256(value) {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);

  return Array.from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getTaiwanTime() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const get = type => parts.find(p => p.type === type).value;

  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    minuteOfDay: Number(get("hour")) * 60 + Number(get("minute"))
  };
}

function isSessionOpen(session, taiwan) {
  const minute = taiwan.minuteOfDay;

  if (session === "morning") {
    return minute >= 480 && minute < 510;
  }

  if (session === "noon") {
    return minute >= 720 && minute < 750;
  }

  return false;
}

async function getStatus(
  db,
  drawDate,
  userHash,
  session,
  taiwan
) {
  const used = await db.prepare(`
    SELECT 1
    FROM daily_draws
    WHERE draw_date = ? AND user_hash = ?
    LIMIT 1
  `).bind(drawDate, userHash).first();

  const count = await db.prepare(`
    SELECT COUNT(*) AS total
    FROM session_draws
    WHERE draw_date = ? AND session = ?
  `).bind(drawDate, session).first();

  const remaining = Math.max(
    0,
    MAX_PER_SESSION - Number(count.total || 0)
  );

  return json({
    success: true,
    alreadyDrawn: !!used,
    remaining,
    sessionCount: Number(count.total || 0),
    sessionQuota: MAX_PER_SESSION,
    canDraw:
      !used &&
      remaining > 0 &&
      isSessionOpen(session, taiwan),
    session,
    drawDate
  });
}

async function makeDraw(
  db,
  drawDate,
  userHash,
  session,
  taiwan
) {
  if (!isSessionOpen(session, taiwan)) {
    return json({
      success: false,
      error: "SESSION_CLOSED",
      message: "目前不在開放抽選時間"
    }, 403);
  }

  const already = await db.prepare(`
    SELECT 1
    FROM daily_draws
    WHERE draw_date = ? AND user_hash = ?
    LIMIT 1
  `).bind(drawDate, userHash).first();

  if (already) {
    return json({
      success: false,
      error: "ALREADY_DRAWN",
      message: "今天已經登記過"
    }, 409);
  }

  try {
    await db.batch([
      db.prepare(`
        INSERT INTO session_draws
          (draw_date, session, user_hash)
        VALUES (?, ?, ?)
      `).bind(drawDate, session, userHash),

      db.prepare(`
        INSERT INTO daily_draws
          (draw_date, user_hash)
        VALUES (?, ?)
      `).bind(drawDate, userHash)
    ]);

    return json({
      success: true,
      message: "登記成功",
      session,
      drawDate
    });

  } catch (error) {
    const message = String(error.message || error);

    if (message.includes("SESSION_FULL")) {
      return json({
        success: false,
        error: "SESSION_FULL",
        message: "本場次名額已滿"
      }, 409);
    }

    if (
      message.includes("UNIQUE constraint") ||
      message.includes("PRIMARY KEY") ||
      message.includes("SQLITE_CONSTRAINT")
    ) {
      return json({
        success: false,
        error: "ALREADY_DRAWN",
        message: "今天已經登記過"
      }, 409);
    }

    console.error("Database write error:", error);

    return json({
      success: false,
      error: "DATABASE_ERROR"
    }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

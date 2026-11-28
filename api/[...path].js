const { Pool } = require("pg");
const crypto = require("crypto");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 10000,
});

const MAX_PER_DAY = 108;
const CHANNEL_ID = process.env.LINE_CHANNEL_ID;
const HASH_SECRET = process.env.USER_HASH_SECRET;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method not allowed" });
  if (!process.env.DATABASE_URL || !CHANNEL_ID || !HASH_SECRET) {
    return res.status(500).json({ success: false, error: "server configuration missing" });
  }

  const path = (req.url || "").split("?")[0];
  if (path !== "/api/status" && path !== "/api/draw") {
    return res.status(404).json({ success: false, error: "not found" });
  }
  const { idToken, session } = req.body || {};
  if (!idToken) return res.status(400).json({ success: false, error: "missing LINE ID Token" });
  if (!["morning", "noon"].includes(session)) return res.status(400).json({ success: false, error: "invalid session" });

  try {
    const identity = await verifyLineToken(idToken);
    const userHash = crypto.createHash("sha256").update(identity.sub + ":" + HASH_SECRET).digest("hex");
    const taiwan = taiwanNow();
    if (path === "/api/status") {
      const client = await pool.connect();
      try {
        const used = await client.query("SELECT 1 FROM daily_draws WHERE draw_date=$1 AND user_hash=$2 LIMIT 1", [taiwan.date, userHash]);
        const count = await client.query("SELECT COUNT(*)::int AS total FROM session_draws WHERE draw_date=$1", [taiwan.date]);
        const total = count.rows[0].total;
        const remaining = Math.max(0, MAX_PER_DAY - total);
        return res.status(200).json({
          success: true, alreadyDrawn: used.rowCount > 0, remaining,
          dailyCount: total, dailyQuota: MAX_PER_DAY,
          canDraw: used.rowCount === 0 && remaining > 0 && isSessionOpen(session, taiwan),
          session, drawDate: taiwan.date
        });
      } finally { client.release(); }
    }

    if (!isSessionOpen(session, taiwan)) {
      return res.status(403).json({ success: false, error: "SESSION_CLOSED", message: "目前不在開放抽選時間" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize every draw for the same Taiwan date so both sessions share one daily cap.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [taiwan.date]);
      const used = await client.query("SELECT 1 FROM daily_draws WHERE draw_date=$1 AND user_hash=$2 LIMIT 1", [taiwan.date, userHash]);
      if (used.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: "ALREADY_DRAWN", message: "今天已經登記過" });
      }
      const count = await client.query("SELECT COUNT(*)::int AS total FROM session_draws WHERE draw_date=$1", [taiwan.date]);
      if (count.rows[0].total >= MAX_PER_DAY) {
        await client.query("ROLLBACK");
        return res.status(409).json({ success: false, error: "DAILY_FULL", message: "今日 108 個名額已滿，請明日再來" });
      }
      await client.query("INSERT INTO session_draws(draw_date, session, user_hash) VALUES($1,$2,$3)", [taiwan.date, session, userHash]);
      await client.query("INSERT INTO daily_draws(draw_date, user_hash) VALUES($1,$2)", [taiwan.date, userHash]);
      await client.query("COMMIT");
      return res.status(200).json({ success: true, drawn: true, message: "登記成功", session, drawDate: taiwan.date });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.code === "23505") return res.status(409).json({ success: false, error: "ALREADY_DRAWN", message: "今天已經登記過" });
      throw error;
    } finally { client.release(); }
  } catch (error) {
    console.error("draw API error", error);
    return res.status(500).json({ success: false, error: "server error" });
  }
};

async function verifyLineToken(idToken) {
  const form = new URLSearchParams({ id_token: idToken, client_id: CHANNEL_ID });
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form
  });
  if (!response.ok) throw new Error("LINE token verification failed");
  const data = await response.json();
  if (!data.sub || data.aud !== CHANNEL_ID) throw new Error("Invalid LINE identity");
  return data;
}

function taiwanNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = Number(get("hour")), minute = Number(get("minute"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minuteOfDay: hour * 60 + minute };
}
function isSessionOpen(session, now) {
  const m = now.minuteOfDay;
  return session === "morning" ? m >= 480 && m < 510 : session === "noon" ? m >= 720 && m < 750 : false;
}

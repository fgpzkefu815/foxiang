import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEITY_IDS = [
  "guanyin", "wenshu", "dizang", "yaoshi", "amitabha",
  "shakyamuni", "mila", "puxian", "longnü", "shancai",
  "mazu", "guandi", "xuantian", "zhunti", "dashizhi",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);

  try {
    const { idToken } = await req.json();
    if (typeof idToken !== "string" || !idToken) return json({ error: "MISSING_ID_TOKEN" }, 400);

    const channelId = Deno.env.get("LINE_CHANNEL_ID");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!channelId || !supabaseUrl || !serviceRoleKey) {
      return json({ error: "SERVER_NOT_CONFIGURED" }, 500);
    }

    // Verify the raw LIFF ID token with LINE. Never trust profile data sent by the browser.
    const verifyBody = new URLSearchParams({ id_token: idToken, client_id: channelId });
    const verifyResponse = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: verifyBody,
    });
    if (!verifyResponse.ok) return json({ error: "INVALID_LINE_TOKEN" }, 401);

    const verified = await verifyResponse.json();
    if (typeof verified.sub !== "string" || !verified.sub) {
      return json({ error: "LINE_ID_UNAVAILABLE" }, 401);
    }

    const deityId = DEITY_IDS[Math.floor(Math.random() * DEITY_IDS.length)];
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.rpc("reserve_draw", {
      p_line_user_id: verified.sub,
      p_deity_id: deityId,
    });
    if (error) {
      console.error("reserve_draw failed", error.message);
      return json({ error: "DRAW_RESERVATION_FAILED" }, 500);
    }
    if (!data?.ok) return json({ error: data?.code ?? "DRAW_REJECTED", details: data }, 409);

    return json({ ok: true, deityId, period: data.period, used: data.used, remaining: data.remaining });
  } catch (error) {
    console.error("draw function error", error);
    return json({ error: "BAD_REQUEST" }, 400);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

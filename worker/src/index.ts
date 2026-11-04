export interface Env {
  GEMINI_API_KEY: string;
  APP_TOKEN: string;
  ALLOWED_ORIGIN?: string;
}

type AssetMeta = { id: string; name?: string; duration: number; mimeType?: string };
type Scene = {
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  title: string;
  voiceover: string;
  visualNote: string;
};

const MAX_FILES = 12;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 45 * 1024 * 1024;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function cors(origin: string, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGIN || "https://e041l31o4.github.io";
  return origin === allowed
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
      }
    : {};
}

function parseModelJson(text: string): any {
  const cleaned = text.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("AI 回傳格式不是有效 JSON，請重新分析");
  }
}

async function gemini(env: Env, parts: any[]): Promise<any> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(env.GEMINI_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.25, responseMimeType: "application/json" },
      }),
    },
  );
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || "Gemini API request failed (" + response.status + ")";
    throw new Error(message);
  }
  const text = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
  if (!text) throw new Error("AI 沒有回傳可用內容，可能是影片格式或內容不受支援");
  return parseModelJson(text);
}

function validateScenes(raw: any, assets: AssetMeta[]): { scenes: Scene[]; warnings: string[]; overallScript: string } {
  if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length === 0) {
    throw new Error("AI 未能從影片中選出有效片段");
  }
  if (raw.scenes.length > 80) throw new Error("AI 回傳鏡頭數量異常，請降低目標影片長度後重試");
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const scenes: Scene[] = [];
  for (const item of raw.scenes) {
    const assetId = String(item?.assetId || "");
    const asset = byId.get(assetId);
    const start = Number(item?.sourceStart);
    const end = Number(item?.sourceEnd);
    if (!asset) throw new Error("AI 回傳了不存在的素材識別碼，請重新分析");
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > asset.duration + 0.25) {
      throw new Error("AI 回傳的片段時間碼超出原始影片範圍：" + (asset.name || assetId));
    }
    scenes.push({
      assetId,
      sourceStart: Math.max(0, start),
      sourceEnd: Math.min(asset.duration, end),
      title: String(item?.title || "精華片段").slice(0, 100),
      voiceover: String(item?.voiceover || "").slice(0, 1200),
      visualNote: String(item?.visualNote || "").slice(0, 500),
    });
  }
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((value: unknown): value is string => typeof value === "string").slice(0, 20)
    : [];
  return { scenes, warnings, overallScript: String(raw.overallScript || "").slice(0, 6000) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin") || "";
    const headers = cors(origin, env);
    const respond = (data: unknown, status = 200) => {
      const response = json(data, status);
      const merged = new Headers(response.headers);
      Object.entries(headers).forEach(([key, value]) => merged.set(key, value));
      return new Response(response.body, { status: response.status, headers: merged });
    };

    if (request.method === "OPTIONS") {
      return headers["Access-Control-Allow-Origin"]
        ? new Response(null, { status: 204, headers })
        : new Response(null, { status: 403 });
    }
    if (!headers["Access-Control-Allow-Origin"]) return respond({ error: "Origin not allowed" }, 403);

    const pathname = new URL(request.url).pathname.replace(/\/$/, "");
    if (request.method === "GET" && pathname.endsWith("/health")) {
      return respond({
        ok: true,
        service: "ai-video-studio-storyboard",
        version: "1.2",
        ready: Boolean(env.GEMINI_API_KEY && env.APP_TOKEN),
      });
    }
    if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
    if (!env.GEMINI_API_KEY || !env.APP_TOKEN) return respond({ error: "Worker secrets are not configured" }, 503);
    if (request.headers.get("Authorization") !== "Bearer " + env.APP_TOKEN) {
      return respond({ error: "Unauthorized" }, 401);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_TOTAL_BYTES + 2 * 1024 * 1024) {
      return respond({ error: "上傳內容超過伺服器限制，請壓縮影片後再試。" }, 413);
    }

    try {
      const form = await request.formData();
      const prompt = String(form.get("prompt") || "請製作有吸引力的短影音").slice(0, 3000);
      const targetDuration = Math.max(10, Math.min(600, Number(form.get("targetDuration")) || 60));
      const platform = String(form.get("platform") || "Reels / Shorts").slice(0, 100);
      const style = String(form.get("style") || "高質感房屋銷售").slice(0, 100);
      let assets: AssetMeta[];
      try {
        const parsed = JSON.parse(String(form.get("assets") || "[]"));
        if (!Array.isArray(parsed)) throw new Error("素材清單格式錯誤");
        assets = parsed;
      } catch {
        return respond({ error: "素材清單格式錯誤，請重新選取影片。" }, 400);
      }
      const files = form.getAll("videos").filter((value): value is File => value instanceof File);
      if (!assets.length || assets.length !== files.length) {
        return respond({ error: "影片清單與檔案數量不一致，請重新選取素材。" }, 400);
      }
      if (files.length > MAX_FILES) return respond({ error: "單次最多分析 12 段影片" }, 413);
      const ids = new Set<string>();
      for (const asset of assets) {
        if (!asset || typeof asset.id !== "string" || !asset.id.trim() || ids.has(asset.id)) {
          return respond({ error: "素材識別資料有誤，請重新匯入影片。" }, 400);
        }
        ids.add(asset.id);
        if (!Number.isFinite(Number(asset.duration)) || Number(asset.duration) <= 0) {
          return respond({ error: "影片片長資訊不完整，請確認影片已載入完成。" }, 400);
        }
      }
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        return respond({ error: "全部影片合計不可超過 45MB，請分批或壓縮素材後再分析。" }, 413);
      }

      const analyses: any[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const asset = assets[index];
        if (file.size > MAX_FILE_BYTES) {
          return respond({ error: "單段影片超過 12MB inline 分析限制：" + file.name + "。請先壓縮影片或切成較小片段。" }, 413);
        }
        if (!file.type.startsWith("video/")) {
          return respond({ error: "不支援的影片格式：" + file.name }, 400);
        }
        if (asset.mimeType && asset.mimeType !== file.type) {
          return respond({ error: "影片格式資訊不一致：" + file.name }, 400);
        }

        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        const analysis = await gemini(env, [
          {
            text:
              "你是專業短影音剪輯師。分析這一段影片，輸出 JSON：summary(畫面內容摘要)、segments(陣列，每段含 start、end、visual、speech、qualityScore 0-100、keepReason)。時間必須是影片內秒數，不能超出 " +
              Number(asset.duration) +
              " 秒。優先保留穩定清晰、有資訊價值的鏡頭，避開晃動、空白、重複。若聽到語音，盡量整理原意，不可捏造。影片檔名：" +
              String(asset.name || file.name).slice(0, 200),
          },
          { inline_data: { mime_type: file.type, data: btoa(binary) } },
        ]);
        analyses.push({
          assetId: asset.id,
          name: String(asset.name || file.name),
          duration: Number(asset.duration),
          summary: analysis.summary,
          segments: Array.isArray(analysis.segments) ? analysis.segments.slice(0, 40) : [],
        });
      }

      const plan = await gemini(env, [
        {
          text:
            "你是資深影音導演。根據下列每段影片的實際視覺與語音分析，為使用者剪輯一支完整短影音。不可捏造房屋規格、價格、地點、學區或任何事實；不確定的資訊以中性旁白或 warnings 提醒。遵守使用者要求：" +
            prompt +
            "。平台：" +
            platform +
            "；風格：" +
            style +
            "；目標長度：" +
            targetDuration +
            "秒。請輸出 JSON，格式 {scenes:[{assetId,sourceStart,sourceEnd,title,voiceover,visualNote}],warnings:[string],overallScript:string}。所有 sourceStart/sourceEnd 必須落在該素材長度內；以故事順序排序；可以從同一支原片選多個片段。每個鏡頭約 2-8 秒，總長盡量接近目標長度。分析資料：" +
            JSON.stringify(analyses),
        },
      ]);
      const validated = validateScenes(plan, assets);
      return respond(validated);
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 分析失敗";
      return respond({ error: message.slice(0, 1000) }, 500);
    }
  },
};

export interface AssetMeta { id: string; name?: string; duration: number; mimeType?: string }
export interface Scene {
  assetId: string;
  sourceStart: number;
  sourceEnd: number;
  title: string;
  voiceover: string;
  visualNote: string;
}
type JobStatus = "queued" | "processing" | "completed" | "failed";
type StoredFile = { key: string; name: string; mimeType: string; size: number };
type JobRecord = {
  id: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  prompt: string;
  targetDuration: number;
  platform: string;
  style: string;
  assets: AssetMeta[];
  files: StoredFile[];
  progress: number;
  total: number;
  currentFile?: string;
  message: string;
  result?: { scenes: Scene[]; warnings: string[]; overallScript: string };
  error?: string;
};

interface R2ObjectLike { arrayBuffer(): Promise<ArrayBuffer> }
interface R2BucketLike {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(keys: string | string[]): Promise<unknown>;
}
interface StorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(timestamp: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
interface DurableObjectStateLike {
  storage: StorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface JobStubLike { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> }
interface JobNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): JobStubLike;
}
export interface Env {
  GEMINI_API_KEY: string;
  APP_TOKEN: string;
  ALLOWED_ORIGIN?: string;
  STORYBOARD_MEDIA: R2BucketLike;
  STORYBOARD_JOBS: JobNamespaceLike;
}

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
        Vary: "Origin",
      }
    : {};
}
function parseModelJson(text: string): any {
  const cleaned = text.trim().replace(/^`{3}(?:json)?\s*/i, "").replace(/\s*`{3}$/, "");
  try { return JSON.parse(cleaned); }
  catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
    throw new Error("AI 回傳格式不是有效 JSON，請重新分析");
  }
}
async function gemini(env: Env, parts: any[]): Promise<any> {
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(env.GEMINI_API_KEY),
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
  if (!response.ok) throw new Error(payload?.error?.message || "Gemini API request failed (" + response.status + ")");
  const output = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
  if (!output) throw new Error("AI 沒有回傳可用內容，可能是影片格式或內容不受支援");
  return parseModelJson(output);
}
function validateScenes(raw: any, assets: AssetMeta[]) {
  if (!raw || !Array.isArray(raw.scenes) || raw.scenes.length === 0) throw new Error("AI 未能從影片中選出有效片段");
  if (raw.scenes.length > 80) throw new Error("AI 回傳鏡頭數量異常，請降低目標影片長度後重試");
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const scenes: Scene[] = raw.scenes.map((item: any) => {
    const assetId = String(item?.assetId || "");
    const asset = byId.get(assetId);
    const start = Number(item?.sourceStart);
    const end = Number(item?.sourceEnd);
    if (!asset) throw new Error("AI 回傳了不存在的素材識別碼，請重新分析");
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > asset.duration + 0.25) {
      throw new Error("AI 回傳的片段時間碼超出原始影片範圍：" + (asset.name || assetId));
    }
    return {
      assetId,
      sourceStart: Math.max(0, start),
      sourceEnd: Math.min(asset.duration, end),
      title: String(item?.title || "精華片段").slice(0, 100),
      voiceover: String(item?.voiceover || "").slice(0, 1200),
      visualNote: String(item?.visualNote || "").slice(0, 500),
    };
  });
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((value: unknown): value is string => typeof value === "string").slice(0, 20)
    : [];
  return { scenes, warnings, overallScript: String(raw.overallScript || "").slice(0, 6000) };
}
async function processJob(job: JobRecord, env: Env, progress: (patch: Partial<JobRecord>) => Promise<void>) {
  const analyses: any[] = [];
  for (let index = 0; index < job.files.length; index++) {
    const stored = job.files[index];
    await progress({
      status: "processing",
      progress: index,
      currentFile: stored.name,
      message: "正在分析第 " + (index + 1) + " / " + job.files.length + " 段影片",
    });
    const object = await env.STORYBOARD_MEDIA.get(stored.key);
    if (!object) throw new Error("暫存影片不存在或已逾期：" + stored.name);
    const bytes = new Uint8Array(await object.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const asset = job.assets[index];
    const analysis = await gemini(env, [
      {
        text:
          "你是專業短影音剪輯師。分析這一段影片，輸出 JSON：summary(畫面內容摘要)、segments(陣列，每段含 start、end、visual、speech、qualityScore 0-100、keepReason)。時間必須是影片內秒數，不能超出 " +
          Number(asset.duration) +
          " 秒。優先保留穩定清晰、有資訊價值的鏡頭，避開晃動、空白、重複。若聽到語音，盡量整理原意，不可捏造。影片檔名：" +
          String(asset.name || stored.name).slice(0, 200),
      },
      { inline_data: { mime_type: stored.mimeType, data: btoa(binary) } },
    ]);
    analyses.push({
      assetId: asset.id,
      name: String(asset.name || stored.name),
      duration: Number(asset.duration),
      summary: analysis.summary,
      segments: Array.isArray(analysis.segments) ? analysis.segments.slice(0, 40) : [],
    });
    await progress({ progress: index + 1, message: "已完成 " + (index + 1) + " / " + job.files.length + " 段影片分析" });
  }
  await progress({ currentFile: "正在整合腳本與剪輯順序", message: "影片分析完成，AI 正在編排完整故事線" });
  const plan = await gemini(env, [{
    text:
      "你是資深影音導演。根據下列每段影片的實際視覺與語音分析，為使用者剪輯一支完整短影音。不可捏造房屋規格、價格、地點、學區或任何事實；不確定的資訊以中性旁白或 warnings 提醒。遵守使用者要求：" +
      job.prompt + "。平台：" + job.platform + "；風格：" + job.style + "；目標長度：" + job.targetDuration +
      "秒。請輸出 JSON，格式 {scenes:[{assetId,sourceStart,sourceEnd,title,voiceover,visualNote}],warnings:[string],overallScript:string}。所有 sourceStart/sourceEnd 必須落在該素材長度內；以故事順序排序；可以從同一支原片選多個片段。每個鏡頭約 2-8 秒，總長盡量接近目標長度。分析資料：" +
      JSON.stringify(analyses),
  }]);
  return validateScenes(plan, job.assets);
}

export class StoryboardJob {
  private state: DurableObjectStateLike;
  private env: Env;
  constructor(state: DurableObjectStateLike, env: Env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && new URL(request.url).pathname === "/start") {
      const incoming = await request.json() as JobRecord;
      await this.state.storage.put("job", incoming);
      await this.state.storage.setAlarm(Date.now() + 100);
      return json({ ok: true });
    }
    if (request.method === "GET") {
      const job = await this.state.storage.get<JobRecord>("job");
      return job ? json(job) : json({ error: "Job not found" }, 404);
    }
    return json({ error: "Method not allowed" }, 405);
  }
  async alarm(): Promise<void> {
    const job = await this.state.storage.get<JobRecord>("job");
    if (!job || job.status === "completed" || job.status === "failed") return;
    const save = async (patch: Partial<JobRecord>) => {
      Object.assign(job, patch, { updatedAt: Date.now() });
      await this.state.storage.put("job", job);
    };
    try {
      await save({ status: "processing", message: "AI 背景分析啟動中" });
      const result = await processJob(job, this.env, save);
      await save({ status: "completed", progress: job.total, result, currentFile: undefined, message: "AI 分析完成" });
    } catch (error) {
      await save({ status: "failed", error: error instanceof Error ? error.message.slice(0, 1000) : "AI 分析失敗", message: "分析失敗" });
    } finally {
      await this.env.STORYBOARD_MEDIA.delete(job.files.map(file => file.key)).catch(() => undefined);
    }
  }
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
      return headers["Access-Control-Allow-Origin"] ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 });
    }
    if (!headers["Access-Control-Allow-Origin"]) return respond({ error: "Origin not allowed" }, 403);
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/$/, "");
    if (request.method === "GET" && pathname.endsWith("/health")) {
      return respond({
        ok: true,
        service: "ai-video-studio-storyboard",
        version: "2.0",
        ready: Boolean(env.GEMINI_API_KEY && env.APP_TOKEN && env.STORYBOARD_MEDIA && env.STORYBOARD_JOBS),
        features: ["durable-background-jobs", "r2-temporary-media", "progress-polling"],
      });
    }
    if (!env.GEMINI_API_KEY || !env.APP_TOKEN) return respond({ error: "Worker secrets are not configured" }, 503);
    if (request.headers.get("Authorization") !== "Bearer " + env.APP_TOKEN) return respond({ error: "Unauthorized" }, 401);

    const jobMatch = pathname.match(/\/jobs\/([a-zA-Z0-9-]+)$/);
    if (request.method === "GET" && jobMatch) {
      const id = jobMatch[1];
      const stub = env.STORYBOARD_JOBS.get(env.STORYBOARD_JOBS.idFromName(id));
      const response = await stub.fetch("https://job.internal/");
      return respond(await response.json(), response.status);
    }
    if (request.method !== "POST" || pathname !== "") return respond({ error: "Method not allowed" }, 405);
    if (!env.STORYBOARD_MEDIA || !env.STORYBOARD_JOBS) return respond({ error: "Worker storage bindings are not configured" }, 503);
    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_TOTAL_BYTES + 2 * 1024 * 1024) return respond({ error: "上傳內容超過伺服器限制，請壓縮影片後再試。" }, 413);

    const uploadedKeys: string[] = [];
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
      } catch { return respond({ error: "素材清單格式錯誤，請重新選取影片。" }, 400); }
      const files = form.getAll("videos").filter((value): value is File => value instanceof File);
      if (!assets.length || assets.length !== files.length) return respond({ error: "影片清單與檔案數量不一致，請重新選取素材。" }, 400);
      if (files.length > MAX_FILES) return respond({ error: "單次最多分析 12 段影片" }, 413);
      if (assets.some(asset => !asset || typeof asset.id !== "string" || !asset.id.trim() || !Number.isFinite(Number(asset.duration)) || Number(asset.duration) <= 0)) {
        return respond({ error: "素材識別或片長資料有誤，請重新匯入影片。" }, 400);
      }
      if (new Set(assets.map(asset => asset.id)).size !== assets.length) return respond({ error: "素材識別碼重複，請重新匯入影片。" }, 400);
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) return respond({ error: "全部影片合計不可超過 45MB，請分批或壓縮素材後再分析。" }, 413);
      const id = crypto.randomUUID();
      const storedFiles: StoredFile[] = [];
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (file.size > MAX_FILE_BYTES) return respond({ error: "單段影片超過 12MB inline 分析限制：" + file.name, }, 413);
        if (!file.type.startsWith("video/")) return respond({ error: "不支援的影片格式：" + file.name }, 400);
        if (assets[index].mimeType && assets[index].mimeType !== file.type) return respond({ error: "影片格式資訊不一致：" + file.name }, 400);
        const key = "jobs/" + id + "/" + index + "-" + file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
        await env.STORYBOARD_MEDIA.put(key, await file.arrayBuffer());
        uploadedKeys.push(key);
        storedFiles.push({ key, name: file.name, mimeType: file.type, size: file.size });
      }
      const job: JobRecord = {
        id, status: "queued", createdAt: Date.now(), updatedAt: Date.now(),
        prompt, targetDuration, platform, style, assets, files: storedFiles,
        progress: 0, total: files.length, message: "影片已安全暫存，等待背景分析",
      };
      const stub = env.STORYBOARD_JOBS.get(env.STORYBOARD_JOBS.idFromName(id));
      const started = await stub.fetch("https://job.internal/start", { method: "POST", body: JSON.stringify(job) });
      if (!started.ok) throw new Error("無法建立背景分析任務");
      return respond({ jobId: id, status: "queued", message: job.message }, 202);
    } catch (error) {
      if (uploadedKeys.length) await env.STORYBOARD_MEDIA.delete(uploadedKeys).catch(() => undefined);
      return respond({ error: error instanceof Error ? error.message.slice(0, 1000) : "建立 AI 分析任務失敗" }, 500);
    }
  },
};

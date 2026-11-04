export interface Env {
  GEMINI_API_KEY: string;
  APP_TOKEN: string;
  ALLOWED_ORIGIN?: string;
}
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8"}});
function cors(origin:string,env:Env):Record<string,string>{const allowed=env.ALLOWED_ORIGIN||"https://e041l31o4.github.io";return origin===allowed?{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type, Authorization","Vary":"Origin"}:{};}
async function gemini(env:Env,parts:any[]){
  const response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+encodeURIComponent(env.GEMINI_API_KEY),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{temperature:.25,responseMimeType:"application/json"}})});
  const payload:any=await response.json();
  if(!response.ok)throw new Error(payload?.error?.message||"Gemini API request failed ("+response.status+")");
  const text=payload?.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||"").join("")||"";
  if(!text)throw new Error("AI 沒有回傳可用內容");
  return JSON.parse(text);
}
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const origin=request.headers.get("Origin")||"";
  const headers=cors(origin,env);
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers});
  const respond=(data:unknown,status=200)=>{const response=json(data,status);const merged=new Headers(response.headers);Object.entries(headers).forEach(([k,v])=>merged.set(k,v));return new Response(response.body,{status:response.status,headers:merged});};
  if(request.method!=="POST")return respond({error:"Method not allowed"},405);
  if(!headers["Access-Control-Allow-Origin"])return respond({error:"Origin not allowed"},403);
  if(!env.GEMINI_API_KEY||!env.APP_TOKEN)return respond({error:"Worker secrets are not configured"},503);
  if(request.headers.get("Authorization")!=="Bearer "+env.APP_TOKEN)return respond({error:"Unauthorized"},401);
  try{
   const form=await request.formData();
   const prompt=String(form.get("prompt")||"請製作有吸引力的短影音");
   const targetDuration=Math.max(10,Math.min(600,Number(form.get("targetDuration"))||60));
   const platform=String(form.get("platform")||"Reels / Shorts");
   const style=String(form.get("style")||"高質感房屋銷售");
   const assets=JSON.parse(String(form.get("assets")||"[]"));
   const files=form.getAll("videos").filter((x):x is File=>x instanceof File);
   if(!assets.length||assets.length!==files.length)return respond({error:"影片清單與檔案數量不一致"},400);
   if(files.length>12)return respond({error:"單次最多分析 12 段影片"},413);
   const totalBytes=files.reduce((sum,file)=>sum+file.size,0);
   if(totalBytes>45*1024*1024)return respond({error:"全部影片合計不可超過 45MB，請分批或壓縮素材後再分析。"},413);
   const analyses:any[]=[];
   for(let i=0;i<files.length;i++){
    const file=files[i];
    if(file.size>12*1024*1024)return respond({error:"單段影片超過 12MB inline 分析限制："+file.name+"。請先壓縮影片或切成較小片段。"},413);
    if(!file.type.startsWith("video/"))return respond({error:"不支援的影片格式："+file.name},400);
    const bytes=new Uint8Array(await file.arrayBuffer());
    let binary="";for(let j=0;j<bytes.length;j+=0x8000)binary+=String.fromCharCode(...bytes.subarray(j,j+0x8000));
    const b64=btoa(binary);
    const analysis=await gemini(env,[
      {text:"你是專業短影音剪輯師。分析這一段影片，輸出 JSON：summary(畫面內容摘要)、segments(陣列，每段含 start、end、visual、speech、qualityScore 0-100、keepReason)。時間必須是影片內秒數，不能超出 "+Number(assets[i]?.duration||0)+" 秒。優先保留穩定清晰、有資訊價值的鏡頭，避開晃動、空白、重複。若聽到語音，盡量整理原意，不可捏造。影片檔名："+String(assets[i]?.name||file.name)}
      ,{inline_data:{mime_type:file.type,data:b64}}
    ]);
    analyses.push({assetId:String(assets[i].id),name:file.name,duration:Number(assets[i].duration)||0,...analysis});
   }
   const plan=await gemini(env,[{text:"你是資深影音導演。根據下列每段影片的實際視覺與語音分析，為使用者剪輯一支完整短影音。不可捏造房屋規格、價格、地點、學區或任何事實；不確定的資訊以中性旁白或 warnings 提醒。遵守使用者要求："+prompt+"。平台："+platform+"；風格："+style+"；目標長度："+targetDuration+"秒。請輸出 JSON，格式 {scenes:[{assetId,sourceStart,sourceEnd,title,voiceover,visualNote}],warnings:[string],overallScript:string}。所有 sourceStart/sourceEnd 必須落在該素材長度內；以故事順序排序；可以從同一支原片選多個片段。每個鏡頭約 2-8 秒，總長盡量接近目標長度。分析資料："+JSON.stringify(analyses)}]);
   if(!Array.isArray(plan.scenes)||!plan.scenes.length)return respond({error:"AI 未能從影片中選出有效片段"},422);
   return respond(plan);
  }catch(error){return respond({error:error instanceof Error?error.message:"AI 分析失敗"},500);}
 }
};

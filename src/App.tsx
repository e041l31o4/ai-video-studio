import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type Asset = { id:string; file:File; url:string; kind:'video'|'image'|'audio'; duration:number; start:number; end:number; fadeIn:number; fadeOut:number; volume:number; opacity:number; timelineStart:number; trackIndex:number };
type Cue = { id:string; text:string; start:number; end:number };
const time = (n:number) => { if(!Number.isFinite(n)) return '00:00'; return String(Math.floor(n/60)).padStart(2,'0')+':'+String(Math.floor(n%60)).padStart(2,'0'); };
async function makeSubtitlePng(cue:Cue,width:number,height:number,size:number,color:string,position:string,background:boolean){
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('無法建立字幕畫布');
  const fontSize=Math.max(18,Math.round(size*width/390)),lineHeight=Math.round(fontSize*1.35),maxWidth=width*.84;
  ctx.font='700 '+fontSize+'px "Noto Sans TC", "Microsoft JhengHei", sans-serif';
  ctx.textAlign='center';ctx.textBaseline='middle';
  const lines:string[]=[];
  cue.text.split(/\n/).forEach(paragraph=>{
    let line='';
    for(const char of Array.from(paragraph)){
      const next=line+char;
      if(line&&ctx.measureText(next).width>maxWidth-48){lines.push(line);line=char;}else line=next;
    }
    lines.push(line);
  });
  const textWidth=Math.min(maxWidth,Math.max(1,...lines.map(line=>ctx.measureText(line).width)));
  const blockHeight=lines.length*lineHeight,padX=Math.round(fontSize*.65),padY=Math.round(fontSize*.42);
  let centerY=position==='top'?height*.12+blockHeight/2+padY:position==='center'?height/2:height*.88-blockHeight/2-padY;
  const x=width/2,y=centerY;
  if(background){const w=textWidth+padX*2,h=blockHeight+padY*2,r=Math.round(fontSize*.18);ctx.fillStyle='rgba(0,0,0,.68)';ctx.beginPath();ctx.roundRect(x-w/2,y-h/2,w,h,r);ctx.fill();}
  ctx.fillStyle=color;ctx.shadowColor='rgba(0,0,0,.85)';ctx.shadowBlur=Math.max(2,fontSize*.12);ctx.shadowOffsetY=1;
  lines.forEach((line,i)=>ctx.fillText(line,x,y-blockHeight/2+lineHeight*(i+.5)));
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('字幕圖產生失敗')),'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export default function App(){
  const [assets,setAssets]=useState<Asset[]>([]);
  const [waveforms,setWaveforms]=useState<Record<string,number[]>>({});
  const [timelineZoom,setTimelineZoom]=useState(1);
  const [selected,setSelected]=useState('');
  const [ratio,setRatio]=useState('9:16');
  const [quality,setQuality]=useState('1080');
  const [subtitle,setSubtitle]=useState('');
  const [cues,setCues]=useState<Cue[]>([]);
  const [keepAudio,setKeepAudio]=useState(true);
  const [preserveOriginalAudio,setPreserveOriginalAudio]=useState(true);
  const [originalVolume,setOriginalVolume]=useState(80);
  const [musicVolume,setMusicVolume]=useState(22);
  const [subtitleSize,setSubtitleSize]=useState(28);
  const [subtitleColor,setSubtitleColor]=useState('#ffffff');
  const [subtitlePosition,setSubtitlePosition]=useState('bottom');
  const [subtitleBackground,setSubtitleBackground]=useState(true);
  const [previewTime,setPreviewTime]=useState(0);
  const [pendingSeek,setPendingSeek]=useState<number|null>(null);
  const videoRef=useRef<HTMLVideoElement>(null);
  const previewVideoRefs=useRef<Record<string,HTMLVideoElement|null>>({});
  const previewAudioRefs=useRef<Record<string,HTMLAudioElement|null>>({});
  const [isPlaying,setIsPlaying]=useState(false);
  const audioTrimDrag=useRef<{id:string;edge:'left'|'right';x:number;width:number;start:number;end:number}|null>(null);
  const visualMoveDrag=useRef<{id:string;x:number;width:number;start:number}|null>(null);
  const [status,setStatus]=useState('匯入影片、圖片與配樂，開始製作短影音');
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState(0);
  const [engineReady,setEngineReady]=useState(false);
  const [showStoryboard,setShowStoryboard]=useState(false);
  const [storyPrompt,setStoryPrompt]=useState('請將所有影片素材剪輯成一支有吸引力、節奏明快的房屋介紹短影音，保留重要賣點，刪除重複與空白片段。');
  const [storyDuration,setStoryDuration]=useState(60);
  const [storyPlatform,setStoryPlatform]=useState('Reels / Shorts');
  const [storyStyle,setStoryStyle]=useState('高質感房屋銷售');
  const [aiEndpoint,setAiEndpoint]=useState('');
  const [aiAccessToken,setAiAccessToken]=useState('');
  const [storyBusy,setStoryBusy]=useState(false);
  const [storyboard,setStoryboard]=useState<Array<{assetId:string;order:number;sourceStart:number;sourceEnd:number;title:string;voiceover:string;visualNote:string}>>([]);
  const [storyWarnings,setStoryWarnings]=useState<string[]>([]);
  const [storyOverallScript,setStoryOverallScript]=useState('');
  const input=useRef<HTMLInputElement>(null);
  const projectInput=useRef<HTMLInputElement>(null);
  const ffmpeg=useRef<FFmpeg|null>(null);
  const current=assets.find(a=>a.id===selected)||assets.find(a=>a.kind!=='audio')||assets[0];
  const visualAssets=assets.filter(a=>a.kind!=='audio');
  const activeVisuals=visualAssets.filter(a=>previewTime>=a.timelineStart&&previewTime<a.timelineStart+Math.max(0,a.end-a.start)).sort((a,b)=>(a.trackIndex??1)-(b.trackIndex??1));
  const currentOffset=current?.kind!=='audio'?(current?.timelineStart||0):0;
  const total=useMemo(()=>visualAssets.reduce((v,a)=>Math.max(v,Math.max(0,a.timelineStart)+Math.max(0,a.end-a.start)),0),[visualAssets]);

  useEffect(()=>{setIsPlaying(false);setPreviewTime(currentOffset);},[current?.id,currentOffset]);
  useEffect(()=>{if(!isPlaying)return;const startTime=previewTime;let frame=0;let startStamp=0;const tick=(stamp:number)=>{if(!startStamp)startStamp=stamp;const next=Math.min(total,startTime+(stamp-startStamp)/1000);setPreviewTime(next);if(next>=total){setIsPlaying(false);return;}frame=requestAnimationFrame(tick);};frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);},[isPlaying,total]);
  useEffect(()=>{for(const asset of visualAssets){const element=previewVideoRefs.current[asset.id];if(!element)continue;const duration=Math.max(0,asset.end-asset.start);const active=previewTime>=asset.timelineStart&&previewTime<asset.timelineStart+duration;if(!active){element.pause();continue;}const elapsed=Math.max(0,previewTime-asset.timelineStart),target=asset.start+Math.max(0,Math.min(duration,elapsed));const fadeIn=Math.max(0,asset.fadeIn||0),fadeOut=Math.max(0,asset.fadeOut||0),fadeLevel=Math.min(fadeIn>0?Math.min(1,elapsed/fadeIn):1,fadeOut>0?Math.min(1,(duration-elapsed)/fadeOut):1);element.muted=!preserveOriginalAudio;element.volume=Math.max(0,Math.min(1,(originalVolume/100)*(asset.volume??100)/100*fadeLevel));if(Number.isFinite(element.duration)&&Math.abs(element.currentTime-target)>.28){try{element.currentTime=target;}catch{}}if(isPlaying){if(element.paused)void element.play().catch(()=>setIsPlaying(false));}else element.pause();}for(const asset of assets.filter(item=>item.kind==='audio')){const element=previewAudioRefs.current[asset.id];if(!element)continue;const duration=Math.max(0,asset.end-asset.start),active=keepAudio&&previewTime>=asset.timelineStart&&previewTime<asset.timelineStart+duration;if(!active){element.pause();continue;}const elapsed=Math.max(0,previewTime-asset.timelineStart),target=asset.start+Math.max(0,Math.min(duration,elapsed)),fadeIn=Math.max(0,asset.fadeIn||0),fadeOut=Math.max(0,asset.fadeOut||0),fadeLevel=Math.min(fadeIn>0?Math.min(1,elapsed/fadeIn):1,fadeOut>0?Math.min(1,(duration-elapsed)/fadeOut):1);element.volume=Math.max(0,Math.min(1,(musicVolume/100)*(asset.volume??100)/100*fadeLevel));if(Number.isFinite(element.duration)&&Math.abs(element.currentTime-target)>.35){try{element.currentTime=target;}catch{}}if(isPlaying&&element.paused)void element.play().catch(()=>setIsPlaying(false));else if(!isPlaying)element.pause();}},[assets,previewTime,isPlaying,preserveOriginalAudio,originalVolume,keepAudio,musicVolume]);
  useEffect(()=>{
    const onKeyDown=(event:KeyboardEvent)=>{
      const target=event.target as HTMLElement|null;
      const tag=target?.tagName?.toLowerCase();
      if(tag==='input'||tag==='textarea'||tag==='select'||target?.isContentEditable)return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='b'){
        event.preventDefault();splitSelectedClip();return;
      }
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='d'){
        event.preventDefault();duplicateSelectedClip();return;
      }
      if(event.key==='Delete'||event.key==='Backspace'){
        if(selected){event.preventDefault();remove(selected);}return;
      }
      if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
        event.preventDefault();seekTimeline(previewTime+(event.key==='ArrowLeft'?-0.1:0.1));return;
      }
      if(event.code==='Space'&&tag!=='button'&&tag!=='video'){
        event.preventDefault();setIsPlaying(value=>!value);
      }
    };
    window.addEventListener('keydown',onKeyDown);
    return()=>window.removeEventListener('keydown',onKeyDown);
  },[selected,current?.id,current?.kind,previewTime,total,assets]);
  useEffect(()=>{const move=(event:PointerEvent)=>{const drag=audioTrimDrag.current;if(!drag)return;const delta=(event.clientX-drag.x)/Math.max(1,drag.width)*Math.max(total,.1);if(drag.edge==='left'){const start=Math.max(0,Math.min(drag.end-.1,drag.start+delta));patch(drag.id,{start:Number(start.toFixed(2))});}else{const end=Math.max(drag.start+.1,Math.min(assets.find(a=>a.id===drag.id)?.duration||Infinity,drag.end+delta));patch(drag.id,{end:Number(end.toFixed(2))});}};const up=()=>{audioTrimDrag.current=null;};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};},[total,assets]);
  useEffect(()=>{const move=(event:PointerEvent)=>{const drag=visualMoveDrag.current;if(!drag)return;const delta=(event.clientX-drag.x)/Math.max(1,drag.width)*Math.max(total,.1);patch(drag.id,{timelineStart:Number(Math.max(0,drag.start+delta).toFixed(2))});};const up=()=>{visualMoveDrag.current=null;};window.addEventListener('pointermove',move);window.addEventListener('pointerup',up);return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);};},[total]);
  useEffect(()=>{let cancelled=false;const pending=assets.filter(a=>a.kind==='audio'&&!waveforms[a.id]&&a.file.size<80*1024*1024);if(!pending.length)return;const Context=window.AudioContext||(window as any).webkitAudioContext;if(!Context)return;const context=new Context();void Promise.all(pending.map(async asset=>{try{const decoded=await context.decodeAudioData(await asset.file.arrayBuffer());const channel=decoded.getChannelData(0),bins=180,step=Math.max(1,Math.floor(channel.length/bins)),peaks:number[]=[];for(let i=0;i<bins;i++){let peak=0;for(let j=i*step;j<Math.min(channel.length,(i+1)*step);j++)peak=Math.max(peak,Math.abs(channel[j]));peaks.push(peak);}return [asset.id,peaks] as const;}catch{return [asset.id,[]] as const;}})).then(results=>{if(!cancelled)setWaveforms(old=>({...old,...Object.fromEntries(results)}));}).finally(()=>{void context.close();});return()=>{cancelled=true;};},[assets]);
  useEffect(()=>{if(pendingSeek===null)return;setPreviewTime(pendingSeek);setPendingSeek(null);},[pendingSeek]);
  useEffect(()=>()=>assets.forEach(a=>URL.revokeObjectURL(a.url)),[]);

  async function testAIConnection(){
    let endpoint=aiEndpoint.trim();while(endpoint.endsWith('/'))endpoint=endpoint.slice(0,-1);
    if(!endpoint){setStatus('請先輸入 Cloudflare Worker 網址。');return;}
    setStoryBusy(true);setStatus('正在測試 AI 後端連線…');
    try{
      const response=await fetch(endpoint+'/health');
      const data=await response.json();
      if(!response.ok||!data.ok)throw new Error(data.error||'健康檢查未通過');
      setStatus(data.ready?'AI 後端連線正常，Worker 與必要 Secrets 已就緒。':'Worker 已連線，但尚未設定 GEMINI_API_KEY 或 APP_TOKEN。');
    }catch(error){setStatus('後端連線失敗：'+(error instanceof Error?error.message:'請確認網址、部署狀態與 CORS 設定。'));}
    finally{setStoryBusy(false);}
  }
  async function generateStoryboard(){
    const videos=assets.filter(a=>a.kind==='video'&&a.duration>0);
    if(!videos.length){setStatus('請先匯入至少一段影片，並等待讀取完成片長。');return;}
    if(videos.length>12){setStatus('單次最多分析 12 段影片，請先減少素材數量。');return;}
    const oversized=videos.find(asset=>asset.file.size>12*1024*1024);
    if(oversized){setStatus('影片「'+oversized.file.name+'」超過單段 12MB 限制，請先壓縮或切成較小片段。');return;}
    const uploadBytes=videos.reduce((sum,asset)=>sum+asset.file.size,0);
    if(uploadBytes>45*1024*1024){setStatus('全部影片合計超過 45MB，請分批或壓縮素材後再分析。');return;}
    if(!aiEndpoint.trim()){setStatus('尚未設定 AI 分析服務網址。請先部署 AI 後端，再填入 API Endpoint；目前不會假裝已分析影片內容。');return;}
    if(!aiAccessToken.trim()){setStatus('請輸入 Worker APP_TOKEN，這是 AI 後端的存取驗證。');return;}
    let endpoint=aiEndpoint.trim();while(endpoint.endsWith('/'))endpoint=endpoint.slice(0,-1);
    setStoryBusy(true);setStatus('正在上傳全部影片，交由 AI 分析畫面與語音…');
    try{
      const form=new FormData();
      form.append('prompt',storyPrompt);form.append('targetDuration',String(storyDuration));form.append('platform',storyPlatform);form.append('style',storyStyle);
      form.append('assets',JSON.stringify(videos.map(a=>({id:a.id,name:a.file.name,duration:a.duration,mimeType:a.file.type}))));
      videos.forEach((asset,index)=>form.append('videos',asset.file,asset.file.name));
      const response=await fetch(endpoint,{method:'POST',headers:{Authorization:'Bearer '+aiAccessToken.trim()},body:form});
      if(!response.ok)throw new Error('AI 服務回應 '+response.status+'：'+(await response.text()).slice(0,240));
      const data=await response.json();
      if(!Array.isArray(data.scenes)||!data.scenes.length)throw new Error('AI 回傳格式錯誤：找不到 scenes 分鏡陣列。');
      const normalized=data.scenes.map((scene:any,index:number)=>{
        const asset=videos.find(a=>a.id===scene.assetId);
        if(!asset)throw new Error('AI 回傳了不存在的素材 ID：'+String(scene.assetId));
        const sourceStart=Math.max(0,Math.min(Math.max(0,asset.duration-.2),Number(scene.sourceStart)||0));
        const sourceEnd=Math.min(asset.duration,Math.max(sourceStart+.2,Number(scene.sourceEnd)||asset.duration));
        return {assetId:asset.id,order:index+1,sourceStart,sourceEnd,title:String(scene.title||'重點畫面 '+(index+1)),voiceover:String(scene.voiceover||''),visualNote:String(scene.visualNote||'')};
      });
      setStoryboard(normalized);setStoryWarnings(Array.isArray(data.warnings)?data.warnings.map(String):[]);setStoryOverallScript(String(data.overallScript||''));setStatus('AI 已完成 '+normalized.length+' 個分鏡，請檢查後套用至時間軸。');
    }catch(error){console.error(error);setStatus('AI 分析失敗：'+(error instanceof Error?error.message:'請檢查服務網址與後端設定。'));}
    finally{setStoryBusy(false);}
  }
  function applyStoryboard(){
    if(!storyboard.length){setStatus('請先完成 AI 分析並產生分鏡。');return;}
    const ordered=[...storyboard].sort((a,b)=>a.order-b.order);
    let cursor=0;
    const clips:Asset[]=ordered.flatMap(scene=>{
      const source=assets.find(a=>a.id===scene.assetId&&a.kind==='video');
      if(!source)return [];
      const start=Math.max(0,Math.min(source.duration,scene.sourceStart));
      const end=Math.max(start+.2,Math.min(source.duration,scene.sourceEnd));
      const clip:Asset={...source,id:crypto.randomUUID(),url:URL.createObjectURL(source.file),start,end,timelineStart:Number(cursor.toFixed(2)),trackIndex:1,fadeIn:.25,fadeOut:.25};
      cursor+=Math.max(.2,end-start);
      return [clip];
    });
    if(!clips.length){setStatus('分鏡中的原始影片已不存在，請重新分析。');return;}
    assets.filter(a=>a.kind==='video').forEach(a=>URL.revokeObjectURL(a.url));
    setAssets([...assets.filter(a=>a.kind!=='video'),...clips]);setSelected(clips[0].id);setPreviewTime(0);setIsPlaying(false);
    const script=ordered.map(scene=>scene.voiceover).filter(Boolean);
    if(script.length)syncSubtitle(script.join('\\n'));
    setShowStoryboard(false);setStatus('已將 '+clips.length+' 個 AI 精華片段依分鏡順序建立至 V1 時間軸（原片未覆蓋，素材清單以剪輯片段取代）。');
  }
  async function saveProject(){
    if(!assets.length){setStatus('目前沒有素材可儲存。');return;}
    setBusy(true);setStatus('正在封裝專案與素材，檔案較大時請稍候…');
    try{
      const savedAssets=await Promise.all(assets.map(async asset=>({
        id:asset.id,name:asset.file.name,type:asset.file.type,kind:asset.kind,duration:asset.duration,start:asset.start,end:asset.end,fadeIn:asset.fadeIn,fadeOut:asset.fadeOut,volume:asset.volume,opacity:asset.opacity??100,timelineStart:asset.timelineStart,trackIndex:asset.trackIndex??1,
        dataUrl:await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('讀取素材失敗'));reader.readAsDataURL(asset.file);})
      })));
      const project={format:'ai-video-studio-project',version:1,savedAt:new Date().toISOString(),settings:{ratio,quality,subtitle,cues,keepAudio,preserveOriginalAudio,originalVolume,musicVolume,subtitleSize,subtitleColor,subtitlePosition,subtitleBackground},assets:savedAssets};
      const blob=new Blob([JSON.stringify(project)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');
      link.href=url;link.download='ai-video-studio-project.json';link.click();URL.revokeObjectURL(url);
      setStatus('專案已儲存，JSON 檔內含素材，可在下次匯入還原。');
    }catch(error){console.error(error);setStatus('專案儲存失敗，可能是素材總容量過大。');}
    finally{setBusy(false);}
  }
  async function loadProject(file:File|null){
    if(!file)return;
    setBusy(true);setStatus('正在讀取專案與還原素材…');
    try{
      const project=JSON.parse(await file.text());
      if(project.format!=='ai-video-studio-project'||project.version!==1||!Array.isArray(project.assets)||!project.settings)throw new Error('專案格式不相容');
      const restored:Asset[]=await Promise.all(project.assets.map(async (item:any)=>{
        if(typeof item.dataUrl!=='string'||typeof item.name!=='string'||!['video','image','audio'].includes(item.kind))throw new Error('專案素材資料不完整');
        const blob=await fetch(item.dataUrl).then(response=>response.blob());
        const media=new File([blob],item.name,{type:item.type||blob.type||'application/octet-stream'});
        return {id:String(item.id||crypto.randomUUID()),file:media,url:URL.createObjectURL(media),kind:item.kind as Asset['kind'],duration:Number(item.duration)||0,start:Number(item.start)||0,end:Number(item.end)||0,fadeIn:Number(item.fadeIn)||0,fadeOut:Number(item.fadeOut)||0,volume:Number(item.volume??100),opacity:Math.max(0,Math.min(100,Number(item.opacity??100))),timelineStart:Number(item.timelineStart)||0,trackIndex:Math.max(1,Math.min(3,Number(item.trackIndex)||1))};
      }));
      const legacyVisual=restored.filter(asset=>asset.kind!=='audio');
      if(legacyVisual.length>1&&legacyVisual.every(asset=>asset.timelineStart===0)){let cursor=0;legacyVisual.forEach(asset=>{asset.timelineStart=cursor;cursor+=Math.max(0,asset.end-asset.start);});}
      assets.forEach(asset=>URL.revokeObjectURL(asset.url));
      const settings=project.settings;
      setAssets(restored);setSelected(restored.find(asset=>asset.kind!=='audio')?.id||restored[0]?.id||'');
      if(['9:16','16:9','1:1'].includes(settings.ratio))setRatio(settings.ratio);
      if(['1080','4k'].includes(settings.quality))setQuality(settings.quality);
      setSubtitle(String(settings.subtitle||''));setCues(Array.isArray(settings.cues)?settings.cues:[]);
      setKeepAudio(Boolean(settings.keepAudio));setPreserveOriginalAudio(Boolean(settings.preserveOriginalAudio));
      setOriginalVolume(Number(settings.originalVolume??80));setMusicVolume(Number(settings.musicVolume??22));
      setSubtitleSize(Number(settings.subtitleSize??28));setSubtitleColor(/^#[0-9a-f]{6}$/i.test(settings.subtitleColor)?settings.subtitleColor:'#ffffff');
      if(['top','center','bottom'].includes(settings.subtitlePosition))setSubtitlePosition(settings.subtitlePosition);
      setSubtitleBackground(settings.subtitleBackground!==false);
      restored.filter(asset=>asset.kind!=='image'&&!asset.duration).forEach(asset=>{const probe=document.createElement(asset.kind==='video'?'video':'audio');probe.preload='metadata';probe.src=asset.url;probe.onloadedmetadata=()=>updateDuration(asset.id,probe.duration);});
      setStatus('專案已還原，共 '+restored.length+' 個素材。');
    }catch(error){console.error(error);setStatus('專案載入失敗：請確認是 AI Video Studio 匯出的有效 JSON 專案。');}
    finally{setBusy(false);}
  }

  function importFiles(list:FileList|null){
    if(!list)return;
    let cursor=visualAssets.reduce((v,a)=>Math.max(v,a.timelineStart+Math.max(0,a.end-a.start)),0);const next=Array.from(list).filter(f=>/^(video|image|audio)\//.test(f.type)).map(file=>{const kind=(file.type.startsWith('video/')?'video':file.type.startsWith('image/')?'image':'audio') as Asset['kind'],duration=file.type.startsWith('image/')?5:0,timelineStart=kind==='audio'?0:cursor;if(kind!=='audio')cursor+=duration;return {id:crypto.randomUUID(),file,url:URL.createObjectURL(file),kind,duration,start:0,end:duration,fadeIn:0,fadeOut:0,volume:100,opacity:100,timelineStart,trackIndex:1};});
    setAssets(old=>[...old,...next]); if(next[0])setSelected(next[0].id);
    next.filter(a=>a.kind==='video').forEach(a=>{const probe=document.createElement('video');probe.preload='metadata';probe.src=a.url;probe.onloadedmetadata=()=>updateDuration(a.id,probe.duration);});
    next.filter(a=>a.kind==='audio').forEach(a=>{const probe=document.createElement('audio');probe.preload='metadata';probe.src=a.url;probe.onloadedmetadata=()=>updateDuration(a.id,probe.duration);});
    setStatus(next.length?'已匯入 '+next.length+' 個素材':'沒有找到支援的素材格式');
  }
  function updateDuration(id:string,duration:number){setAssets(old=>{const index=old.findIndex(a=>a.id===id);if(index<0)return old;const target=old[index],oldDuration=Math.max(0,target.end-target.start),nextEnd=target.end||duration,delta=Math.max(0,duration)-oldDuration;if(!delta)return old.map(a=>a.id===id?{...a,duration,end:nextEnd}:a);const oldEnd=target.timelineStart+oldDuration;return old.map((a,i)=>a.id===id?{...a,duration,end:nextEnd}:i>index&&a.kind!=='audio'&&a.timelineStart>=oldEnd-.01?{...a,timelineStart:Math.max(0,a.timelineStart+delta)}:a);});}
  function patch(id:string,p:Partial<Asset>){setAssets(old=>old.map(a=>a.id===id?{...a,...p}:a));}
  function reorder(id:string,step:number){setAssets(old=>{const i=old.findIndex(a=>a.id===id),j=i+step;if(i<0||j<0||j>=old.length)return old;const copy=[...old];[copy[i],copy[j]]=[copy[j],copy[i]];return copy;});}
  function seekTimeline(value:number){
    setIsPlaying(false);
    const targetTime=Math.max(0,Math.min(total,value));
    if(!visualAssets.length)return;
    const target=visualAssets.filter(asset=>targetTime>=asset.timelineStart&&targetTime<=asset.timelineStart+Math.max(0,asset.end-asset.start)).sort((x,y)=>y.timelineStart-x.timelineStart)[0]||[...visualAssets].sort((x,y)=>Math.abs((x.timelineStart+Math.max(0,x.end-x.start)/2)-targetTime)-Math.abs((y.timelineStart+Math.max(0,y.end-y.start)/2)-targetTime))[0];
    setSelected(target.id);
    setPendingSeek(targetTime);
  }
  function duplicateSelectedClip(){
    const target=assets.find(a=>a.id===selected&&a.kind!=='audio');
    if(!target){setStatus('請先選取要複製的影片或圖片片段。');return;}
    const copy:Asset={...target,id:crypto.randomUUID(),url:URL.createObjectURL(target.file),timelineStart:target.timelineStart+Math.max(0,target.end-target.start)};
    setAssets(old=>{const index=old.findIndex(a=>a.id===target.id);if(index<0){URL.revokeObjectURL(copy.url);return old;}const next=[...old];next.splice(index+1,0,copy);return next;});
    setSelected(copy.id);setStatus('已複製片段，並保留獨立的裁切與淡入淡出設定。');
  }
  function splitSelectedClip(){
    const target=assets.find(a=>a.id===selected&&a.kind!=='audio');
    if(!target){setStatus('請先選取要切割的影片或圖片片段。');return;}
    const localTime=target.start+(previewTime-currentOffset);
    if(localTime<=target.start+.1||localTime>=target.end-.1){setStatus('播放頭需位於片段中間，並保留至少 0.1 秒。');return;}
    const second:Asset={...target,id:crypto.randomUUID(),start:Number(localTime.toFixed(2)),end:target.end,timelineStart:target.timelineStart+Math.max(0,localTime-target.start)};
    setAssets(old=>{const index=old.findIndex(a=>a.id===target.id);if(index<0)return old;const next=[...old];next[index]={...next[index],end:second.start};next.splice(index+1,0,second);return next;});
    setSelected(second.id);setStatus('片段已在播放頭位置切割成兩段。');
  }
  function moveAsset(sourceId:string,targetId:string){
    if(!sourceId||!targetId||sourceId===targetId)return;
    setAssets(old=>{const from=old.findIndex(a=>a.id===sourceId),to=old.findIndex(a=>a.id===targetId);if(from<0||to<0)return old;const next=[...old];const [item]=next.splice(from,1);next.splice(to,0,item);return next;});
  }
  function handleFileDrop(event:React.DragEvent){
    if(!event.dataTransfer.files.length)return;
    event.preventDefault();importFiles(event.dataTransfer.files);
  }
  function remove(id:string){setAssets(old=>{const a=old.find(x=>x.id===id);if(a)URL.revokeObjectURL(a.url);return old.filter(x=>x.id!==id)});setWaveforms(old=>{const next={...old};delete next[id];return next;});if(selected===id)setSelected('');}
  async function loadEngine(){
    if(ffmpeg.current)return ffmpeg.current;
    const engine=new FFmpeg();
    engine.on('log',({message})=>setStatus(message.slice(-100)));
    engine.on('progress',({progress:p})=>setProgress(Math.min(99,Math.round(p*100))));
    setStatus('首次載入影片引擎中，請稍候…');
    const base='https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
    await engine.load({coreURL:await toBlobURL(base+'/ffmpeg-core.js','text/javascript'),wasmURL:await toBlobURL(base+'/ffmpeg-core.wasm','application/wasm')});
    ffmpeg.current=engine;setEngineReady(true);return engine;
  }
  function syncSubtitle(value:string){
    setSubtitle(value);
    const lines=value.split('\n').map(s=>s.trim()).filter(Boolean);
    const slot=Math.max(0.5,(total||lines.length*3)/Math.max(lines.length,1));
    setCues(lines.map((text,i)=>({id:'cue_'+i+'_'+text.length,text,start:Number((i*slot).toFixed(2)),end:Number(Math.min(total||lines.length*slot,(i+1)*slot).toFixed(2))})));
  }
  function patchCue(id:string,patch:Partial<Cue>){
    setCues(old=>old.map(c=>c.id===id?{...c,...patch}:c));
  }
  function removeCue(id:string){
    const next=cues.filter(c=>c.id!==id);
    setCues(next);setSubtitle(next.map(c=>c.text).join('\n'));
  }
  function jumpToCue(cue:Cue){
    setIsPlaying(false);
    let offset=0;
    const target=visualAssets.find(asset=>{const end=offset+Math.max(0,asset.end-asset.start);const hit=cue.start>=offset&&cue.start<=end; if(!hit)offset=end;return hit;});
    if(target){setSelected(target.id);setPendingSeek(cue.start);}
  }
  function addCue(){
    const start=cues.length?Math.max(...cues.map(c=>c.end)):0;
    const cue={id:crypto.randomUUID(),text:'新字幕',start:Number(start.toFixed(2)),end:Number((start+3).toFixed(2))};
    setCues(old=>[...old,cue]);setSubtitle(old=>old?old+'\n'+cue.text:cue.text);
  }
  async function importSrt(file:File|null){
    if(!file)return;
    const raw=await file.text();
    let endpoint=aiEndpoint.trim();while(endpoint.endsWith('/'))endpoint=endpoint.slice(0,-1);
    const parsed:Cue[]=[];
    for(const block of blocks){
      const lines=block.split('\n');
      const timeLine=lines.find(line=>line.includes('-->'));
      if(!timeLine)continue;
      const match=timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if(!match)continue;
      const toSeconds=(h:string,m:string,s:string,ms:string)=>Number(h)*3600+Number(m)*60+Number(s)+Number(ms)/1000;
      const start=toSeconds(match[1],match[2],match[3],match[4]),end=toSeconds(match[5],match[6],match[7],match[8]);
      let endpoint=aiEndpoint.trim();while(endpoint.endsWith('/'))endpoint=endpoint.slice(0,-1);
      if(text&&end>start)parsed.push({id:crypto.randomUUID(),text,start,end});
    }
    if(!parsed.length){setStatus('找不到有效的 SRT 字幕內容，請確認檔案格式。');return;}
    setCues(parsed);setSubtitle(parsed.map(c=>c.text).join('\n'));setStatus('已匯入 '+parsed.length+' 段 SRT 字幕。');
  }
  function downloadSrt(){
    const valid=cues.filter(c=>c.text.trim()&&c.end>c.start).sort((a,b)=>a.start-b.start);
    if(!valid.length){setStatus('請先新增有效字幕，並確認結束時間大於開始時間。');return;}
    const fmt=(v:number)=>{const ms=Math.round(v*1000),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),x=ms%1000;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+','+String(x).padStart(3,'0')};
    const srt=valid.map((cue,i)=>(i+1)+'\n'+fmt(cue.start)+' --> '+fmt(cue.end)+'\n'+cue.text).join('\n\n');
    const url=URL.createObjectURL(new Blob([srt],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='subtitles.srt';a.click();URL.revokeObjectURL(url);setStatus('SRT 字幕檔已匯出（依各段自訂時間）。');
  }
  function silentWav(seconds:number){
    const sampleRate=44100,channels=2,bits=16,samples=Math.max(1,Math.ceil(seconds*sampleRate)),dataSize=samples*channels*(bits/8);
    const buffer=new ArrayBuffer(44+dataSize),view=new DataView(buffer);
    const write=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
    write(0,'RIFF');view.setUint32(4,36+dataSize,true);write(8,'WAVE');write(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*channels*bits/8,true);view.setUint16(32,channels*bits/8,true);view.setUint16(34,bits,true);write(36,'data');view.setUint32(40,dataSize,true);
    return new Uint8Array(buffer);
  }
  async function exportMp4(){
    const clips=assets.filter(a=>a.kind!=='audio'&&a.end>a.start).sort((a,b)=>(a.trackIndex??1)-(b.trackIndex??1));
    const soundtracks=assets.filter(a=>a.kind==='audio');
    if(!clips.length){setStatus('請先匯入影片或圖片素材。');return;}
    setBusy(true);setProgress(0);
    try{
      const engine=await loadEngine();
      const width=ratio==='9:16'?(quality==='4k'?2160:1080):ratio==='1:1'?(quality==='4k'?2160:1080):(quality==='4k'?3840:1920);
      const height=ratio==='9:16'?(quality==='4k'?3840:1920):ratio==='1:1'?(quality==='4k'?2160:1080):(quality==='4k'?2160:1080);
      const names:string[]=[];
      const audioNames:string[]=[];
      for(let i=0;i<clips.length;i++){
        const a=clips[i],outputName='part_'+i+'.mp4';
        let endpoint=aiEndpoint.trim();while(endpoint.endsWith('/'))endpoint=endpoint.slice(0,-1);
        await engine.writeFile(inputName,await fetchFile(a.file));
        const duration=Math.max(.1,a.end-a.start),fadeIn=Math.min(duration,a.fadeIn||0),fadeOut=Math.min(duration,a.fadeOut||0);
        const fadeFilters=[fadeIn>0?'fade=t=in:st=0:d='+fadeIn.toFixed(2):'',fadeOut>0?'fade=t=out:st='+Math.max(0,duration-fadeOut).toFixed(2)+':d='+fadeOut.toFixed(2):''].filter(Boolean);
        const vf=['scale='+width+':'+height+':force_original_aspect_ratio=decrease','pad='+width+':'+height+':(ow-iw)/2:(oh-ih)/2','fps=30',...fadeFilters,'format=yuv420p'].join(',');
        const args=a.kind==='image'?['-loop','1','-framerate','30','-i',inputName,'-t',String(Math.max(.1,a.end-a.start)),'-vf',vf,'-an','-c:v','libx264','-preset','ultrafast','-crf',quality==='4k'?'21':'23','-pix_fmt','yuv420p',outputName]:['-ss',String(a.start),'-i',inputName,'-t',String(Math.max(.1,a.end-a.start)),'-vf',vf,'-an','-c:v','libx264','-preset','ultrafast','-crf',quality==='4k'?'21':'23','-pix_fmt','yuv420p',outputName];
        setStatus('正在處理素材 '+(i+1)+' / '+clips.length+'…');
        const code=await engine.exec(args);if(code!==0)throw new Error('素材轉檔失敗');
        names.push(outputName);
        if(preserveOriginalAudio){
          const audioName='audio_'+i+'.wav',duration=Math.max(.1,a.end-a.start);
          const audioFades=[fadeIn>0?'afade=t=in:st=0:d='+fadeIn.toFixed(2):'',fadeOut>0?'afade=t=out:st='+Math.max(0,duration-fadeOut).toFixed(2)+':d='+fadeOut.toFixed(2):''].filter(Boolean);
          let audioCode=1;
          if(a.kind==='video'){
            try{audioCode=await engine.exec(['-ss',String(a.start),'-i',inputName,'-t',String(duration),'-vn',...(audioFades.length?['-af',audioFades.join(',')]:[]),'-ac','2','-ar','44100','-c:a','pcm_s16le',audioName]);}
            catch{audioCode=1;}
          }
          if(a.kind==='image'||audioCode!==0)await engine.writeFile(audioName,silentWav(duration));
          audioNames.push(audioName);
        }
      }
      setStatus('正在合併多位置影片片段與字幕…');
      const finalArgs=['-f','lavfi','-i','color=c=black:s='+width+'x'+height+':r=30:d='+Math.max(.1,total)];for(const name of names)finalArgs.push('-i',name);
      const validCues=cues.filter(c=>c.text.trim()&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.end>c.start&&c.start<total).sort((a,b)=>a.start-b.start);
      const subtitleIndexes:number[]=[];
      for(let i=0;i<validCues.length;i++){
        const cue=validCues[i],pngName='subtitle_'+i+'.png';
        const png=await makeSubtitlePng(cue,width,height,subtitleSize,subtitleColor,subtitlePosition,subtitleBackground);
        await engine.writeFile(pngName,png);
        subtitleIndexes.push(1+clips.length+i);
        finalArgs.push('-loop','1','-framerate','30','-i',pngName);
      }
      let nextInput=1+clips.length+validCues.length;
      const originalIndexes:number[]=[];
      const musicIndexes:number[]=[];
      if(preserveOriginalAudio&&audioNames.length){for(const name of audioNames){finalArgs.push('-i',name);originalIndexes.push(nextInput++);}}
      if(keepAudio&&soundtracks.length){
        for(let i=0;i<soundtracks.length;i++){
          let endpoint=aiEndpoint.trim();while(endpoint.endsWith('/'))endpoint=endpoint.slice(0,-1);
          await engine.writeFile(audioName,await fetchFile(soundtrack.file));
          finalArgs.push('-stream_loop','-1','-ss',String(Math.max(0,soundtrack.start)),'-i',audioName);
          musicIndexes.push(nextInput++);
        }
      }
      const filters:string[]=[];
      let previous='0:v:0';
      clips.forEach((clip,i)=>{const start=Math.max(0,clip.timelineStart),end=Math.min(total,start+Math.max(0,clip.end-clip.start)),inputIndex=1+i,shifted='clippts'+i,output='vclip'+i;filters.push('['+inputIndex+':v]format=rgba,colorchannelmixer=aa='+(Math.max(0,Math.min(100,clip.opacity??100))/100).toFixed(3)+',setpts=PTS-STARTPTS+'+start.toFixed(3)+'/TB['+shifted+']');filters.push('['+previous+']['+shifted+']overlay=0:0:eof_action=pass:enable=\'between(t,'+start.toFixed(3)+','+end.toFixed(3)+')\'['+output+']');previous=output;});
      let videoMap='['+previous+']';
      if(validCues.length){
        validCues.forEach((cue,i)=>{
          const output='vsub'+i;
          const from=Math.max(0,cue.start),to=Math.min(total,cue.end);
          filters.push("["+previous+"]["+subtitleIndexes[i]+":v]overlay=0:0:enable='between(t,"+from.toFixed(3)+","+to.toFixed(3)+")'["+output+"]");
          previous=output;
        });
        videoMap='['+previous+']';
      }
      let audioMap='';
      const audioInputs:string[]=[];
      originalIndexes.forEach((index,i)=>{const clip=clips[i],delay=Math.max(0,clip.timelineStart)*1000,label='orig'+i;filters.push('['+index+':a]asetpts=PTS-STARTPTS,volume='+(originalVolume/100)*(Math.max(0,Math.min(200,clip.volume??100))/100)+',adelay='+Math.round(delay)+'|'+Math.round(delay)+'['+label+']');audioInputs.push('['+label+']');});
      musicIndexes.forEach((index,i)=>{const track=soundtracks[i],label='music'+i,trackLength=Math.max(0,Math.min(total-track.timelineStart,track.end-track.start)),delay=Math.max(0,Math.min(total,track.timelineStart))*1000,level=(musicVolume/100)*(Math.max(0,Math.min(200,track.volume))/100),fadeIn=Math.min(trackLength,Math.max(0,track.fadeIn||0)),fadeOut=Math.min(trackLength,Math.max(0,track.fadeOut||0)),fadeFilters=[fadeIn>0?'afade=t=in:st=0:d='+fadeIn.toFixed(3):'',fadeOut>0?'afade=t=out:st='+Math.max(0,trackLength-fadeOut).toFixed(3)+':d='+fadeOut.toFixed(3):''].filter(Boolean);filters.push('['+index+':a]atrim=duration='+trackLength.toFixed(3)+',asetpts=PTS-STARTPTS,volume='+level+(fadeFilters.length?','+fadeFilters.join(','):'')+',adelay='+Math.round(delay)+'|'+Math.round(delay)+'['+label+']');audioInputs.push('['+label+']');});
      if(audioInputs.length===1){audioMap=audioInputs[0];}
      else if(audioInputs.length>1){filters.push(audioInputs.join('')+'amix=inputs='+audioInputs.length+':duration=longest:dropout_transition=2[aout]');audioMap='[aout]';}
      if(filters.length)finalArgs.push('-filter_complex',filters.join(';'));
      finalArgs.push('-map',videoMap);
      if(audioMap)finalArgs.push('-map',audioMap);else finalArgs.push('-an');
      finalArgs.push('-c:v','libx264','-preset','ultrafast','-crf',quality==='4k'?'21':'23','-pix_fmt','yuv420p');
      if(audioMap)finalArgs.push('-c:a','aac','-b:a','192k');
      finalArgs.push('-t',String(Math.max(.1,total)),'-movflags','+faststart','final.mp4');
      const code=await engine.exec(finalArgs);if(code!==0)throw new Error('影片合併或字幕合成失敗');
      const data=await engine.readFile('final.mp4');
      const blob=new Blob([new Uint8Array(data as Uint8Array).buffer as ArrayBuffer],{type:'video/mp4'}),url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download='ai-video-studio-export.mp4';a.click();URL.revokeObjectURL(url);
      setProgress(100);setStatus('MP4 輸出完成，已開始下載。');
    }catch(err){console.error(err);setStatus('輸出失敗：可能是素材編碼不相容或裝置記憶體不足。請先縮短影片並嘗試 1080P。');}
    finally{setBusy(false);}
  }
  function videosAvailable(){return assets.some(a=>a.kind==='video'&&a.duration>0);}
  return <div className="app" onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDrop={handleFileDrop}>
    <header className="topbar"><a className="brand" href="#"><span className="brandIcon">▶</span><span>AI VIDEO <b>STUDIO</b><small>CREATIVE WORKSPACE</small></span></a><div className="topRight"><span className="local"><i/> 本機處理</span><button className="btn" disabled={busy} onClick={()=>projectInput.current?.click()}>開啟專案</button><button className="btn" disabled={busy||!assets.length} onClick={saveProject}>儲存專案</button><button className="btn" onClick={()=>input.current?.click()}>＋ 匯入素材</button><button className="btn primary" disabled={busy||!assets.some(a=>a.kind!=='audio')} onClick={exportMp4}>{busy?'製作中…':'輸出 MP4 ↗'}</button></div></header>
    <div className="layout"><aside className="sidebar"><div className="sideTitle">WORKSPACE</div><div className="nav active">▧　影片剪輯工作台</div><div className="nav" onClick={()=>setShowStoryboard(true)}>✧　AI 腳本與分鏡</div><div className="nav" onClick={()=>setStatus('字幕辨識及時間軸編輯：規劃於下一階段接入')}>▤　字幕工作室</div><div className="engine"><i/> <b>本機影音引擎</b><small>{engineReady?'已載入':'輸出時啟動'}</small></div><p className="privacy">素材目前只在你的裝置中處理，不會自動上傳。</p></aside>
    <main className="main"><div className="heading"><div><div className="eyebrow">VIDEO EDITOR / 01</div><h1>影片剪輯工作台</h1><p>匯入素材、調整片段，製作你的下一支短影音。</p></div><span className="project">未命名專案　·　本機工作階段</span></div>
    <div className="editorGrid"><section className="panel preview"><div className="panelHead"><b>影片預覽</b><span>即時素材檢視</span></div><div className={'stage '+(ratio==='9:16'?'vertical':ratio==='1:1'?'square':'horizontal')}>{activeVisuals.length>0?<div className="previewComposite">{activeVisuals.map(asset=><div className={'previewLayer trackLayer'+(asset.trackIndex??1)} key={asset.id} style={{zIndex:asset.trackIndex??1,opacity:Math.max(0,Math.min(100,asset.opacity??100))/100*Math.min(asset.fadeIn>0?Math.min(1,(previewTime-asset.timelineStart)/asset.fadeIn):1,asset.fadeOut>0?Math.min(1,(asset.timelineStart+asset.end-asset.start-previewTime)/asset.fadeOut):1)}}>{asset.kind==='video'?<video ref={element=>{previewVideoRefs.current[asset.id]=element;}} src={asset.url} muted={!preserveOriginalAudio} playsInline preload="auto" onLoadedMetadata={e=>{const local=asset.start+Math.max(0,Math.min(asset.end-asset.start,previewTime-asset.timelineStart));e.currentTarget.currentTime=local;}}/>:<img src={asset.url}/>}</div>)}</div>:<div className="empty"><div className="orb">▶</div><b>{visualAssets.length?'播放頭目前沒有影像片段':'準備開始創作'}</b><span>{visualAssets.length?'移動播放頭或調整片段位置':'匯入影片或圖片素材'}</span>{!visualAssets.length&&<button className="btn primary" onClick={()=>input.current?.click()}>選擇素材</button>}</div>}{current&&cues.find(cue=>previewTime>=cue.start&&previewTime<=cue.end)&&<div className={'subtitleOverlay '+subtitlePosition} style={{fontSize:subtitleSize,color:subtitleColor,background:subtitleBackground?'rgba(0,0,0,.62)':'transparent'}}>{cues.find(cue=>previewTime>=cue.start&&previewTime<=cue.end)?.text}</div>}</div><div className="previewFoot"><span className="previewTransport"><button className="btn compact" onClick={()=>{setIsPlaying(false);setPreviewTime(Math.max(0,previewTime-.1));}}>−0.1s</button><button className="btn compact" onClick={()=>{if(!isPlaying&&previewTime>=total)setPreviewTime(0);setIsPlaying(value=>!value);}}>{isPlaying?'Ⅱ 暫停':'▶ 播放'}</button><button className="btn compact" onClick={()=>{setIsPlaying(false);setPreviewTime(Math.min(total,previewTime+.1));}}>+0.1s</button><b>{time(previewTime)} / {time(total)}</b></span><span>{activeVisuals.length} 個圖層 · {ratio} · {quality==='4k'?'4K UHD':'1080P'}</span></div></section>
    <section className="panel settings"><div className="panelHead"><b>專案設定</b><span className="tag">EDITOR</span></div><label>影片比例</label><div className="choices">{['9:16','16:9','1:1'].map(v=><button className={ratio===v?'choice selected':'choice'} key={v} onClick={()=>setRatio(v)}>{v}</button>)}</div><label>輸出畫質</label><div className="choices"><button className={quality==='1080'?'choice selected':'choice'} onClick={()=>setQuality('1080')}>1080P</button><button className={quality==='4k'?'choice selected':'choice'} onClick={()=>setQuality('4k')}>4K UHD</button></div><label className="check"><input type="checkbox" checked={preserveOriginalAudio} onChange={e=>setPreserveOriginalAudio(e.target.checked)}/> 保留原影片聲音</label>{preserveOriginalAudio&&<label className="volumeControl">原片音量 <b>{originalVolume}%</b><input type="range" min="0" max="150" step="5" value={originalVolume} onChange={e=>setOriginalVolume(Number(e.target.value))}/></label>}<label className="check"><input type="checkbox" checked={keepAudio} onChange={e=>setKeepAudio(e.target.checked)}/> 混音多條背景音軌（可匯入多個音訊）</label>{keepAudio&&<label className="volumeControl">所有配樂音量 <b>{musicVolume}%</b><input type="range" min="0" max="100" step="5" value={musicVolume} onChange={e=>setMusicVolume(Number(e.target.value))}/></label>}<div className="subtitleHead"><label>字幕文案（每行一段）</label><button type="button" className="btn compact" onClick={()=>document.getElementById('srtInput')?.click()}>匯入 SRT</button></div><div className="subtitleStyle"><label>字體大小 <b>{subtitleSize}px</b><input type="range" min="14" max="48" step="1" value={subtitleSize} onChange={e=>setSubtitleSize(Number(e.target.value))}/></label><label>文字顏色 <input type="color" value={subtitleColor} onChange={e=>setSubtitleColor(e.target.value)}/></label><label>字幕位置 <select value={subtitlePosition} onChange={e=>setSubtitlePosition(e.target.value)}><option value="top">上方</option><option value="center">置中</option><option value="bottom">下方</option></select></label><label className="check"><input type="checkbox" checked={subtitleBackground} onChange={e=>setSubtitleBackground(e.target.checked)}/> 半透明底色</label></div><textarea value={subtitle} onChange={e=>syncSubtitle(e.target.value)} placeholder="每行輸入一段字幕，系統會先平均建立時間…" rows={3}/><div className="cueEditor"><div className="cueHeader"><b>字幕時間軸</b><span>{cues.length} 段字幕 <button type="button" onClick={addCue}>＋ 新增</button></span></div>{cues.map((cue,i)=><div className="cueRow" key={cue.id}><div className="cueIndex">{String(i+1).padStart(2,'0')}</div><div className="cueFields"><input className="cueText" value={cue.text} aria-label="字幕文字" onChange={e=>{patchCue(cue.id,{text:e.target.value});setSubtitle(old=>{const lines=old.split('\n');lines[i]=e.target.value;return lines.join('\n')})}}/><div className="cueTimes"><label>開始 <input type="number" min="0" step=".1" value={cue.start} onChange={e=>patchCue(cue.id,{start:Math.max(0,Number(e.target.value))})}/></label><label>結束 <input type="number" min="0" step=".1" value={cue.end} onChange={e=>patchCue(cue.id,{end:Math.max(0,Number(e.target.value))})}/></label><button type="button" onClick={()=>removeCue(cue.id)}>移除</button></div>{cue.end<=cue.start&&<small className="cueError">結束時間必須大於開始時間</small>}</div></div>)}</div><p className="note">輸入文案時先平均分配時間；你可以逐段修改起訖秒數。匯出 MP4 時會依字幕時間軸、字體、顏色、位置與底色合成字幕。</p><button className="btn compact" onClick={downloadSrt}>下載 SRT 字幕檔</button><div className="summary"><span>影片／圖片總長</span><b>{time(total)}</b></div><button className="btn primary full" disabled={busy||!assets.some(a=>a.kind!=='audio')} onClick={exportMp4}>{busy?'正在製作影片…':'開始輸出 MP4 ↗'}</button>{busy&&<div className="progress"><span style={{width:progress+'%'}}/></div>}</section></div>
    <section className="panel timeline"><div className="panelHead"><div><b>素材與時間軸</b><span>{assets.length} 個素材</span></div><div className="timelineTools"><span className="shortcutHint">空白鍵 播放／暫停　·　← → 微調　·　Ctrl/⌘+D 複製　·　Ctrl/⌘+B 切割　·　Delete 刪除</span><label>縮放 <input aria-label="時間軸縮放" type="range" min="1" max="4" step=".25" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))}/><b>{timelineZoom.toFixed(2)}×</b></label><button className="btn compact" disabled={!current||current.kind==='audio'} onClick={duplicateSelectedClip}>▣ 複製片段</button><button className="btn compact" disabled={!current||current.kind==='audio'} onClick={splitSelectedClip}>✂ 切割片段</button><button className="btn compact" onClick={()=>input.current?.click()}>＋ 新增素材</button></div></div>{assets.length>0&&<div className="timelineBoard"><div className="ruler" style={{minWidth:(timelineZoom*100)+"%"}} onClick={e=>{const rect=e.currentTarget.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));seekTimeline(ratio*total);}}><span>00:00</span><span>{time(total)}</span><i className="playhead" style={{left:(previewTime/Math.max(total,.1)*100)+"%"}}/></div><div className="trackLabel">VIDEO TRACKS · V3 覆蓋 V2、V1</div>{[1,2,3].map(track=><div className="visualTrackGroup" key={track}><div className="trackLabel visualTrackLabel">V{track}</div><div className="trackLane visualLane" data-track={track} style={{minWidth:(timelineZoom*100)+"%",width:(timelineZoom*100)+"%"}} onDragOver={e=>{if(e.dataTransfer.types.includes("application/x-ai-video-asset"))e.preventDefault();}} onDrop={e=>{const id=e.dataTransfer.getData("application/x-ai-video-asset");if(id){e.preventDefault();patch(id,{trackIndex:track});setSelected(id);}}}>{visualAssets.filter(a=>(a.trackIndex??1)===track).map((a,i)=><button key={a.id} draggable onDragStart={e=>{e.dataTransfer.setData("application/x-ai-video-asset",a.id);e.dataTransfer.effectAllowed="move";}} onDragOver={e=>{if(e.dataTransfer.types.includes("application/x-ai-video-asset"))e.preventDefault();}} onDrop={e=>{const source=e.dataTransfer.getData("application/x-ai-video-asset");if(source){e.preventDefault();e.stopPropagation();moveAsset(source,a.id);}}} className={"clipBlock "+(selected===a.id?"active":"")} onPointerDown={e=>{visualMoveDrag.current={id:a.id,x:e.clientX,width:e.currentTarget.parentElement?.getBoundingClientRect().width||1,start:a.timelineStart};}} style={{left:(a.timelineStart/Math.max(total,.1)*100)+"%",width:Math.max(2,(Math.max(0,a.end-a.start)/Math.max(total,.1)*100))+"%"}} onClick={()=>setSelected(a.id)} title={a.file.name}><span>{i+1}</span>{a.file.name}<span className="videoTrimHandle left" title="拖曳裁切片段起點" onPointerDown={e=>{e.preventDefault();e.stopPropagation();audioTrimDrag.current={id:a.id,edge:"left",x:e.clientX,width:e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width||1,start:a.start,end:a.end};}}/><span className="videoTrimHandle right" title="拖曳裁切片段終點" onPointerDown={e=>{e.preventDefault();e.stopPropagation();audioTrimDrag.current={id:a.id,edge:"right",x:e.clientX,width:e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width||1,start:a.start,end:a.end};}}/></button>)}</div></div>)}{cues.length>0&&<><div className="trackLabel subtitleTrackLabel">SUBTITLES</div><div className="trackLane subtitleLane" style={{minWidth:(timelineZoom*100)+"%"}}>{cues.map((cue,i)=><button key={cue.id} className="subtitleBlock" style={{left:(Math.max(0,cue.start)/Math.max(total,.1)*100)+'%',width:(Math.max(.5,Math.min(total,cue.end)-Math.max(0,cue.start))/Math.max(total,.1)*100)+'%'}} onClick={()=>jumpToCue(cue)} title={cue.text}>{i+1}. {cue.text}</button>)}</div></>}{assets.some(a=>a.kind==='audio')&&<><div className="trackLabel audioLabel">AUDIO</div><div className="trackLane audioLane" style={{minWidth:(timelineZoom*100)+'%'}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-ai-audio-track'))e.preventDefault();}} onDrop={e=>{const id=e.dataTransfer.getData('application/x-ai-audio-track');if(id){e.preventDefault();const rect=e.currentTarget.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));patch(id,{timelineStart:Number((ratio*total).toFixed(2))});setSelected(id);}}}>{assets.filter(a=>a.kind==='audio').map(a=><button key={a.id} draggable className={'audioBlock '+(selected===a.id?'selectedAudio':'')} style={{marginLeft:(a.timelineStart/Math.max(total,.1)*100)+'%',flexBasis:Math.max(90,Math.min(1000,Math.max(0,a.end-a.start)/Math.max(total,.1)*100))+'%'}} onDragStart={e=>{e.dataTransfer.setData('application/x-ai-audio-track',a.id);e.dataTransfer.effectAllowed='move';}} onClick={()=>setSelected(a.id)}><span className="audioTrimHandle left" title="拖曳裁切起點" onPointerDown={e=>{e.preventDefault();e.stopPropagation();audioTrimDrag.current={id:a.id,edge:"left",x:e.clientX,width:e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width||1,start:a.start,end:a.end};}}/><span className="waveform">{(waveforms[a.id]||[]).map((peak,i)=><i key={i} style={{height:Math.max(3,Math.round(peak*30))+'px'}}/> )}</span><span className="audioCaption">♫ {a.file.name} · {time(a.timelineStart)}<span className="audioTrimHandle right" title="拖曳裁切終點" onPointerDown={e=>{e.preventDefault();e.stopPropagation();audioTrimDrag.current={id:a.id,edge:"right",x:e.clientX,width:e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().width||1,start:a.start,end:a.end};}}/></span></button>)}</div></>}</div>}{assets.length===0?<button className="dropzone" onClick={()=>input.current?.click()}><strong>↑</strong><b>拖曳素材到這裡，或點擊上傳</b><small>支援 MP4、MOV、WEBM、JPG、PNG、MP3、WAV；圖片預設 5 秒</small></button>:<div className="assetList">{assets.map((a,i)=><div className={'asset '+(selected===a.id?'chosen':'')} key={a.id} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-ai-video-asset',a.id);e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-ai-video-asset'))e.preventDefault();}} onDrop={e=>{const source=e.dataTransfer.getData('application/x-ai-video-asset');if(source){e.preventDefault();e.stopPropagation();moveAsset(source,a.id);}}} onClick={()=>setSelected(a.id)}><div className="assetIcon">{a.kind==='video'?'▶':a.kind==='image'?'▧':'♫'}</div><div className="assetBody"><b>{a.file.name}</b><small>{a.kind.toUpperCase()}　{a.duration?time(a.duration):'讀取片長中…'}</small>{a.kind!=='audio'&&<><div className="trim"><span>起點</span><input type="number" min="0" max={a.duration||undefined} step=".1" value={a.start} onChange={e=>patch(a.id,{start:Math.max(0,Number(e.target.value))})}/><span>終點</span><input type="number" min={a.start} max={a.duration||undefined} step=".1" value={a.end} onChange={e=>patch(a.id,{end:Math.min(a.duration||Number(e.target.value),Math.max(a.start,Number(e.target.value)))})}/></div><div className="fadeControls"><label>時間軸位置 <input type="number" min="0" step=".1" value={a.timelineStart} onChange={e=>patch(a.id,{timelineStart:Math.max(0,Number(e.target.value))})}/> 秒</label><label>影像軌道 <select value={a.trackIndex??1} onChange={e=>patch(a.id,{trackIndex:Number(e.target.value)})}><option value="1">V1 主畫面</option><option value="2">V2 疊加</option><option value="3">V3 最上層</option></select></label><label>原片音量 <b>{a.volume??100}%</b><input className="clipVolume" type="range" min="0" max="200" step="5" value={a.volume??100} onChange={e=>patch(a.id,{volume:Number(e.target.value)})}/></label><label>圖層透明度 <b>{a.opacity??100}%</b><input className="clipVolume" type="range" min="0" max="100" step="5" value={a.opacity??100} onChange={e=>patch(a.id,{opacity:Number(e.target.value)})}/></label><label>淡入 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeIn} onChange={e=>patch(a.id,{fadeIn:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label><label>淡出 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeOut} onChange={e=>patch(a.id,{fadeOut:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label></div></>}{a.kind==='audio'&&<div className="audioTrackControls"><label>素材起點 <input type="number" min="0" max={a.duration||undefined} step=".1" value={a.start} onChange={e=>patch(a.id,{start:Math.max(0,Number(e.target.value))})}/> 秒</label><label>素材終點 <input type="number" min={a.start} max={a.duration||undefined} step=".1" value={a.end} onChange={e=>patch(a.id,{end:Math.max(a.start,Math.min(a.duration||Number(e.target.value),Number(e.target.value)))})}/> 秒</label><label>時間軸位置 <input type="number" min="0" max={total} step=".1" value={a.timelineStart} onChange={e=>patch(a.id,{timelineStart:Math.max(0,Number(e.target.value))})}/> 秒</label><label>音量 {a.volume}% <input type="range" min="0" max="200" step="5" value={a.volume} onChange={e=>patch(a.id,{volume:Number(e.target.value)})}/></label><label>淡入 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeIn} onChange={e=>patch(a.id,{fadeIn:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label><label>淡出 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeOut} onChange={e=>patch(a.id,{fadeOut:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label></div>}</div><div className="assetActions"><button onClick={e=>{e.stopPropagation();reorder(a.id,-1)}}>↑</button><button onClick={e=>{e.stopPropagation();reorder(a.id,1)}}>↓</button><button onClick={e=>{e.stopPropagation();remove(a.id)}}>×</button></div></div>)}</div>}</section>
    <div className="status"><i/> {status}</div></main></div>
    <div className="audioPreviewPool" aria-hidden="true">{assets.filter(asset=>asset.kind==='audio').map(asset=><audio key={asset.id} ref={element=>{previewAudioRefs.current[asset.id]=element;}} src={asset.url} preload="auto" onLoadedMetadata={e=>{e.currentTarget.currentTime=asset.start;}}/>)}</div>
    {showStoryboard&&<div className="storyModal"><section className="storyPanel"><header className="storyHeader"><div><div className="eyebrow">AI CREATIVE DIRECTOR</div><h2>AI 腳本與自動分鏡</h2><p>一次分析你匯入的全部影片，產生剪輯腳本、片段順序與時間碼。</p></div><button className="btn" onClick={()=>setShowStoryboard(false)}>關閉 ×</button></header><div className="storyGrid"><div className="storySettings"><label>剪輯要求</label><textarea rows={5} value={storyPrompt} onChange={e=>setStoryPrompt(e.target.value)}/><label>目標成片長度</label><select value={storyDuration} onChange={e=>setStoryDuration(Number(e.target.value))}><option value={30}>30 秒</option><option value={60}>60 秒</option><option value={90}>90 秒</option><option value={180}>3 分鐘</option></select><label>發布平台</label><select value={storyPlatform} onChange={e=>setStoryPlatform(e.target.value)}><option>Reels / Shorts</option><option>Facebook</option><option>YouTube</option><option>網站形象影片</option></select><label>影片風格</label><select value={storyStyle} onChange={e=>setStoryStyle(e.target.value)}><option>高質感房屋銷售</option><option>生活感自然紀錄</option><option>專業建案介紹</option><option>快節奏社群短影音</option><option>品牌形象影片</option></select><label>AI 分析服務 Endpoint</label><input value={aiEndpoint} onChange={e=>setAiEndpoint(e.target.value)} placeholder="https://你的-worker.workers.dev"/><label>Worker 存取 Token</label><input type="password" autoComplete="off" value={aiAccessToken} onChange={e=>setAiAccessToken(e.target.value)} placeholder="輸入後端 APP_TOKEN（僅保留在目前頁面）"/><button className="btn full" disabled={storyBusy||!aiEndpoint.trim()} onClick={testAIConnection}>⌁ 測試 AI 後端連線</button><p className="note">影片會傳送至你部署的 Cloudflare Worker，再由後端呼叫 Gemini 分析。Gemini API Key 必須存放在 Worker Secret，絕不可放進網站程式碼。</p><button className="btn primary full" disabled={storyBusy||!videosAvailable()} onClick={generateStoryboard}>{storyBusy?'AI 正在分析全部影片…':'✧ 分析全部影片並產生分鏡'}</button><div className="storyAssetCount">已匯入影片：<b>{assets.filter(a=>a.kind==='video').length} 段</b>　·　總片長 {time(assets.filter(a=>a.kind==='video').reduce((n,a)=>n+a.duration,0))}</div></div><div className="storyResults"><div className="panelHead"><b>腳本與分鏡清單</b><span>{storyboard.length} 個鏡頭</span></div>{storyOverallScript&&<article className="storyScene"><b>完整腳本</b><p>{storyOverallScript}</p></article>}{storyWarnings.map((warning,index)=><article className="storyWarning" key={index}>注意：{warning}</article>)}{storyboard.length?storyboard.map((scene,index)=><article className="storyScene" key={scene.assetId+'-'+index}><div className="storySceneTop"><b>鏡頭 {String(scene.order).padStart(2,'0')}｜{scene.title}</b><span>{time(scene.sourceStart)} – {time(scene.sourceEnd)}</span></div><small>{assets.find(a=>a.id===scene.assetId)?.file.name||'原始影片'}</small><p>{scene.visualNote||'AI 畫面重點說明'}</p><label>旁白／字幕稿</label><textarea rows={2} value={scene.voiceover} onChange={e=>setStoryboard(old=>old.map((x,i)=>i===index?{...x,voiceover:e.target.value}:x))}/><div className="storySceneControls"><label>排序 <input type="number" min="1" value={scene.order} onChange={e=>setStoryboard(old=>old.map((x,i)=>i===index?{...x,order:Math.max(1,Number(e.target.value))}:x))}/></label><label>來源起點 <input type="number" min="0" step=".1" value={scene.sourceStart} onChange={e=>setStoryboard(old=>old.map((x,i)=>i===index?{...x,sourceStart:Math.max(0,Number(e.target.value))}:x))}/></label><label>來源終點 <input type="number" min=".1" step=".1" value={scene.sourceEnd} onChange={e=>setStoryboard(old=>old.map((x,i)=>i===index?{...x,sourceEnd:Math.max(x.sourceStart+.1,Number(e.target.value))}:x))}/></label></div></article>):<div className="storyEmpty"><b>尚未產生分鏡</b><p>匯入影片後設定剪輯要求，連接 AI 後端即可讓系統分析所有影片，挑選重點並安排順序。</p><small>預計流程：影片視覺理解 → 語音轉文字 → 精華片段評分 → 腳本生成 → 分鏡排序 → 套用 V1 時間軸</small></div>}{storyboard.length>0&&<button className="btn primary full" onClick={applyStoryboard}>套用分鏡並自動排列 V1 時間軸</button>}</div></div></section></div>}
    <input ref={projectInput} type="file" hidden accept=".json,application/json" onChange={e=>{void loadProject(e.target.files?.[0]||null);e.currentTarget.value='';}}/>
    <input ref={input} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={e=>{importFiles(e.target.files);e.currentTarget.value='';}}/>
    <input id="srtInput" type="file" hidden accept=".srt,text/plain" onChange={e=>{void importSrt(e.target.files?.[0]||null);e.currentTarget.value='';}}/>
  </div>;
}

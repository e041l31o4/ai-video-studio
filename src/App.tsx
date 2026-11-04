import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type Asset = { id:string; file:File; url:string; kind:'video'|'image'|'audio'; duration:number; start:number; end:number; fadeIn:number; fadeOut:number; volume:number; timelineStart:number };
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
  const [status,setStatus]=useState('匯入影片、圖片與配樂，開始製作短影音');
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState(0);
  const [engineReady,setEngineReady]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  const projectInput=useRef<HTMLInputElement>(null);
  const ffmpeg=useRef<FFmpeg|null>(null);
  const current=assets.find(a=>a.id===selected)||assets.find(a=>a.kind!=='audio')||assets[0];
  const visualAssets=assets.filter(a=>a.kind!=='audio');
  const currentOffset=useMemo(()=>{const index=visualAssets.findIndex(a=>a.id===current?.id);return index>0?visualAssets.slice(0,index).reduce((sum,a)=>sum+Math.max(0,a.end-a.start),0):0;},[assets,current?.id]);
  const total=useMemo(()=>visualAssets.reduce((v,a)=>v+Math.max(0,a.end-a.start),0),[visualAssets]);

  useEffect(()=>{setPreviewTime(currentOffset);},[current?.id,currentOffset]);
  useEffect(()=>{let cancelled=false;const pending=assets.filter(a=>a.kind==='audio'&&!waveforms[a.id]&&a.file.size<80*1024*1024);if(!pending.length)return;const Context=window.AudioContext||(window as any).webkitAudioContext;if(!Context)return;const context=new Context();pending.forEach(async asset=>{try{const decoded=await context.decodeAudioData(await asset.file.arrayBuffer());const channel=decoded.getChannelData(0),bins=180,step=Math.max(1,Math.floor(channel.length/bins)),peaks:number[]=[];for(let i=0;i<bins;i++){let peak=0;for(let j=i*step;j<Math.min(channel.length,(i+1)*step);j++)peak=Math.max(peak,Math.abs(channel[j]));peaks.push(peak);}if(!cancelled)setWaveforms(old=>({...old,[asset.id]:peaks}));}catch{if(!cancelled)setWaveforms(old=>({...old,[asset.id]:[]}));}});return()=>{cancelled=true;void context.close();};},[assets,waveforms]);
  useEffect(()=>{if(pendingSeek!==null&&current?.kind==='video'&&videoRef.current){const localTime=Math.max(current.start,Math.min(current.end,current.start+pendingSeek-currentOffset));videoRef.current.currentTime=localTime;setPreviewTime(pendingSeek);setPendingSeek(null);}},[pendingSeek,current?.id,current?.start,current?.end,currentOffset]);
  useEffect(()=>()=>assets.forEach(a=>URL.revokeObjectURL(a.url)),[]);

  async function saveProject(){
    if(!assets.length){setStatus('目前沒有素材可儲存。');return;}
    setBusy(true);setStatus('正在封裝專案與素材，檔案較大時請稍候…');
    try{
      const savedAssets=await Promise.all(assets.map(async asset=>({
        id:asset.id,name:asset.file.name,type:asset.file.type,kind:asset.kind,duration:asset.duration,start:asset.start,end:asset.end,fadeIn:asset.fadeIn,fadeOut:asset.fadeOut,volume:asset.volume,timelineStart:asset.timelineStart,
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
        return {id:String(item.id||crypto.randomUUID()),file:media,url:URL.createObjectURL(media),kind:item.kind as Asset['kind'],duration:Number(item.duration)||0,start:Number(item.start)||0,end:Number(item.end)||0,fadeIn:Number(item.fadeIn)||0,fadeOut:Number(item.fadeOut)||0,volume:Number(item.volume??100),timelineStart:Number(item.timelineStart)||0};
      }));
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
    const next=Array.from(list).filter(f=>/^(video|image|audio)\//.test(f.type)).map(file=>({id:crypto.randomUUID(),file,url:URL.createObjectURL(file),kind:(file.type.startsWith('video/')?'video':file.type.startsWith('image/')?'image':'audio') as Asset['kind'],duration:file.type.startsWith('image/')?5:0,start:0,end:file.type.startsWith('image/')?5:0,fadeIn:0,fadeOut:0,volume:100,timelineStart:0}));
    setAssets(old=>[...old,...next]); if(next[0])setSelected(next[0].id);
    next.filter(a=>a.kind==='video').forEach(a=>{const probe=document.createElement('video');probe.preload='metadata';probe.src=a.url;probe.onloadedmetadata=()=>updateDuration(a.id,probe.duration);});
    next.filter(a=>a.kind==='audio').forEach(a=>{const probe=document.createElement('audio');probe.preload='metadata';probe.src=a.url;probe.onloadedmetadata=()=>updateDuration(a.id,probe.duration);});
    setStatus(next.length?'已匯入 '+next.length+' 個素材':'沒有找到支援的素材格式');
  }
  function updateDuration(id:string,duration:number){setAssets(old=>old.map(a=>a.id===id?{...a,duration,end:a.end||duration}:a));}
  function patch(id:string,p:Partial<Asset>){setAssets(old=>old.map(a=>a.id===id?{...a,...p}:a));}
  function reorder(id:string,step:number){setAssets(old=>{const i=old.findIndex(a=>a.id===id),j=i+step;if(i<0||j<0||j>=old.length)return old;const copy=[...old];[copy[i],copy[j]]=[copy[j],copy[i]];return copy;});}
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
    let offset=0;
    const target=visualAssets.find(asset=>{const end=offset+Math.max(0,asset.end-asset.start);const hit=cue.start>=offset&&cue.start<=end; if(!hit)offset=end;return hit;});
    if(target){setSelected(target.id);setPendingSeek(target.kind==='video'?cue.start:null);setPreviewTime(cue.start);}
  }
  function addCue(){
    const start=cues.length?Math.max(...cues.map(c=>c.end)):0;
    const cue={id:crypto.randomUUID(),text:'新字幕',start:Number(start.toFixed(2)),end:Number((start+3).toFixed(2))};
    setCues(old=>[...old,cue]);setSubtitle(old=>old?old+'\n'+cue.text:cue.text);
  }
  async function importSrt(file:File|null){
    if(!file)return;
    const raw=await file.text();
    const blocks=raw.replace(/\r/g,'').trim().split(/\n\s*\n/);
    const parsed:Cue[]=[];
    for(const block of blocks){
      const lines=block.split('\n');
      const timeLine=lines.find(line=>line.includes('-->'));
      if(!timeLine)continue;
      const match=timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
      if(!match)continue;
      const toSeconds=(h:string,m:string,s:string,ms:string)=>Number(h)*3600+Number(m)*60+Number(s)+Number(ms)/1000;
      const start=toSeconds(match[1],match[2],match[3],match[4]),end=toSeconds(match[5],match[6],match[7],match[8]);
      const text=lines.slice(lines.indexOf(timeLine)+1).join('\n').replace(/<[^>]+>/g,'').trim();
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
    const clips=assets.filter(a=>a.kind!=='audio'&&a.end>a.start);
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
        const inputName='source_'+i+'.'+(a.file.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'');
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
      const list=names.map(n=>"file '"+n+"'").join('\n');
      await engine.writeFile('concat.txt',new TextEncoder().encode(list));
      setStatus('正在合併影片片段與字幕…');
      const finalArgs=['-f','concat','-safe','0','-i','concat.txt'];
      const validCues=cues.filter(c=>c.text.trim()&&Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.end>c.start&&c.start<total).sort((a,b)=>a.start-b.start);
      const subtitleIndexes:number[]=[];
      for(let i=0;i<validCues.length;i++){
        const cue=validCues[i],pngName='subtitle_'+i+'.png';
        const png=await makeSubtitlePng(cue,width,height,subtitleSize,subtitleColor,subtitlePosition,subtitleBackground);
        await engine.writeFile(pngName,png);
        subtitleIndexes.push(1+i);
        finalArgs.push('-loop','1','-framerate','30','-i',pngName);
      }
      let nextInput=1+validCues.length,originalIndex=-1;
      const musicIndexes:number[]=[];
      if(preserveOriginalAudio&&audioNames.length){
        await engine.writeFile('audio_concat.txt',new TextEncoder().encode(audioNames.map(n=>"file '"+n+"'").join('\n')));
        finalArgs.push('-f','concat','-safe','0','-i','audio_concat.txt');
        originalIndex=nextInput++;
      }
      if(keepAudio&&soundtracks.length){
        for(let i=0;i<soundtracks.length;i++){
          const soundtrack=soundtracks[i],audioName='soundtrack_'+i+'.'+(soundtrack.file.name.split('.').pop()||'mp3').replace(/[^a-z0-9]/gi,'');
          await engine.writeFile(audioName,await fetchFile(soundtrack.file));
          finalArgs.push('-stream_loop','-1','-ss',String(Math.max(0,soundtrack.start)),'-i',audioName);
          musicIndexes.push(nextInput++);
        }
      }
      const filters:string[]=[];
      let videoMap='0:v:0';
      if(validCues.length){
        let previous='0:v:0';
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
      if(originalIndex>=0){filters.push('['+originalIndex+':a]volume='+originalVolume/100+'[orig]');audioInputs.push('[orig]');}
      musicIndexes.forEach((index,i)=>{const track=soundtracks[i],label='music'+i,trackLength=Math.max(0,Math.min(total-track.timelineStart,track.end-track.start)),delay=Math.max(0,Math.min(total,track.timelineStart))*1000,level=(musicVolume/100)*(Math.max(0,Math.min(200,track.volume))/100),fadeIn=Math.min(trackLength,Math.max(0,track.fadeIn||0)),fadeOut=Math.min(trackLength,Math.max(0,track.fadeOut||0)),fadeFilters=[fadeIn>0?'afade=t=in:st=0:d='+fadeIn.toFixed(3):'',fadeOut>0?'afade=t=out:st='+Math.max(0,trackLength-fadeOut).toFixed(3)+':d='+fadeOut.toFixed(3):''].filter(Boolean);filters.push('['+index+':a]atrim=duration='+trackLength.toFixed(3)+',asetpts=PTS-STARTPTS,volume='+level+(fadeFilters.length?','+fadeFilters.join(','):'')+',adelay='+Math.round(delay)+'|'+Math.round(delay)+'['+label+']');audioInputs.push('['+label+']');});
      if(audioInputs.length===1){audioMap=audioInputs[0];}
      else if(audioInputs.length>1){filters.push(audioInputs.join('')+'amix=inputs='+audioInputs.length+':duration=longest:dropout_transition=2[aout]');audioMap='[aout]';}
      if(filters.length)finalArgs.push('-filter_complex',filters.join(';'));
      finalArgs.push('-map',videoMap);
      if(audioMap)finalArgs.push('-map',audioMap);else finalArgs.push('-an');
      if(validCues.length)finalArgs.push('-c:v','libx264','-preset','ultrafast','-crf',quality==='4k'?'21':'23','-pix_fmt','yuv420p');
      else finalArgs.push('-c:v','copy');
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
  return <div className="app" onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDrop={handleFileDrop}>
    <header className="topbar"><a className="brand" href="#"><span className="brandIcon">▶</span><span>AI VIDEO <b>STUDIO</b><small>CREATIVE WORKSPACE</small></span></a><div className="topRight"><span className="local"><i/> 本機處理</span><button className="btn" disabled={busy} onClick={()=>projectInput.current?.click()}>開啟專案</button><button className="btn" disabled={busy||!assets.length} onClick={saveProject}>儲存專案</button><button className="btn" onClick={()=>input.current?.click()}>＋ 匯入素材</button><button className="btn primary" disabled={busy||!assets.some(a=>a.kind!=='audio')} onClick={exportMp4}>{busy?'製作中…':'輸出 MP4 ↗'}</button></div></header>
    <div className="layout"><aside className="sidebar"><div className="sideTitle">WORKSPACE</div><div className="nav active">▧　影片剪輯工作台</div><div className="nav" onClick={()=>setStatus('AI 腳本與自動分鏡：規劃於下一階段接入')}>✧　AI 腳本與分鏡</div><div className="nav" onClick={()=>setStatus('字幕辨識及時間軸編輯：規劃於下一階段接入')}>▤　字幕工作室</div><div className="engine"><i/> <b>本機影音引擎</b><small>{engineReady?'已載入':'輸出時啟動'}</small></div><p className="privacy">素材目前只在你的裝置中處理，不會自動上傳。</p></aside>
    <main className="main"><div className="heading"><div><div className="eyebrow">VIDEO EDITOR / 01</div><h1>影片剪輯工作台</h1><p>匯入素材、調整片段，製作你的下一支短影音。</p></div><span className="project">未命名專案　·　本機工作階段</span></div>
    <div className="editorGrid"><section className="panel preview"><div className="panelHead"><b>影片預覽</b><span>即時素材檢視</span></div><div className={'stage '+(ratio==='9:16'?'vertical':ratio==='1:1'?'square':'horizontal')}>{current?.kind==='video'?<video ref={videoRef} key={current.id} src={current.url} controls onTimeUpdate={e=>setPreviewTime(currentOffset+Math.max(0,e.currentTarget.currentTime-current.start))} onLoadedMetadata={e=>{updateDuration(current.id,e.currentTarget.duration);e.currentTarget.currentTime=Math.min(current.start,e.currentTarget.duration);}}/>:current?.kind==='image'?<img src={current.url}/>:<div className="empty"><div className="orb">▶</div><b>準備開始創作</b><span>匯入影片或圖片素材</span><button className="btn primary" onClick={()=>input.current?.click()}>選擇素材</button></div>}{current&&cues.find(cue=>previewTime>=cue.start&&previewTime<=cue.end)&&<div className={'subtitleOverlay '+subtitlePosition} style={{fontSize:subtitleSize,color:subtitleColor,background:subtitleBackground?'rgba(0,0,0,.62)':'transparent'}}>{cues.find(cue=>previewTime>=cue.start&&previewTime<=cue.end)?.text}</div>}</div><div className="previewFoot"><span>預覽畫布</span><span>{ratio} · {quality==='4k'?'4K UHD':'1080P'}</span></div></section>
    <section className="panel settings"><div className="panelHead"><b>專案設定</b><span className="tag">EDITOR</span></div><label>影片比例</label><div className="choices">{['9:16','16:9','1:1'].map(v=><button className={ratio===v?'choice selected':'choice'} key={v} onClick={()=>setRatio(v)}>{v}</button>)}</div><label>輸出畫質</label><div className="choices"><button className={quality==='1080'?'choice selected':'choice'} onClick={()=>setQuality('1080')}>1080P</button><button className={quality==='4k'?'choice selected':'choice'} onClick={()=>setQuality('4k')}>4K UHD</button></div><label className="check"><input type="checkbox" checked={preserveOriginalAudio} onChange={e=>setPreserveOriginalAudio(e.target.checked)}/> 保留原影片聲音</label>{preserveOriginalAudio&&<label className="volumeControl">原片音量 <b>{originalVolume}%</b><input type="range" min="0" max="150" step="5" value={originalVolume} onChange={e=>setOriginalVolume(Number(e.target.value))}/></label>}<label className="check"><input type="checkbox" checked={keepAudio} onChange={e=>setKeepAudio(e.target.checked)}/> 混音多條背景音軌（可匯入多個音訊）</label>{keepAudio&&<label className="volumeControl">所有配樂音量 <b>{musicVolume}%</b><input type="range" min="0" max="100" step="5" value={musicVolume} onChange={e=>setMusicVolume(Number(e.target.value))}/></label>}<div className="subtitleHead"><label>字幕文案（每行一段）</label><button type="button" className="btn compact" onClick={()=>document.getElementById('srtInput')?.click()}>匯入 SRT</button></div><div className="subtitleStyle"><label>字體大小 <b>{subtitleSize}px</b><input type="range" min="14" max="48" step="1" value={subtitleSize} onChange={e=>setSubtitleSize(Number(e.target.value))}/></label><label>文字顏色 <input type="color" value={subtitleColor} onChange={e=>setSubtitleColor(e.target.value)}/></label><label>字幕位置 <select value={subtitlePosition} onChange={e=>setSubtitlePosition(e.target.value)}><option value="top">上方</option><option value="center">置中</option><option value="bottom">下方</option></select></label><label className="check"><input type="checkbox" checked={subtitleBackground} onChange={e=>setSubtitleBackground(e.target.checked)}/> 半透明底色</label></div><textarea value={subtitle} onChange={e=>syncSubtitle(e.target.value)} placeholder="每行輸入一段字幕，系統會先平均建立時間…" rows={3}/><div className="cueEditor"><div className="cueHeader"><b>字幕時間軸</b><span>{cues.length} 段字幕 <button type="button" onClick={addCue}>＋ 新增</button></span></div>{cues.map((cue,i)=><div className="cueRow" key={cue.id}><div className="cueIndex">{String(i+1).padStart(2,'0')}</div><div className="cueFields"><input className="cueText" value={cue.text} aria-label="字幕文字" onChange={e=>{patchCue(cue.id,{text:e.target.value});setSubtitle(old=>{const lines=old.split('\n');lines[i]=e.target.value;return lines.join('\n')})}}/><div className="cueTimes"><label>開始 <input type="number" min="0" step=".1" value={cue.start} onChange={e=>patchCue(cue.id,{start:Math.max(0,Number(e.target.value))})}/></label><label>結束 <input type="number" min="0" step=".1" value={cue.end} onChange={e=>patchCue(cue.id,{end:Math.max(0,Number(e.target.value))})}/></label><button type="button" onClick={()=>removeCue(cue.id)}>移除</button></div>{cue.end<=cue.start&&<small className="cueError">結束時間必須大於開始時間</small>}</div></div>)}</div><p className="note">輸入文案時先平均分配時間；你可以逐段修改起訖秒數。匯出 MP4 時會依字幕時間軸、字體、顏色、位置與底色合成字幕。</p><button className="btn compact" onClick={downloadSrt}>下載 SRT 字幕檔</button><div className="summary"><span>影片／圖片總長</span><b>{time(total)}</b></div><button className="btn primary full" disabled={busy||!assets.some(a=>a.kind!=='audio')} onClick={exportMp4}>{busy?'正在製作影片…':'開始輸出 MP4 ↗'}</button>{busy&&<div className="progress"><span style={{width:progress+'%'}}/></div>}</section></div>
    <section className="panel timeline"><div className="panelHead"><div><b>素材與時間軸</b><span>{assets.length} 個素材</span></div><div className="timelineTools"><label>縮放 <input aria-label="時間軸縮放" type="range" min="1" max="4" step=".25" value={timelineZoom} onChange={e=>setTimelineZoom(Number(e.target.value))}/><b>{timelineZoom.toFixed(2)}×</b></label><button className="btn compact" onClick={()=>input.current?.click()}>＋ 新增素材</button></div></div>{assets.length>0&&<div className="timelineBoard"><div className="ruler"><span>00:00</span><span>{time(total)}</span></div><div className="trackLabel">VIDEO / IMAGE</div><div className="trackLane">{visualAssets.map((a,i)=><button key={a.id} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-ai-video-asset',a.id);e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-ai-video-asset'))e.preventDefault();}} onDrop={e=>{const source=e.dataTransfer.getData('application/x-ai-video-asset');if(source){e.preventDefault();e.stopPropagation();moveAsset(source,a.id);}}} className={'clipBlock '+(selected===a.id?'active':'')} style={{width:Math.max(90,(Math.max(0,a.end-a.start)/Math.max(total,1))*100)+'%',flexGrow:Math.max(.2,a.end-a.start)}} onClick={()=>setSelected(a.id)} title={a.file.name}><span>{i+1}</span>{a.file.name}</button>)}</div>{cues.length>0&&<><div className="trackLabel subtitleTrackLabel">SUBTITLES</div><div className="trackLane subtitleLane">{cues.map((cue,i)=><button key={cue.id} className="subtitleBlock" style={{left:(Math.max(0,cue.start)/Math.max(total,.1)*100)+'%',width:(Math.max(.5,Math.min(total,cue.end)-Math.max(0,cue.start))/Math.max(total,.1)*100)+'%'}} onClick={()=>jumpToCue(cue)} title={cue.text}>{i+1}. {cue.text}</button>)}</div></>}{assets.some(a=>a.kind==='audio')&&<><div className="trackLabel audioLabel">AUDIO</div><div className="trackLane audioLane" style={{minWidth:(timelineZoom*100)+'%'}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-ai-audio-track'))e.preventDefault();}} onDrop={e=>{const id=e.dataTransfer.getData('application/x-ai-audio-track');if(id){e.preventDefault();const rect=e.currentTarget.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width));patch(id,{timelineStart:Number((ratio*total).toFixed(2))});setSelected(id);}}}>{assets.filter(a=>a.kind==='audio').map(a=><button key={a.id} draggable className={'audioBlock '+(selected===a.id?'selectedAudio':'')} style={{marginLeft:(a.timelineStart/Math.max(total,.1)*100)+'%',flexBasis:Math.max(90,Math.min(1000,Math.max(0,a.end-a.start)/Math.max(total,.1)*100))+'%'}} onDragStart={e=>{e.dataTransfer.setData('application/x-ai-audio-track',a.id);e.dataTransfer.effectAllowed='move';}} onClick={()=>setSelected(a.id)}><span className="waveform">{(waveforms[a.id]||[]).map((peak,i)=><i key={i} style={{height:Math.max(3,Math.round(peak*30))+'px'}}/> )}</span><span className="audioCaption">♫ {a.file.name} · {time(a.timelineStart)}</span></button>)}</div></>}</div>}{assets.length===0?<button className="dropzone" onClick={()=>input.current?.click()}><strong>↑</strong><b>拖曳素材到這裡，或點擊上傳</b><small>支援 MP4、MOV、WEBM、JPG、PNG、MP3、WAV；圖片預設 5 秒</small></button>:<div className="assetList">{assets.map((a,i)=><div className={'asset '+(selected===a.id?'chosen':'')} key={a.id} draggable onDragStart={e=>{e.dataTransfer.setData('application/x-ai-video-asset',a.id);e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-ai-video-asset'))e.preventDefault();}} onDrop={e=>{const source=e.dataTransfer.getData('application/x-ai-video-asset');if(source){e.preventDefault();e.stopPropagation();moveAsset(source,a.id);}}} onClick={()=>setSelected(a.id)}><div className="assetIcon">{a.kind==='video'?'▶':a.kind==='image'?'▧':'♫'}</div><div className="assetBody"><b>{a.file.name}</b><small>{a.kind.toUpperCase()}　{a.duration?time(a.duration):'讀取片長中…'}</small>{a.kind!=='audio'&&<><div className="trim"><span>起點</span><input type="number" min="0" max={a.duration||undefined} step=".1" value={a.start} onChange={e=>patch(a.id,{start:Math.max(0,Number(e.target.value))})}/><span>終點</span><input type="number" min={a.start} max={a.duration||undefined} step=".1" value={a.end} onChange={e=>patch(a.id,{end:Math.min(a.duration||Number(e.target.value),Math.max(a.start,Number(e.target.value)))})}/></div><div className="fadeControls"><label>淡入 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeIn} onChange={e=>patch(a.id,{fadeIn:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label><label>淡出 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeOut} onChange={e=>patch(a.id,{fadeOut:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label></div></>}{a.kind==='audio'&&<div className="audioTrackControls"><label>素材起點 <input type="number" min="0" max={a.duration||undefined} step=".1" value={a.start} onChange={e=>patch(a.id,{start:Math.max(0,Number(e.target.value))})}/> 秒</label><label>素材終點 <input type="number" min={a.start} max={a.duration||undefined} step=".1" value={a.end} onChange={e=>patch(a.id,{end:Math.max(a.start,Math.min(a.duration||Number(e.target.value),Number(e.target.value)))})}/> 秒</label><label>時間軸位置 <input type="number" min="0" max={total} step=".1" value={a.timelineStart} onChange={e=>patch(a.id,{timelineStart:Math.max(0,Number(e.target.value))})}/> 秒</label><label>音量 {a.volume}% <input type="range" min="0" max="200" step="5" value={a.volume} onChange={e=>patch(a.id,{volume:Number(e.target.value)})}/></label><label>淡入 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeIn} onChange={e=>patch(a.id,{fadeIn:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label><label>淡出 <input type="number" min="0" max={Math.max(0,a.end-a.start)} step=".1" value={a.fadeOut} onChange={e=>patch(a.id,{fadeOut:Math.max(0,Math.min(a.end-a.start,Number(e.target.value)))})}/> 秒</label></div>}</div><div className="assetActions"><button onClick={e=>{e.stopPropagation();reorder(a.id,-1)}}>↑</button><button onClick={e=>{e.stopPropagation();reorder(a.id,1)}}>↓</button><button onClick={e=>{e.stopPropagation();remove(a.id)}}>×</button></div></div>)}</div>}</section>
    <div className="status"><i/> {status}</div></main></div>
    <input ref={projectInput} type="file" hidden accept=".json,application/json" onChange={e=>{void loadProject(e.target.files?.[0]||null);e.currentTarget.value='';}}/>
    <input ref={input} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={e=>{importFiles(e.target.files);e.currentTarget.value='';}}/>
    <input id="srtInput" type="file" hidden accept=".srt,text/plain" onChange={e=>{void importSrt(e.target.files?.[0]||null);e.currentTarget.value='';}}/>
  </div>;
}

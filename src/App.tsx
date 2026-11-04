import { useEffect, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type Asset = { id:string; file:File; url:string; kind:'video'|'image'|'audio'; duration:number; start:number; end:number };
const time = (n:number) => { if(!Number.isFinite(n)) return '00:00'; return String(Math.floor(n/60)).padStart(2,'0')+':'+String(Math.floor(n%60)).padStart(2,'0'); };

export default function App(){
  const [assets,setAssets]=useState<Asset[]>([]);
  const [selected,setSelected]=useState('');
  const [ratio,setRatio]=useState('9:16');
  const [quality,setQuality]=useState('1080');
  const [subtitle,setSubtitle]=useState('');
  const [keepAudio,setKeepAudio]=useState(true);
  const [status,setStatus]=useState('匯入影片、圖片與配樂，開始製作短影音');
  const [busy,setBusy]=useState(false);
  const [progress,setProgress]=useState(0);
  const [engineReady,setEngineReady]=useState(false);
  const input=useRef<HTMLInputElement>(null);
  const ffmpeg=useRef<FFmpeg|null>(null);
  const current=assets.find(a=>a.id===selected)||assets.find(a=>a.kind!=='audio')||assets[0];
  const total=useMemo(()=>assets.filter(a=>a.kind!=='audio').reduce((v,a)=>v+Math.max(0,a.end-a.start),0),[assets]);

  useEffect(()=>()=>assets.forEach(a=>URL.revokeObjectURL(a.url)),[]);
  function importFiles(list:FileList|null){
    if(!list)return;
    const next=Array.from(list).filter(f=>/^(video|image|audio)\//.test(f.type)).map(file=>({id:crypto.randomUUID(),file,url:URL.createObjectURL(file),kind:(file.type.startsWith('video/')?'video':file.type.startsWith('image/')?'image':'audio') as Asset['kind'],duration:file.type.startsWith('image/')?5:0,start:0,end:file.type.startsWith('image/')?5:0}));
    setAssets(old=>[...old,...next]); if(next[0])setSelected(next[0].id);
    next.filter(a=>a.kind==='video').forEach(a=>{const probe=document.createElement('video');probe.preload='metadata';probe.src=a.url;probe.onloadedmetadata=()=>updateDuration(a.id,probe.duration);});
    setStatus(next.length?'已匯入 '+next.length+' 個素材':'沒有找到支援的素材格式');
  }
  function updateDuration(id:string,duration:number){setAssets(old=>old.map(a=>a.id===id?{...a,duration,end:a.end||duration}:a));}
  function patch(id:string,p:Partial<Asset>){setAssets(old=>old.map(a=>a.id===id?{...a,...p}:a));}
  function reorder(id:string,step:number){setAssets(old=>{const i=old.findIndex(a=>a.id===id),j=i+step;if(i<0||j<0||j>=old.length)return old;const copy=[...old];[copy[i],copy[j]]=[copy[j],copy[i]];return copy;});}
  function remove(id:string){setAssets(old=>{const a=old.find(x=>x.id===id);if(a)URL.revokeObjectURL(a.url);return old.filter(x=>x.id!==id)});if(selected===id)setSelected('');}
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
  function downloadSrt(){
    const lines=subtitle.split('\n').map(s=>s.trim()).filter(Boolean);
    if(!lines.length){setStatus('請先輸入字幕，每行一段，再匯出 SRT。');return;}
    const fmt=(v:number)=>{const ms=Math.round(v*1000),h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),x=ms%1000;return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')+','+String(x).padStart(3,'0')};
    const srt=lines.map((line,i)=>(i+1)+'\n'+fmt(i*3)+' --> '+fmt((i+1)*3)+'\n'+line).join('\n\n');
    const url=URL.createObjectURL(new Blob([srt],{type:'text/plain;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='subtitles.srt';a.click();URL.revokeObjectURL(url);setStatus('SRT 字幕檔已匯出。');
  }
  async function exportMp4(){
    const clips=assets.filter(a=>a.kind!=='audio'&&a.end>a.start);
    const soundtrack=assets.find(a=>a.kind==='audio');
    if(!clips.length){setStatus('請先匯入影片或圖片素材。');return;}
    setBusy(true);setProgress(0);
    try{
      const engine=await loadEngine();
      const width=ratio==='9:16'?(quality==='4k'?2160:1080):ratio==='1:1'?(quality==='4k'?2160:1080):(quality==='4k'?3840:1920);
      const height=ratio==='9:16'?(quality==='4k'?3840:1920):ratio==='1:1'?(quality==='4k'?2160:1080):(quality==='4k'?2160:1080);
      const names:string[]=[];
      for(let i=0;i<clips.length;i++){
        const a=clips[i],outputName='part_'+i+'.mp4';
        const inputName='source_'+i+'.'+(a.file.name.split('.').pop()||'bin').replace(/[^a-z0-9]/gi,'');
        await engine.writeFile(inputName,await fetchFile(a.file));
        const vf='scale='+width+':'+height+':force_original_aspect_ratio=decrease,pad='+width+':'+height+':(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p';
        const args=a.kind==='image'?['-loop','1','-framerate','30','-i',inputName,'-t',String(Math.max(.1,a.end-a.start)),'-vf',vf,'-an','-c:v','libx264','-preset','ultrafast','-crf',quality==='4k'?'21':'23','-pix_fmt','yuv420p',outputName]:['-ss',String(a.start),'-i',inputName,'-t',String(Math.max(.1,a.end-a.start)),'-vf',vf,'-an','-c:v','libx264','-preset','ultrafast','-crf',quality==='4k'?'21':'23','-pix_fmt','yuv420p',outputName];
        setStatus('正在處理素材 '+(i+1)+' / '+clips.length+'…');
        const code=await engine.exec(args);if(code!==0)throw new Error('素材轉檔失敗');
        names.push(outputName);
      }
      const list=names.map(n=>"file '"+n+"'").join('\n');
      await engine.writeFile('concat.txt',new TextEncoder().encode(list));
      setStatus('正在合併影片片段…');
      const finalArgs=['-f','concat','-safe','0','-i','concat.txt'];
      if(keepAudio&&soundtrack){
        const audioName='soundtrack.'+(soundtrack.file.name.split('.').pop()||'mp3').replace(/[^a-z0-9]/gi,'');
        await engine.writeFile(audioName,await fetchFile(soundtrack.file));
        finalArgs.push('-i',audioName,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-shortest');
      }else finalArgs.push('-map','0:v:0','-an','-c:v','copy');
      finalArgs.push('-movflags','+faststart','final.mp4');
      const code=await engine.exec(finalArgs);if(code!==0)throw new Error('影片合併失敗');
      const data=await engine.readFile('final.mp4');
      const blob=new Blob([new Uint8Array(data as Uint8Array).buffer as ArrayBuffer],{type:'video/mp4'}),url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download='ai-video-studio-export.mp4';a.click();URL.revokeObjectURL(url);
      setProgress(100);setStatus('MP4 輸出完成，已開始下載。');
    }catch(err){console.error(err);setStatus('輸出失敗：可能是素材編碼不相容或裝置記憶體不足。請先縮短影片並嘗試 1080P。');}
    finally{setBusy(false);}
  }
  return <div className="app">
    <header className="topbar"><a className="brand" href="#"><span className="brandIcon">▶</span><span>AI VIDEO <b>STUDIO</b><small>CREATIVE WORKSPACE</small></span></a><div className="topRight"><span className="local"><i/> 本機處理</span><button className="btn" onClick={()=>input.current?.click()}>＋ 匯入素材</button><button className="btn primary" disabled={busy||!assets.some(a=>a.kind!=='audio')} onClick={exportMp4}>{busy?'製作中…':'輸出 MP4 ↗'}</button></div></header>
    <div className="layout"><aside className="sidebar"><div className="sideTitle">WORKSPACE</div><div className="nav active">▧　影片剪輯工作台</div><div className="nav" onClick={()=>setStatus('AI 腳本與自動分鏡：規劃於下一階段接入')}>✧　AI 腳本與分鏡</div><div className="nav" onClick={()=>setStatus('字幕辨識及時間軸編輯：規劃於下一階段接入')}>▤　字幕工作室</div><div className="engine"><i/> <b>本機影音引擎</b><small>{engineReady?'已載入':'輸出時啟動'}</small></div><p className="privacy">素材目前只在你的裝置中處理，不會自動上傳。</p></aside>
    <main className="main"><div className="heading"><div><div className="eyebrow">VIDEO EDITOR / 01</div><h1>影片剪輯工作台</h1><p>匯入素材、調整片段，製作你的下一支短影音。</p></div><span className="project">未命名專案　·　本機工作階段</span></div>
    <div className="editorGrid"><section className="panel preview"><div className="panelHead"><b>影片預覽</b><span>即時素材檢視</span></div><div className={'stage '+(ratio==='9:16'?'vertical':ratio==='1:1'?'square':'horizontal')}>{current?.kind==='video'?<video key={current.id} src={current.url} controls onLoadedMetadata={e=>updateDuration(current.id,e.currentTarget.duration)}/>:current?.kind==='image'?<img src={current.url}/>:<div className="empty"><div className="orb">▶</div><b>準備開始創作</b><span>匯入影片或圖片素材</span><button className="btn primary" onClick={()=>input.current?.click()}>選擇素材</button></div>}</div><div className="previewFoot"><span>預覽畫布</span><span>{ratio} · {quality==='4k'?'4K UHD':'1080P'}</span></div></section>
    <section className="panel settings"><div className="panelHead"><b>專案設定</b><span className="tag">EDITOR</span></div><label>影片比例</label><div className="choices">{['9:16','16:9','1:1'].map(v=><button className={ratio===v?'choice selected':'choice'} key={v} onClick={()=>setRatio(v)}>{v}</button>)}</div><label>輸出畫質</label><div className="choices"><button className={quality==='1080'?'choice selected':'choice'} onClick={()=>setQuality('1080')}>1080P</button><button className={quality==='4k'?'choice selected':'choice'} onClick={()=>setQuality('4k')}>4K UHD</button></div><label className="check"><input type="checkbox" checked={keepAudio} onChange={e=>setKeepAudio(e.target.checked)}/> 使用匯入的音訊作為配樂</label><label>字幕文案（匯出 SRT 字幕檔）</label><textarea value={subtitle} onChange={e=>setSubtitle(e.target.value)} placeholder="輸入影片標題或字幕文案…" rows={4}/><p className="note">每行文字會依序產生 3 秒字幕時間軸；目前先匯出 SRT，尚未燒錄進影片。</p><button className="btn compact" onClick={downloadSrt}>下載 SRT 字幕檔</button><div className="summary"><span>影片／圖片總長</span><b>{time(total)}</b></div><button className="btn primary full" disabled={busy||!assets.some(a=>a.kind==='video')} onClick={exportMp4}>{busy?'正在製作影片…':'開始輸出 MP4 ↗'}</button>{busy&&<div className="progress"><span style={{width:progress+'%'}}/></div>}</section></div>
    <section className="panel timeline"><div className="panelHead"><div><b>素材與時間軸</b><span>{assets.length} 個素材</span></div><button className="btn compact" onClick={()=>input.current?.click()}>＋ 新增素材</button></div>{assets.length===0?<button className="dropzone" onClick={()=>input.current?.click()}><strong>↑</strong><b>拖曳素材到這裡，或點擊上傳</b><small>支援 MP4、MOV、WEBM、JPG、PNG、MP3、WAV；圖片預設 5 秒</small></button>:<div className="assetList">{assets.map((a,i)=><div className={'asset '+(selected===a.id?'chosen':'')} key={a.id} onClick={()=>setSelected(a.id)}><div className="assetIcon">{a.kind==='video'?'▶':a.kind==='image'?'▧':'♫'}</div><div className="assetBody"><b>{a.file.name}</b><small>{a.kind.toUpperCase()}　{a.duration?time(a.duration):'讀取片長中…'}</small>{a.kind!=='audio'&&<div className="trim"><span>起點</span><input type="number" min="0" max={a.duration||undefined} step=".1" value={a.start} onChange={e=>patch(a.id,{start:Math.max(0,Number(e.target.value))})}/><span>終點</span><input type="number" min={a.start} max={a.duration||undefined} step=".1" value={a.end} onChange={e=>patch(a.id,{end:Math.min(a.duration||Number(e.target.value),Math.max(a.start,Number(e.target.value)))})}/></div>}</div><div className="assetActions"><button onClick={e=>{e.stopPropagation();reorder(a.id,-1)}}>↑</button><button onClick={e=>{e.stopPropagation();reorder(a.id,1)}}>↓</button><button onClick={e=>{e.stopPropagation();remove(a.id)}}>×</button></div></div>)}</div>}</section>
    <div className="status"><i/> {status}</div></main></div>
    <input ref={input} type="file" hidden multiple accept="video/*,image/*,audio/*" onChange={e=>importFiles(e.target.files)}/>
  </div>;
}

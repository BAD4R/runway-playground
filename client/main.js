// Runway API Playground (deferred uploads & multi-image)
const API_BASE = "http://localhost:5100/api";
const API_VERSION = "2024-11-06";

const PRICING = {
  gen4_aleph: { kind: "video", creditsPerSecond: 15, durations: [5] },
  gen4_turbo: { kind: "video", creditsPerSecond: 5, durations: [5, 10] },
  gen4_image: { kind: "image", creditsPerImage: { "720p": 5, "1080p": 8 } },
};

// State for deferred uploads
const state = {
  videoFile: null,         // File or null
  imageFiles: [],          // Files for Turbo input
  imageUrls: [],           // URLs added for Turbo input
  refFiles: [],            // Files for reference images
  refUrls: [],             // URLs added for references
};

const els = {
  apiKey: document.getElementById("apiKey"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  balanceCredits: document.getElementById("balanceCredits"),
  balanceUSD: document.getElementById("balanceUSD"),
  refreshBalanceBtn: document.getElementById("refreshBalanceBtn"),

  form: document.getElementById("genForm"),
  model: document.getElementById("model"),
  ratio: document.getElementById("ratio"),
  duration: document.getElementById("duration"),

  // VIDEO (Aleph)
  videoUrl: document.getElementById("videoUrl"),
  videoFileInput: document.getElementById("videoFile"),
  videoList: document.getElementById("videoList"),

  // TURBO (image->video)
  imageUrlInput: document.getElementById("imageUrlInput"),
  addImageUrlBtn: document.getElementById("addImageUrlBtn"),
  imageFileInput: document.getElementById("imageFile"),
  imageList: document.getElementById("imageList"),

  // REFERENCES
  refUrlInput: document.getElementById("refUrlInput"),
  addRefUrlBtn: document.getElementById("addRefUrlBtn"),
  refFileInput: document.getElementById("refFile"),
  refList: document.getElementById("refList"),

  promptText: document.getElementById("promptText"),
  seed: document.getElementById("seed"),
  submitBtn: document.getElementById("submitBtn"),
  cancelBtn: document.getElementById("cancelBtn"),

  estCredits: document.getElementById("estCredits"),
  estUSD: document.getElementById("estUSD"),

  statusBadge: document.getElementById("statusBadge"),
  taskIdWrap: document.getElementById("taskIdWrap"),
  taskId: document.getElementById("taskId"),
  log: document.getElementById("log"),
  output: document.getElementById("output"),
};


function getApiKey(){ return els.apiKey.value.trim() || localStorage.getItem("RUNWAY_API_KEY") || ""; }
function setApiKey(k){ localStorage.setItem("RUNWAY_API_KEY", k); }
function logLine(obj){ const t=new Date().toLocaleTimeString(); let s=`[${t}] `; s+= typeof obj==="string"?obj:JSON.stringify(obj,null,2); els.log.textContent+=s+"\\n"; els.log.scrollTop=els.log.scrollHeight; }
function setBadge(state,text){ els.statusBadge.className="badge "+(state||""); els.statusBadge.textContent=text; }
function toUSD(c){ return (c*0.01).toFixed(2); }
function parseIntOrNull(v){ const n=parseInt(v,10); return Number.isFinite(n)?n:null; }

function extractCreditBalance(j){
  if (!j) return null;
  if (typeof j.creditBalance==="number") return j.creditBalance;
  if (typeof j.credits==="number") return j.credits;
  if (j.organization && typeof j.organization.credits==="number") return j.organization.credits;
  let found=null; (function walk(v){ if(found!==null)return; if(v&&typeof v==="object"){ for(const[k,val]of Object.entries(v)){ if(found!==null)break; if(/credit/i.test(k)&&typeof val==="number"){found=val;break;} walk(val);} } })(j);
  return found;
}

(function init(){
  // Не даём браузеру открывать файл при dnd по странице
  window.addEventListener("dragover", (e)=> e.preventDefault());
  window.addEventListener("drop", (e)=> {
    if (!e.target || !(e.target.closest && e.target.closest(".dz-area"))) {
      e.preventDefault();
    }
  });

  const saved=localStorage.getItem("RUNWAY_API_KEY"); if(saved) els.apiKey.value=saved;
  els.saveKeyBtn.addEventListener("click",()=>{ const k=els.apiKey.value.trim(); if(!k){alert("Введите API ключ.");return;} setApiKey(k); alert("Ключ сохранён."); refreshBalance(); });
  els.refreshBalanceBtn.addEventListener("click", refreshBalance);

  els.model.addEventListener("change", handleModelChange); handleModelChange();
  ["change","input"].forEach(evt=>{ els.model.addEventListener(evt,updateEstimate); els.duration.addEventListener(evt,updateEstimate); els.ratio.addEventListener(evt,updateEstimate); });
  updateEstimate();
  renderFiles();   // первичный рендер пустых списков


  // DnD + file inputs + "выбрать файл" (pick) кнопки
  // Привязываем все кнопки data-action="pick" к соответствующим <input type="file">
  document.querySelectorAll('button[data-action="pick"]').forEach(btn => {
    const forId = btn.getAttribute("data-for");
    const inp = document.getElementById(forId);
    if (inp) btn.addEventListener("click", () => inp.click());
  });

  // VIDEO (Aleph) — одиночный файл
  bindDnD("videoDrop",".dz-area","video/*",(files)=>{ if(files[0]){ state.videoFile = files[0]; renderFiles(); } });
  els.videoFileInput.addEventListener("change", ()=>{
    if (els.videoFileInput.files && els.videoFileInput.files[0]) {
      state.videoFile = els.videoFileInput.files[0];
      renderFiles();
    }
  });

  // TURBO — множественные картинки (вход)
  bindDnD("imageDrop",".dz-area","image/*",(files)=>{ if(files.length){ state.imageFiles.push(...files); renderFiles(); } });
  els.imageFileInput.addEventListener("change", ()=>{
    if (els.imageFileInput.files && els.imageFileInput.files.length) {
      state.imageFiles.push(...Array.from(els.imageFileInput.files));
      renderFiles();
    }
  });
  els.addImageUrlBtn.addEventListener("click", ()=>{
    const u = els.imageUrlInput.value.trim();
    if (u) { state.imageUrls.push(u); els.imageUrlInput.value = ""; renderFiles(); }
  });

  // REFERENCES — множественные
  bindDnD("refDrop",".dz-area","image/*",(files)=>{
    if (files.length) { state.refFiles.push(...files); renderFiles(); }
  });
  if (els.refFileInput) {
    els.refFileInput.addEventListener("change", ()=>{
      if (els.refFileInput.files && els.refFileInput.files.length) {
        state.refFiles.push(...Array.from(els.refFileInput.files));
        renderFiles();
      }
    });
  }
  if (els.addRefUrlBtn && els.refUrlInput) {
    els.addRefUrlBtn.addEventListener("click", ()=>{
      const u = els.refUrlInput.value.trim();
      if (u) { state.refUrls.push(u); els.refUrlInput.value = ""; renderFiles(); }
    });
}

  els.form.addEventListener("submit", onSubmit);
  els.cancelBtn.addEventListener("click", onCancel);

  setInterval(refreshBalance, 60*1000);
  refreshBalance();
})();

function bindDnD(containerId, areaSel, accept, onFiles) {
  const c = document.getElementById(containerId); if (!c) return;
  // Фолбэк: если .dz-area нет/переименована — используем сам контейнер
  const area = c.querySelector(areaSel) || c;

  const allow = (e) => { e.preventDefault(); e.stopPropagation(); };

  ["dragenter","dragover"].forEach(evt =>
    area.addEventListener(evt, e => { allow(e); area.classList.add("drag"); })
  );
  ["dragleave","drop"].forEach(evt =>
    area.addEventListener(evt, e => { allow(e); area.classList.remove("drag"); })
  );

  area.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    let files = [];
    if (dt?.items?.length) {
      for (const it of dt.items) {
        if (it.kind !== "file") continue;
        const f = it.getAsFile(); if (!f) continue;
        if (accept && accept.startsWith("image/") && !f.type.startsWith("image/")) continue;
        if (accept && accept.startsWith("video/") && !f.type.startsWith("video/")) continue;
        files.push(f);
      }
    } else if (dt?.files?.length) {
      files = Array.from(dt.files).filter(f => {
        if (!accept) return true;
        if (accept.startsWith("image/")) return f.type.startsWith("image/");
        if (accept.startsWith("video/")) return f.type.startsWith("video/");
        return true;
      });
    }
    if (files.length) onFiles(files);
  });
}



function renderFiles() {
  // VIDEO
  if (els.videoList) {
    els.videoList.innerHTML = "";
    if (state.videoFile) {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="thumb"><span>🎬 ${escapeHtml(state.videoFile.name)}</span></div>
        <div class="meta">${(state.videoFile.size/1024/1024).toFixed(1)} MB</div>
        <button type="button" class="secondary">Удалить</button>`;
      li.querySelector("button").addEventListener("click", () => {
        state.videoFile = null;
        renderFiles();
      });
      els.videoList.appendChild(li);
    }
  }

  // TURBO images
  if (els.imageList) {
    els.imageList.innerHTML = "";
    // URLs
    state.imageUrls.forEach((u, idx) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="thumb filled"><img src="${u}" onerror="this.src='';this.parentNode.textContent='URL';"/></div>
        <div class="meta">${escapeHtml(u)}</div>
        <button type="button" class="secondary">Удалить</button>`;
      li.querySelector("button").addEventListener("click", () => {
        state.imageUrls.splice(idx, 1);
        renderFiles();
      });
      els.imageList.appendChild(li);
    });
    // FILES
    state.imageFiles.forEach((f, idx) => {
      const li = document.createElement("li");
      const url = URL.createObjectURL(f);
      li.innerHTML = `
        <div class="thumb filled"><img src="${url}" /></div>
        <div class="meta">${escapeHtml(f.name)}</div>
        <button type="button" class="secondary">Удалить</button>`;
      li.querySelector("button").addEventListener("click", () => {
        state.imageFiles.splice(idx, 1);
        renderFiles();
      });
      els.imageList.appendChild(li);
    });
  }

  // REFERENCES
  if (els.refList) {
    els.refList.innerHTML = "";
    state.refUrls.forEach((u, idx) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <div class="thumb filled"><img src="${u}" onerror="this.src='';this.parentNode.textContent='URL';"/></div>
        <div class="meta">${escapeHtml(u)}</div>
        <button type="button" class="secondary">Удалить</button>`;
      li.querySelector("button").addEventListener("click", () => {
        state.refUrls.splice(idx, 1);
        renderFiles();
      });
      els.refList.appendChild(li);
    });
    state.refFiles.forEach((f, idx) => {
      const li = document.createElement("li");
      const url = URL.createObjectURL(f);
      li.innerHTML = `
        <div class="thumb filled"><img src="${url}" /></div>
        <div class="meta">${escapeHtml(f.name)}</div>
        <button type="button" class="secondary">Удалить</button>`;
      li.querySelector("button").addEventListener("click", () => {
        state.refFiles.splice(idx, 1);
        renderFiles();
      });
      els.refList.appendChild(li);
    });
  }
}


function handleModelChange(){
  const m=els.model.value;
  document.getElementById("videoDrop").classList.toggle("hidden", m!=="gen4_aleph");
  document.getElementById("imageDrop").classList.toggle("hidden", m!=="gen4_turbo");
  els.duration.disabled = (m==="gen4_image");
  updateEstimate();
  renderFiles();
}

function updateEstimate(){
  const m=els.model.value;
  let credits=0; const p=PRICING[m];
  if(!p){ els.estCredits.textContent="—"; els.estUSD.textContent="—"; return; }
  if(p.kind==="video"){
    const dur=parseIntOrNull(els.duration.value)||5;
    if(m==="gen4_aleph" && dur!==5) els.duration.value="5";
    credits=dur*(p.creditsPerSecond||0);
  }else if(p.kind==="image"){
    credits=p.creditsPerImage["720p"]||5;
  }
  els.estCredits.textContent=String(credits);
  els.estUSD.textContent=toUSD(credits);
}

function getHeaders(){
  const key=getApiKey(); if(!key) throw new Error("Не задан API ключ.");
  return {"Content-Type":"application/json","Authorization":`Bearer ${key}`,"X-Runway-Version":API_VERSION};
}

async function refreshBalance(){
  try{
    const r=await fetch(`${API_BASE}/organization`,{method:"GET",headers:getHeaders()});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const j=await r.json();
    const bal=extractCreditBalance(j);
    if(typeof bal==="number"){ els.balanceCredits.textContent=String(bal); els.balanceUSD.textContent=toUSD(bal); }
    else{ els.balanceCredits.textContent="неизв."; els.balanceUSD.textContent="—"; }
    logLine({balance:j});
  }catch(e){ logLine("Ошибка получения баланса: "+e.message); }
}

async function onSubmit(e){
  e.preventDefault();
  els.output.innerHTML="";
  setBadge("sent","запрос отправлен");
  els.taskIdWrap.classList.add("hidden");
  els.taskId.textContent="—";
  els.cancelBtn.disabled=true;

  const model=els.model.value;
  const ratio=els.ratio.value;
  const promptText=els.promptText.value.trim();
  const seed=els.seed.value?parseInt(els.seed.value,10):undefined;

  try{
    // Gather URLs (deferred upload now)
    const urls = await ensurePublicUrls();
    const { videoUrl, imageUrls, refUrls } = urls;

    let payload, endpoint;
    if(model==="gen4_aleph"){
      const videoUri = els.videoUrl.value.trim() || videoUrl;
      if(!videoUri){ alert("Добавьте URL/файл видео."); return; }
      payload={ model, videoUri, promptText, ratio, duration:5 };
      if(seed!==undefined && Number.isFinite(seed)) payload.seed=seed;
      if(refUrls.length) payload.referenceImages = refUrls; // plural when multiple
      endpoint="/video_to_video";
    } else if(model==="gen4_turbo"){
      const allImages = [...state.imageUrls, ...imageUrls]; // prefer explicit URL list + newly uploaded
      if(!allImages.length){ alert("Добавьте URL/файлы изображений для Turbo."); return; }
      const duration=parseIntOrNull(els.duration.value)||5;
      // Prefer field promptImages when multiple; keep promptImage for single for backward compat
      payload={ model, promptText, ratio, duration };
      if(allImages.length===1) payload.promptImage = allImages[0];
      else payload.promptImages = allImages;
      if(seed!==undefined && Number.isFinite(seed)) payload.seed=seed;
      if(refUrls.length) payload.referenceImages = refUrls;
      endpoint="/image_to_video";
    } else if(model==="gen4_image"){
      payload={ model, promptText, ratio, resolution:"720p" };
      if(refUrls.length) payload.referenceImages = refUrls;
      endpoint="/text_to_image";
    } else {
      throw new Error("Неизвестная модель");
    }

    logLine({request:{endpoint,payload}});
    const start=await startTask(payload, endpoint);
    logLine({start});
    const taskId = start?.id || start?.taskId || start?.task?.id;
    if(!taskId) throw new Error("Не удалось получить ID задачи из ответа.");
    els.taskId.textContent=taskId; els.taskIdWrap.classList.remove("hidden"); els.cancelBtn.disabled=false;
    setBadge("processing","обрабатывается");
    pollTask(taskId);
  }catch(err){
    setBadge("fail","ошибка");
    logLine("Ошибка старта: "+(err?.message||err));
  }
}

// Upload pending Files to proxy to get public URLs (transfer.sh). Do nothing for existing URLs.
async function ensurePublicUrls(){
  // Video
  let videoUrl=null;
  if(state.videoFile){
    const res = await uploadFiles([state.videoFile]);
    videoUrl = res[0];
  }
  // Turbo images
  let imageUrls=[];
  if(state.imageFiles.length){
    const res = await uploadFiles(state.imageFiles);
    imageUrls = res;
  }
  // Refs
  let refUrls=[];
  if(state.refFiles.length){
    const res = await uploadFiles(state.refFiles);
    refUrls = res;
  }
  return {
    videoUrl,
    imageUrls,
    refUrls: [...state.refUrls, ...refUrls], // keep manual URLs + uploaded ones
  };
}

async function uploadFiles(files){
  const fd=new FormData();
  files.forEach(f=> fd.append("files", f, f.name));
  const r=await fetch("http://localhost:5100/file/upload", { method:"POST", body: fd });
  if(!r.ok){
    const t=await r.text().catch(()=> "");
    throw new Error(`upload HTTP ${r.status} ${t}`);
  }
  const j=await r.json();
  if(Array.isArray(j.urls) && j.urls.length===files.length) return j.urls;
  throw new Error("Некорректный ответ загрузки: "+JSON.stringify(j));
}

async function startTask(payload, endpointPath){
  const res = await fetch(`${API_BASE}${endpointPath}`, { method:"POST", headers:getHeaders(), body: JSON.stringify(payload) });
  if(!res.ok){ const t=await res.text().catch(()=> ""); throw new Error(`HTTP ${res.status}: ${t || res.statusText}`); }
  return await res.json();
}

let currentTaskId=null, pollTimer=null;
async function pollTask(id){
  clearInterval(pollTimer);
  pollTimer = setInterval(async ()=>{
    try{
      const res=await fetch(`${API_BASE}/tasks/${encodeURIComponent(id)}`, { method:"GET", headers:getHeaders() });
      const data=await res.json();
      logLine({status:data});
      const status=(data?.status||data?.task?.status||"").toLowerCase();
      if(["succeeded","completed","complete","done"].includes(status)){
        clearInterval(pollTimer); setBadge("ok","выполнено"); els.cancelBtn.disabled=true; showOutput(data); refreshBalance();
      } else if(["failed","error","cancelled"].includes(status)){
        clearInterval(pollTimer); setBadge("fail",status); els.cancelBtn.disabled=true; refreshBalance();
      }
    }catch(e){ logLine("Ошибка опроса задачи: "+e.message); }
  }, 2500);
}

async function onCancel(){
  if(!currentTaskId) return;
  try{
    const res=await fetch(`${API_BASE}/tasks/${encodeURIComponent(currentTaskId)}`, { method:"DELETE", headers:getHeaders() });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    setBadge("fail","отменено"); els.cancelBtn.disabled=true; clearInterval(pollTimer); logLine("Задача отменена."); refreshBalance();
  }catch(e){ logLine("Ошибка отмены: "+e.message); }
}

function safeGet(obj, paths){ for(const p of paths){ const parts=p.split("."); let cur=obj,ok=true; for(const key of parts){ if(cur&&typeof cur==="object" && key in cur) cur=cur[key]; else {ok=false;break;} } if(ok) return cur; } return null; }
function showOutput(data){
  const videoUris=[], imageUris=[];
  const candidates=["output","outputs","result","results","task.output","task.outputs","artifacts","data"];
  for(const c of candidates){
    const val=safeGet(data,[c]); if(!val) continue;
    const arr=Array.isArray(val)?val:[val];
    for(const item of arr){
      if(item && typeof item==="object"){
        const uri=item.uri||item.url||item.signedUrl||item.href;
        const mime=item.mime||item.mimetype||item.contentType;
        if(uri && typeof uri==="string"){
          if((mime&&mime.startsWith("video"))||/\.(mp4|webm|mov|m4v)(\?|$)/i.test(uri)) videoUris.push(uri);
          else if((mime&&mime.startsWith("image"))||/\.(png|jpe?g|webp)(\?|$)/i.test(uri)) imageUris.push(uri);
        }
      } else if (typeof item==="string"){
        if(/\.mp4|\.webm|\.mov|\.m4v/i.test(item)) videoUris.push(item);
        if(/\.png|\.jpg|\.jpeg|\.webp/i.test(item)) imageUris.push(item);
      }
    }
  }
  const out=[];
  videoUris.forEach((u,i)=> out.push(card("Видео "+(i+1), `<video controls src="${u}"></video>`)));
  imageUris.forEach((u,i)=> out.push(card("Кадр "+(i+1), `<img src="${u}" alt="output ${i+1}"/>`)));
  if(!out.length) out.push(card("Нет распознанных медиа", `<pre class="log">${escapeHtml(JSON.stringify(data,null,2))}</pre>`));
  els.output.innerHTML=out.join("");
}
function card(title, html){ return `<div class="card"><header>${title}</header><div class="content">${html}</div></div>`; }
function escapeHtml(str){ return str.replace(/[&<>"']/g,(m)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])); }

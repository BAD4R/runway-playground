import * as api from './api.js';
import { getApiKey, setApiKey } from './state.js';
import { positionPopup, hidePopups, togglePopup, showToast } from './ui.js';

const log = (...args) => console.log('[chat]', ...args);

let modelBtn, modelMenu, chatListEl, newChatBtn, messagesEl, promptInput,
    sendBtn, attachBtn, ratioBtn, durationBtn, hiddenFile, apiKeyInput,
    saveKeyBtn, balanceEl, attachPreview, attachMenu, estCost,
    settingsBtn, settingsModal, viewer;

let chats = [];
let activeChat = null;
let currentModel = 'gen4_image';
let currentFiles = {};
let currentRatio = null;
let currentDuration = null;
let chatColor = '#d946ef';
let autoAttach = false;

function withAlpha(hex, alpha){
  const r=parseInt(hex.slice(1,3),16);
  const g=parseInt(hex.slice(3,5),16);
  const b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function autoResize(el){
  el.style.height='auto';
  el.style.height=Math.min(el.scrollHeight,120)+'px';
}

function openViewer(src,isVideo){
  viewer.innerHTML='';
  const content=document.createElement('div');
  content.className='modal-content';
  const el=isVideo?document.createElement('video'):document.createElement('img');
  el.src=src;
  if(isVideo) el.controls=true;
  content.appendChild(el);
  viewer.appendChild(content);
  viewer.classList.remove('hidden');
}

const MODEL_INFO = {
  gen4_image:{
    label:'Gen4 Image',
    color:'#d946ef',
    desc:'Генерация изображений по тексту и референсам.',
    usage:'Например, "@EiffelTower в стиле @StarryNight"',
    price:'5 ток/720p (0.05$), 8 ток/1080p (0.08$)',
    endpoint:'text_to_image',
    prompt:true,
    ratios:['1920:1080','1080:1920','1024:1024','1360:768','1080:1080','1168:880','1440:1080','1080:1440','1808:768','2112:912','1280:720','720:1280','720:720','960:720','720:960','1680:720'],
    slots:[{name:'referenceImages',label:'Референсы',help:'до 3 изображений',type:'image',multiple:true,count:3}],
    cost:({ratio})=> (ratio&&ratio.includes('1080')?8:5)
  },
  gen4_image_turbo:{
    label:'Gen4 Image Turbo',
    color:'#6366f1',
    desc:'Быстрая генерация изображений.',
    usage:'Быстрые черновые картинки',
    price:'2 ток (0.02$)',
    endpoint:'text_to_image',
    prompt:true,
    ratios:['1280:720','720:1280'],
    slots:[{name:'referenceImages',label:'Референсы',help:'до 3 изображений',type:'image',multiple:true,count:3,required:true}],
    cost:()=>2
  },
  gen4_turbo:{
    label:'Gen4 Turbo',
    color:'#0ea5e9',
    desc:'Создание короткого видео по изображению и тексту.',
    usage:'Замените видео фон на фон из референса',
    price:'5 ток/сек (0.05$/сек)',
    endpoint:'image_to_video',
    prompt:true,
    ratios:['1280:720','720:1280','1104:832','832:1104','960:960','1584:672'],
    durations:[5,10],
    slots:[{name:'promptImage',label:'Изображение',help:'первый кадр',type:'image',count:1,required:true}],
    cost:({duration=5})=>5*duration
  },
  gen4_aleph:{
    label:'Gen4 Aleph',
    color:'#22c55e',
    desc:'Преобразование видео с учётом референсов.',
    usage:'Видео по видео с применением стиля',
    price:'15 ток/сек (0.15$/сек)',
    endpoint:'video_to_video',
    prompt:true,
    ratios:['1280:720','720:1280','1104:832','960:960','832:1104','1584:672','848:480','640:480'],
    slots:[{name:'videoUri',label:'Видео',help:'исходное видео',type:'video',count:1,required:true},{name:'references',label:'Референсы',help:'изображения стиля',type:'image',multiple:true,count:3}],
    cost:({duration=5})=>15*duration
  },
  upscale_v1:{
    label:'Upscale v1',
    color:'#f97316',
    desc:'Апскейл видео до 4K.',
    usage:'Улучшение качества готового видео',
    price:'2 ток/сек (0.02$/сек)',
    endpoint:'video_upscale',
    slots:[{name:'videoUri',label:'Видео',help:'для апскейла',type:'video',count:1,required:true}],
    cost:({duration=5})=>2*duration
  },
  act_two:{
    label:'Act Two',
    color:'#eab308',
    desc:'Анимация персонажа по движению актёра.',
    usage:'Оживите персонажа по эталонному видео',
    price:'5 ток/сек (0.05$/сек)',
    endpoint:'character_performance',
    ratios:['1280:720','720:1280','960:960','1104:832','832:1104','1584:672'],
    slots:[{name:'character',label:'Персонаж',help:'изображение или видео',type:'image',count:1,required:true},{name:'reference',label:'Референс',help:'видео движения',type:'video',count:1,required:true}],
    cost:({duration=5})=>5*duration
  },
  veo3:{
    label:'Veo3',
    color:'#14b8a6',
    desc:'Высококачественное видео из изображения.',
    usage:'Снимите кинематографичный ролик из фото',
    price:'40 ток/сек (0.40$/сек)',
    endpoint:'image_to_video',
    prompt:true,
    ratios:['1280:720','720:1280'],
    durations:[8],
    slots:[{name:'promptImage',label:'Изображение',help:'начальный кадр',type:'image',count:1,required:true}],
    cost:({duration=8})=>40*duration
  }
};

function populateModelMenu(){
  modelMenu.innerHTML='';
  Object.keys(MODEL_INFO).forEach(m=>{
    const btn=document.createElement('button');
    btn.textContent=MODEL_INFO[m].label;
    btn.addEventListener('click',()=>{selectModel(m);hidePopups();});
    const infoIcon=document.createElement('span');
    infoIcon.className='info-icon';
    infoIcon.innerHTML='<img src="./icons/info.svg" alt="info" />';
    attachModelInfo(infoIcon,m);
    btn.appendChild(infoIcon);
    modelMenu.appendChild(btn);
  });
}

function attachModelInfo(el,key){
  let timer,popup;
  const show=()=>{
    const info=MODEL_INFO[key];
    popup=document.createElement('div');
    popup.className='popup model-info';
    popup.innerHTML=`<p>${info.desc}</p><p class="usage">${info.usage}</p><p class="price">${info.price}</p>`;
    document.body.appendChild(popup);
    positionPopup(el,popup);
  };
  el.addEventListener('mouseenter',()=>{timer=setTimeout(show,300);});
  el.addEventListener('mouseleave',()=>{clearTimeout(timer); if(popup){popup.remove(); popup=null;}});
}

function selectModel(m){
  currentModel=m;
  const info=MODEL_INFO[m];
  modelBtn.textContent=info.label;
  chatColor=info.color;
  document.documentElement.style.setProperty('--accent', chatColor);
  document.documentElement.style.setProperty('--accent-bg', withAlpha(chatColor,0.15));
  ratioBtn.style.display = info.ratios ? '' : 'none';
  durationBtn.style.display = info.durations ? '' : 'none';
  currentRatio=null; currentDuration=null; currentFiles={};
  renderAttachPreview();
  renderAttachMenu();
  updateCost();
  updateChatState();
  updateModelDesc();
}

function renderAttachMenu(){
  attachMenu.innerHTML='';
  const info=MODEL_INFO[currentModel];
  if(!info.slots) return;
  info.slots.forEach(slot=>{
    const lbl=document.createElement('div');
    lbl.className='slot-label';
    lbl.textContent=slot.label;
    attachMenu.appendChild(lbl);
    const hint=document.createElement('div');
    hint.className='slot-hint';
    hint.textContent=slot.help;
    attachMenu.appendChild(hint);
    const cont=document.createElement('div');
    cont.className='slot-container';
    const val=currentFiles[slot.name];
    const arr=slot.multiple ? (Array.isArray(val)?val:[]) : (val?[val]:[]);
    for(let i=0;i<slot.count;i++){
      cont.appendChild(makeSlot(slot.name,i,arr[i]));
    }
    attachMenu.appendChild(cont);
  });
}

function makeSlot(slotName,index,uri){
  const slot=document.createElement('div');
  slot.className='attach-slot';
  slot.dataset.slot=slotName;
  slot.dataset.index=index;
  if(uri){
    slot.classList.add('filled');
    let el;
    if(uri.startsWith('data:video')){
      el=document.createElement('video');
      el.src=uri; el.muted=true; el.loop=true; el.play();
    }else{
      el=document.createElement('img');
      el.src=uri;
    }
    el.addEventListener('click',()=>openViewer(uri,uri.startsWith('data:video')));
    slot.appendChild(el);
    const rm=document.createElement('button');
    rm.className='remove';
    rm.textContent='×';
    rm.addEventListener('click',e=>{e.stopPropagation();removeFile(slotName,index);});
    slot.appendChild(rm);
  }else{
    slot.classList.add('drop-zone');
    slot.textContent='+';
    slot.addEventListener('click',()=>openFile(slotName,index));
    slot.addEventListener('dragover',e=>{e.preventDefault();slot.classList.add('dragover');});
    slot.addEventListener('dragleave',()=>slot.classList.remove('dragover'));
    slot.addEventListener('drop',e=>{e.preventDefault();slot.classList.remove('dragover'); if(autoAttach) autoAttach=false; handleFiles(slotName,index,e.dataTransfer.files);});
  }
  return slot;
}

function openFile(slotName,index){
  hiddenFile.dataset.slot=slotName;
  hiddenFile.dataset.index=index;
  hiddenFile.click();
}

function handleFiles(slotName,index,files){
  const file=files[0];
  if(!file) return;
  const info=MODEL_INFO[currentModel];
  if(file.type.startsWith('video/') && !info.durations){
    const v=document.createElement('video');
    v.preload='metadata';
    v.onloadedmetadata=()=>{
      currentDuration=Math.ceil(v.duration);
      updateCost();
      updateChatState();
      URL.revokeObjectURL(v.src);
    };
    v.src=URL.createObjectURL(file);
  }
  const reader=new FileReader();
  reader.onload=()=>{
    const slot=MODEL_INFO[currentModel].slots.find(s=>s.name===slotName);
    if(slot.multiple){
      if(!Array.isArray(currentFiles[slotName])) currentFiles[slotName]=Array(slot.count).fill(null);
      currentFiles[slotName][index]=reader.result;
    }else{
      currentFiles[slotName]=reader.result;
    }
    renderAttachMenu();
    renderAttachPreview();
    updateChatState();
    if(autoAttach) autoAttach=false;
  };
  reader.readAsDataURL(file);
}

function removeFile(slotName,index){
  const slot=MODEL_INFO[currentModel].slots.find(s=>s.name===slotName);
  if(slot.multiple){
    if(Array.isArray(currentFiles[slotName])) currentFiles[slotName][index]=null;
  }else{
    delete currentFiles[slotName];
  }
  if(slot.name==='videoUri' && !MODEL_INFO[currentModel].durations){
    currentDuration=null;
    updateCost();
    updateChatState();
  }
  renderAttachMenu();
  renderAttachPreview();
  updateChatState();
}

function renderAttachPreview(){
  attachPreview.innerHTML='';
  Object.keys(currentFiles).forEach(slot=>{
    const val=currentFiles[slot];
    const arr=Array.isArray(val)?val:[val];
    arr.forEach((uri,i)=>{
      if(!uri) return;
      const wrap=document.createElement('div');
      wrap.className='thumb';
      wrap.style.backgroundImage="url('./images/empty-field-bg.png')";
      let el;
      if(typeof uri==='string' && uri.startsWith('data:video')){
        el=document.createElement('video');
        el.src=uri; el.muted=true; el.loop=true; el.play();
      }else{
        el=document.createElement('img');
        el.src=uri;
      }
      el.addEventListener('click',()=>openViewer(uri,uri.startsWith('data:video')));
      wrap.appendChild(el);
      const rm=document.createElement('button');
      rm.textContent='×';
      rm.addEventListener('click',e=>{e.stopPropagation();removeFile(slot,i);});
      wrap.appendChild(rm);
      attachPreview.appendChild(wrap);
    });
  });
  log('preview files', Object.keys(currentFiles).length);
}

function updateModelDesc(){
  const el=messagesEl.querySelector('.model-desc');
  if(el) el.textContent=MODEL_INFO[currentModel].desc;
}

function renderChatList(){
  chatListEl.innerHTML='';
  chats.forEach(c=>{
    const li=document.createElement('li');
    li.dataset.id=c.id;
    const span=document.createElement('span');
    span.textContent=c.name;
    li.appendChild(span);
    const menuBtn=document.createElement('button');
    menuBtn.className='menu-btn';
    menuBtn.innerHTML='<img src="./icons/ellipsis.svg" alt="menu" />';
    li.appendChild(menuBtn);
    menuBtn.addEventListener('click',e=>{e.stopPropagation();hidePopups();showChatMenu(c.id,li);});
    if(activeChat===c.id) li.classList.add('active');
    li.addEventListener('click',()=>{selectChat(c.id);});
    chatListEl.appendChild(li);
  });
}

function showChatMenu(id, li){
  let menu=li.querySelector('.chat-menu');
  if(menu){ menu.remove(); return; }
  menu=document.createElement('div');
  menu.className='chat-menu popup';
  const rename=document.createElement('button');
  rename.innerHTML='<img src="./icons/pencil.svg" alt="rename" /> Переименовать';
  rename.addEventListener('click',async e=>{
    e.stopPropagation();
    const name=prompt('Новое имя чата');
    if(name){ await api.updateChat(id,{name}); const c=chats.find(x=>x.id===id); if(c) c.name=name; renderChatList(); }
    menu.remove();
  });
  const del=document.createElement('button');
  del.className='danger';
  del.innerHTML='<img src="./icons/trash.svg" alt="delete" /> Удалить';
  del.addEventListener('click',async e=>{
    e.stopPropagation();
    if(confirm('Удалить чат?')){
      await api.deleteChat(id);
      chats=chats.filter(c=>c.id!==id);
      if(activeChat===id){activeChat=null; if(chats[0]) selectChat(chats[0].id); else messagesEl.innerHTML='';}
      else renderChatList();
    }
    menu.remove();
  });
  menu.appendChild(rename);
  menu.appendChild(del);
  li.appendChild(menu);
}

async function loadChats(){
  try{ chats=await api.listChats(); }catch(e){ chats=[]; }
  renderChatList();
  if(chats.length===0){
    const color=MODEL_INFO[currentModel].color;
    const c=await api.createChat('Новый чат',{color,model:currentModel});
    c.state={color,model:currentModel};
    chats.unshift(c);
    renderChatList();
  }
  if(!activeChat && chats[0]) selectChat(chats[0].id);
}

async function selectChat(id){
  if(id===activeChat) return;
  const chat=await api.getChat(id);
  const msgs=await api.listMessages(id);
  promptInput.value=chat.state.prompt||'';
  currentModel=chat.state.model||currentModel;
  currentFiles=chat.state.files||{};
  currentRatio=chat.state.ratio||null;
  currentDuration=chat.state.duration||null;
  renderAttachMenu();
  renderAttachPreview();
  updateCost();
  updateModelDesc();
  renderMessages(msgs);

  activeChat=id;
  const info=MODEL_INFO[currentModel];
  chatColor=info.color;
  modelBtn.textContent=info.label;
  ratioBtn.style.display = info.ratios ? '' : 'none';
  durationBtn.style.display = info.durations ? '' : 'none';
  document.documentElement.style.setProperty('--accent', chatColor);
  document.documentElement.style.setProperty('--accent-bg', withAlpha(chatColor,0.15));
  renderChatList();
  if((chat.state.color||'')!==chatColor){ chat.state.color=chatColor; await api.updateChat(id,{state:chat.state}); }
}

function renderMessages(msgs){
  messagesEl.classList.add('fade-out');
  setTimeout(()=>{
    messagesEl.innerHTML='';
    if(msgs.length===0){
      const d=document.createElement('div');
      d.className='model-desc';
      d.textContent=MODEL_INFO[currentModel].desc;
      messagesEl.appendChild(d);
    }else{
      msgs.forEach(m=>messagesEl.appendChild(createMessageEl(m)));
      messagesEl.scrollTop=messagesEl.scrollHeight;
    }
    messagesEl.classList.remove('fade-out');
    messagesEl.classList.add('fade-in');
    setTimeout(()=>messagesEl.classList.remove('fade-in'),200);
  },200);
}

function createMessageEl(m){
  const div=document.createElement('div');
  div.className='message '+m.role;
  const header=document.createElement('div');
  header.className='msg-header';
  if(m.status){
    const s=document.createElement('span');
    s.className='status '+statusClass(m.status);
    s.textContent=m.status;
    header.appendChild(s);
  }
  div.appendChild(header);
  if(m.content){
    const p=document.createElement('p');
    p.textContent=m.content;
    div.appendChild(p);
  }
  if(m.attachments){
    m.attachments.forEach(a=>{
      const box=document.createElement('div');
      box.className='attachment-box';
      box.style.backgroundImage="url('./images/empty-field-bg.png')";
      let el;
      if(typeof a === 'string' && a.startsWith('data:video')){
        el=document.createElement('video');
        el.src=a; el.controls=true;
        el.addEventListener('click',()=>openViewer(a,true));
      }else{
        el=document.createElement('img');
        el.src=a;
        el.addEventListener('click',()=>openViewer(a,false));
      }
      el.className='attachment';
      box.appendChild(el);
      const dl=document.createElement('a');
      dl.href=a;
      dl.download='';
      dl.className='download-btn';
      dl.innerHTML='<img src="./icons/download.svg" alt="download" />';
      box.appendChild(dl);
      div.appendChild(box);
    });
  }
  if(m.params){
    const meta=document.createElement('div');
    meta.className='meta';
    meta.textContent=formatMeta(m.params);
    div.appendChild(meta);
  }
  return div;
}

function statusClass(text){
  if(text.startsWith('отправка')) return 'sending';
  if(text.startsWith('обработка')) return 'processing';
  if(text.startsWith('ошибка')) return 'error';
  if(text.startsWith('готово')) return 'done';
  return '';
}

function formatMeta(p){
  const parts=[p.model];
  if(p.ratio) parts.push(p.ratio);
  if(p.duration) parts.push(p.duration+' сек');
  if(p.credits!=null) parts.push(`${p.credits} ток $${(p.credits/100).toFixed(2)}`);
  return parts.join(' ');
}

function setStatus(el,text){
  const span=el.querySelector('.status');
  if(span){
    span.textContent=text;
    span.className='status '+statusClass(text);
  }
}

function updateChatState(){
  if(!activeChat) return;
  api.updateChat(activeChat,{state:{model:currentModel,prompt:promptInput.value,files:currentFiles,ratio:currentRatio,duration:currentDuration,color:chatColor}});
}

function updateCost(){
  const info=MODEL_INFO[currentModel];
  const credits=info.cost({ratio:currentRatio,duration:currentDuration})||0;
  const parts=[];
  const ratio=currentRatio||info.ratios?.[0];
  if(ratio) parts.push(ratio.replace(':','x'));
  const dur=currentDuration||info.durations?.[0];
  if(dur) parts.push(`${dur} секунд`);
  parts.push(`${(credits/100).toFixed(2)}$`);
  estCost.textContent=parts.join(', ');
}

async function handleSend(){
  const apiKey=getApiKey();
  if(!apiKey){ showToast('Введите API ключ'); return; }
  if(!activeChat){ showToast('Нет активного чата'); return; }
  const prompt=promptInput.value.trim();
  const info=MODEL_INFO[currentModel];
  if(info.prompt && !prompt){ showToast('Введите промпт'); return; }
  if(info.slots){
    for(const s of info.slots){
      if(s.required){
        const val=currentFiles[s.name];
        const arr=s.multiple? (Array.isArray(val)?val.filter(Boolean):[]) : (val?[val]:[]);
        if(arr.length===0){ showToast(`Добавьте ${s.label.toLowerCase()}`); return; }
      }
    }
  }
  const payload=await buildPayload(currentModel,prompt,currentFiles);
  const userMsg={role:'user',content:prompt,attachments:collectAllFiles()};
  await api.addMessage(activeChat,userMsg);
  messagesEl.querySelector('.model-desc')?.remove();
  messagesEl.appendChild(createMessageEl(userMsg));
  promptInput.value=''; autoResize(promptInput); currentFiles={}; renderAttachMenu(); renderAttachPreview(); updateChatState();
  const credits=info.cost({ratio:currentRatio,duration:currentDuration})||0;
  const params={model:info.label,ratio:currentRatio||info.ratios?.[0],duration:currentDuration,credits};
  const placeholder={role:'assistant',content:'',status:'отправка',attachments:[],params};
  const placeholderEl=createMessageEl(placeholder);
  messagesEl.appendChild(placeholderEl);
  messagesEl.scrollTop=messagesEl.scrollHeight;
  try{
    const res=await api.callRunway(apiKey,info.endpoint,payload);
    placeholder.status='обработка';
    setStatus(placeholderEl,placeholder.status);
    const task=await api.waitForTask(apiKey,res.id,t=>{
      if(t.status){
        const pct = t.progress!=null ? Math.floor(t.progress*100) : null;
        placeholder.status = pct!=null ? `обработка ${pct}%` : 'обработка';
        setStatus(placeholderEl,placeholder.status);
      }
    });
    if(task.status==='SUCCEEDED' && task.output){
      placeholder.status='готово';
      placeholder.attachments=await Promise.all(task.output.map(async u=>{
        if(typeof u==='string' && u.startsWith('data:')) return u;
        try{
          const r=await fetch(u);
          const b=await r.blob();
          return await new Promise(res=>{const fr=new FileReader();fr.onloadend=()=>res(fr.result);fr.readAsDataURL(b);});
        }catch{return u;}
      }));
    }else{
      placeholder.status='ошибка';
      placeholder.content='Ошибка генерации';
    }
  }catch(e){
    placeholder.status='ошибка';
    placeholder.content=e.message;
  }
  setStatus(placeholderEl,placeholder.status);
  await api.addMessage(activeChat,placeholder);
  placeholderEl.replaceWith(createMessageEl(placeholder));
  updateCost();
}

function collectAllFiles(){
  const arr=[];
  Object.values(currentFiles).forEach(v=>{ if(Array.isArray(v)) v.forEach(x=>{if(x) arr.push(x);}); else if(v) arr.push(v);});
  return arr;
}

async function buildPayload(model,prompt,files){
  const info=MODEL_INFO[model];
  switch(info.endpoint){
    case 'text_to_image':
      return {model,promptText:prompt,ratio:currentRatio||info.ratios?.[0],referenceImages:(files.referenceImages||[]).filter(Boolean).map(u=>({uri:u}))};
    case 'image_to_video':
      return {model,promptText:prompt,ratio:currentRatio||info.ratios?.[0],duration:currentDuration||info.durations?.[0],promptImage:files.promptImage};
    case 'video_to_video':
      return {model,promptText:prompt,ratio:currentRatio||info.ratios?.[0],videoUri:files.videoUri,references:(files.references||[]).filter(Boolean).map(u=>({type:'image',uri:u}))};
    case 'video_upscale':
      return {model,videoUri:files.videoUri};
    case 'character_performance':
      return {model,ratio:currentRatio||info.ratios?.[0],character:{type:'image',uri:files.character},reference:{type:'video',uri:files.reference}};
    default:
      return {model,promptText:prompt};
  }
}

async function refreshBalance(silent=false){
  const key=getApiKey();
  if(!key) return;
  const j=await api.fetchBalance(key,silent);
  if(j && typeof j.creditBalance==='number') balanceEl.textContent=j.creditBalance;
}

export function init(){
  modelBtn=document.getElementById('modelBtn');
  modelMenu=document.getElementById('modelMenu');
  chatListEl=document.getElementById('chatList');
  newChatBtn=document.getElementById('newChatBtn');
  messagesEl=document.getElementById('messages');
  promptInput=document.getElementById('promptInput');
  sendBtn=document.getElementById('sendBtn');
  attachBtn=document.getElementById('attachBtn');
  ratioBtn=document.getElementById('ratioBtn');
  durationBtn=document.getElementById('durationBtn');
  hiddenFile=document.getElementById('hiddenFile');
  apiKeyInput=document.getElementById('apiKey');
  saveKeyBtn=document.getElementById('saveKeyBtn');
  balanceEl=document.getElementById('balanceCredits');
  attachPreview=document.getElementById('attachPreview');
  attachMenu=document.getElementById('attachMenu');
  estCost=document.getElementById('estCost');
  settingsBtn=document.getElementById('settingsBtn');
  settingsModal=document.getElementById('settingsModal');
  viewer=document.getElementById('viewer');

  if(!modelBtn||!chatListEl||!newChatBtn||!messagesEl||!promptInput||!sendBtn||!attachBtn||!ratioBtn||!durationBtn||!hiddenFile||!apiKeyInput||!saveKeyBtn||!balanceEl||!attachPreview||!attachMenu||!settingsBtn||!settingsModal||!viewer){
    console.error('Missing DOM elements'); return;
  }

  populateModelMenu();
  selectModel(currentModel);
  apiKeyInput.value=getApiKey();
  if(apiKeyInput.value) refreshBalance(true);

  saveKeyBtn.addEventListener('click',()=>{ setApiKey(apiKeyInput.value.trim()); settingsModal.classList.add('hidden'); refreshBalance();});
  settingsBtn.addEventListener('click',()=>{ settingsModal.classList.remove('hidden'); });
  settingsModal.addEventListener('click',e=>{ if(e.target===settingsModal) settingsModal.classList.add('hidden'); });
  viewer.addEventListener('click',e=>{ if(e.target===viewer) viewer.classList.add('hidden'); });
  newChatBtn.addEventListener('click',async()=>{
    const color=MODEL_INFO[currentModel].color;
    const c=await api.createChat('Новый чат',{color,model:currentModel});
    c.state={color,model:currentModel};
    chatColor=color;
    document.documentElement.style.setProperty('--accent', color);
    document.documentElement.style.setProperty('--accent-bg', withAlpha(color,0.15));
    chats.unshift(c);
    renderChatList();
    selectChat(c.id);
  });
  modelBtn.addEventListener('click',e=>{
    e.stopPropagation();
    togglePopup(modelBtn, modelMenu);
  });
  attachBtn.addEventListener('click',e=>{
    e.stopPropagation();
    renderAttachMenu();
    togglePopup(attachBtn, attachMenu);
  });
  hiddenFile.addEventListener('change',e=>{const slot=hiddenFile.dataset.slot;const idx=parseInt(hiddenFile.dataset.index,10)||0;handleFiles(slot,idx,e.target.files);hiddenFile.value='';});
  ratioBtn.addEventListener('click',e=>{e.stopPropagation();showRatioMenu();});
  durationBtn.addEventListener('click',e=>{e.stopPropagation();showDurationMenu();});
  promptInput.addEventListener('input',()=>{autoResize(promptInput);updateChatState();});
  autoResize(promptInput);
  sendBtn.addEventListener('click',handleSend);
  balanceEl.addEventListener('click',()=>refreshBalance());
  setInterval(()=>refreshBalance(true),60000);
  window.addEventListener('dragenter',e=>{
    if(attachMenu.classList.contains('hidden')){
      renderAttachMenu();
      positionPopup(attachBtn,attachMenu);
      attachMenu.classList.remove('hidden');
      autoAttach=true;
    }
  });
  window.addEventListener('dragover',e=>{e.preventDefault();});
  window.addEventListener('drop',e=>{
    e.preventDefault();
    if(autoAttach){
      setTimeout(()=>{if(autoAttach){hidePopups(); autoAttach=false;}},0);
    }
  });
  loadChats();
}

function showRatioMenu(){
  hidePopups();
  const info=MODEL_INFO[currentModel];
  const opts=info.ratios||[]; if(opts.length===0) return;
  const menu=document.createElement('div');
  menu.className='popup dynamic';
  opts.forEach(r=>{const b=document.createElement('button');b.textContent=r;b.addEventListener('click',()=>{currentRatio=r;updateChatState();updateCost();hidePopups();});menu.appendChild(b);});
  document.body.appendChild(menu);
  positionPopup(ratioBtn, menu);
}

function showDurationMenu(){
  hidePopups();
  const info=MODEL_INFO[currentModel];
  const opts=info.durations||[]; if(opts.length===0) return;
  const menu=document.createElement('div');
  menu.className='popup dynamic';
  opts.forEach(d=>{const b=document.createElement('button');b.textContent=d+' сек';b.addEventListener('click',()=>{currentDuration=d;updateChatState();updateCost();hidePopups();});menu.appendChild(b);});
  document.body.appendChild(menu);
  positionPopup(durationBtn, menu);
}

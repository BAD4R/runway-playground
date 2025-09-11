import * as api from './api.js';
import { getApiKey, setApiKey } from './state.js';
import { positionPopup } from './ui.js';

const log = (...args) => console.log('[chat]', ...args);

let modelBtn, modelMenu, chatListEl, newChatBtn, messagesEl, promptInput,
    sendBtn, attachBtn, ratioBtn, durationBtn, hiddenFile, apiKeyInput,
    saveKeyBtn, balanceEl, refreshBalanceBtn, attachPreview, attachMenu,
    estCost;

let chats = [];
let activeChat = null;
let currentModel = 'gen4_image';
let currentFiles = {};
let currentRatio = null;
let currentDuration = null;
let chatColor = COLORS[0];

const COLORS=['#d946ef','#6366f1','#0ea5e9','#22c55e','#f97316'];
function randomColor(){return COLORS[Math.floor(Math.random()*COLORS.length)];}

const MODEL_INFO = {
  gen4_image: {
    desc:'Генерация изображений по тексту и референсам.',
    endpoint: 'text_to_image',
    ratios: ['1920:1080','1080:1920','1024:1024','1360:768','1080:1080','1168:880','1440:1080','1080:1440','1808:768','2112:912','1280:720','720:1280','720:720','960:720','720:960','1680:720'],
    slots: [{name:'referenceImages', type:'image', multiple:true}],
    cost: ({ratio}) => (ratio && ratio.includes('1080') ? 8 : 5)
  },
  gen4_image_turbo: {
    desc:'Быстрая генерация изображений.',
    endpoint:'text_to_image',
    ratios:['1280:720','720:1280'],
    slots:[{name:'referenceImages', type:'image', multiple:true}],
    cost: () => 2
  },
  gen4_turbo: {
    desc:'Создание короткого видео по изображению и тексту.',
    endpoint:'image_to_video',
    ratios:['1280:720','720:1280','1104:832','832:1104','960:960','1584:672'],
    durations:[5,10],
    slots:[{name:'promptImage', type:'image'}],
    cost: ({duration=5}) => 5*duration
  },
  gen4_aleph: {
    desc:'Преобразование видео с учётом референсов.',
    endpoint:'video_to_video',
    ratios:['1280:720','720:1280','1104:832','960:960','832:1104','1584:672','848:480','640:480'],
    slots:[{name:'videoUri', type:'video'},{name:'references', type:'image', multiple:true}],
    cost: ({duration=5}) => 15*duration
  },
  upscale_v1: {
    desc:'Апскейл видео до 4K.',
    endpoint:'video_upscale',
    slots:[{name:'videoUri', type:'video'}],
    cost: ({duration=5}) => 2*duration
  },
  act_two: {
    desc:'Анимация персонажа по движению актёра.',
    endpoint:'character_performance',
    ratios:['1280:720','720:1280','960:960','1104:832','832:1104','1584:672'],
    slots:[{name:'character', type:'image'},{name:'reference', type:'video'}],
    cost: ({duration=5}) => 5*duration
  },
  veo3: {
    desc:'Высококачественное видео из изображения.',
    endpoint:'image_to_video',
    ratios:['1280:720','720:1280'],
    durations:[8],
    slots:[{name:'promptImage', type:'image'}],
    cost: ({duration=8}) => 40*duration
  }
};

function populateModelMenu(){
  modelMenu.innerHTML='';
  Object.keys(MODEL_INFO).forEach(m=>{
    const btn=document.createElement('button');
    btn.textContent=m;
    btn.addEventListener('click',()=>{selectModel(m);hidePopups();});
    modelMenu.appendChild(btn);
  });
}

function selectModel(m){
  currentModel=m;
  document.getElementById('modelLabel').textContent=m;
  const info=MODEL_INFO[m];
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
    const label=document.createElement('div');
    label.textContent=slot.name;
    attachMenu.appendChild(label);
    const val=currentFiles[slot.name];
    const arr=slot.multiple ? (Array.isArray(val)?val:[]) : (val?[val]:[]);
    arr.forEach((v,i)=>attachMenu.appendChild(makeSlot(slot.name,i,v)));
    if(!slot.multiple || arr.length<3){
      attachMenu.appendChild(makeSlot(slot.name,arr.length,null));
    }
  });
}

function makeSlot(slotName,index,uri){
  const slot=document.createElement('div');
  slot.className='attach-slot';
  slot.dataset.slot=slotName;
  slot.dataset.index=index;
  if(uri){
    const img=document.createElement('img');
    img.src=uri;
    slot.appendChild(img);
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
    slot.addEventListener('drop',e=>{e.preventDefault();slot.classList.remove('dragover');handleFiles(slotName,index,e.dataTransfer.files);});
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
  const reader=new FileReader();
  reader.onload=()=>{
    if(MODEL_INFO[currentModel].slots.find(s=>s.name===slotName).multiple){
      if(!Array.isArray(currentFiles[slotName])) currentFiles[slotName]=[];
      currentFiles[slotName][index]=reader.result;
    }else{
      currentFiles[slotName]=reader.result;
    }
    renderAttachMenu();
    renderAttachPreview();
    updateChatState();
  };
  reader.readAsDataURL(file);
}

function removeFile(slotName,index){
  const slot=MODEL_INFO[currentModel].slots.find(s=>s.name===slotName);
  if(slot.multiple){
    currentFiles[slotName].splice(index,1);
  }else{
    delete currentFiles[slotName];
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
      const wrap=document.createElement('div');
      wrap.className='thumb';
      const img=document.createElement('img');
      img.src=uri;
      wrap.appendChild(img);
      const rm=document.createElement('button');
      rm.textContent='×';
      rm.addEventListener('click',()=>removeFile(slot,i));
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

export function hidePopups(){
  document.querySelectorAll('.popup').forEach(p=>{
    if(p.classList.contains('static')) p.classList.add('hidden');
    else p.remove();
  });
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
    const color=randomColor();
    const c=await api.createChat('Новый чат',{color});
    c.state={color};
    chats.unshift(c);
    renderChatList();
  }
  if(!activeChat && chats[0]) selectChat(chats[0].id);
}

async function selectChat(id){
  activeChat=id;
  renderChatList();
  const chat=await api.getChat(id);
  promptInput.value=chat.state.prompt||'';
  currentModel=chat.state.model||currentModel;
  selectModel(currentModel);
  currentFiles=chat.state.files||{};
  currentRatio=chat.state.ratio||null;
  currentDuration=chat.state.duration||null;
  chatColor=chat.state.color||randomColor();
  document.documentElement.style.setProperty('--accent', chatColor);
  if(!chat.state.color){ chat.state.color=chatColor; await api.updateChat(id,{state:chat.state}); }
  renderAttachMenu();
  renderAttachPreview();
  updateCost();
  const msgs=await api.listMessages(id);
  renderMessages(msgs);
}

function renderMessages(msgs){
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
}

function createMessageEl(m){
  const div=document.createElement('div');
  div.className='message '+m.role;
  if(m.content){
    const p=document.createElement('p');
    p.textContent=m.content;
    div.appendChild(p);
  }
  if(m.status){
    const s=document.createElement('span');
    s.className='status';
    s.textContent=m.status;
    div.appendChild(s);
  }
  if(m.attachments){
    m.attachments.forEach(a=>{
      if(typeof a === 'string' && a.startsWith('data:video')){
        const v=document.createElement('video');
        v.src=a; v.controls=true; v.className='attachment';
        div.appendChild(v);
      }else{
        const img=document.createElement('img');
        img.src=a;
        img.className='attachment';
        div.appendChild(img);
      }
    });
  }
  return div;
}

function updateChatState(){
  if(!activeChat) return;
  api.updateChat(activeChat,{state:{model:currentModel,prompt:promptInput.value,files:currentFiles,ratio:currentRatio,duration:currentDuration,color:chatColor}});
}

function updateCost(){
  const info=MODEL_INFO[currentModel];
  const credits=info.cost({ratio:currentRatio,duration:currentDuration})||0;
  estCost.textContent='$'+(credits/100).toFixed(2);
}

async function handleSend(){
  const apiKey=getApiKey();
  if(!apiKey){ alert('Введите API ключ'); return; }
  if(!activeChat){ alert('Нет активного чата'); return; }
  const prompt=promptInput.value.trim();
  const info=MODEL_INFO[currentModel];
  const payload=await buildPayload(currentModel,prompt,currentFiles);
  const userMsg={role:'user',content:prompt,attachments:collectAllFiles()};
  await api.addMessage(activeChat,userMsg);
  messagesEl.querySelector('.model-desc')?.remove();
  messagesEl.appendChild(createMessageEl(userMsg));
  promptInput.value=''; currentFiles={}; renderAttachMenu(); renderAttachPreview(); updateChatState();
  const placeholder={role:'assistant',content:'',status:'Обработка...',attachments:[]};
  const placeholderEl=createMessageEl(placeholder);
  messagesEl.appendChild(placeholderEl);
  messagesEl.scrollTop=messagesEl.scrollHeight;
  try{
    const res=await api.callRunway(apiKey,info.endpoint,payload);
    const task=await api.waitForTask(apiKey,res.id,t=>{
      if(t.status){
        placeholder.status=t.status+(t.progress?` ${t.progress}%`:'' );
        placeholderEl.querySelector('.status').textContent=placeholder.status;
      }
    });
    if(task.status==='SUCCEEDED' && task.output){
      placeholder.status='Готово';
      placeholder.attachments=task.output;
    }else{
      placeholder.status='Ошибка';
      placeholder.content='Ошибка генерации';
    }
  }catch(e){
    placeholder.status='Ошибка';
    placeholder.content=e.message;
  }
  placeholderEl.replaceWith(createMessageEl(placeholder));
  updateCost();
}

function collectAllFiles(){
  const arr=[];
  Object.values(currentFiles).forEach(v=>{ if(Array.isArray(v)) arr.push(...v); else if(v) arr.push(v);});
  return arr;
}

async function buildPayload(model,prompt,files){
  const info=MODEL_INFO[model];
  switch(info.endpoint){
    case 'text_to_image':
      return {model,promptText:prompt,ratio:currentRatio||info.ratios?.[0],referenceImages:(files.referenceImages||[]).map(u=>({uri:u}))};
    case 'image_to_video':
      return {model,promptText:prompt,ratio:currentRatio||info.ratios?.[0],duration:currentDuration||info.durations?.[0],promptImage:files.promptImage};
    case 'video_to_video':
      return {model,promptText:prompt,ratio:currentRatio||info.ratios?.[0],videoUri:files.videoUri,references:(files.references||[]).map(u=>({type:'image',uri:u}))};
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
  refreshBalanceBtn=document.getElementById('refreshBalanceBtn');
  attachPreview=document.getElementById('attachPreview');
  attachMenu=document.getElementById('attachMenu');
  estCost=document.getElementById('estCost');

  if(!modelBtn||!chatListEl||!newChatBtn||!messagesEl||!promptInput||!sendBtn||!attachBtn||!ratioBtn||!durationBtn||!hiddenFile||!apiKeyInput||!saveKeyBtn||!balanceEl||!refreshBalanceBtn||!attachPreview||!attachMenu){
    console.error('Missing DOM elements'); return;
  }

  populateModelMenu();
  selectModel(currentModel);
  apiKeyInput.value=getApiKey();
  if(apiKeyInput.value) refreshBalance(true);

  saveKeyBtn.addEventListener('click',()=>{ setApiKey(apiKeyInput.value.trim()); refreshBalance();});
  newChatBtn.addEventListener('click',async()=>{
    const color=randomColor();
    const c=await api.createChat('Новый чат',{color});
    c.state={color};
    chatColor=color;
    document.documentElement.style.setProperty('--accent', color);
    chats.unshift(c);
    renderChatList();
    selectChat(c.id);
  });
  modelBtn.addEventListener('click',e=>{
    e.stopPropagation();
    if(modelMenu.classList.contains('hidden')){
      hidePopups();
      modelMenu.classList.remove('hidden');
      positionPopup(modelBtn, modelMenu);
    }else{
      modelMenu.classList.add('hidden');
    }
  });
  attachBtn.addEventListener('click',e=>{
    e.stopPropagation();
    hidePopups();
    renderAttachMenu();
    attachMenu.classList.remove('hidden');
    positionPopup(attachBtn, attachMenu);
  });
  hiddenFile.addEventListener('change',e=>{const slot=hiddenFile.dataset.slot;const idx=parseInt(hiddenFile.dataset.index,10)||0;handleFiles(slot,idx,e.target.files);hiddenFile.value='';});
  ratioBtn.addEventListener('click',e=>{e.stopPropagation();showRatioMenu();});
  durationBtn.addEventListener('click',e=>{e.stopPropagation();showDurationMenu();});
  promptInput.addEventListener('input',updateChatState);
  sendBtn.addEventListener('click',handleSend);
  refreshBalanceBtn.addEventListener('click',()=>refreshBalance());
  setInterval(()=>refreshBalance(true),60000);
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

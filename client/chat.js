import * as api from './api.js';
import { getApiKey, setApiKey } from './state.js';

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

const MODEL_INFO = {
  gen4_image: {
    endpoint: 'text_to_image',
    ratios: ['1920:1080','1080:1920','1024:1024','1360:768','1080:1080','1168:880','1440:1080','1080:1440','1808:768','2112:912','1280:720','720:1280','720:720','960:720','720:960','1680:720'],
    slots: [{name:'referenceImages', type:'image', multiple:true}],
    cost: ({ratio}) => (ratio && ratio.includes('1080') ? 8 : 5)
  },
  gen4_image_turbo: {
    endpoint:'text_to_image',
    ratios:['1280:720','720:1280'],
    slots:[{name:'referenceImages', type:'image', multiple:true}],
    cost: () => 2
  },
  gen4_turbo: {
    endpoint:'image_to_video',
    ratios:['1280:720','720:1280','1104:832','832:1104','960:960','1584:672'],
    durations:[5,10],
    slots:[{name:'promptImage', type:'image'}],
    cost: ({duration=5}) => 5*duration
  },
  gen4_aleph: {
    endpoint:'video_to_video',
    ratios:['1280:720','720:1280','1104:832','960:960','832:1104','1584:672','848:480','640:480'],
    slots:[{name:'videoUri', type:'video'},{name:'references', type:'image', multiple:true}],
    cost: ({duration=5}) => 15*duration
  },
  upscale_v1: {
    endpoint:'video_upscale',
    slots:[{name:'videoUri', type:'video'}],
    cost: ({duration=5}) => 2*duration
  },
  act_two: {
    endpoint:'character_performance',
    ratios:['1280:720','720:1280','960:960','1104:832','832:1104','1584:672'],
    slots:[{name:'character', type:'image'},{name:'reference', type:'video'}],
    cost: ({duration=5}) => 5*duration
  },
  veo3: {
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

function hidePopups(){
  document.querySelectorAll('.popup').forEach(p=>p.classList.add('hidden'));
}

document.addEventListener('click',e=>{
  if(!e.target.closest('.popup') && !e.target.closest('.menu-btn') && e.target!==modelBtn && !e.target.closest('#attachBtn')){
    hidePopups();
  }
});

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
  if(chats.length===0){ const c=await api.createChat('Новый чат'); chats.unshift(c); renderChatList(); }
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
  renderAttachMenu();
  renderAttachPreview();
  updateCost();
  const msgs=await api.listMessages(id);
  renderMessages(msgs);
}

function renderMessages(msgs){
  messagesEl.innerHTML='';
  msgs.forEach(m=>messagesEl.appendChild(createMessageEl(m)));
  messagesEl.scrollTop=messagesEl.scrollHeight;
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
  api.updateChat(activeChat,{state:{model:currentModel,prompt:promptInput.value,files:currentFiles,ratio:currentRatio,duration:currentDuration}});
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
  newChatBtn.addEventListener('click',async()=>{const c=await api.createChat('Новый чат');chats.unshift(c);renderChatList();selectChat(c.id);});
  modelBtn.addEventListener('click',e=>{
    e.stopPropagation();
    modelMenu.classList.toggle('hidden');
    const rect=modelBtn.getBoundingClientRect();
    modelMenu.style.left=rect.left+'px';
    modelMenu.style.top=(rect.bottom+4)+'px';
  });
  attachBtn.addEventListener('click',e=>{
    e.stopPropagation();
    renderAttachMenu();
    attachMenu.classList.toggle('hidden');
    const rect=attachBtn.getBoundingClientRect();
    attachMenu.style.left=rect.left+'px';
    attachMenu.style.top=(rect.top-attachMenu.offsetHeight-8)+'px';
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
  const info=MODEL_INFO[currentModel];
  const opts=info.ratios||[]; if(opts.length===0) return;
  const menu=document.createElement('div');
  menu.className='popup';
  opts.forEach(r=>{const b=document.createElement('button');b.textContent=r;b.addEventListener('click',()=>{currentRatio=r;updateChatState();updateCost();hidePopups();});menu.appendChild(b);});
  ratioBtn.after(menu); menu.style.right='0';
  document.addEventListener('click',()=>menu.remove(),{once:true});
}

function showDurationMenu(){
  const info=MODEL_INFO[currentModel];
  const opts=info.durations||[]; if(opts.length===0) return;
  const menu=document.createElement('div');
  menu.className='popup';
  opts.forEach(d=>{const b=document.createElement('button');b.textContent=d+' сек';b.addEventListener('click',()=>{currentDuration=d;updateChatState();updateCost();hidePopups();});menu.appendChild(b);});
  durationBtn.after(menu); menu.style.right='0';
  document.addEventListener('click',()=>menu.remove(),{once:true});
}

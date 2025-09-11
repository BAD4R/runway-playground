import * as api from './api.js';
import { getApiKey, setApiKey } from './state.js';

// Simple logger to track user interactions
const log = (...args) => console.log('[chat]', ...args);

// DOM nodes are resolved during init so that missing elements do not break script execution
let modelSelect, chatListEl, newChatBtn, messagesEl, promptInput,
    sendBtn, attachBtn, ratioBtn, durationBtn, fileInput,
    apiKeyInput, saveKeyBtn, balanceEl, refreshBalanceBtn, attachPreview;

let chats = [];
let activeChat = null;
let currentFiles = [];
let currentRatio = null;
let currentDuration = null;

const MODEL_INFO = {
  gen4_image: {endpoint:'text_to_image', ratios:['1920:1080','1080:1920','1024:1024','1360:768','1080:1080','1168:880','1440:1080','1080:1440','1808:768','2112:912','1280:720','720:1280','720:720','960:720','720:960','1680:720']},
  gen4_image_turbo: {endpoint:'text_to_image', ratios:['1280:720','720:1280']},
  gen4_turbo: {endpoint:'image_to_video', ratios:['1280:720','720:1280','1104:832','832:1104','960:960','1584:672'], durations:[5,10]},
  // gen4_aleph does not expose duration, only ratio
  gen4_aleph: {endpoint:'video_to_video', ratios:['1280:720','720:1280','1104:832','960:960','832:1104','1584:672','848:480','640:480']},
  upscale_v1: {endpoint:'video_upscale'},
  act_two: {endpoint:'character_performance', ratios:['1280:720','720:1280','960:960','1104:832','832:1104','1584:672']},
  veo3: {endpoint:'image_to_video', ratios:['1280:720','720:1280'], durations:[8]}
};

function populateModelSelect(){
  modelSelect.innerHTML='';
  Object.keys(MODEL_INFO).forEach(m=>{
    const opt=document.createElement('option');
    opt.value=m; opt.textContent=m;
    modelSelect.appendChild(opt);
  });
  log('models populated');
}

async function loadChats(){
  try{
    chats = await api.listChats();
    log('chats loaded', chats);
  }catch(e){
    console.error('Failed to load chats', e);
    chats = [];
  }
  renderChatList();
  if(chats.length===0){
    const c = await api.createChat('Новый чат');
    chats.unshift(c); renderChatList();
  }
  if(!activeChat && chats.length>0){ selectChat(chats[0].id); }
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
    menuBtn.addEventListener('click',e=>{e.stopPropagation();log('chat menu', c.id);showChatMenu(c.id, li);});
    if(activeChat===c.id) li.classList.add('active');
    li.addEventListener('click',()=>{log('select chat', c.id);selectChat(c.id);});
    chatListEl.appendChild(li);
  });
}

async function selectChat(id){
  activeChat=id;
  renderChatList();
  const chat=await api.getChat(id);
  log('chat selected', chat);
  promptInput.value = chat.state.prompt||'';
  modelSelect.value = chat.state.model||'gen4_image';
  currentFiles = chat.state.files||[];
  currentRatio = chat.state.ratio || null;
  currentDuration = chat.state.duration || null;
  renderAttachPreview();
  const msgs=await api.listMessages(id);
  renderMessages(msgs);
}

function showChatMenu(id, li){
  let menu=li.querySelector('.chat-menu');
  if(menu){ menu.remove(); return; }
  menu=document.createElement('div');
  menu.className='chat-menu';
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

function renderMessages(msgs){
  messagesEl.innerHTML='';
  msgs.forEach(m=>{
    const div=document.createElement('div');
    div.className='message '+m.role;
    div.textContent=m.content||'';
    if(m.attachments && m.attachments.length){
      m.attachments.forEach(a=>{
        const img=document.createElement('img');
        img.src=a;
        img.style.maxWidth='200px';
        img.style.display='block';
        div.appendChild(img);
      });
    }
    messagesEl.appendChild(div);
  });
  messagesEl.scrollTop=messagesEl.scrollHeight;
  log('messages rendered', msgs.length);
}

function renderAttachPreview(){
  attachPreview.innerHTML='';
  currentFiles.forEach(f=>{
    const img=document.createElement('img');
    img.src=f;
    attachPreview.appendChild(img);
  });
  log('preview files', currentFiles.length);
}

async function handleSend(){
  log('send clicked');
  const apiKey = getApiKey();
  if(!apiKey){ alert('Введите API ключ'); return; }
  if(!activeChat){ alert('Нет активного чата'); return; }
  const prompt = promptInput.value.trim();
  if(!prompt && currentFiles.length===0) return;
  const model = modelSelect.value;
  const userMsg = {role:'user', content:prompt, attachments:currentFiles};
  await api.addMessage(activeChat, userMsg);
  messagesEl.appendChild(createMessageEl(userMsg));
  messagesEl.scrollTop=messagesEl.scrollHeight;
  const payload = await buildPayload(model, prompt, currentFiles);
  log('payload', payload);
  try{
    const res = await api.callRunway(apiKey, MODEL_INFO[model].endpoint, payload);
    log('response', res);
    const out = res.output || [];
    const asMsg = {role:'assistant', content:'', attachments:out};
    await api.addMessage(activeChat, asMsg);
    messagesEl.appendChild(createMessageEl(asMsg));
  }catch(e){
    log('send error', e);
    const errMsg={role:'assistant', content:'Ошибка: '+e.message};
    await api.addMessage(activeChat, errMsg);
    messagesEl.appendChild(createMessageEl(errMsg));
  }
  currentFiles=[]; promptInput.value='';
  renderAttachPreview();
  await api.updateChat(activeChat,{state:{model,prompt:'',files:[],ratio:currentRatio,duration:currentDuration}});
}

function createMessageEl(m){
  const div=document.createElement('div');
  div.className='message '+m.role;
  if(m.content) div.textContent=m.content;
  if(m.attachments){
    m.attachments.forEach(a=>{
      const img=document.createElement('img');
      img.src=a;
      img.style.maxWidth='200px';
      img.style.display='block';
      div.appendChild(img);
    });
  }
  return div;
}

async function buildPayload(model, prompt, files){
  const info = MODEL_INFO[model];
  switch(info.endpoint){
    case 'text_to_image':
      return {model, promptText:prompt, ratio: currentRatio || info.ratios?.[0] || '1280:720', referenceImages: files.map(f=>({uri:f}))};
    case 'image_to_video':
      return {model, promptText:prompt, ratio: currentRatio || info.ratios?.[0] || '1280:720', duration: currentDuration || info.durations?.[0], promptImage: files[0]};
    case 'video_to_video':
      return {model, promptText:prompt, ratio: currentRatio || info.ratios?.[0] || '1280:720', videoUri: files[0], references: files.slice(1).map(f=>({type:'image', uri:f}))};
    case 'video_upscale':
      return {model, videoUri: files[0]};
    case 'character_performance':
      return {model, ratio: currentRatio || info.ratios?.[0] || '1280:720', character:{type:'image', uri:files[0]}, reference:{type:'video', uri:files[1]||files[0]}};
    default:
      return {model, promptText:prompt};
  }
}

function handleFileInput(e){
  const files = Array.from(e.target.files);
  log('file input', files.map(f=>f.name));
  files.forEach(f=>{
    const reader = new FileReader();
    reader.onload = () => {
      log('file loaded', f.name);
      currentFiles.push(reader.result); updateChatState(); renderAttachPreview();
    };
    reader.readAsDataURL(f);
  });
  e.target.value='';
}

function updateChatState(){
  if(!activeChat) return;
  const model=modelSelect.value;
  const prompt=promptInput.value;
  log('state update', {model,prompt,files:currentFiles.length,ratio:currentRatio,duration:currentDuration});
  api.updateChat(activeChat,{state:{model,prompt,files:currentFiles,ratio:currentRatio,duration:currentDuration}});
}

async function refreshBalance(silent=false){
  const key=getApiKey();
  if(!key) return;
  const j=await api.fetchBalance(key, silent);
  if(j && typeof j.creditBalance==='number') balanceEl.textContent=j.creditBalance;
  if(!silent) log('balance fetched', j);
}

export function init(){
  log('init start');
  // Resolve DOM nodes dynamically
  modelSelect = document.getElementById('modelSelect');
  chatListEl = document.getElementById('chatList');
  newChatBtn = document.getElementById('newChatBtn');
  messagesEl = document.getElementById('messages');
  promptInput = document.getElementById('promptInput');
  sendBtn = document.getElementById('sendBtn');
  attachBtn = document.getElementById('attachBtn');
  ratioBtn = document.getElementById('ratioBtn');
  durationBtn = document.getElementById('durationBtn');
  fileInput = document.getElementById('fileInput');
  apiKeyInput = document.getElementById('apiKey');
  saveKeyBtn = document.getElementById('saveKeyBtn');
  balanceEl = document.getElementById('balanceCredits');
  refreshBalanceBtn = document.getElementById('refreshBalanceBtn');
  attachPreview = document.getElementById('attachPreview');

  if(!modelSelect||!chatListEl||!newChatBtn||!messagesEl||!promptInput||!sendBtn||!attachBtn||!ratioBtn||!durationBtn||!fileInput||!apiKeyInput||!saveKeyBtn||!balanceEl||!refreshBalanceBtn||!attachPreview){
    console.error('Missing DOM elements, unable to init chat UI');
    return;
  }

  populateModelSelect();
  apiKeyInput.value = getApiKey();
  if(apiKeyInput.value) refreshBalance(true);
  saveKeyBtn.addEventListener('click',()=>{ log('save key'); setApiKey(apiKeyInput.value.trim()); refreshBalance(); });
  newChatBtn.addEventListener('click', async ()=>{ log('new chat'); const c=await api.createChat('Новый чат'); chats.unshift(c); renderChatList(); selectChat(c.id); });
  sendBtn.addEventListener('click', handleSend);
  promptInput.addEventListener('input', ()=>{ log('prompt input'); updateChatState(); });
  modelSelect.addEventListener('change', ()=>{ log('model change', modelSelect.value); currentRatio=null; currentDuration=null; updateChatState(); });
  attachBtn.addEventListener('click',()=>{ log('attach click'); fileInput.click(); });
  fileInput.addEventListener('change', handleFileInput);
  ratioBtn.addEventListener('click',()=>{
    log('ratio click');
    const info=MODEL_INFO[modelSelect.value];
    const opts=info.ratios||[];
    if(opts.length===0) return;
    const r=prompt('Соотношение сторон: '+opts.join(', '), currentRatio||opts[0]);
    if(r){ currentRatio=r; updateChatState(); }
  });
  durationBtn.addEventListener('click',()=>{
    log('duration click');
    const info=MODEL_INFO[modelSelect.value];
    const opts=info.durations||[];
    if(opts.length===0) return;
    const d=prompt('Длительность (сек): '+opts.join(', '), currentDuration||opts[0]);
    if(d){ currentDuration=parseInt(d,10); updateChatState(); }
  });
  refreshBalanceBtn.addEventListener('click', ()=>{ log('balance refresh'); refreshBalance(); });
  setInterval(()=>refreshBalance(true),60000);
  loadChats();
  log('init complete');
}

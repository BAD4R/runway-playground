import * as api from './api.js';
import {getApiKey,setApiKey} from './state.js';

const modelSelect = document.getElementById('modelSelect');
const chatListEl = document.getElementById('chatList');
const newChatBtn = document.getElementById('newChatBtn');
const messagesEl = document.getElementById('messages');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');
const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const balanceEl = document.getElementById('balanceCredits');
const refreshBalanceBtn = document.getElementById('refreshBalanceBtn');

let chats = [];
let activeChat = null;
let currentFiles = [];

const MODEL_INFO = {
  gen4_image: {endpoint:'text_to_image', ratios:['1920:1080','1080:1920','1024:1024','1360:768','1080:1080','1168:880','1440:1080','1080:1440','1808:768','2112:912','1280:720','720:1280','720:720','960:720','720:960','1680:720']},
  gen4_image_turbo: {endpoint:'text_to_image'},
  gen4_turbo: {endpoint:'image_to_video'},
  gen4_aleph: {endpoint:'video_to_video'},
  upscale_v1: {endpoint:'video_upscale'},
  act_two: {endpoint:'character_performance'},
  veo3: {endpoint:'image_to_video'}
};

async function loadChats(){
  chats = await api.listChats();
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
    menuBtn.addEventListener('click',e=>{e.stopPropagation();showChatMenu(c.id, li);});
    if(activeChat===c.id) li.classList.add('active');
    li.addEventListener('click',()=>selectChat(c.id));
    chatListEl.appendChild(li);
  });
}

async function selectChat(id){
  activeChat=id;
  renderChatList();
  const chat=await api.getChat(id);
  promptInput.value = chat.state.prompt||'';
  modelSelect.value = chat.state.model||'gen4_image';
  currentFiles = chat.state.files||[];
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
}

async function handleSend(){
  const apiKey = getApiKey();
  if(!apiKey){ alert('Введите API ключ'); return; }
  const prompt = promptInput.value.trim();
  if(!prompt && currentFiles.length===0) return;
  const model = modelSelect.value;
  const userMsg = {role:'user', content:prompt, attachments:currentFiles};
  await api.addMessage(activeChat, userMsg);
  messagesEl.appendChild(createMessageEl(userMsg));
  messagesEl.scrollTop=messagesEl.scrollHeight;
  const payload = await buildPayload(model, prompt, currentFiles);
  try{
    const res = await api.callRunway(apiKey, MODEL_INFO[model].endpoint, payload);
    const out = res.output || [];
    const asMsg = {role:'assistant', content:'', attachments:out};
    await api.addMessage(activeChat, asMsg);
    messagesEl.appendChild(createMessageEl(asMsg));
  }catch(e){
    const errMsg={role:'assistant', content:'Ошибка: '+e.message};
    await api.addMessage(activeChat, errMsg);
    messagesEl.appendChild(createMessageEl(errMsg));
  }
  currentFiles=[]; promptInput.value='';
  await api.updateChat(activeChat,{state:{model,prompt:'',files:[]}});
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
      return {model, promptText:prompt, ratio:'1360:768'};
    case 'image_to_video':
      return {model, promptText:prompt, ratio:'1280:720', promptImage: files[0]};
    case 'video_to_video':
      return {model, promptText:prompt, ratio:'1280:720', videoUri: files[0]};
    case 'video_upscale':
      return {model, videoUri: files[0]};
    case 'character_performance':
      return {model, ratio:'1280:720', character:{type:'image', uri:files[0]}, reference:{type:'video', uri:files[1]||files[0]}};
    default:
      return {model, promptText:prompt};
  }
}

function handleFileInput(e){
  const files = Array.from(e.target.files);
  files.forEach(f=>{
    const reader = new FileReader();
    reader.onload = () => {
      currentFiles.push(reader.result); updateChatState();
    };
    reader.readAsDataURL(f);
  });
  e.target.value='';
}

function updateChatState(){
  const model=modelSelect.value;
  const prompt=promptInput.value;
  api.updateChat(activeChat,{state:{model,prompt,files:currentFiles}});
}

export function init(){
  apiKeyInput.value = getApiKey();
  saveKeyBtn.addEventListener('click',()=>{ setApiKey(apiKeyInput.value); });
  newChatBtn.addEventListener('click', async ()=>{ const c=await api.createChat('Новый чат'); chats.unshift(c); renderChatList(); selectChat(c.id); });
  sendBtn.addEventListener('click', handleSend);
  promptInput.addEventListener('input', updateChatState);
  modelSelect.addEventListener('change', updateChatState);
  attachBtn.addEventListener('click',()=>fileInput.click());
  fileInput.addEventListener('change', handleFileInput);
  refreshBalanceBtn.addEventListener('click', async()=>{
    const key=getApiKey(); if(!key) return;
    const j=await api.fetchBalance(key);
    if(j && typeof j.creditBalance==='number') balanceEl.textContent=j.creditBalance;
  });
  loadChats();
}

init();

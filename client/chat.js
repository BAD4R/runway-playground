import * as api from './api.js';
import { getRunwayKey, setRunwayKey, getOpenAIKey, setOpenAIKey, getOpenAITiers, setOpenAITiers } from './state.js';
import { positionPopup, hidePopups, togglePopup, showToast } from './ui.js';

const log = (...args) => console.log('[chat]', ...args);

let modelBtn, modelMenu, chatListEl, newChatBtn, messagesEl, promptInput,
    sendBtn, attachBtn, openaiBtn, ratioBtn, durationBtn, hiddenFile,
    runwayKeyInput, openaiKeyInput, openaiTiersEl, saveSettingsBtn, balanceEl,
    attachPreview, attachMenu, replaceMenu, estCost, settingsBtn, settingsModal,
    modeBtn, modeMenu, modeTags, modeSettingsModal, modeSettingsContent,
    modeSaveBtn, modeCancelBtn, viewer;

let chats = [];
let activeChat = null;
let currentModel = 'gen4_image';
let currentFiles = {};
let currentRatio = null;
let currentDuration = null;
let chatColor = '#d946ef';
let autoAttach = false;
let openAiPrices = {};
let currentModes = [];
let modeSettings = {};
let replaceInputs = {targets:[null,null],reference:null};
let openaiUsageHistory = [];
let expandedTextEl = null;

const REPLACE_MODE='Заменить человека на фото';
const PROMPT_LIMIT=1000;

function cleanPromptInput(el, limit = PROMPT_LIMIT){
  const start = el.selectionStart || 0;
  let prefix = sanitizeText(el.value.slice(0, start));
  let v = sanitizeText(el.value);
  if(limit != null){
    prefix = prefix.slice(0, limit);
    if(v.length > limit) v = v.slice(0, limit);
  }
  el.value = v;
  const pos = Math.min(prefix.length, v.length);
  el.setSelectionRange(pos,pos);
}

function sanitizeText(str){
  return str
    .replace(/[“”«»„‟"]/g,"'")
    .replace(/[’‘‚‛]/g,"'")
    .replace(/[–—‑]/g,'-');
}

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

function updatePromptCounter(){
  const cnt=document.getElementById('promptCounter');
  if(cnt) cnt.textContent=`${promptInput.value.length}/${PROMPT_LIMIT}`;
}

function openViewer(src,isVideo){
  viewer.innerHTML='';
  const content=document.createElement('div');
  content.className='modal-content';
  if(isVideo){
    const video=document.createElement('video');
    video.src=src;
    const controls=document.createElement('div');
    controls.className='viewer-controls';
    const play=document.createElement('button');
    play.textContent='▶';
    play.addEventListener('click',()=>{if(video.paused){video.play();play.textContent='❚❚';}else{video.pause();play.textContent='▶';}});
    const range=document.createElement('input');
    range.type='range';range.min=0;range.max=100;range.value=0;
    video.addEventListener('timeupdate',()=>{if(video.duration) range.value=video.currentTime/video.duration*100;});
    range.addEventListener('input',()=>{if(video.duration) video.currentTime=range.value/100*video.duration;});
    controls.append(play,range);
    content.append(video,controls);
  }else{
    const img=document.createElement('img');
    img.src=src;
    content.appendChild(img);
  }
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

const AVAILABLE_MODES = [REPLACE_MODE];
const REPLACE_BASE_PROMPT = 'Replace the person on the last image with person from first two (or first one, of two photos in total in request) images';
const REPLACE_PROMPT_DEFAULT = "Make output strictly less than 1000 characters long, keep it closer to 700-800. Describe the gender of the person in the photo (skip if unsure), their exact pose (clearly for each body part - which body parts are visible and the position of each body part), the direction of the head, eyes, and gaze. Describe in detail their clothing and accessories (clearly for each element of clothing - what decorative elements are present on this clothing - in what quantity and where they are located and what they depict such as lace, buttons, straps, tags, patches, prints). Describe the actions the person is performing (if any) and in detail every object they are interacting with (if any) (whether it is a small item or a large bus). Describe the location where they are situated (what is visible in the background, which specific objects are in which places in the frame), other small details, any color filters or special effects (if any). Do not describe the hairstyle, skin color, or hair color, the parameters of the face or body of the person. Provide the answer as continuous text (without lists, without your own comments, explanations, code, emoticons, special symbols, or words about how you understood my request). If you can not describe something just skip it, without notifying about it, and try to describe all other parameters.";

function populateModelMenu(){
  modelMenu.innerHTML='';
  Object.keys(MODEL_INFO).forEach(m=>{
    const btn=document.createElement('button');
    btn.textContent=MODEL_INFO[m].label;
    const allowed=['gen4_image','gen4_image_turbo'];
    if(currentModes.includes(REPLACE_MODE) && !allowed.includes(m)){
      btn.className='disabled';
    }else{
      btn.addEventListener('click',()=>{selectModel(m);hidePopups();});
    }
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
  updateModeUI();
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

function renderReplaceMenu(){
  replaceMenu.innerHTML='';
  for(let i=0;i<2;i++) replaceMenu.appendChild(createReplaceSlot('rp-target',i,replaceInputs.targets[i]));
  const arrow=document.createElement('img');
  arrow.src='./icons/arrow-right.svg';
  arrow.className='arrow';
  replaceMenu.appendChild(arrow);
  replaceMenu.appendChild(createReplaceSlot('rp-reference',0,replaceInputs.reference));
}

function createReplaceSlot(prefix,index,val){
  const slot=document.createElement('div');
  slot.className='replace-slot'+(val?' filled':'');
  if(val){
    const img=document.createElement('img');
    img.src=val; slot.appendChild(img);
    const rm=document.createElement('button');
    rm.className='remove'; rm.textContent='×';
    rm.addEventListener('click',e=>{e.stopPropagation(); if(prefix==='rp-reference') replaceInputs.reference=null; else replaceInputs.targets[index]=null; renderReplaceMenu(); renderAttachPreview(); updateChatState();});
    slot.appendChild(rm);
  }else{
    const dz=document.createElement('div'); dz.className='drop-zone'; dz.textContent='+'; slot.appendChild(dz);
  }
  slot.addEventListener('click',()=>{hiddenFile.dataset.slot=prefix; hiddenFile.dataset.index=index; hiddenFile.click();});
  slot.addEventListener('dragover',e=>{e.preventDefault(); slot.classList.add('dragover');});
  slot.addEventListener('dragleave',()=>slot.classList.remove('dragover'));
  slot.addEventListener('drop',e=>{e.preventDefault(); slot.classList.remove('dragover'); if(autoAttach) autoAttach=false; handleFiles(prefix,index,e.dataTransfer.files);});
  return slot;
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
  if(slotName.startsWith('rp-')){
    const reader=new FileReader();
    reader.onload=()=>{
      if(slotName==='rp-reference') replaceInputs.reference=reader.result;
      else replaceInputs.targets[index]=reader.result;
      renderReplaceMenu();
      renderAttachPreview();
      updateChatState();
    };
    reader.readAsDataURL(file);
    return;
  }
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
  const addThumb=(uri,rmCb)=>{
    if(!uri) return;
    const wrap=document.createElement('div');
    wrap.className='thumb';
    wrap.style.backgroundImage="url('./images/empty-field-bg.png')";
    const img=document.createElement('img');
    img.src=uri;
    img.addEventListener('click',()=>openViewer(uri,false));
    wrap.appendChild(img);
    const rm=document.createElement('button');
    rm.textContent='×';
    rm.addEventListener('click',e=>{e.stopPropagation();rmCb();});
    wrap.appendChild(rm);
    attachPreview.appendChild(wrap);
  };
  Object.keys(currentFiles).forEach(slot=>{
    const val=currentFiles[slot];
    const arr=Array.isArray(val)?val:[val];
    arr.forEach((uri,i)=>{
      if(typeof uri==='string' && uri.startsWith('data:video')){
        const wrap=document.createElement('div');
        wrap.className='thumb';
        wrap.style.backgroundImage="url('./images/empty-field-bg.png')";
        const video=document.createElement('video');
        video.src=uri; video.muted=true; video.loop=true; video.play();
        video.addEventListener('click',()=>openViewer(uri,true));
        wrap.appendChild(video);
        const rm=document.createElement('button');
        rm.textContent='×';
        rm.addEventListener('click',e=>{e.stopPropagation();removeFile(slot,i);});
        wrap.appendChild(rm);
        attachPreview.appendChild(wrap);
      }else{
        addThumb(uri,()=>removeFile(slot,i));
      }
    });
  });
  // replace mode previews
  if(currentModes.includes(REPLACE_MODE)){
    replaceInputs.targets.forEach((uri,i)=>{
      addThumb(uri,()=>removeReplaceFile('rp-target',i));
    });
    addThumb(replaceInputs.reference,()=>removeReplaceFile('rp-reference',0));
  }
  log('preview files', Object.keys(currentFiles).length);
}

function removeReplaceFile(slot,index){
  if(slot==='rp-reference') replaceInputs.reference=null; else replaceInputs.targets[index]=null;
  renderReplaceMenu();
  renderAttachPreview();
  updateChatState();
}

function clearAttachments(){
  currentFiles={};
  replaceInputs={targets:[null,null],reference:null};
  renderAttachMenu();
  renderReplaceMenu();
  renderAttachPreview();
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
    const c=await api.createChat('Новый чат',{color,model:currentModel,modes:[],modeSettings:{}});
    c.state={color,model:currentModel,modes:[],modeSettings:{}};
    chats.unshift(c);
    renderChatList();
  }
  if(!activeChat && chats[0]) selectChat(chats[0].id);
}

async function selectChat(id){
  if(id===activeChat) return;
  const chat=await api.getChat(id);
  const msgs=await api.listMessages(id);
  promptInput.value=sanitizeText(chat.state.prompt||'').slice(0,PROMPT_LIMIT);
  autoResize(promptInput);
  updatePromptCounter();
  currentModel=chat.state.model||currentModel;
  currentFiles=chat.state.files||{};
  currentRatio=chat.state.ratio||null;
  currentDuration=chat.state.duration||null;
  currentModes=chat.state.modes||[];
  modeSettings=chat.state.modeSettings||{};
  replaceInputs=(modeSettings[REPLACE_MODE]?.images)||{targets:[null,null],reference:null};
  renderAttachMenu();
  renderAttachPreview();
  renderReplaceMenu();
  updateCost();
  updateModelDesc();
  renderMessages(msgs);
  renderModeTags();
  updateModeUI();

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
    expandedTextEl=null;
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
    p.className='msg-text';
    p.textContent=m.content;
    div.appendChild(p);
    if(m.content.length>800){
      const shortTemp=document.createElement('p');
      shortTemp.className='msg-text';
      shortTemp.style.visibility='hidden';
      shortTemp.style.position='absolute';
      p.classList.add('collapsible','collapsed');
      p.addEventListener('click',e=>{e.stopPropagation(); expandText(p);});
    }
  }
  if(m.attachments && m.attachments.length){
    const wrap=document.createElement('div');
    wrap.className='attachments';
    m.attachments.forEach(a=>{
      const box=document.createElement('div');
      box.className='attachment-box';
      box.style.backgroundImage="url('./images/empty-field-bg.png')";
      let el;
      if(typeof a==='string' && (a.startsWith('data:video') || a.endsWith('.mp4'))){
        el=document.createElement('video');
        el.src=a; el.muted=true; el.loop=true; el.play();
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
      wrap.appendChild(box);
    });
    div.appendChild(wrap);
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
  if(p.mode) parts.push(p.mode);
  if(p.ratio) parts.push(p.ratio);
  if(p.duration) parts.push(p.duration+' сек');
  if('cost' in p) parts.push(p.cost==null?'$?.??':`$${p.cost.toFixed(2)}`);
  else if(p.credits!=null) parts.push(`${p.credits} ток $${(p.credits/100).toFixed(2)}`);
  return parts.join(', ');
}

function expandText(el){
  if(expandedTextEl && expandedTextEl!==el) collapseText(expandedTextEl);
  el.classList.remove('collapsed');
  el.classList.add('expanded');
  expandedTextEl = el;
}

function collapseText(el){
  el.classList.remove('expanded');
  el.classList.add('collapsed');
  if(expandedTextEl===el) expandedTextEl=null;
}

document.addEventListener('click',e=>{
  if(expandedTextEl){
    const msg=expandedTextEl.closest('.message');
    if(!msg || !msg.contains(e.target)) collapseText(expandedTextEl);
  }
});

function findOpenAIPrice(model){
  if(openAiPrices[model]) return openAiPrices[model];
  for(const k in openAiPrices){
    if(model.includes(k)) return openAiPrices[k];
  }
  return null;
}

function calcOpenAICost(model,usage){
  const p=findOpenAIPrice(model);
  if(!p) return 0;
  const ic=(usage.input_tokens||0)*(p.input||0)/1e6;
  const oc=(usage.output_tokens||0)*(p.output||0)/1e6;
  return ic+oc;
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
  const ms=modeSettings[REPLACE_MODE]||{prompt:REPLACE_PROMPT_DEFAULT,basePrompt:REPLACE_BASE_PROMPT,tier:2,reasoning:'high'};
  ms.images=replaceInputs;
  modeSettings[REPLACE_MODE]=ms;
  api.updateChat(activeChat,{state:{model:currentModel,prompt:promptInput.value,files:currentFiles,ratio:currentRatio,duration:currentDuration,color:chatColor,modes:currentModes,modeSettings}});
}

function updateCost(){
  const info=MODEL_INFO[currentModel];
  const ratio=currentRatio||info.ratios?.[0];
  const dur=currentDuration||info.durations?.[0];
  const credits=info.cost({ratio,duration:dur})||0;
  const parts=[];
  if(ratio) parts.push(ratio.replace(':','x'));
  if(dur) parts.push(`${dur} секунд`);
  parts.push(`${(credits/100).toFixed(2)}$`);
  estCost.textContent=parts.join(', ');
}

function renderModeMenu(){
  modeMenu.innerHTML='';
  AVAILABLE_MODES.forEach(m=>{
    const row=document.createElement('div');
    row.className='mode-item';
    const b=document.createElement('button');
    b.textContent=m;
    b.addEventListener('click',()=>{activateMode(m);hidePopups();});
    const gear=document.createElement('span');
    gear.className='mode-gear';
    gear.innerHTML='<img src="./icons/gear.svg" alt="settings" />';
    gear.addEventListener('click',e=>{e.stopPropagation();openModeSettings(m);});
    row.appendChild(b); row.appendChild(gear);
    modeMenu.appendChild(row);
  });
}

function activateMode(m){
  const wasReplace=currentModes.includes(REPLACE_MODE);
  if(m===REPLACE_MODE && !['gen4_image','gen4_image_turbo'].includes(currentModel)) selectModel('gen4_image');
  if(m===REPLACE_MODE){
    currentModes=[REPLACE_MODE];
    clearAttachments();
  }else{
    if(wasReplace) clearAttachments();
    currentModes=currentModes.filter(x=>x!==REPLACE_MODE);
    if(!currentModes.includes(m)) currentModes.push(m);
  }
  renderModeTags();
  updateModeUI();
  updateChatState();
}

function removeMode(m){
  currentModes=currentModes.filter(x=>x!==m);
  if(m===REPLACE_MODE) clearAttachments();
  renderModeTags();
  updateModeUI();
  updateChatState();
}

function renderModeTags(){
  modeTags.innerHTML='';
  currentModes.forEach(m=>{
    const tag=document.createElement('span');
    tag.className='mode-tag';
    tag.textContent=m;
    const x=document.createElement('button');
    x.textContent='×';
    x.addEventListener('click',e=>{e.stopPropagation();removeMode(m);});
    tag.appendChild(x);
    tag.addEventListener('click',()=>openModeSettings(m));
    modeTags.appendChild(tag);
  });
}

function updateModeUI(){
  const active=currentModes.includes(REPLACE_MODE);
  promptInput.disabled=active;
  promptInput.placeholder=active?`Контролируется режимом "${REPLACE_MODE}"`:'Введите промпт...';
  attachBtn.classList.toggle('disabled',active);
  openaiBtn.classList.toggle('hidden',!active);
  populateModelMenu();
}

let editingMode=null;
function openModeSettings(m){
  editingMode=m;
  if(m===REPLACE_MODE){
    const ms=modeSettings[m]||{prompt:REPLACE_PROMPT_DEFAULT,basePrompt:REPLACE_BASE_PROMPT,tier:2,reasoning:'high'};
    const tiers=getOpenAITiers();
    let opts='';
    for(let i=1;i<=5;i++){opts+=`<option value="${i}" ${ms.tier==i?'selected':''}>Tier ${i} (${tiers[i]})</option>`;}
    const base=sanitizeText(ms.basePrompt||REPLACE_BASE_PROMPT);
    modeSettingsContent.innerHTML=`<label><textarea id="modePrompt" rows="4" placeholder="Промпт">${ms.prompt}</textarea></label><label><input id="modeBasePrompt" type="text" placeholder="Основной промпт для Runway" value="${base}"/></label><label><select id="modeTier">${opts}</select></label><div id="reasoningWrap"></div><p class="mode-desc">Составляет детальное описание референса через ChatGPT и отправляет запрос к Runway для замены личности на фото</p>`;
    const promptEl=document.getElementById('modePrompt');
    promptEl.addEventListener('input',()=>cleanPromptInput(promptEl,null));
    const baseEl=document.getElementById('modeBasePrompt');
    baseEl.addEventListener('input',()=>cleanPromptInput(baseEl,null));
    const tierSel=document.getElementById('modeTier');
    const reasonWrap=document.getElementById('reasoningWrap');
    const renderReasoning=()=>{
      const model=tiers[parseInt(tierSel.value,10)];
      if(/^o/.test(model)){
        let ropts=['low','medium','high'].map(r=>`<option value="${r}" ${ms.reasoning===r?'selected':''}>${r}</option>`).join('');
        reasonWrap.innerHTML=`<label><select id="modeReasoning">${ropts}</select></label>`;
      }else{
        reasonWrap.innerHTML='';
      }
    };
    renderReasoning();
    tierSel.addEventListener('change',renderReasoning);
  }else{
    modeSettingsContent.innerHTML=`<p>Настройки для ${m}</p>`;
  }
  modeSettingsModal.classList.remove('hidden');
}

function renderOpenAITiers(){
  openaiTiersEl.innerHTML='';
  const tiers=getOpenAITiers();
  for(let i=1;i<=5;i++){
    const lbl=document.createElement('label');
    lbl.textContent=`Tier ${i}`;
    const sel=document.createElement('select');
    sel.dataset.tier=i;
    Object.keys(openAiPrices).forEach(m=>{
      const p=openAiPrices[m];
      const opt=document.createElement('option');
      opt.value=m;
      const inp=p.input!=null?`$${p.input}`:'-';
      const outp=p.output!=null?`$${p.output}`:'-';
      opt.textContent=`${m} (${inp} / ${outp})`;
      sel.appendChild(opt);
    });
    sel.value=tiers[i]||sel.options[0]?.value;
    lbl.appendChild(sel);
    openaiTiersEl.appendChild(lbl);
  }
}

async function handleReplaceSend(){
  const openaiKey=getOpenAIKey();
  if(!openaiKey){showToast('Введите OpenAI ключ');return;}
  if(!activeChat){showToast('Нет активного чата');return;}
  const chatId=activeChat;
  const modelRunway=currentModel;
  const ratio=currentRatio;
  const ms=modeSettings[REPLACE_MODE]||{prompt:REPLACE_PROMPT_DEFAULT,basePrompt:REPLACE_BASE_PROMPT,tier:2,reasoning:'high',images:replaceInputs};
  const imgs=ms.images||replaceInputs;
  if(!(imgs.reference && imgs.targets.some(x=>x))){showToast('Нужен хотя бы один исходник И референс');return;}
  const tiers=getOpenAITiers();
  const model=tiers[ms.tier]||tiers[2];
  const ref=imgs.reference; // full data URI
  const promptText=sanitizeText(ms.prompt);
  const userMsg={role:'user',content:promptText,attachments:[...imgs.targets.filter(Boolean),imgs.reference]};
  await api.addMessage(chatId,userMsg);
  if(chatId===activeChat){
    messagesEl.querySelector('.model-desc')?.remove();
    messagesEl.appendChild(createMessageEl(userMsg));
  }
  const placeholder={role:'assistant',content:'',status:'отправка',attachments:[],params:{model,mode:REPLACE_MODE,cost:null}};
  const saved=await api.addMessage(chatId,placeholder);
  placeholder.id=saved.id;
  let placeholderEl=null;
  if(chatId===activeChat){
    placeholderEl=createMessageEl(placeholder);
    messagesEl.appendChild(placeholderEl); messagesEl.scrollTop=messagesEl.scrollHeight;
  }
  try{
    const body={model,input:[{role:'user',content:[{type:'input_text',text:promptText},{type:'input_image',image_url:ref}]}]};
    if(ms.reasoning) body.reasoning={effort:ms.reasoning};
    placeholder.status='обработка';
    if(placeholderEl) setStatus(placeholderEl,placeholder.status);
    await api.updateMessage(chatId,placeholder.id,{status:placeholder.status});
    const res=await api.callOpenAI(openaiKey,body);
    placeholder.status='готово';
    const outs=Array.isArray(res?.output)
      ? res.output.flatMap(o=>Array.isArray(o.content)?o.content:[])
      : Array.isArray(res?.content)?res.content:[];
    outs.forEach(o=>{
      if(o.type==='output_text' || o.type==='text') placeholder.content+=o.text;
      if(o.type==='output_image' || o.type==='image'){
        const b64=o.image_base64||o.b64_json;
        if(b64) placeholder.attachments.push('data:image/png;base64,'+b64);
      }
    });
    if(!placeholder.content && typeof res?.output_text==='string') placeholder.content=res.output_text;
    if(!placeholder.content && typeof res?.text==='string') placeholder.content=res.text;
    if(!placeholder.content && res?.choices?.length){
      const c=res.choices[0].message?.content;
      if(typeof c==='string') placeholder.content=c;
      else if(Array.isArray(c)) placeholder.content=c.map(p=>p.text||'').join('');
    }
    const respModel=res.model||model;
    const usage=res.usage||{};
    placeholder.params.model=respModel;
    placeholder.params.tokens=usage;
    placeholder.params.cost=calcOpenAICost(respModel,usage);
    openaiUsageHistory.push({model:respModel,usage});
  }catch(e){
    placeholder.status='ошибка';
    placeholder.content=e.message;
  }
  placeholder.content=sanitizeText(placeholder.content).slice(0,PROMPT_LIMIT);
  if(placeholderEl) setStatus(placeholderEl,placeholder.status);
  await api.updateMessage(chatId,placeholder.id,{status:placeholder.status,content:placeholder.content,attachments:placeholder.attachments,params:placeholder.params});
  if(placeholderEl) placeholderEl.replaceWith(createMessageEl(placeholder));
  if(placeholder.status!=='готово') return;
  const apiKey=getRunwayKey();
  const info=MODEL_INFO[modelRunway];
  const basePrompt=sanitizeText(ms.basePrompt||REPLACE_BASE_PROMPT).slice(0,PROMPT_LIMIT);
  const maxDescLen=PROMPT_LIMIT-basePrompt.length-1;
  const desc=sanitizeText(placeholder.content).slice(0,Math.max(0,maxDescLen));
  const finalPrompt=`${basePrompt} ${desc}`.trim();
  const rawImgs=[...imgs.targets.filter(Boolean),imgs.reference];
  const runwayUserMsg={role:'user',content:finalPrompt,attachments:rawImgs};
  await api.addMessage(chatId,runwayUserMsg);
  if(chatId===activeChat){
    messagesEl.appendChild(createMessageEl(runwayUserMsg));
    messagesEl.scrollTop=messagesEl.scrollHeight;
  }
  const images=rawImgs.map(u=>({uri:u}));
  const payload={model:modelRunway,promptText:finalPrompt,ratio:ratio||info.ratios?.[0],referenceImages:images};
  const credits=info.cost({ratio})||0;
  const params={model:info.label,mode:REPLACE_MODE,ratio:ratio||info.ratios?.[0],credits};
  const ph={role:'assistant',content:'',status:'отправка',attachments:[],params};
  const saved2=await api.addMessage(chatId,ph);
  ph.id=saved2.id;
  let phEl=null;
  if(chatId===activeChat){
    phEl=createMessageEl(ph); messagesEl.appendChild(phEl); messagesEl.scrollTop=messagesEl.scrollHeight;
  }
  try{
    const res2=await api.callRunway(apiKey,info.endpoint,payload);
    ph.status='обработка'; if(phEl) setStatus(phEl,ph.status); await api.updateMessage(chatId,ph.id,{status:ph.status});
    const task=await api.waitForTask(apiKey,res2.id,t=>{
      if(t.status){const pct=t.progress!=null?Math.floor(t.progress*100):null;ph.status=pct!=null?`обработка ${pct}%`:'обработка';if(phEl) setStatus(phEl,ph.status);api.updateMessage(chatId,ph.id,{status:ph.status});}
    });
    if(task.status==='SUCCEEDED' && task.output){
      ph.status='готово';
      ph.attachments=await Promise.all(task.output.map(async u=>{if(typeof u==='string'&&u.startsWith('data:')) return u; try{const r=await fetch(u);const b=await r.blob();return await new Promise(res=>{const fr=new FileReader();fr.onloadend=()=>res(fr.result);fr.readAsDataURL(b);});}catch{return u;} }));
    }else{ph.status='ошибка';ph.content='Ошибка генерации';}
  }catch(e){ph.status='ошибка';ph.content=e.message;}
  if(phEl) setStatus(phEl,ph.status);
  await api.updateMessage(chatId,ph.id,{status:ph.status,content:ph.content,attachments:ph.attachments,params:ph.params});
  if(phEl) phEl.replaceWith(createMessageEl(ph));
  updateCost();
  refreshBalance();
}

async function handleSend(){
  if(currentModes.includes(REPLACE_MODE)){
    await handleReplaceSend();
    return;
  }
  const apiKey=getRunwayKey();
  if(!apiKey){ showToast('Введите API ключ'); return; }
  if(!activeChat){ showToast('Нет активного чата'); return; }
  const chatId=activeChat;
  let prompt=sanitizeText(promptInput.value.trim());
  if(prompt.length>PROMPT_LIMIT) prompt=prompt.slice(0,PROMPT_LIMIT);
  const model=currentModel;
  const ratio=currentRatio;
  const duration=currentDuration;
  const files=JSON.parse(JSON.stringify(currentFiles));
  const info=MODEL_INFO[model];
  if(info.prompt && !prompt){ showToast('Введите промпт'); return; }
  if(info.slots){
    for(const s of info.slots){
      if(s.required){
        const val=files[s.name];
        const arr=s.multiple? (Array.isArray(val)?val.filter(Boolean):[]) : (val?[val]:[]);
        if(arr.length===0){ showToast(`Добавьте ${s.label.toLowerCase()}`); return; }
      }
    }
  }
  const payload=await buildPayload(model,prompt,files,ratio,duration);
  const userMsg={role:'user',content:prompt,attachments:collectAllFiles(files)};
  await api.addMessage(chatId,userMsg);
  if(chatId===activeChat){
    messagesEl.querySelector('.model-desc')?.remove();
    messagesEl.appendChild(createMessageEl(userMsg));
  }
  promptInput.value=''; autoResize(promptInput); updatePromptCounter(); currentFiles={}; renderAttachMenu(); renderAttachPreview(); updateChatState();
  const credits=info.cost({ratio,duration})||0;
  const params={model:info.label,ratio:ratio||info.ratios?.[0],duration,credits};
  const placeholder={role:'assistant',content:'',status:'отправка',attachments:[],params};
  const saved=await api.addMessage(chatId,placeholder);
  placeholder.id=saved.id;
  let placeholderEl=null;
  if(chatId===activeChat){
    placeholderEl=createMessageEl(placeholder);
    messagesEl.appendChild(placeholderEl);
    messagesEl.scrollTop=messagesEl.scrollHeight;
  }
  try{
    const res=await api.callRunway(apiKey,info.endpoint,payload);
    placeholder.status='обработка';
    if(placeholderEl) setStatus(placeholderEl,placeholder.status);
    await api.updateMessage(chatId,placeholder.id,{status:placeholder.status});
    const task=await api.waitForTask(apiKey,res.id,t=>{
      if(t.status){
        const pct = t.progress!=null ? Math.floor(t.progress*100) : null;
        placeholder.status = pct!=null ? `обработка ${pct}%` : 'обработка';
        if(placeholderEl) setStatus(placeholderEl,placeholder.status);
        api.updateMessage(chatId,placeholder.id,{status:placeholder.status});
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
  if(placeholderEl) setStatus(placeholderEl,placeholder.status);
  await api.updateMessage(chatId,placeholder.id,{status:placeholder.status,content:placeholder.content,attachments:placeholder.attachments,params:placeholder.params});
  if(placeholderEl) placeholderEl.replaceWith(createMessageEl(placeholder));
  updateCost();
  refreshBalance();
}

function collectAllFiles(filesObj=currentFiles){
  const arr=[];
  Object.values(filesObj).forEach(v=>{ if(Array.isArray(v)) v.forEach(x=>{if(x) arr.push(x);}); else if(v) arr.push(v);});
  return arr;
}

async function buildPayload(model,prompt,files,ratio,duration){
  const info=MODEL_INFO[model];
  switch(info.endpoint){
    case 'text_to_image':
      return {model,promptText:prompt,ratio:ratio||info.ratios?.[0],referenceImages:(files.referenceImages||[]).filter(Boolean).map(u=>({uri:u}))};
    case 'image_to_video':
      return {model,promptText:prompt,ratio:ratio||info.ratios?.[0],duration:duration||info.durations?.[0],promptImage:files.promptImage};
    case 'video_to_video':
      return {model,promptText:prompt,ratio:ratio||info.ratios?.[0],videoUri:files.videoUri,references:(files.references||[]).filter(Boolean).map(u=>({type:'image',uri:u}))};
    case 'video_upscale':
      return {model,videoUri:files.videoUri};
    case 'character_performance':
      return {model,ratio:ratio||info.ratios?.[0],character:{type:'image',uri:files.character},reference:{type:'video',uri:files.reference}};
    default:
      return {model,promptText:prompt};
  }
}

async function refreshBalance(silent=false){
  const key=getRunwayKey();
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
  openaiBtn=document.getElementById('openaiBtn');
  ratioBtn=document.getElementById('ratioBtn');
  durationBtn=document.getElementById('durationBtn');
  hiddenFile=document.getElementById('hiddenFile');
  runwayKeyInput=document.getElementById('runwayKey');
  openaiKeyInput=document.getElementById('openaiKey');
  openaiTiersEl=document.getElementById('openaiTiers');
  saveSettingsBtn=document.getElementById('saveSettingsBtn');
  balanceEl=document.getElementById('balanceCredits');
  attachPreview=document.getElementById('attachPreview');
  attachMenu=document.getElementById('attachMenu');
  replaceMenu=document.getElementById('replaceMenu');
  estCost=document.getElementById('estCost');
  settingsBtn=document.getElementById('settingsBtn');
  settingsModal=document.getElementById('settingsModal');
  modeBtn=document.getElementById('modeBtn');
  modeMenu=document.getElementById('modeMenu');
  modeTags=document.getElementById('modeTags');
  modeSettingsModal=document.getElementById('modeSettings');
  modeSettingsContent=document.getElementById('modeSettingsContent');
  modeSaveBtn=document.getElementById('modeSave');
  modeCancelBtn=document.getElementById('modeCancel');
  viewer=document.getElementById('viewer');

  if(!modelBtn||!chatListEl||!newChatBtn||!messagesEl||!promptInput||!sendBtn||!attachBtn||!openaiBtn||!ratioBtn||!durationBtn||!hiddenFile||!runwayKeyInput||!openaiKeyInput||!openaiTiersEl||!saveSettingsBtn||!balanceEl||!attachPreview||!attachMenu||!replaceMenu||!settingsBtn||!settingsModal||!modeBtn||!modeMenu||!modeTags||!modeSettingsModal||!modeSettingsContent||!modeSaveBtn||!modeCancelBtn||!viewer){
    console.error('Missing DOM elements'); return;
  }

  populateModelMenu();
  renderModeMenu();
  selectModel(currentModel);
  runwayKeyInput.value=getRunwayKey();
  openaiKeyInput.value=getOpenAIKey();
  if(runwayKeyInput.value) refreshBalance(true);

  saveSettingsBtn.addEventListener('click',()=>{
    setRunwayKey(runwayKeyInput.value.trim());
    setOpenAIKey(openaiKeyInput.value.trim());
    const tiers={};
    openaiTiersEl.querySelectorAll('select').forEach(sel=>tiers[sel.dataset.tier]=sel.value);
    setOpenAITiers(tiers);
    settingsModal.classList.add('hidden');
    refreshBalance();
  });
  settingsBtn.addEventListener('click',()=>{
    runwayKeyInput.value=getRunwayKey();
    openaiKeyInput.value=getOpenAIKey();
    renderOpenAITiers();
    settingsModal.classList.remove('hidden');
  });
  settingsModal.addEventListener('click',e=>{ if(e.target===settingsModal) settingsModal.classList.add('hidden'); });
  settingsModal.querySelectorAll('.tabs button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      settingsModal.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      settingsModal.querySelectorAll('.tab-content').forEach(c=>c.classList.add('hidden'));
      document.getElementById('tab-'+btn.dataset.tab).classList.remove('hidden');
    });
  });

  modeBtn.addEventListener('click',e=>{e.stopPropagation();togglePopup(modeBtn,modeMenu);});
  modeSaveBtn.addEventListener('click',()=>{
    if(editingMode===REPLACE_MODE){
      let prompt=sanitizeText(document.getElementById('modePrompt').value.trim());
      let basePrompt=sanitizeText(document.getElementById('modeBasePrompt').value.trim());
      const tier=parseInt(document.getElementById('modeTier').value,10);
      const reasoningEl=document.getElementById('modeReasoning');
      const reasoning=reasoningEl?reasoningEl.value:undefined;
      modeSettings[REPLACE_MODE]={prompt:prompt||REPLACE_PROMPT_DEFAULT,basePrompt:basePrompt||REPLACE_BASE_PROMPT,tier,reasoning,images:replaceInputs};
    }else{
      modeSettings[editingMode]=true;
    }
    modeSettingsModal.classList.add('hidden');
    updateChatState();
  });
  modeCancelBtn.addEventListener('click',()=>modeSettingsModal.classList.add('hidden'));
  modeSettingsModal.addEventListener('click',e=>{if(e.target===modeSettingsModal) modeSettingsModal.classList.add('hidden');});
  viewer.addEventListener('click',e=>{ if(e.target===viewer) viewer.classList.add('hidden'); });
  newChatBtn.addEventListener('click',async()=>{
    const color=MODEL_INFO[currentModel].color;
    const c=await api.createChat('Новый чат',{color,model:currentModel,modes:[],modeSettings:{}});
    c.state={color,model:currentModel,modes:[],modeSettings:{}};
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
    if(attachBtn.classList.contains('disabled')) return;
    e.stopPropagation();
    renderAttachMenu();
    togglePopup(attachBtn, attachMenu);
  });
  openaiBtn.addEventListener('click',e=>{e.stopPropagation();renderReplaceMenu();togglePopup(openaiBtn,replaceMenu);});
  hiddenFile.addEventListener('change',e=>{const slot=hiddenFile.dataset.slot;const idx=parseInt(hiddenFile.dataset.index,10)||0;handleFiles(slot,idx,e.target.files);hiddenFile.value='';});
  ratioBtn.addEventListener('click',e=>{e.stopPropagation();showRatioMenu();});
  durationBtn.addEventListener('click',e=>{e.stopPropagation();showDurationMenu();});
  promptInput.addEventListener('input',()=>{
    cleanPromptInput(promptInput);
    autoResize(promptInput);
    updatePromptCounter();
    updateChatState();
  });
  autoResize(promptInput);
  updatePromptCounter();
  sendBtn.addEventListener('click',handleSend);
  balanceEl.addEventListener('click',()=>refreshBalance());
  setInterval(()=>refreshBalance(true),60000);
  window.addEventListener('dragenter',e=>{
    const useReplace=currentModes.includes(REPLACE_MODE);
    const menu=useReplace?replaceMenu:attachMenu;
    const btn=useReplace?openaiBtn:attachBtn;
    if(menu.classList.contains('hidden')){
      if(useReplace) renderReplaceMenu(); else renderAttachMenu();
      positionPopup(btn,menu);
      menu.classList.remove('hidden');
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
  fetch('./globalParams.json').then(r=>r.json()).then(d=>{openAiPrices=d.openAiPrices||{};});
  loadChats();
}

function showRatioMenu(){
  hidePopups();
  const info=MODEL_INFO[currentModel];
  const opts=info.ratios||[]; if(opts.length===0) return;
  const menu=document.createElement('div');
  menu.className='popup dynamic';
  menu.style.maxHeight='200px';
  menu.style.overflowY='auto';
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

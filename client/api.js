const BASE = 'http://localhost:5100';
const API_VERSION = '2024-11-06';

async function jsonFetch(url, opts={}){
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ----- Local chat storage API -----
export function listChats(){
  return jsonFetch(`${BASE}/local/chats`);
}

export function createChat(name, state={}){
  return jsonFetch(`${BASE}/local/chats`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name, state})
  });
}

export function getChat(id){
  return jsonFetch(`${BASE}/local/chats/${id}`);
}

export function updateChat(id, data){
  return jsonFetch(`${BASE}/local/chats/${id}`, {
    method:'PATCH',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(data)
  });
}

export function deleteChat(id){
  return fetch(`${BASE}/local/chats/${id}`, {method:'DELETE'});
}

export function listMessages(chatId){
  return jsonFetch(`${BASE}/local/chats/${chatId}/messages`);
}

export function addMessage(chatId, msg){
  return jsonFetch(`${BASE}/local/chats/${chatId}/messages`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(msg)
  });
}

// ----- OpenAI API -----
export async function callOpenAI(apiKey, body){
  const r = await fetch(`${BASE}/proxy-responses`, {
    method:'POST',
    headers:{
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

// ----- Runway API -----
export async function callRunway(apiKey, path, body){
  const r = await fetch(`${BASE}/api/${path}`, {
    method:'POST',
    headers:{
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Runway-Version': API_VERSION
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function fetchBalance(apiKey, silent=false){
  const url = `${BASE}/api/organization` + (silent ? '?no_log=1' : '');
  const r = await fetch(url, {
    headers:{
      'Authorization': `Bearer ${apiKey}`,
      'X-Runway-Version': API_VERSION
    }
  });
  if (!r.ok) return null;
  return r.json();
}

export async function getTask(apiKey, id){
  const r = await fetch(`${BASE}/api/tasks/${id}`, {
    headers:{
      'Authorization': `Bearer ${apiKey}`,
      'X-Runway-Version': API_VERSION
    }
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function waitForTask(apiKey, id, onUpdate){
  while(true){
    const t = await getTask(apiKey, id);
    if(onUpdate) onUpdate(t);
    if(t.status && t.status !== 'RUNNING' && t.status !== 'PENDING') return t;
    await new Promise(r=>setTimeout(r,2000));
  }
}

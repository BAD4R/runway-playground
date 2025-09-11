const KEY='RUNWAY_API_KEY';

export function getApiKey(){
  return localStorage.getItem(KEY) || '';
}

export function setApiKey(k){
  localStorage.setItem(KEY, k);
}

export function getApiKey(){
  return localStorage.getItem('RUNWAY_API_KEY') || '';
}

export function setApiKey(k){
  localStorage.setItem('RUNWAY_API_KEY', k);
}

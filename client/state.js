const RUNWAY_KEY='RUNWAY_API_KEY';
const OPENAI_KEY='OPENAI_API_KEY';
const OPENAI_TIERS='OPENAI_TIERS';

export function getRunwayKey(){
  return localStorage.getItem(RUNWAY_KEY) || '';
}

export function setRunwayKey(k){
  localStorage.setItem(RUNWAY_KEY, k);
}

export function getOpenAIKey(){
  return localStorage.getItem(OPENAI_KEY) || '';
}

export function setOpenAIKey(k){
  localStorage.setItem(OPENAI_KEY, k);
}

const DEFAULT_TIERS={1:'gpt-5',2:'o3',3:'gpt-5-mini',4:'gpt-5-nano',5:'gpt-4o-mini'};

export function getOpenAITiers(){
  try{
    return JSON.parse(localStorage.getItem(OPENAI_TIERS)) || {...DEFAULT_TIERS};
  }catch{
    return {...DEFAULT_TIERS};
  }
}

export function setOpenAITiers(map){
  localStorage.setItem(OPENAI_TIERS, JSON.stringify(map));
}

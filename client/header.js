import { togglePopup } from './ui.js';

export function initHeader(){
  const switchBtn = document.getElementById('serviceSwitch');
  const menu = document.getElementById('serviceMenu');
  if(!switchBtn || !menu) return;
  switchBtn.addEventListener('click', e=>{
    e.stopPropagation();
    togglePopup(switchBtn, menu);
  });
}

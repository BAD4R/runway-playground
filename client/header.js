import { positionPopup } from './ui.js';

export function initHeader(){
  const switchBtn = document.getElementById('serviceSwitch');
  const menu = document.getElementById('serviceMenu');
  if(!switchBtn || !menu) return;
  switchBtn.addEventListener('click', e=>{
    e.stopPropagation();
    menu.classList.toggle('hidden');
    if(!menu.classList.contains('hidden')) positionPopup(switchBtn, menu);
  });
  document.addEventListener('click', e=>{
    if(!e.target.closest('#serviceMenu')) menu.classList.add('hidden');
  });
}

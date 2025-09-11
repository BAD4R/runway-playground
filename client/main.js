import { init, hidePopups } from './chat.js';
import { initHeader } from './header.js';

console.log('main.js loaded, initializing');
initHeader();
init();

document.addEventListener('click',e=>{ if(!e.target.closest('.popup')) hidePopups(); });

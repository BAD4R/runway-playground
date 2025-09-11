export function positionPopup(anchor, popup){
  popup.classList.remove('hidden');
  const rect = anchor.getBoundingClientRect();
  const w = popup.offsetWidth;
  const h = popup.offsetHeight;
  const margin = 4;
  let left = rect.left;
  let top = rect.bottom + margin;
  const maxLeft = window.innerWidth - w - margin;
  const maxTop = window.innerHeight - h - margin;
  if(left > maxLeft) left = maxLeft;
  if(top > maxTop) top = rect.top - h - margin;
  if(left < margin) left = margin;
  if(top < margin) top = margin;
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

export function hidePopups(){
  document.querySelectorAll('.popup').forEach(p=>{
    if(p.classList.contains('static')) p.classList.add('hidden');
    else p.remove();
  });
}

export function togglePopup(anchor, popup){
  if(popup.classList.contains('hidden')){
    hidePopups();
    positionPopup(anchor, popup);
  }else{
    if(popup.classList.contains('static')) popup.classList.add('hidden');
    else popup.remove();
  }
}
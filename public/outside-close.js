// Every menu closes the same way when the user acts outside it: a press or
// focus elsewhere on the page, or a click in the Canvas. The Canvas is its own
// document, so the page hears nothing of a click there; it only sees its window
// lose focus to the Canvas frame. `inside(target)` says what belongs to the
// menu (its panel, its button); `close()` must do nothing when it is closed.
export function closeOnOutside(inside,close) {
 const away=event=>{if(!inside(event.target))close();};
 document.addEventListener('pointerdown',away);
 document.addEventListener('focusin',away);
 window.addEventListener('blur',()=>setTimeout(()=>{if(document.activeElement?.tagName==='IFRAME')close();},0));
}

// The tab icon gains a small dot while the agent works on the open Goal, so a
// background tab shows progress without using any title space.
const dot="%3Ccircle cx='24.5' cy='7.5' r='6.5' fill='%23d9822b' stroke='%23ffffff' stroke-width='2'/%3E";
export function createTabIcon(link=document.querySelector('link[rel="icon"]')){
 if(!link)return {set(){}};
 const idle=link.getAttribute('href'),working=idle.replace(/%3C\/svg%3E$/,`${dot}%3C/svg%3E`);
 return {set(value){const href=value?working:idle;if(link.getAttribute('href')!==href)link.setAttribute('href',href);}};
}

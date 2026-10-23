// While the agent works on the open Goal, the tab icon's sunrise takes color: a
// warm sky, a filled orange sun and a blue sea. While it waits for a check it
// scheduled, the sun is yellow on a pale sky: between idle and running. It uses
// no title space.
const svg=(sky,sun,sea)=>`data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='9' fill='${sky}'/><path d='M10 17a6 6 0 1 1 12 0z' fill='${sun}' stroke='${sun}' stroke-width='2' stroke-linejoin='round'/><path d='M16 3v3M5 8l3 3M27 8l-3 3' fill='none' stroke='${sun}' stroke-width='2' stroke-linecap='round'/><path d='M5 21h22M9 25h14' fill='none' stroke='${sea}' stroke-width='2' stroke-linecap='round'/></svg>`)}`;
export const workingIcon=svg('#fde7cf','#e2702a','#2c7bb6');
export const waitingIcon=svg('#fdf4cf','#e6ab17','#5b958a');
export function createTabIcon(link=document.querySelector('link[rel="icon"]')){
 if(!link)return {set(){}};
 const idle=link.getAttribute('href');
 return {set(state){const href=state==='working'?workingIcon:state==='waiting'?waitingIcon:idle;if(link.getAttribute('href')!==href)link.setAttribute('href',href);}};
}

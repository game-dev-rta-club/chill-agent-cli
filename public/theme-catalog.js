// IDs are persisted per workspace and per Root; a removed ID falls back to the default.
const hues=[['mint','Mint',160],['ocean','Ocean',205],['iris','Iris',265],['rose','Rose',335],['peach','Peach',25],['lime','Lime',90]];
export const themes=['gradient','light','dark'].flatMap(kind=>hues.map(([name,label,hue])=>({id:`${kind}-${name}`,kind,name:label,hue})));
export const defaultTheme='gradient-mint';
export const validTheme=id=>themes.some(theme=>theme.id===id);

// Opaque browser-chrome colors; gradients use a soft representative hue.
export function browserThemeColor(id) {
 const theme=themes.find(theme=>theme.id===id);
 if(!theme||id===defaultTheme)return '#b2edcf';
 const s=theme.kind==='gradient'?0.60:0.16,l=theme.kind==='dark'?0.10:theme.kind==='light'?0.96:0.78;
 const a=s*Math.min(l,1-l);
 const channel=n=>{const k=(n+theme.hue/30)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0');};
 return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// Tab icon sets share one sunrise. Idle draws it in outline. Waiting fills a
// yellow sun on the idle sky with short rays. Running warms the sky and draws
// long, thicker rays, so the two states differ in shape as well as color.
// Lines are thick and high-contrast so a tab reads from a distance.
const svg=body=>`data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>${body}</svg>`)}`;
const outline=(sky,line)=>svg(`<rect width='32' height='32' rx='9' fill='${sky}'/><path d='M5 21h22M9 25h14M10 17a6 6 0 1 1 12 0M16 3v3M5 8l3 3M27 8l-3 3' fill='none' stroke='${line}' stroke-width='2.6' stroke-linecap='round'/>`);
const sunrise=(sky,sun,sea,running=false)=>svg(`<rect width='32' height='32' rx='9' fill='${sky}'/><path d='M10 17a6 6 0 1 1 12 0z' fill='${sun}' stroke='${sun}' stroke-width='2' stroke-linejoin='round'/><path d='${running?'M16 1.5v4.5M3.5 6.5l4 4M28.5 6.5l-4 4':'M16 3v3M5 8l3 3M27 8l-3 3'}' fill='none' stroke='${sun}' stroke-width='${running?3.2:2.4}' stroke-linecap='round'/><path d='M5 21h22M9 25h14' fill='none' stroke='${sea}' stroke-width='2.6' stroke-linecap='round'/>`);
export const tabIcons=[
 {id:'morning',name:'Morning',idle:outline('#2f8f74','#ffffff'),waiting:sunrise('#2f8f74','#ffd23f','#d6f3ea'),working:sunrise('#f08a3c','#fff3c4','#ffffff',true)},
 {id:'cloudy',name:'Cloudy',idle:outline('#e6e7ea','#555b64'),waiting:sunrise('#e6e7ea','#b39a45','#6b7684'),working:sunrise('#f0d6c0','#cc6f2c','#4e5f77',true)},
 {id:'night',name:'Night',idle:outline('#1f2946','#d3def7'),waiting:sunrise('#1f2946','#ffd84d','#aebfe6'),working:sunrise('#3c55c4','#ffa62b','#e0edff',true)},
];
export const defaultTabIcon='morning';
export const validTabIcon=id=>tabIcons.some(icon=>icon.id===id);
export const tabIconSet=id=>tabIcons.find(icon=>icon.id===id)||tabIcons[0];

// A Root without its own choice uses the project default, one field at a time.
export function resolveAppearance(stored,rootId=null) {
 const own=rootId?stored.roots?.[rootId]:null;
 return {theme:own?.theme||stored.theme,tabIcon:own?.tabIcon||stored.tabIcon,custom:Boolean(own)};
}

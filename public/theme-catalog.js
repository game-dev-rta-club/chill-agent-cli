// IDs are persisted per workspace; keep them stable across palette revisions.
const hues=[['mint','Mint',160],['ocean','Ocean',205],['iris','Iris',265],['rose','Rose',335],['peach','Peach',25],['sand','Sand',45]];
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

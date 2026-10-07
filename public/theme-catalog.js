// IDs are persisted per workspace; keep them stable across palette revisions.
const hues=[['mint','Mint',160],['ocean','Ocean',205],['iris','Iris',265],['rose','Rose',335],['peach','Peach',25],['sand','Sand',45]];
export const themes=['gradient','light','dark'].flatMap(kind=>hues.map(([name,label,hue])=>({id:`${kind}-${name}`,kind,name:label,hue})));
export const defaultTheme='gradient-mint';
export const validTheme=id=>themes.some(theme=>theme.id===id);

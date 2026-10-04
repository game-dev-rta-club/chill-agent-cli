// Prefer a complete sentence; make omission visible and never split a surrogate pair.
export function continuationExcerpt(value,limit=220){
 const text=String(value||'').replace(/\s+/g,' ').trim();
 const points=Array.from(text);if(points.length<=limit)return text;
 const head=points.slice(0,limit-1).join('');
 const boundaries=[...head.matchAll(/[。！？!?]|\.(?=\s)/g)];
 const last=boundaries.at(-1);
 if(last)return head.slice(0,last.index+1).trimEnd()+'…';
 const space=head.lastIndexOf(' ');
 return (space>head.length/2?head.slice(0,space):head).trimEnd()+'…';
}

// Runs before first paint. The server fills in the project default; a Goal of a
// Root with its own choice switches to that Root's theme and tab icon here.
(()=>{try{
 const root=document.documentElement,data=JSON.parse(document.querySelector('meta[name="workspace-appearance"]').content);
 const id=/^#\/goal\/([1-9][0-9]*)/.exec(location.hash)?.[1],rootId=data.goals[id],look=data.looks[rootId];
 if(!look)return;
 root.dataset.theme=look.theme;root.dataset.tabIcon=data.stored.roots[rootId].tabIcon||data.stored.tabIcon;
 document.querySelector('meta[name="theme-color"]')?.setAttribute('content',look.color);
 document.querySelector('link[rel="icon"]')?.setAttribute('href',look.icon);
}catch{}})();

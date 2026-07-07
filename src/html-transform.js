export function injectLavishSdk(html, key) {
  const script = `<script src="/sdk.js?key=${encodeURIComponent(key)}"></script>`;
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  return `${html}\n${script}`;
}

// Print artifacts often hide content behind tabs: CSS-only radio/checkbox tabs
// (panels are `display:none` until their input is `:checked`), `[hidden]`
// toggles, or collapsed `<details>`. A naive `window.print()` then captures only
// the active tab. Before printing we reveal everything: expand disclosures, drop
// `[hidden]`, and for CSS-only tab groups force-show every panel that is visible
// in *some* tab state (the union across states), so all tabs print stacked, and
// force a page break before each revealed panel root so every tab begins on its
// own printed page. A panel root is a revealed element whose parent was visible
// before the reveal; nested descendants of a hidden panel are skipped so we break
// per tab, not per block. It also scales the printed output to 80% via a
// print-scoped `zoom` (which reflows across page breaks, unlike a transform)
// so the stacked, screen-sized type prints at a comfortable size, and prepends
// each broken panel with an `<h1>` naming its tab (resolved from the controlling
// input's label) so pages after the first identify which tab they show. The
// routine is a no-op when there are no such controls, and best-effort - it never
// blocks printing.
const PRINT_REVEAL_SCRIPT = `<script>(function(){
function tabName(inp){var t="";try{if(inp.id){var l=document.querySelector('label[for="'+((window.CSS&&CSS.escape)?CSS.escape(inp.id):inp.id)+'"]');if(l)t=l.textContent;}if(!t&&inp.closest){var p=inp.closest("label");if(p)t=p.textContent;}if(!t)t=inp.getAttribute("aria-label")||inp.value||"";}catch(e){}return t.trim();}
function reveal(){try{
var st=document.createElement("style");st.textContent="@media print{html{zoom:0.8}h1[data-lavish-print-heading]{font-size:1.5rem;font-weight:700;margin:0 0 0.75rem}}";(document.head||document.documentElement).appendChild(st);
document.querySelectorAll("details:not([open])").forEach(function(d){d.open=true;});
document.querySelectorAll("[hidden]").forEach(function(e){e.removeAttribute("hidden");});
var inputs=Array.prototype.slice.call(document.querySelectorAll("input[type=radio],input[type=checkbox]"));
if(inputs.length){
var groups={};
inputs.forEach(function(i){var k=(i.type==="radio"&&i.name)?"r:"+i.name:"c:"+(i.id||Math.random());(groups[k]=groups[k]||[]).push(i);});
var all=Array.prototype.slice.call(document.querySelectorAll("body *"));
var union=[];
Object.keys(groups).forEach(function(k){
var ins=groups[k];
var saved=ins.map(function(i){return i.checked;});
ins.forEach(function(active){
ins.forEach(function(i){i.checked=(i===active);});
var name=tabName(active);
all.forEach(function(el){if(getComputedStyle(el).display!=="none"){if(union.indexOf(el)===-1)union.push(el);if(name&&!el.__lavishTab)el.__lavishTab=name;}});
});
ins.forEach(function(i,idx){i.checked=saved[idx];});
});
var toReveal=union.filter(function(el){return getComputedStyle(el).display==="none";});
var roots=toReveal.filter(function(el){return !(el.parentElement&&getComputedStyle(el.parentElement).display==="none");});
toReveal.forEach(function(el){el.style.setProperty("display","revert","important");});
roots.forEach(function(el){el.style.setProperty("break-before","page","important");el.style.setProperty("page-break-before","always","important");var nm=el.__lavishTab;if(nm){var h=document.createElement("h1");h.setAttribute("data-lavish-print-heading","");h.textContent=nm;el.insertBefore(h,el.firstChild);}});
}
}catch(e){}}
function run(){reveal();window.print();}
if(document.readyState==="complete")run();else window.addEventListener("load",run);
})();</script>`;

export function injectPrintScript(html) {
  if (/<\/body\s*>/i.test(html)) {
    return html.replace(/<\/body\s*>/i, `${PRINT_REVEAL_SCRIPT}</body>`);
  }
  return `${html}\n${PRINT_REVEAL_SCRIPT}`;
}

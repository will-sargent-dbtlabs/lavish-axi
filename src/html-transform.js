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
// in *some* tab state (the union across states), so all tabs print stacked. The
// routine is a no-op when there are no such controls, and best-effort — it never
// blocks printing.
const PRINT_REVEAL_SCRIPT = `<script>(function(){
function reveal(){try{
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
all.forEach(function(el){if(getComputedStyle(el).display!=="none"&&union.indexOf(el)===-1)union.push(el);});
});
ins.forEach(function(i,idx){i.checked=saved[idx];});
});
union.forEach(function(el){if(getComputedStyle(el).display==="none")el.style.setProperty("display","revert","important");});
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

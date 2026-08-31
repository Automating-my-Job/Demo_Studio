'use strict';
/**
 * pageOutline.js — browser-side JS (a string, like cameraClient.js builds)
 * that walks the visible DOM and returns a compact outline Gemini can frame
 * against: for each element a stable-ish selector, an nth index when the
 * selector is ambiguous, trimmed text, and its bounding box. Capped so a
 * huge dashboard cannot blow the prompt up.
 */
function buildOutlineJs(maxNodes) {
  const cap = maxNodes || 400;
  return '(function(){' +
    'var out=[];var n=0;var CAP=' + cap + ';' +
    'function sel(el){' +
    ' if(el.id&&!/\\d{3,}/.test(el.id)) return "#"+el.id;' +
    ' var s=el.tagName.toLowerCase();' +
    ' var cls=Array.prototype.slice.call(el.classList||[],0,2).filter(function(c){return !/\\d{3,}/.test(c);});' +
    ' if(cls.length) s+="."+cls.join(".");' +
    ' return s;}' +
    'function visible(el){' +
    ' var st=getComputedStyle(el);' +
    ' if(st.display==="none"||st.visibility==="hidden"||Number(st.opacity)===0) return false;' +
    ' var r=el.getBoundingClientRect();' +
    ' return r.width>=8&&r.height>=8;}' +
    'function textOf(el){' +
    ' var t="";' +
    ' for(var i=0;i<el.childNodes.length;i++){var c=el.childNodes[i];' +
    '  if(c.nodeType===3) t+=c.textContent;}' +
    ' t=t.replace(/\\s+/g," ").trim();' +
    ' if(!t&&el.children.length===0) t=(el.textContent||"").replace(/\\s+/g," ").trim();' +
    ' return t.slice(0,60);}' +
    'function walk(el,depth){' +
    ' if(n>=CAP||depth>12) return;' +
    ' if(el.nodeType!==1) return;' +
    ' var tag=el.tagName.toLowerCase();' +
    ' if(tag==="script"||tag==="style"||tag==="link"||tag==="meta") return;' +
    ' if(!visible(el)) return;' +
    ' var s=sel(el);' +
    ' var all=document.querySelectorAll(s);' +
    ' var nth=0;' +
    ' for(var i=0;i<all.length;i++){if(all[i]===el){nth=i;break;}}' +
    ' var r=el.getBoundingClientRect();' +
    ' var t=textOf(el);' +
    ' var interesting=t||el.id||(el.classList&&el.classList.length)||tag==="button"||tag==="a"||tag==="input";' +
    ' if(interesting&&s!=="div"&&s!=="span"){' +
    '  out.push({sel:s,nth:nth,matches:all.length,tag:tag,text:t,' +
    '   x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),' +
    '   clickable:(tag==="button"||tag==="a"||el.onclick!==null||el.hasAttribute("data-toggle"))});' +
    '  n++;}' +
    ' for(var j=0;j<el.children.length;j++) walk(el.children[j],depth+1);}' +
    'walk(document.body,0);' +
    'return JSON.stringify({title:document.title,scrollHeight:document.documentElement.scrollHeight,nodes:out});' +
    '}())';
}

module.exports = { buildOutlineJs };

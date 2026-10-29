'use strict';
/**
 * cameraClient.js — the browser-injected camera/caption/spotlight script.
 * NODE-ONLY (this file BUILDS a string of client-side JS; nothing in it runs
 * here).
 *
 * ===========================================================================
 * SPOTLIGHT, NOT CROP-ZOOM — AND WHY THAT MATTERS
 * ===========================================================================
 * The obvious way to draw attention to something on screen is to scale the
 * page up until that thing fills the frame. On a real, dense page layout
 * that crops the thing's own edges — the demo looks hand-made, and worse,
 * unfinished. So emphasis here works the other way: the page is held at a
 * calm scale that ALWAYS shows the whole width, and attention is drawn by
 * dimming everything except the subject and ringing it — a technique
 * professional SaaS demos use specifically for dense dashboards, because it
 * mechanically cannot crop (the camera never moves to make the emphasis).
 *
 * ===========================================================================
 * WHY THE MOTION IS "PRODUCED", NOT OBSERVED
 * ===========================================================================
 * This script assumes frames are captured by forcing a render
 * (`Page.captureScreenshot` after setting exact state), not by streaming a
 * live compositor (`Page.startScreencast`). Headless Chrome does not reliably
 * drive its own compositor when nothing else is asking it to, so a CSS
 * transition or `requestAnimationFrame` loop here would render at most a
 * frame or two and then stop. Every "move" in this file is therefore driven
 * frame-by-frame from Node (see recorder.js's `motion()`), which is why
 * every animatable property here is exposed as a plain settable function of
 * `t`, not a CSS transition.
 *
 * ===========================================================================
 * CONFIGURATION
 * ===========================================================================
 * `buildCameraClientJs(config)` takes:
 *   - pageSelector: CSS selector for the element the camera moves (the
 *     "page" — usually a single wrapping div). Falls back to document.body
 *     if the selector matches nothing, so a project with no such wrapper
 *     still works (camera just transforms body directly).
 *   - captionHeight: px reserved at the top of the frame for the caption bar
 *     (default 104, matching a ~34px caption at a comfortable size).
 *   - margin: px of safe margin kept around any subject (default 48).
 *
 * The live-app kit (liveKit.js: __q, __findText, __labelCheck, __redact,
 * __neverShow …) is appended, so the top frame has everything an iframe
 * gets from frames.js.
 */
const { buildLiveKitJs } = require('./liveKit.js');

function buildCameraClientJs(config) {
  const pageSelector = JSON.stringify((config && config.pageSelector) || '.demo-page');
  // `|| default` would turn an explicit 0 into the default; a live Setup take
  // burns no caption bar and keeps the ring close to the frame edge.
  const pick = (v, d) => (typeof v === 'number' && v >= 0 ? v : d);
  const captionHeight = pick(config && config.captionHeight, 104);
  const margin = pick(config && config.margin, 48);

  return (
    // Every user-facing string below goes through a literal DOM API
    // (textContent, style.cssText with numeric interpolation only) — nothing
    // here ever assigns untrusted text through innerHTML, so a project's own
    // page content can never become markup inside this overlay.
    'window.__caption=function(text){' +
    ' var el=document.getElementById("__demoCap");' +
    // Appended to <html>, not <body> — the camera transforms <body>/the page
    // root, and a fixed element living inside a transformed ancestor scales
    // and drifts along with it. The caption must stay put.
    ' if(!el){el=document.createElement("div");el.id="__demoCap";' +
    // Fully opaque: at .97 the page scrolling up beneath the bar (a hidden
    // app header, dashboard numbers) ghosted through as faint text.
    '  el.style.cssText="position:fixed;left:0;right:0;top:0;z-index:99999;' +
    'padding:26px 48px;background:rgb(6,10,18);border-bottom:2px solid rgba(120,200,220,.45);' +
    'font:600 34px/1.35 ui-sans-serif,system-ui,-apple-system,sans-serif;color:#F2F7FC;' +
    'letter-spacing:.2px";document.documentElement.appendChild(el);' +
    '  document.documentElement.style.paddingTop="' + captionHeight + 'px";}' +
    ' el.textContent=text;};' +

    // Keeps the compositor from going fully idle between captured frames on
    // some Chrome builds. Harmless, and cheap enough to always leave on.
    'window.__tick=function(){' +
    ' var d=document.createElement("div");' +
    ' d.style.cssText="position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;' +
    'pointer-events:none;z-index:0;background:#fff";' +
    ' document.body.appendChild(d); var i=0;' +
    ' (function loop(){ i=(i+1)%1000; d.style.transform="translateX("+(i%2)+"px)";' +
    '   requestAnimationFrame(loop); }());};' +

    // ===========================================================================
    // THE CAMERA
    // ===========================================================================
    'window.__CAP=' + captionHeight + ';window.__M=' + margin + ';' +
    'window.__cam={y:0,s:1};' +
    'window.__page=function(){return document.querySelector(' + pageSelector + ')||document.body;};' +
    'window.__apply=function(){var p=window.__page();' +
    ' p.style.transformOrigin="50% 0";' +
    ' var ty=Math.round(-window.__cam.y*window.__cam.s);' +
    ' p.style.transform="translateY("+ty+"px) scale("+window.__cam.s+")";};' +

    // Only vertical position and a gentle scale are chosen — never past the
    // honest fit for the element, so the full page width is always in frame.
    // mode 'wide' aims for an airy 0.82-1.0; 'focus' (the default) aims for
    // 0.85-1.0 unless the element is naturally larger, then it fits down.
    'window.__plan=function(el,mode){' +
    ' var H=window.innerHeight,CAP=window.__CAP,M=window.__M;' +
    ' window.__A={y:window.__cam.y,s:window.__cam.s}; window.__crawl=null;' +
    ' if(!el){window.__B=window.__A;return "none";}' +
    ' var p=window.__page(); var keep={y:window.__cam.y,s:window.__cam.s};' +
    ' window.__cam.y=0; window.__cam.s=1; window.__apply();' +
    ' var box=el.getBoundingClientRect();' +
    ' var avail=H-CAP-2*M;' +
    ' var fit=avail/Math.max(1,box.height);' +
    ' var s;' +
    ' if(mode==="wide") s=Math.min(1.0,Math.max(0.82,fit));' +
    ' else s=Math.min(1.0,Math.max(0.85,fit));' +
    ' var over=box.height>avail;' +
    ' window.__cam.s=s; window.__cam.y=0; window.__apply();' +
    ' var r=el.getBoundingClientRect();' +
    ' var wantTop=over?(CAP+M):Math.max(CAP+20,(CAP+H)/2-r.height/2);' +
    ' var y=(r.top-wantTop)/s;' +
    ' var pr=p.getBoundingClientRect();' +
    // The page's own box is not always its content height: an app shell
    // laid out with absolute/fixed children (Salesforce Lightning's body is
    // 0px tall) would clamp maxY to 0 and pin the camera to the top with no
    // error. Take the tallest honest measure of where the content ends.
    ' var bottom=Math.max(pr.bottom,pr.top+p.scrollHeight*s,' +
    '  p===document.body?(document.scrollingElement||document.documentElement).scrollHeight-window.scrollY:0);' +
    ' var maxY=Math.max(0,(bottom-(H-40))/s);' +
    ' y=Math.max(0,Math.min(y,maxY));' +
    ' if(over) window.__crawl={by:(r.height-avail)/s};' +
    ' window.__cam.y=keep.y; window.__cam.s=keep.s; window.__apply();' +
    ' window.__B={y:y,s:s};' +
    ' return over?"crawl":"focus";};' +
    'window.__lerp=function(t){' +
    ' var e=t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;' +
    ' window.__cam.y=window.__A.y+(window.__B.y-window.__A.y)*e;' +
    ' window.__cam.s=window.__A.s+(window.__B.s-window.__A.s)*e;' +
    ' window.__apply();};' +

    // A tall element is READ rather than crammed to fit: park on the top,
    // travel down, park on the bottom. Eased at both ends so it does not
    // read as a mechanical scroll.
    'window.__crawlStart=function(){window.__crawlFrom=window.__cam.y;' +
    ' window.__crawlBy=(window.__crawl?window.__crawl.by:0);};' +
    'window.__crawlTo=function(t){' +
    ' if(window.__crawlFrom===undefined) return;' +
    ' var e=t<0.2?(t*t)/0.08:(t>0.8?1-Math.pow(1-t,2)/0.08:t);' +
    ' e=Math.min(1,Math.max(0,e));' +
    ' window.__cam.y=window.__crawlFrom+window.__crawlBy*e; window.__apply();};' +

    // ===========================================================================
    // THE SPOTLIGHT — emphasis without ever moving the camera to crop
    // ===========================================================================
    // A fixed overlay outside the page transform: reads the subject's
    // on-screen rect AFTER the camera has settled, darkens everything else
    // with a huge box-shadow spread, and rings the subject. Clamped to all
    // four frame edges — a subject bigger than the safe area gets a ring that
    // hugs the frame rather than one that runs off it.
    // __spotBox draws the ring around a viewport rect {left,top,right,bottom};
    // __spot measures an element and calls it; __spotRect takes numbers, for
    // a subject inside an iframe whose rect the recorder has already mapped
    // into this frame's coordinates (frames.js).
    'window.__spotBox=function(r,a){' +
    ' var el=document.getElementById("__demoSpot");' +
    ' if(!el){el=document.createElement("div");el.id="__demoSpot";' +
    '  el.style.cssText="position:fixed;z-index:99990;pointer-events:none;border-radius:12px";' +
    '  document.documentElement.appendChild(el);}' +
    // Ring padding defaults to 12px all round. window.__spotPad overrides it
    // (a number, or [top,right,bottom,left]) for a subject that sits tight
    // against a neighbour the ring must NOT touch, e.g. one line of a
    // stacked block, where a 12px ring slices through the line above.
    ' if(r){var M=window.__M;' +
    '   var P=window.__spotPad;P=(P===undefined||P===null)?12:P;' +
    '   if(typeof P==="number")P=[P,P,P,P];' +
    '   var L=Math.max(M,r.left-P[3]);' +
    '   var T=Math.max(window.__CAP+M/2,r.top-P[0]);' +
    '   var Rt=Math.min(window.innerWidth-M,r.right+P[1]);' +
    '   var Bt=Math.min(window.innerHeight-M,r.bottom+P[2]);' +
    '   el.style.left=Math.round(L)+"px";el.style.top=Math.round(T)+"px";' +
    '   el.style.width=Math.round(Math.max(0,Rt-L))+"px";' +
    '   el.style.height=Math.round(Math.max(0,Bt-T))+"px";}' +
    ' el.style.boxShadow="0 0 0 9999px rgba(4,8,14,"+(0.60*a).toFixed(3)+"),"+' +
    '  "inset 0 0 0 2px rgba(94,200,216,"+(0.85*a).toFixed(3)+"),"+' +
    '  "0 0 44px 6px rgba(94,200,216,"+(0.20*a).toFixed(3)+")";};' +
    'window.__spot=function(sel,a){' +
    ' var t=sel?((typeof sel==="string")?document.querySelector(sel):sel):null;' +
    ' window.__spotBox(t?t.getBoundingClientRect():null,a);};' +
    'window.__spotRect=function(l,t,r,b,a){window.__spotBox({left:l,top:t,right:r,bottom:b},a);};' +
    'window.__spotOff=function(){var el=document.getElementById("__demoSpot");' +
    ' if(el){el.style.boxShadow="none";}};' +

    // A ring that GLIDES from its current subject to a new one at full
    // strength — for walking a row of related things (four hero cards, a bar
    // then its callout) without the dim-out/dim-in blink that spotOut+spot
    // makes between each. t=0 snapshots the start box; the target box is
    // re-measured every step so a settling layout is still tracked.
    'window.__spotGlide=function(sel,t){' +
    ' var el=document.getElementById("__demoSpot");' +
    ' var tgt=(typeof sel==="string")?document.querySelector(sel):sel;' +
    ' if(!el||!tgt){window.__spot(tgt,1);window.__spotSel=tgt;return !!tgt;}' +
    ' if(t<=0||!window.__glideFrom){window.__glideFrom={L:parseFloat(el.style.left)||0,' +
    '  T:parseFloat(el.style.top)||0,W:parseFloat(el.style.width)||0,H:parseFloat(el.style.height)||0};}' +
    ' var f=window.__glideFrom;' +
    ' window.__spot(tgt,1);' +
    ' var to={L:parseFloat(el.style.left),T:parseFloat(el.style.top),W:parseFloat(el.style.width),H:parseFloat(el.style.height)};' +
    ' var e=t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;' +
    ' el.style.left=Math.round(f.L+(to.L-f.L)*e)+"px";el.style.top=Math.round(f.T+(to.T-f.T)*e)+"px";' +
    ' el.style.width=Math.round(f.W+(to.W-f.W)*e)+"px";el.style.height=Math.round(f.H+(to.H-f.H)*e)+"px";' +
    ' if(t>=1){window.__glideFrom=null;window.__spotSel=tgt;}' +
    ' return true;};' +

    // Shadow-piercing __q, the label lookups, and display-only redaction
    // (__redact / __redactAudit, re-applied before EVERY frame through
    // runDemo's everyFrameJs) live in liveKit.js, shared with every iframe.
    buildLiveKitJs() +

    // A small explicit highlight for inline things (a link, a button) that
    // do not warrant a full spotlight.
    'window.__flash=function(sel,v){' +
    ' Array.prototype.forEach.call(document.querySelectorAll(sel),function(el){' +
    '  el.style.outline=v>0?("3px solid rgba(94,200,216,"+v+")"):"";' +
    '  el.style.outlineOffset="3px";' +
    '  el.style.borderRadius="6px";});};' +

    'window.__spotGlideRect=function(l,tp,r,b,t){' +
    ' var el=document.getElementById("__demoSpot");' +
    ' if(!el){window.__spotRect(l,tp,r,b,1);return true;}' +
    ' if(t<=0||!window.__glideFrom){window.__glideFrom={L:parseFloat(el.style.left)||0,' +
    '  T:parseFloat(el.style.top)||0,W:parseFloat(el.style.width)||0,H:parseFloat(el.style.height)||0};}' +
    ' var f=window.__glideFrom;window.__spotRect(l,tp,r,b,1);' +
    ' var to={L:parseFloat(el.style.left),T:parseFloat(el.style.top),W:parseFloat(el.style.width),H:parseFloat(el.style.height)};' +
    ' var e=t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2;' +
    ' el.style.left=Math.round(f.L+(to.L-f.L)*e)+"px";el.style.top=Math.round(f.T+(to.T-f.T)*e)+"px";' +
    ' el.style.width=Math.round(f.W+(to.W-f.W)*e)+"px";el.style.height=Math.round(f.H+(to.H-f.H)*e)+"px";' +
    ' if(t>=1)window.__glideFrom=null;return true;};' +

    // ===========================================================================
    // THE CURSOR - a visible pointer for live takes (off unless drawn)
    // ===========================================================================
    // __cursor(x, y, press) draws an arrow whose TIP is at (x, y), in viewport
    // px. press in [0,1] dips it and rings the tip, for a click. It never
    // takes pointer events: the recorder's real mouse events (CDP) land on
    // the page underneath. Built with DOM APIs only (no innerHTML), which
    // also keeps it working on pages that enforce Trusted Types.
    'window.__cursor=function(x,y,press){' +
    ' var c=document.getElementById("__demoCursor");' +
    ' if(!c){var NS="http://www.w3.org/2000/svg";c=document.createElement("div");c.id="__demoCursor";' +
    '  c.style.cssText="position:fixed;left:0;top:0;width:30px;height:38px;z-index:100002;pointer-events:none;' +
    'transform-origin:3px 3px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";' +
    '  var ring=document.createElement("div");ring.id="__demoCursorRing";' +
    '  ring.style.cssText="position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;' +
    'border-radius:50%;z-index:100001;pointer-events:none;opacity:0;border:3px solid rgba(94,200,216,.9)";' +
    '  var svg=document.createElementNS(NS,"svg");svg.setAttribute("width","30");svg.setAttribute("height","38");' +
    '  svg.setAttribute("viewBox","0 0 30 38");var p=document.createElementNS(NS,"path");' +
    '  p.setAttribute("d","M3 3 L3 31 L10 24 L15 35 L20 33 L15 22 L25 22 Z");' +
    '  p.setAttribute("fill","#111");p.setAttribute("stroke","#fff");p.setAttribute("stroke-width","2");' +
    '  p.setAttribute("stroke-linejoin","round");svg.appendChild(p);c.appendChild(svg);' +
    '  document.documentElement.appendChild(ring);document.documentElement.appendChild(c);}' +
    ' var k=press||0;c.style.display="block";' +
    ' c.style.transform="translate("+(x-3)+"px,"+(y-3)+"px) scale("+(1-0.14*k).toFixed(3)+")";' +
    ' var ring2=document.getElementById("__demoCursorRing");' +
    ' if(ring2){ring2.style.left=x+"px";ring2.style.top=y+"px";ring2.style.opacity=(0.9*k).toFixed(3);' +
    '  ring2.style.transform="scale("+(0.55+0.45*k).toFixed(3)+")";}' +
    ' return true;};' +
    // A full-frame card (slide, end card) takes the cursor with it: the
    // pointer sat on M1's end card for its whole 10 s (2026-10-26).
    'window.__cursorUnder=function(alpha){["__demoCursor","__demoCursorRing"].forEach(function(id){' +
    ' var e=document.getElementById(id);if(e)e.style.visibility=alpha>0.02?"hidden":"";});};' +
    'window.__cursorHide=function(){["__demoCursor","__demoCursorRing"].forEach(function(id){' +
    ' var e=document.getElementById(id);if(e)e.style.display="none";});};' +

    // ===========================================================================
    // THE BAND - an opaque title strip over the app's global header
    // ===========================================================================
    // Live Salesforce takes never film the global header (search, avatar,
    // org banner). __band(text, height) lays an opaque strip over the top
    // `height` px (a number, or a selector whose bottom edge sets it, e.g.
    // '#oneHeader'), re-measured on every call so the per-frame hook keeps
    // it exact. It registers itself in window.__covers, so the wording
    // preflight counts a label under it as covered, and raises __CAP so the
    // spotlight ring never runs under it.
    'window.__band=function(text,height){' +
    ' var h=height;if(typeof h==="string"){var src=document.querySelector(h);h=src?Math.round(src.getBoundingClientRect().bottom):0;}' +
    ' h=Math.max(0,Number(h)||0);' +
    ' var el=document.getElementById("__demoBand");' +
    ' if(!el){el=document.createElement("div");el.id="__demoBand";' +
    '  el.style.cssText="position:fixed;left:0;right:0;top:0;z-index:99995;pointer-events:none;display:flex;' +
    'align-items:center;padding:0 32px;box-sizing:border-box;background:rgb(6,10,18);color:#F2F7FC;' +
    'font:600 22px/1 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.2px";' +
    '  document.documentElement.appendChild(el);}' +
    ' if(text!==undefined&&text!==null&&el.textContent!==String(text))el.textContent=String(text);' +
    ' el.style.height=h+"px";el.style.display=h?"flex":"none";' +
    ' window.__covers=h?[{l:0,t:0,r:window.innerWidth,b:h}]:[];' +
    ' window.__CAP=Math.max(' + captionHeight + ',h);return h;};' +

    // ===========================================================================
    // A FULL-SCREEN VALUE SLIDE — for a beat that argues rather than shows
    // ===========================================================================
    'window.__slide=function(spec,alpha){' +
    ' var el=document.getElementById("__demoSlide");' +
    ' if(!el){el=document.createElement("div");el.id="__demoSlide";' +
    '  el.style.cssText="position:fixed;inset:0;z-index:99998;display:flex;' +
    'flex-direction:column;justify-content:center;padding:0 12vw;background:#070B12";' +
    '  var h=document.createElement("div");h.textContent=spec.title;' +
    '  h.style.cssText="font:700 66px/1.15 ui-sans-serif,system-ui,-apple-system,' +
    'sans-serif;color:#F2F7FC;margin-bottom:10px";el.appendChild(h);' +
    '  var sub=document.createElement("div");sub.textContent=spec.subtitle;' +
    '  sub.style.cssText="font:400 30px/1.3 ui-sans-serif,system-ui,-apple-system,' +
    'sans-serif;color:#5EC8D8;margin-bottom:52px";el.appendChild(sub);' +
    '  spec.points.forEach(function(p){' +
    '   var row=document.createElement("div");row.className="__demoSlideRow";' +
    '   row.style.cssText="display:flex;align-items:baseline;gap:22px;' +
    'margin-bottom:30px;opacity:0";' +
    '   var k=document.createElement("div");k.textContent=p[0];' +
    '   k.style.cssText="font:600 40px/1.25 ui-sans-serif,system-ui,-apple-system,' +
    'sans-serif;color:#F2F7FC;min-width:340px";' +
    '   var v=document.createElement("div");v.textContent=p[1];' +
    '   v.style.cssText="font:400 30px/1.35 ui-sans-serif,system-ui,-apple-system,' +
    'sans-serif;color:#9FB3C8";' +
    '   row.appendChild(k);row.appendChild(v);el.appendChild(row);});' +
    '  if(spec.footer){var f=document.createElement("div");f.textContent=spec.footer;' +
    '   f.style.cssText="position:absolute;left:12vw;bottom:7vh;font:400 24px/1.4 ' +
    'ui-sans-serif,system-ui,-apple-system,sans-serif;color:#5F7488";' +
    '   el.appendChild(f);}' +
    '  document.body.appendChild(el);}' +
    ' el.style.opacity=String(alpha);__cursorUnder(alpha);};' +
    'window.__slideRow=function(i,alpha){' +
    ' var rows=document.querySelectorAll("#__demoSlide .__demoSlideRow");' +
    ' if(rows[i]) rows[i].style.opacity=String(alpha);};' +
    'window.__slideGone=function(){' +
    ' var el=document.getElementById("__demoSlide"); if(el) el.remove();};' +

    // ===========================================================================
    // A CLOSING CARD — full-frame CTA
    // ===========================================================================
    'window.__cta=function(lines,alpha){' +
    ' var el=document.getElementById("__demoCta");' +
    ' if(!el){el=document.createElement("div");el.id="__demoCta";' +
    '  el.style.cssText="position:fixed;inset:0;z-index:100000;display:flex;' +
    'flex-direction:column;align-items:center;justify-content:center;gap:26px;' +
    'background:#070B12;text-align:center;padding:0 8vw";' +
    '  lines.forEach(function(L){' +
    '   var d=document.createElement("div");' +
    '   d.textContent=L.text; d.style.cssText=L.css; el.appendChild(d);' +
    '  });' +
    '  document.body.appendChild(el);}' +
    ' el.style.opacity=String(alpha);__cursorUnder(alpha);' +
    ' el.style.transform="translateY("+((1-alpha)*14).toFixed(2)+"px)";};'
  );
}

module.exports = { buildCameraClientJs: buildCameraClientJs };

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
 */
function buildCameraClientJs(config) {
  const pageSelector = JSON.stringify((config && config.pageSelector) || '.demo-page');
  const captionHeight = (config && config.captionHeight) || 104;
  const margin = (config && config.margin) || 48;

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
    '  el.style.cssText="position:fixed;left:0;right:0;top:0;z-index:99999;' +
    'padding:26px 48px;background:rgba(6,10,18,.97);border-bottom:2px solid rgba(120,200,220,.45);' +
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
    ' var maxY=Math.max(0,(pr.bottom-(H-40))/s);' +
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
    'window.__spot=function(sel,a){' +
    ' var el=document.getElementById("__demoSpot");' +
    ' if(!el){el=document.createElement("div");el.id="__demoSpot";' +
    '  el.style.cssText="position:fixed;z-index:99990;pointer-events:none;border-radius:12px";' +
    '  document.documentElement.appendChild(el);}' +
    ' if(sel){var t=(typeof sel==="string")?document.querySelector(sel):sel;' +
    '  if(t){var r=t.getBoundingClientRect();var pad=12;var M=window.__M;' +
    '   var L=Math.max(M,r.left-pad);' +
    '   var T=Math.max(window.__CAP+M/2,r.top-pad);' +
    '   var Rt=Math.min(window.innerWidth-M,r.right+pad);' +
    '   var Bt=Math.min(window.innerHeight-M,r.bottom+pad);' +
    '   el.style.left=Math.round(L)+"px";el.style.top=Math.round(T)+"px";' +
    '   el.style.width=Math.round(Math.max(0,Rt-L))+"px";' +
    '   el.style.height=Math.round(Math.max(0,Bt-T))+"px";}}' +
    ' el.style.boxShadow="0 0 0 9999px rgba(4,8,14,"+(0.60*a).toFixed(3)+"),"+' +
    '  "inset 0 0 0 2px rgba(94,200,216,"+(0.85*a).toFixed(3)+"),"+' +
    '  "0 0 44px 6px rgba(94,200,216,"+(0.20*a).toFixed(3)+")";};' +
    'window.__spotOff=function(){var el=document.getElementById("__demoSpot");' +
    ' if(el){el.style.boxShadow="none";}};' +

    // A small explicit highlight for inline things (a link, a button) that
    // do not warrant a full spotlight.
    'window.__flash=function(sel,v){' +
    ' Array.prototype.forEach.call(document.querySelectorAll(sel),function(el){' +
    '  el.style.outline=v>0?("3px solid rgba(94,200,216,"+v+")"):"";' +
    '  el.style.outlineOffset="3px";' +
    '  el.style.borderRadius="6px";});};' +

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
    ' el.style.opacity=String(alpha);};' +
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
    ' el.style.opacity=String(alpha);' +
    ' el.style.transform="translateY("+((1-alpha)*14).toFixed(2)+"px)";};'
  );
}

module.exports = { buildCameraClientJs: buildCameraClientJs };

'use strict';
/**
 * liveKit.js — the in-page helpers every frame of a LIVE app needs. NODE-ONLY
 * (this file builds a string of client-side JS; nothing in it runs here).
 *
 * ===========================================================================
 * WHY A SEPARATE KIT
 * ===========================================================================
 * The camera client (cameraClient.js) belongs to the TOP frame: it owns the
 * caption, spotlight, cursor and camera overlays. A live Salesforce Setup
 * page puts its content in an iframe on a different site, which a top-frame
 * script cannot reach. So the lookups, label checks and display-only
 * redaction live here, in a kit that frames.js injects into EVERY frame's
 * own JavaScript context (and that the camera client also includes, so the
 * top frame has it too).
 *
 * The kit is a real function serialized with toString(), so it can be unit
 * tested in a vm with a tiny DOM. It must stay self-contained: no closures
 * over this module, and nothing runs at install time except definitions.
 *
 * ===========================================================================
 * WHAT IT DEFINES (all on window)
 * ===========================================================================
 *   __q(path, text)          shadow-piercing query ('host >>> .sel')
 *   __findText(label, o)     the element whose visible label IS `label`
 *   __labelCheck(labels)     per label: visible | covered | hidden | missing
 *   __visibleTexts(max)      short visible labels, for "closest on screen"
 *   __isVisible(el)          rendered, in the viewport, not hidden
 *   __rectOf(el)             rounded viewport rect
 *   __redact(pairs, o)       display-only redaction (+ email masking)
 *   __redactAudit()          what the stored redaction would still change
 *   __neverShow()            counts of never-show patterns in visible text
 *   __busy()                 a Lightning spinner is on screen
 *
 * Every function counts or returns elements and rects; nothing here returns
 * the text it found sensitive, so a log can never echo it.
 */
function liveKit(win) {
  var doc = win.document;
  var OWN = /^__demo/;

  var norm = function (s) {
    return String(s === undefined || s === null ? '' : s).replace(/[\s ]+/g, ' ').trim();
  };
  win.__norm = norm;

  // Element-only walk across open shadow roots (including LWC synthetic
  // shadow). Skips the demo's own overlays. `fn` returning false prunes.
  win.__deepEach = function (fn, root) {
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 1) {
        if (OWN.test(node.id || '')) return;
        if (fn(node) === false) return;
        if (node.shadowRoot) walk(node.shadowRoot);
      }
      var kids = node.children || node.childNodes || [];
      for (var i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) walk(kids[i]);
    }(root || doc.documentElement));
  };

  win.__q = function (path, text) {
    var parts = String(path).split(/\s*>>>\s*/), scope = doc, el = null;
    for (var i = 0; i < parts.length; i++) {
      if (!scope) return null;
      if (i === parts.length - 1 && text !== undefined && text !== null) {
        el = Array.prototype.filter.call(scope.querySelectorAll(parts[i]), function (n) {
          return (n.textContent || '').indexOf(text) !== -1;
        })[0] || null;
      } else {
        el = scope.querySelector(parts[i]);
      }
      if (!el) return null;
      scope = (i < parts.length - 1) ? (el.shadowRoot || el) : null;
    }
    return el;
  };

  // The composed parent: through a shadow root to its host.
  var up = function (n) {
    var p = n.parentNode;
    return p && p.nodeType === 11 && p.host ? p.host : p;
  };
  // The RENDERED parent: a slotted node paints inside its slot (in the
  // host's shadow tree), not under its light-DOM parent. Clipping follows
  // this tree; Lightning's list-view menu is slotted into a popup.
  var flatUp = function (n) { return n.assignedSlot || up(n); };
  var insideOf = function (el, sel) {
    for (var n = up(el); n && n.nodeType === 1; n = up(n)) if (n.matches && n.matches(sel)) return true;
    return false;
  };

  var INTERACTIVE = /^(A|BUTTON|INPUT|SELECT|OPTION|TEXTAREA|LABEL|SUMMARY)$/;
  var ROLES = /^(button|link|option|menuitem|tab|treeitem|checkbox|radio|combobox|searchbox|textbox|switch)$/;
  var isInteractive = function (el) {
    return INTERACTIVE.test(el.tagName || '') || ROLES.test((el.getAttribute && el.getAttribute('role')) || '');
  };

  // The names a person reads on screen for an element: its text, and for
  // icon buttons and fields, the accessible name, title or placeholder. A
  // text field's VALUE is excluded on purpose: the take types a label into
  // a search box, and that must not count as the app showing it.
  var namesOf = function (el) {
    var out = [];
    var add = function (v) { v = norm(v); if (v) out.push(v); };
    var tag = el.tagName || '';
    if (tag === 'INPUT') {
      var type = String(el.type || el.getAttribute && el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset') add(el.value);
      add(el.placeholder);
    } else if (tag === 'TEXTAREA') {
      add(el.placeholder);
    } else {
      add(el.textContent);
    }
    if (el.getAttribute) { add(el.getAttribute('aria-label')); add(el.getAttribute('title')); add(el.getAttribute('alt')); }
    return out;
  };
  win.__namesOf = namesOf;

  var escapeRe = function (s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  // Contained as a whole phrase: "Permission Set" is NOT in "Permission Sets".
  var containsPhrase = function (hay, label) {
    if (hay.indexOf(label) === -1) return false;
    return new RegExp('(^|[^A-Za-z0-9])' + escapeRe(label) + '($|[^A-Za-z0-9])').test(hay);
  };

  win.__rectOf = function (el) {
    var r = el.getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
  };

  // The part of the viewport a box can paint into: the intersection of
  // the clipping ancestors (overflow other than visible) in its containing-
  // block chain. A 0px-wide grid column with overflow:hidden (Setup lists
  // keep a hidden record-ID column this way) leaves its cells a real box
  // but no visible pixels. An absolutely positioned box escapes static
  // ancestors up to its positioned container, and a fixed one escapes all:
  // Lightning's list-view menu hangs out of an overflow:hidden header.
  // `memo` (a Map) caches per ancestor and mode within one pass.
  var VIEWPORT = function () { return { l: 0, t: 0, r: win.innerWidth, b: win.innerHeight }; };
  var styleOf = function (node) { return win.getComputedStyle ? win.getComputedStyle(node) : null; };
  var clipOf = function (node, absMode, memo) {
    if (!node || node.nodeType !== 1) return VIEWPORT();
    var key = absMode ? 'a' : 'n';
    var slot = memo && memo.get(node);
    if (slot && slot[key]) return slot[key];
    var cs = styleOf(node) || {};
    var pos = cs.position || 'static';
    var out;
    if (absMode && pos === 'static') {
      out = clipOf(flatUp(node), true, memo);
    } else {
      out = pos === 'fixed' ? VIEWPORT() : clipOf(flatUp(node), pos === 'absolute', memo);
      if ((cs.overflowX && cs.overflowX !== 'visible') || (cs.overflowY && cs.overflowY !== 'visible')) {
        var r = node.getBoundingClientRect();
        out = { l: Math.max(out.l, r.left), t: Math.max(out.t, r.top), r: Math.min(out.r, r.right), b: Math.min(out.b, r.bottom) };
      }
    }
    if (memo) { slot = slot || {}; slot[key] = out; memo.set(node, slot); }
    return out;
  };
  win.__isVisible = function (el, memo) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= win.innerHeight || r.left >= win.innerWidth) return false;
    if (el.checkVisibility) {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    } else if (win.getComputedStyle) {
      var cs = win.getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    }
    var own = (styleOf(el) || {}).position || 'static';
    var c = own === 'fixed' ? VIEWPORT() : clipOf(flatUp(el), own === 'absolute', memo);
    return Math.min(c.r, r.right) - Math.max(c.l, r.left) >= 2 && Math.min(c.b, r.bottom) - Math.max(c.t, r.top) >= 2;
  };

  // Something else on top of the element's center (a modal backdrop, the
  // demo's band over the global header). Hit testing skips the demo's
  // overlays (pointer-events:none), so only real page layers count, plus the
  // explicit cover rects the band registers in window.__covers.
  win.__isCovered = function (el) {
    var r = el.getBoundingClientRect();
    var cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    var covers = win.__covers || [];
    for (var i = 0; i < covers.length; i++) {
      var c = covers[i];
      if (r.top >= c.t && r.bottom <= c.b && r.left >= c.l && r.right <= c.r) return true;
    }
    if (!doc.elementFromPoint) return false;
    var hit = doc.elementFromPoint(cx, cy);
    while (hit && hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
      var inner = hit.shadowRoot.elementFromPoint(cx, cy);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit) return false;
    var contains = function (a, b) {          // composed: does `a` contain `b`?
      for (var n = b; n; n = n.parentNode || n.host) if (n === a) return true;
      return false;
    };
    return !(contains(el, hit) || contains(hit, el));
  };

  // Every element whose screen name matches `label`, best first.
  //   o.exact (default true) - the whole name equals the label; false also
  //                            accepts the label as a phrase inside a name.
  //   o.selector             - restrict to elements matching this selector.
  //   o.visible (default true) - only elements a viewer can see.
  //   o.within               - only inside a (composed) ancestor matching
  //                            this selector: the App Launcher's result
  //                            'Admin / Setup', not the nav tab of the
  //                            same name.
  // Ranking: exact before phrase, interactive (link, button, option…)
  // before plain text, then the smallest box: the thing a person would
  // point at, not the page section that happens to contain the words.
  win.__findTextAll = function (label, o) {
    o = o || {};
    label = norm(label);
    var exactOnly = o.exact !== false;
    var wantVisible = o.visible !== false;
    var hits = [];
    win.__deepEach(function (el) {
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return false;
      if (o.selector && !(el.matches && el.matches(o.selector))) return;
      if (o.within && !insideOf(el, o.within)) return;
      // Match the element's own names (field value/placeholder, aria-label,
      // title, alt) and its text separately.
      var tag = el.tagName || '';
      var textName = (tag === 'INPUT' || tag === 'TEXTAREA') ? null : norm(el.textContent);
      var names = namesOf(el), rankAttr = -1, rankText = -1;
      var rankOf = function (n) {
        if (n === label) return 0;
        // Drawn uppercase by CSS ("Owner" shown as "OWNER"): match what the
        // viewer reads. Checked only on a case-insensitive hit, so the
        // style lookup stays rare.
        if (n.length === label.length && n.toLowerCase() === label.toLowerCase() && label === label.toUpperCase() && win.getComputedStyle) {
          var tt = (win.getComputedStyle(el) || {}).textTransform;
          if (tt === 'uppercase') return 0;
        }
        return (!exactOnly && n.length <= 400 && containsPhrase(n, label)) ? 1 : -1;
      };
      for (var i = 0; i < names.length; i++) {
        if (textName !== null && i === 0 && names[0] === textName) continue;
        var ra = rankOf(names[i]);
        if (ra >= 0 && (rankAttr < 0 || ra < rankAttr)) rankAttr = ra;
      }
      if (textName) rankText = rankOf(textName);
      var rank = rankAttr < 0 ? rankText : (rankText < 0 ? rankAttr : Math.min(rankAttr, rankText));
      if (rank < 0) return;
      // A text match belongs to the DEEPEST element holding the whole label;
      // otherwise <body> "contains" every sentence on the page, and a wrapper
      // around a scrolled-away link still "shows" its text. An element that
      // is NAMED by the label (an icon button's title) keeps its match, and
      // so does one the caller picked by kind (o.selector: the <a> around a
      // letter's <span>).
      if (!o.selector && (rankAttr < 0 || rankAttr > rankText)) {
        var kids = Array.prototype.slice.call(el.children || []);
        if (el.shadowRoot) kids = kids.concat(Array.prototype.slice.call(el.shadowRoot.children || []));
        for (var k = 0; k < kids.length; k++) if (containsPhrase(norm(kids[k].textContent), label)) return;
      }
      if (wantVisible && !win.__isVisible(el)) return;
      var r = el.getBoundingClientRect();
      hits.push({ el: el, rank: rank, inter: isInteractive(el) ? 0 : 1, area: r.width * r.height });
    });
    // Among exact matches, an interactive ANCESTOR of the smallest match is
    // the better subject (the link row, not the <mark> inside it).
    hits.sort(function (a, b) { return a.rank - b.rank || a.inter - b.inter || a.area - b.area; });
    return hits.map(function (h) { return h.el; });
  };
  // Text often sits deep inside the thing a person clicks: the App
  // Launcher's "Admin / Setup" is a <b> inside a rich-text component's shadow
  // root inside the result row (an <a role="option">). The subject for a
  // click or a spotlight is that row. Only a NEAR interactive ancestor
  // counts (8 levels, at most 30x the text's area and a quarter of the
  // screen), so a label never promotes to a whole panel.
  win.__promote = function (el) {
    if (!el || isInteractive(el)) return el;
    var r0 = el.getBoundingClientRect(), a0 = Math.max(1, r0.width * r0.height);
    var vp = win.innerWidth * win.innerHeight;
    for (var n = up(el), i = 0; n && n.nodeType === 1 && i < 8; n = up(n), i++) {
      if (!isInteractive(n)) continue;
      var r = n.getBoundingClientRect(), a = r.width * r.height;
      return (a <= a0 * 30 && a <= vp * 0.25 && win.__isVisible(n)) ? n : el;
    }
    return el;
  };
  win.__findText = function (label, o) {
    var all = win.__findTextAll(label, o);
    var el = all[(o && o.nth) || 0] || null;
    // A subject picked by kind (o.selector) is already the element meant.
    return o && (o.promote === false || o.selector) ? el : win.__promote(el);
  };

  // Wording preflight: where does each quoted label stand on THIS frame?
  //   visible  - a viewer can read it (exact name, or as a whole phrase)
  //   covered  - rendered, but something sits on top of it
  //   hidden   - in the DOM, not visible (collapsed, off screen, display:none)
  //   missing  - nowhere in this frame
  win.__labelCheck = function (labels) {
    return labels.map(function (label) {
      var all = win.__findTextAll(label, { exact: false, visible: false });
      var status = 'missing', rect = null;
      for (var i = 0; i < all.length; i++) {
        if (!win.__isVisible(all[i])) { if (status === 'missing') status = 'hidden'; continue; }
        if (win.__isCovered(all[i])) { if (status !== 'visible') status = 'covered'; continue; }
        status = 'visible'; rect = win.__rectOf(all[i]); break;
      }
      return { label: norm(label), status: status, rect: rect };
    });
  };

  // Short visible names (buttons, links, headings, field hints), for the
  // "closest on screen" column of a preflight diff.
  win.__visibleTexts = function (max) {
    var seen = {}, out = [];
    win.__deepEach(function (el) {
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return false;
      if (out.length >= (max || 400)) return false;
      var names = namesOf(el);
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n.length < 2 || n.length > 80 || seen[n]) continue;
        if (!win.__isVisible(el)) return;
        seen[n] = 1; out.push(n);
      }
    });
    return out;
  };

  // True while a Lightning/SLDS spinner is on screen: a zero-film wait
  // should run until the page is done, so the cut never lands on a spinner.
  win.__busy = function () {
    var busy = false;
    win.__deepEach(function (el) {
      if (busy) return false;
      var cls = (el.getAttribute && el.getAttribute('class')) || '';
      if ((el.tagName === 'LIGHTNING-SPINNER' || /(^|\s)slds-spinner(\s|$)/.test(cls)) && win.__isVisible(el)) busy = true;
    });
    return busy;
  };

  // ===========================================================================
  // DISPLAY-ONLY REDACTION, re-applied before every frame
  // ===========================================================================
  // __redact([[find, replace], ...], {maskEmails, mask, patterns}) stores the
  // rules; __redact() re-applies them. Text nodes and input values across the
  // document and every open shadow root, in the disposable capture browser
  // only. maskEmails replaces anything shaped like an email address
  // (Salesforce usernames are email-shaped) with `mask`, so a fictional
  // user's username never reaches a frame either.
  // Inputs whose value is DRAWN on screen. A checkbox's value (Setup lists
  // put the record id there) or a hidden field's is never seen, and must
  // never be rewritten either: redaction is display-only.
  var SHOWN = /^(text|search|email|url|tel|number|button|submit|reset|)$/;
  var showsValue = function (node) {
    if (node.tagName === 'TEXTAREA') return true;
    return SHOWN.test(String(node.type || (node.getAttribute && node.getAttribute('type')) || '').toLowerCase());
  };
  var EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';
  // `all` also visits inputs whose value is not drawn (the password check).
  win.__redactWalk = function (fn, all) {
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 3) { fn(node, 'text'); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11 && node.nodeType !== 9) return;
      if (OWN.test(node.id || '')) return;
      if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
      if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && (all || showsValue(node))) fn(node, 'value');
      if (node.shadowRoot) walk(node.shadowRoot);
      var kids = node.childNodes; for (var i = 0; i < kids.length; i++) walk(kids[i]);
    }(doc.documentElement));
  };
  var allowed = function () {
    return ((win.__redactOpts && win.__redactOpts.allowEmails) || []).map(function (e) { return String(e).toLowerCase(); });
  };
  var rules = function () {
    var out = (win.__redactPairs || []).map(function (p) { return { find: p[0], to: p[1] }; });
    var o = win.__redactOpts || {};
    var pats = (o.patterns || []).slice();
    pats.forEach(function (p) { out.push({ re: new RegExp(p[0], p[1] || 'g'), to: p[2] }); });
    // Public addresses the take may show (the app's own support address in
    // its footer): opts.allowEmails, matched case-insensitively.
    if (o.maskEmails) out.push({ re: new RegExp(EMAIL, 'g'), to: o.mask || '••••••', allow: allowed() });
    return out;
  };
  var applyRules = function (v, R) {
    var out = v;
    for (var i = 0; i < R.length; i++) {
      if (R[i].re && R[i].allow) {
        var A = R[i].allow, to = R[i].to; R[i].re.lastIndex = 0;
        out = out.replace(R[i].re, function (m) { return A.indexOf(m.toLowerCase()) !== -1 ? m : to; });
      } else if (R[i].re) { R[i].re.lastIndex = 0; out = out.replace(R[i].re, R[i].to); }
      else if (out.indexOf(R[i].find) !== -1) out = out.split(R[i].find).join(R[i].to);
    }
    return out;
  };
  // Display-only HIDING for whole sections and columns a take must never
  // show, re-applied with the redaction before every frame:
  //   {text: 'Login History', closest: '.bRelatedList'} hides the nearest
  //     container (or the element itself) of every element showing the text;
  //   {column: 'Last Login'} hides that header cell and its column's cells.
  // Returns how many elements it hid this pass.
  var hideAll = function () {
    var H = (win.__redactOpts && win.__redactOpts.hide) || [], n = 0;
    var hide = function (el) {
      if (el && el.style && el.style.visibility !== 'hidden') { el.style.setProperty('visibility', 'hidden', 'important'); n++; }
    };
    H.forEach(function (h) {
      if (h.column) {
        win.__findTextAll(h.column, { exact: false, visible: false }).forEach(function (th) {
          if (th.tagName !== 'TH' && th.tagName !== 'TD') th = th.closest ? th.closest('th,td') : null;
          if (!th) return;
          var table = th.closest ? th.closest('table') : null, idx = th.cellIndex;
          hide(th);
          if (table && idx >= 0) Array.prototype.forEach.call(table.rows || [], function (row) { hide(row.cells && row.cells[idx]); });
        });
      } else if (h.text) {
        win.__findTextAll(h.text, { exact: false, visible: false }).forEach(function (el) {
          hide((h.closest && el.closest && el.closest(h.closest)) || el);
        });
      }
    });
    return n;
  };
  win.__redact = function (pairs, o) {
    if (pairs) win.__redactPairs = pairs.filter(function (p) { return p && p[0]; });
    if (o) win.__redactOpts = o;
    var hidden = hideAll();
    var R = rules(), n = hidden;
    if (!R.length) return n;
    win.__redactWalk(function (node, kind) {
      var key = kind === 'text' ? 'nodeValue' : 'value', v = node[key];
      if (v) { var out = applyRules(v, R); if (out !== v) { node[key] = out; n++; } }
      if (kind === 'value' && node.placeholder) {
        var ph = applyRules(node.placeholder, R);
        if (ph !== node.placeholder) { node.placeholder = ph; n++; }
      }
    });
    return n;
  };
  win.__redactAudit = function () {
    var R = rules(), hits = 0;
    if (!R.length) return 0;
    win.__redactWalk(function (node, kind) {
      var v = (kind === 'text' ? node.nodeValue : node.value) || '';
      if (v && applyRules(v, R) !== v) hits++;
    });
    return hits;
  };

  // ===========================================================================
  // NEVER-SHOW AUDIT (strategy §3): counts only, over VISIBLE text
  // ===========================================================================
  // A count per category, never the matched text. Runs after redaction, so a
  // nonzero count is a leak the redaction does not cover: stop the take.
  var NEVER = {
    email: new RegExp(EMAIL),
    url: /\bhttps?:\/\/|\b[\w-]+(?:\.[\w-]+)*\.(?:force|salesforce|salesforce-setup|visualforce|documentforce|cloudforce)\.com\b/i,
    orgId: /\b00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?\b/,
    sensitivePage: /\b(Consumer Secret|Consumer Key|Security Token|Session ID|Organization ID|Verification Code|Login History|Client Secret|Forgot Your Password|Verify Your Identity|Remember me|Login As|Log in as)\b/,
  };
  // 15/18-character Salesforce ids: key prefix, then mostly digits and mixed
  // case. Ordinary words never carry three digits in a 15-char token.
  var RECORD_ID = /\b[0a-zA-Z][0-9A-Za-z]{14}(?:[0-9A-Za-z]{3})?\b/g;
  var looksLikeId = function (s) {
    var m = s.match(RECORD_ID) || [];
    for (var i = 0; i < m.length; i++) if ((m[i].match(/[0-9]/g) || []).length >= 3 && /[A-Za-z]/.test(m[i])) return true;
    return false;
  };
  win.__neverShow = function () {
    var out = { email: 0, url: 0, orgId: 0, recordId: 0, sensitivePage: 0, passwordField: 0 };
    var vis = typeof Map === 'function' ? new Map() : null;
    var clips = typeof Map === 'function' ? new Map() : null;
    var seenVisible = function (el) {
      if (!el) return false;
      if (vis && vis.has(el)) return vis.get(el);
      var v = win.__isVisible(el, clips);
      if (vis) vis.set(el, v);
      return v;
    };
    var allow = allowed();
    var EMAILS = new RegExp(EMAIL, 'g');
    var scan = function (s) {
      if (!s) return;
      for (var k in NEVER) {
        if (k === 'email') {
          var m = s.match(EMAILS) || [];
          if (m.some(function (e) { return allow.indexOf(e.toLowerCase()) === -1; })) out.email++;
        } else if (NEVER[k].test(s)) out[k]++;
      }
      if (looksLikeId(s)) out.recordId++;
    };
    win.__redactWalk(function (node, kind) {
      if (kind === 'text') {
        var p = node.parentNode;
        while (p && p.nodeType !== 1) p = p.host || p.parentNode;
        if (seenVisible(p)) scan(node.nodeValue);
      } else if (seenVisible(node)) {
        if (String(node.type || '').toLowerCase() === 'password') out.passwordField++;
        else if (showsValue(node)) scan(node.value);
      }
    }, true);
    return out;
  };

  win.__dsKit = 1;
  return true;
}

/** The kit as an injectable expression. Safe to evaluate more than once. */
function buildLiveKitJs() {
  return '(' + liveKit.toString() + ')(window);';
}

module.exports = { buildLiveKitJs: buildLiveKitJs, liveKit: liveKit };

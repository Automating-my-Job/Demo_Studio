'use strict';
/**
 * frames.js — every frame of a live page, as something the recorder can
 * evaluate in and measure. NODE-ONLY.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * Salesforce Setup renders its classic pages (Permission Sets, Manage
 * Assignments, Object Settings) inside an iframe served from a different
 * site than Lightning. A top-frame script cannot read across that boundary,
 * and under Chrome's site isolation the iframe even runs in its own renderer
 * process: an "out-of-process iframe" (OOPIF) with its own DevTools target.
 * So `Runtime.evaluate` on the page reaches none of it, the spotlight cannot
 * measure it, and redaction never touches it.
 *
 * This registry follows both kinds of child frame:
 *   - same-process frames: extra execution contexts on the page's session;
 *   - OOPIFs: auto-attached targets (`Target.setAutoAttach`, flattened), each
 *     with its own sessionId and contexts.
 * It injects the live kit (liveKit.js) into any frame that lacks it, keeps
 * the redaction rules in Node memory and re-applies them in every frame, and
 * maps a rect measured inside a frame into TOP-frame viewport pixels (the
 * frame owner's content box, via DOM.getFrameOwner + DOM.getBoxModel,
 * composed up the frame chain), which is where the spotlight and cursor
 * overlays live and where CDP mouse events are aimed.
 *
 * Nothing here prints a frame URL: Setup URLs carry the org's My Domain.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GONE = /Cannot find context|Execution context was destroyed|Inspected target navigated|No target with given id|Session with given id not found|Target closed|not found for given/i;

/** True when an error only means "that frame went away", not a bug. */
function isGoneError(err) {
  return GONE.test(String(err && err.message || err));
}

/**
 * Composes a frame-local offset with its parent's, both {x, y, s}: the
 * parent maps parent-frame px to top px; `local` is the owner iframe's
 * content-box origin in the parent frame, and the child's own scale.
 */
function composeOffset(parent, local) {
  return { x: parent.x + local.x * parent.s, y: parent.y + local.y * parent.s, s: parent.s * local.s };
}

/** A frame-local rect {l,t,r,b} mapped to top-frame px. */
function toTopRect(rect, off) {
  return {
    l: off.x + rect.l * off.s, t: off.y + rect.t * off.s,
    r: off.x + rect.r * off.s, b: off.y + rect.b * off.s,
  };
}

class FrameRegistry {
  /**
   * @param {object} client - a Cdp connected to the PAGE target.
   * @param {{kitJs: string}} opts - liveKit.js's buildLiveKitJs() output.
   */
  constructor(client, opts) {
    this.client = client;
    this.kitJs = (opts && opts.kitJs) || '';
    this.contexts = new Map();   // key -> {key, sid, id, frameId}
    this.sessions = new Map();   // child sid -> {targetId, parentSid}
    this.parents = new Map();    // frameId -> parentFrameId
    this.topFrameId = null;
    this.redaction = null;       // {pairs, opts}; held in memory only
  }

  /** Registers listeners. Call BEFORE Runtime.enable on the page session. */
  listen() {
    const c = this.client;
    c.on('Runtime.executionContextCreated', (p, sid) => {
      const ctx = p && p.context;
      const aux = (ctx && ctx.auxData) || {};
      if (!ctx || aux.isDefault === false || (aux.type && aux.type !== 'default')) return;
      const key = (sid || '') + ':' + ctx.id;
      this.contexts.set(key, { key: key, sid: sid || null, id: ctx.id, frameId: aux.frameId || null });
    });
    c.on('Runtime.executionContextDestroyed', (p, sid) => {
      this.contexts.delete((sid || '') + ':' + p.executionContextId);
    });
    c.on('Runtime.executionContextsCleared', (p, sid) => {
      for (const [k, v] of this.contexts) if (v.sid === (sid || null)) this.contexts.delete(k);
    });
    c.on('Page.frameAttached', (p) => { if (p.parentFrameId) this.parents.set(p.frameId, p.parentFrameId); });
    c.on('Page.frameDetached', (p) => { if (p.reason !== 'swap') this.parents.delete(p.frameId); });
    c.on('Target.attachedToTarget', (p, parentSid) => this._attached(p, parentSid));
    c.on('Target.detachedFromTarget', (p) => {
      this.sessions.delete(p.sessionId);
      for (const [k, v] of this.contexts) if (v.sid === p.sessionId) this.contexts.delete(k);
    });
  }

  /** Learns the top frame and starts auto-attaching OOPIFs. */
  async enable() {
    const tree = await this.client.send('Page.getFrameTree');
    this.topFrameId = tree.frameTree.frame.id;
    this._learnTree(tree.frameTree);
    await this.client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  }

  _learnTree(node) {
    (node.childFrames || []).forEach((ch) => {
      this.parents.set(ch.frame.id, node.frame.id);
      this._learnTree(ch);
    });
  }

  _attached(p, parentSid) {
    const sid = p.sessionId;
    const info = p.targetInfo || {};
    if (info.type !== 'iframe') {
      // Workers and the like: let them run; nothing to film there.
      if (p.waitingForDebugger) this.client.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
      return;
    }
    this.sessions.set(sid, { targetId: info.targetId, parentSid: parentSid || null });
    const send = (m, params) => this.client.send(m, params || {}, sid);
    Promise.all([
      send('Page.enable'),
      send('Runtime.enable'),
      send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
    ]).then(() => send('Page.getFrameTree'))
      .then((t) => { if (t && t.frameTree) this._learnTree(t.frameTree); })
      .catch(() => { /* detached while enabling: its contexts never arrive */ })
      .then(() => { if (p.waitingForDebugger) return send('Runtime.runIfWaitingForDebugger'); })
      .catch(() => {});
  }

  isTop(ctx) {
    return !!ctx && !ctx.sid && ctx.frameId === this.topFrameId;
  }

  /** Default-world contexts, top frame first, then children in arrival order. */
  list() {
    const all = Array.from(this.contexts.values());
    return all.filter((c) => this.isTop(c)).concat(all.filter((c) => !this.isTop(c)));
  }

  top() { return this.list().find((c) => this.isTop(c)) || null; }
  children() { return this.list().filter((c) => !this.isTop(c)); }

  /** Evaluates in one frame; returns the value (by value). Throws on page errors. */
  async evaluate(ctx, expression, o) {
    const r = await this.client.send('Runtime.evaluate', {
      expression: expression, contextId: ctx.id, returnByValue: true,
      awaitPromise: !!(o && o.awaitPromise),
    }, ctx.sid || undefined);
    if (r && r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('frame evaluate failed: ' + (d.exception && d.exception.description
        ? String(d.exception.description).split('\n')[0] : d.text));
    }
    return r && r.result ? r.result.value : undefined;
  }

  /** Injects the kit (and the redaction rules) into a frame that lacks it. */
  async ensureKit(ctx) {
    const has = await this.evaluate(ctx, '!!window.__dsKit');
    if (has) return false;
    await this.evaluate(ctx, this.kitJs + ';true');
    if (this.redaction) await this.evaluate(ctx, this._redactCall(true));
    return true;
  }

  /** Stores redaction rules in memory; every frame gets them before each shot. */
  setRedaction(pairs, opts) {
    this.redaction = { pairs: (pairs || []).filter((p) => p && p[0]), opts: opts || {} };
  }

  _redactCall(withRules) {
    if (!withRules) return '__redact()';
    return '__redact(' + JSON.stringify(this.redaction.pairs) + ',' + JSON.stringify(this.redaction.opts) + ')';
  }

  /**
   * Evaluates `fnOfCtx(ctx)` (an expression string) in every frame, with the
   * kit ensured first. A frame that disappears mid-call is retried from a
   * fresh list (it is navigating; its replacement must be covered too).
   * Returns [{ctx, value}].
   */
  async evalAll(fnOfCtx, o) {
    const rounds = (o && o.rounds) || 4;
    let pending = this.list();
    const done = new Set();
    const out = [];
    for (let round = 0; round < rounds && pending.length; round++) {
      const failed = [];
      for (const ctx of pending) {
        if (done.has(ctx.key)) continue;
        try {
          await this.ensureKit(ctx);
          out.push({ ctx: ctx, value: await this.evaluate(ctx, fnOfCtx(ctx)) });
          done.add(ctx.key);
        } catch (err) {
          if (!isGoneError(err)) throw err;
          failed.push(ctx);
        }
      }
      if (!failed.length) break;
      await sleep(40);
      // Contexts that are really gone are dropped by now; new ones appear.
      pending = this.list().filter((c) => !done.has(c.key));
    }
    return out;
  }

  /**
   * Re-applies the stored redaction in every frame. Called before every
   * captured frame. Returns the number of nodes it changed.
   */
  async redactAll() {
    if (!this.redaction) return 0;
    const res = await this.evalAll(() =>
      '(window.__redactPairs===undefined?' + this._redactCall(true) + ':__redact())');
    return res.reduce((n, r) => n + (Number(r.value) || 0), 0);
  }

  /**
   * Attaches any iframe target Chrome knows about that we have no session
   * for. Auto-attach should never miss one; this is the belt to its braces,
   * run before every audit.
   */
  async sweep() {
    const res = await this.client.send('Target.getTargets');
    const known = new Set(Array.from(this.sessions.values()).map((s) => s.targetId));
    for (const t of (res && res.targetInfos) || []) {
      if (t.type !== 'iframe' || known.has(t.targetId)) continue;
      try { await this.client.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }); } catch (err) { /* gone */ }
    }
  }

  /**
   * Visible top-level iframes (40px or larger) that no tracked context sits
   * in. Each one is a frame redaction cannot reach: the audit must read 0.
   */
  async untrackedFrames() {
    const top = this.top();
    if (!top) return 0;
    await this.ensureKit(top);
    const boxes = await this.evaluate(top, '(function(){var out=[];__deepEach(function(e){' +
      'if(e.tagName!=="IFRAME"||!__isVisible(e))return;var r=e.getBoundingClientRect();' +
      'if(e.clientWidth>=40&&e.clientHeight>=40)out.push({l:r.left+e.clientLeft,t:r.top+e.clientTop});});return out;})()');
    if (!boxes || !boxes.length) return 0;
    const offs = [];
    for (const ctx of this.children()) {
      try { offs.push(await this.offset(ctx)); } catch (err) { /* not rendered */ }
    }
    return boxes.filter((b) => !offs.some((o) => Math.abs(o.x - b.l) <= 2 && Math.abs(o.y - b.t) <= 2)).length;
  }

  /** Sum of the never-show counts across frames (after redaction). */
  async neverShowAll() {
    await this.sweep();
    const res = await this.evalAll(() => '__neverShow()');
    const total = {};
    res.forEach((r) => Object.keys(r.value || {}).forEach((k) => { total[k] = (total[k] || 0) + r.value[k]; }));
    total.redactLeft = (await this.evalAll(() => '__redactAudit()')).reduce((n, r) => n + (Number(r.value) || 0), 0);
    total.untrackedFrame = await this.untrackedFrames();
    return total;
  }

  /** The owning <iframe>'s title attribute ('' for the top frame). */
  async ownerTitle(ctx) {
    if (this.isTop(ctx)) return '';
    const sess = ctx.sid ? this.sessions.get(ctx.sid) : null;
    const host = sess && sess.targetId === ctx.frameId ? sess.parentSid : ctx.sid;
    const owner = await this.client.send('DOM.getFrameOwner', { frameId: ctx.frameId }, host || undefined);
    const d = await this.client.send('DOM.describeNode', { backendNodeId: owner.backendNodeId }, host || undefined);
    const a = (d && d.node && d.node.attributes) || [];
    for (let i = 0; i < a.length; i += 2) if (a[i] === 'title') return a[i + 1] || '';
    return '';
  }

  /**
   * Where a frame's viewport sits in the TOP frame: {x, y, s}. Throws when
   * the frame is not rendered (its owner has no box: display:none, detached).
   */
  async offset(ctx) {
    if (this.isTop(ctx)) return { x: 0, y: 0, s: 1 };
    return this._frameOffset(ctx.frameId, ctx.sid, ctx, 0);
  }

  async _frameOffset(frameId, sid, ctx, depth) {
    if (depth > 6) throw new Error('frame chain too deep');
    if (!sid && frameId === this.topFrameId) return { x: 0, y: 0, s: 1 };
    // An OOPIF's root frame is owned by an <iframe> in the session that
    // attached it; a same-process child frame, by its own session.
    const sess = sid ? this.sessions.get(sid) : null;
    const host = sess && sess.targetId === frameId ? sess.parentSid : sid;
    const owner = await this.client.send('DOM.getFrameOwner', { frameId: frameId }, host || undefined);
    const box = await this.client.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, host || undefined);
    const q = box.model.content;
    const width = Math.hypot(q[2] - q[0], q[3] - q[1]);
    let inner = 0;
    if (ctx) { try { inner = Number(await this.evaluate(ctx, 'innerWidth')) || 0; } catch (err) { inner = 0; } }
    const local = { x: q[0], y: q[1], s: inner > 0 ? width / inner : 1 };
    const parentId = this.parents.get(frameId);
    const parent = (!host && (!parentId || parentId === this.topFrameId))
      ? { x: 0, y: 0, s: 1 }
      : await this._frameOffset(parentId || this.topFrameId, host,
        this.list().find((c) => c.frameId === parentId) || null, depth + 1);
    return composeOffset(parent, local);
  }
}

module.exports = { FrameRegistry: FrameRegistry, composeOffset: composeOffset, toTopRect: toTopRect, isGoneError: isGoneError };

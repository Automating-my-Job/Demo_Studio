'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { FrameRegistry, composeOffset, toTopRect } = require('../vendor/demo-suite/lib/frames.js');

// A fake DevTools connection: records every send, answers from `handlers`,
// and lets a test emit protocol events (with an optional sessionId, as
// flattened child sessions do).
class FakeCdp {
  constructor(handlers) { this.listeners = {}; this.sent = []; this.handlers = handlers || {}; }
  on(m, fn) { (this.listeners[m] = this.listeners[m] || []).push(fn); }
  emit(m, params, sid) { (this.listeners[m] || []).forEach((fn) => fn(params, sid)); }
  async send(method, params, sid) {
    this.sent.push({ method, params: params || {}, sid });
    const h = this.handlers[method];
    return h ? h(params || {}, sid) : {};
  }
}

const ctxEvent = (id, frameId, extra) => ({ context: Object.assign({ id, auxData: { isDefault: true, type: 'default', frameId } }, extra || {}) });
const flush = () => new Promise((r) => setImmediate(r));

async function registry(handlers) {
  const cdp = new FakeCdp(Object.assign({
    'Page.getFrameTree': (p, sid) => (sid ? { frameTree: { frame: { id: 'OOP' }, childFrames: [{ frame: { id: 'NESTED' } }] } }
      : { frameTree: { frame: { id: 'TOP' }, childFrames: [{ frame: { id: 'SAME' } }, { frame: { id: 'OOP' } }] } }),
  }, handlers));
  const reg = new FrameRegistry(cdp, { kitJs: '(function liveKit(){})(window)' });
  reg.listen();
  await reg.enable();
  return { cdp, reg };
}

test('tracks default contexts for the top frame, same-process frames, and out-of-process iframes', async () => {
  const { cdp, reg } = await registry();
  assert.ok(cdp.sent.some((m) => m.method === 'Target.setAutoAttach' && m.params.flatten === true && !m.sid));
  cdp.emit('Runtime.executionContextCreated', ctxEvent(2, 'SAME'));
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'TOP'));
  cdp.emit('Runtime.executionContextCreated', { context: { id: 9, auxData: { isDefault: false, type: 'isolated', frameId: 'TOP' } } });
  cdp.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'OOP' }, waitingForDebugger: false });
  await flush();
  assert.ok(cdp.sent.some((m) => m.method === 'Runtime.enable' && m.sid === 'S1'), 'the OOPIF session is enabled');
  assert.ok(cdp.sent.some((m) => m.method === 'Target.setAutoAttach' && m.sid === 'S1'), 'nested OOPIFs attach too');
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'OOP'), 'S1');
  const list = reg.list();
  assert.deepStrictEqual(list.map((c) => [c.sid, c.frameId]), [[null, 'TOP'], [null, 'SAME'], ['S1', 'OOP']], 'top first; isolated worlds ignored');
  assert.ok(reg.isTop(list[0]) && !reg.isTop(list[2]));

  cdp.emit('Runtime.executionContextDestroyed', { executionContextId: 2 });
  assert.strictEqual(reg.list().length, 2);
  cdp.emit('Runtime.executionContextsCleared', {}, 'S1');
  assert.deepStrictEqual(reg.list().map((c) => c.frameId), ['TOP']);
  cdp.emit('Runtime.executionContextCreated', ctxEvent(5, 'OOP'), 'S1');
  cdp.emit('Target.detachedFromTarget', { sessionId: 'S1' });
  assert.deepStrictEqual(reg.list().map((c) => c.frameId), ['TOP'], 'a detached iframe takes its contexts with it');
});

test('maps an out-of-process iframe, and a frame nested inside it, into top-frame px', async () => {
  const owners = { OOP: { sid: undefined, node: 11 }, NESTED: { sid: 'S1', node: 22 } };
  const boxes = { 11: [250, 136, 1920, 136, 1920, 1080, 250, 1080], 22: [10, 20, 410, 20, 410, 320, 10, 320] };
  const inner = { 'S1:1': 1670, 'S1:2': 800 };
  const { cdp, reg } = await registry({
    'DOM.getFrameOwner': (p, sid) => { assert.strictEqual(sid, owners[p.frameId].sid, 'asked in the session that owns the iframe'); return { backendNodeId: owners[p.frameId].node }; },
    'DOM.getBoxModel': (p) => ({ model: { content: boxes[p.backendNodeId] } }),
    'Runtime.evaluate': (p, sid) => ({ result: { value: inner[sid + ':' + p.contextId] } }),
  });
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'TOP'));
  cdp.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'OOP' } });
  await flush(); await flush();
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'OOP'), 'S1');
  cdp.emit('Runtime.executionContextCreated', ctxEvent(2, 'NESTED'), 'S1');
  const [top, oop, nested] = reg.list();
  assert.deepStrictEqual(await reg.offset(top), { x: 0, y: 0, s: 1 });
  assert.deepStrictEqual(await reg.offset(oop), { x: 250, y: 136, s: 1 });
  const off = await reg.offset(nested);
  assert.deepStrictEqual(off, { x: 260, y: 156, s: 0.5 }, 'a 400px-wide owner showing an 800px viewport halves');
  assert.deepStrictEqual(toTopRect({ l: 100, t: 40, r: 300, b: 80 }, off), { l: 310, t: 176, r: 410, b: 196 });
});

test('composeOffset chains scale and position', () => {
  assert.deepStrictEqual(composeOffset({ x: 10, y: 20, s: 2 }, { x: 5, y: 5, s: 0.5 }), { x: 20, y: 30, s: 1 });
});

test('ensureKit injects the kit and the stored redaction into a frame that lacks them', async () => {
  const state = {};
  const { cdp, reg } = await registry({
    'Runtime.evaluate': (p, sid) => {
      const key = (sid || '') + ':' + p.contextId;
      const st = state[key] = state[key] || { kit: false, rules: null };
      if (p.expression === '!!window.__dsKit') return { result: { value: st.kit } };
      if (p.expression.indexOf('(function liveKit') === 0) { st.kit = true; return { result: { value: true } }; }
      if (p.expression.indexOf('__redact([') === 0) { st.rules = p.expression; return { result: { value: 1 } }; }
      return { result: { value: 0 } };
    },
  });
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'TOP'));
  reg.setRedaction([['Pat Real', 'Alex Admin'], ['', 'ignored']], { maskEmails: true });
  assert.strictEqual(await reg.ensureKit(reg.list()[0]), true);
  assert.strictEqual(await reg.ensureKit(reg.list()[0]), false, 'already there');
  assert.match(state[':1'].rules, /^__redact\(\[\["Pat Real","Alex Admin"\]\],\{"maskEmails":true\}\)$/, 'empty finds dropped; rules held in memory');
});

test('redactAll covers a frame that navigated mid-call: the replacement context is redacted too', async () => {
  const redacted = [];
  let destroyedOnce = false;
  let cdpRef = null;
  const { cdp, reg } = await registry({
    'Runtime.evaluate': (p, sid) => {
      if (p.expression === '!!window.__dsKit') return { result: { value: true } };
      if (sid === 'S1' && p.contextId === 1 && !destroyedOnce) {
        destroyedOnce = true;
        // The Setup iframe navigates: its old context dies, a new one arrives.
        cdpRef.emit('Runtime.executionContextDestroyed', { executionContextId: 1 }, 'S1');
        cdpRef.emit('Runtime.executionContextCreated', ctxEvent(2, 'OOP'), 'S1');
        throw new Error('Runtime.evaluate: {"code":-32000,"message":"Execution context was destroyed."}');
      }
      redacted.push((sid || 'top') + ':' + p.contextId);
      return { result: { value: 1 } };
    },
  });
  cdpRef = cdp;
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'TOP'));
  cdp.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'OOP' } });
  await flush();
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'OOP'), 'S1');
  reg.setRedaction([['Pat Real', 'Alex Admin']], {});
  assert.strictEqual(await reg.redactAll(), 2);
  assert.deepStrictEqual(redacted, ['top:1', 'S1:2']);
});

test('a real page error is not mistaken for a navigating frame', async () => {
  const { cdp, reg } = await registry({
    'Runtime.evaluate': (p) => (p.expression === '!!window.__dsKit' ? { result: { value: true } }
      : { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: __nope is not defined\n  at x' } } }),
  });
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'TOP'));
  await assert.rejects(reg.evalAll(() => '__nope()'), /ReferenceError: __nope is not defined$/);
});

test('the audit counts a visible iframe that no tracked context sits in, and sweeps unattached iframes', async () => {
  const { cdp, reg } = await registry({
    'Target.getTargets': () => ({ targetInfos: [{ type: 'page', targetId: 'P' }, { type: 'iframe', targetId: 'OOP' }, { type: 'iframe', targetId: 'LOST' }] }),
    'DOM.getFrameOwner': () => ({ backendNodeId: 11 }),
    'DOM.getBoxModel': () => ({ model: { content: [250, 136, 1870, 136, 1870, 960, 250, 960] } }),
    'Runtime.evaluate': (p) => {
      if (p.expression === '!!window.__dsKit') return { result: { value: true } };
      if (p.expression === 'innerWidth') return { result: { value: 1620 } };
      if (p.expression.indexOf('IFRAME') !== -1) return { result: { value: [{ l: 250, t: 136 }, { l: 1000, t: 700 }] } };
      if (p.expression === '__neverShow()') return { result: { value: { email: 0 } } };
      return { result: { value: 0 } };
    },
  });
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'TOP'));
  cdp.emit('Target.attachedToTarget', { sessionId: 'S1', targetInfo: { type: 'iframe', targetId: 'OOP' } });
  await flush();
  cdp.emit('Runtime.executionContextCreated', ctxEvent(1, 'OOP'), 'S1');
  const counts = await reg.neverShowAll();
  assert.strictEqual(counts.untrackedFrame, 1, 'the iframe at (1000, 700) has no context');
  const attached = cdp.sent.filter((m) => m.method === 'Target.attachToTarget').map((m) => m.params.targetId);
  assert.deepStrictEqual(attached, ['LOST'], 'only the iframe we had no session for');
});

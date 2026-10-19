'use strict';
const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { buildLiveKitJs } = require('../vendor/demo-suite/lib/liveKit.js');
const { Text, El, Root, contextFor } = require('./fixtures/tinyDom.js');

// A Setup-like page: an icon button named only by its title, a search field
// known by its placeholder, a results list inside a component's shadow root
// (with the matched words wrapped in <mark>, as the App Launcher does), a
// collapsed menu, and a users table with a username.
function setupPage() {
  const waffle = new El('button', { attrs: { title: 'App Launcher' }, box: [24, 101, 32, 32] })
    .add(new El('span', { cls: 'assistive', box: [0, 0, 1, 1] }).add(new Text('App Launcher')));
  const search = new El('input', { placeholder: 'Quick Find', value: 'Admin / Setup', box: [14, 150, 210, 32] });
  const host = new El('one-app-launcher', { box: [400, 200, 900, 600] });
  const link = new El('a', { box: [420, 300, 300, 24] })
    .add(new El('mark', { box: [420, 300, 60, 24] }).add(new Text('Admin')), new Text(' / Setup'));
  const row = new El('li', { box: [410, 296, 880, 32] }).add(link);
  new Root().attachTo(host).add(new El('ul', { box: [400, 280, 900, 300] }).add(row));
  const collapsed = new El('a', { box: [0, 0, 0, 0] }).add(new Text('Permission Set Groups'));
  const hiddenBtn = new El('button', { box: [600, 900, 120, 30], hidden: true }).add(new Text('Manage Assignments'));
  const manage = new El('input', { type: 'button', value: 'Manage Assignments', box: [300, 700, 160, 30] });
  const user = new El('td', { box: [500, 760, 300, 24] }).add(new Text('alex.admin@example.invalid'));
  const sentence = new El('p', { box: [300, 820, 700, 24] }).add(new Text('Only you have Revenue Execution Viewer.'));
  const body = new El('body', { box: [0, 0, 1920, 1080] })
    .add(waffle, search, host, collapsed, hiddenBtn, manage, user, sentence);
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(body);
  const ctx = contextFor(html, buildLiveKitJs());
  return { ctx, waffle, search, link, row, manage, hiddenBtn, user, sentence };
}

test('__findText finds an icon button by its title, and a field by its placeholder', () => {
  const { ctx, waffle, search } = setupPage();
  assert.strictEqual(vm.runInContext('__findText("App Launcher")', ctx), waffle);
  assert.strictEqual(vm.runInContext('__findText("Quick Find")', ctx), search);
});

test('__findText pierces shadow roots and prefers the interactive element over the <mark> inside it', () => {
  const { ctx, link } = setupPage();
  assert.strictEqual(vm.runInContext('__findText("Admin / Setup")', ctx), link);
});

test('__findText promotes text inside a shadow component to the clickable row around it', () => {
  // The App Launcher result: <a role="option"> > rich-text host > (shadow) <p><b>Admin / Setup</b></p>
  const row = new El('a', { attrs: { role: 'option' }, box: [33, 318, 320, 28] });
  const rich = new El('lightning-formatted-rich-text', { box: [33, 321, 90, 20] });
  new Root().attachTo(rich).add(new El('p', { box: [33, 321, 90, 20] }).add(new El('b', { box: [33, 322, 90, 16] }).add(new Text('Admin / Setup'))));
  row.add(new El('div', { box: [33, 321, 296, 20] }).add(rich));
  const panel = new El('div', { attrs: { role: 'button' }, box: [0, 0, 1920, 1080] }).add(new El('span', { box: [600, 500, 80, 20] }).add(new Text('Whole page')), new El('span', { box: [700, 500, 80, 20] }).add(new Text(' and more')));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(row, panel));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__findText("Admin / Setup")', ctx), row);
  assert.strictEqual(vm.runInContext('__findText("Admin / Setup", {promote:false})', ctx).tagName, 'B');
  assert.strictEqual(vm.runInContext('__findText("Whole page")', ctx).tagName, 'SPAN', 'never promotes to a whole panel');
});

test('__findText skips hidden copies and matches a button input by its value', () => {
  const { ctx, manage } = setupPage();
  assert.strictEqual(vm.runInContext('__findText("Manage Assignments")', ctx), manage);
});

test('__findText is exact by default: no case changes, no partial words', () => {
  const { ctx } = setupPage();
  assert.strictEqual(vm.runInContext('__findText("admin / setup")', ctx), null);
  assert.strictEqual(vm.runInContext('__findText("Revenue Execution Viewer")', ctx), null, 'only inside a sentence');
  assert.ok(vm.runInContext('__findText("Revenue Execution Viewer", {exact:false})', ctx), 'phrase match when asked');
  assert.strictEqual(vm.runInContext('__findText("Execution View", {exact:false})', ctx), null, 'never half a word');
});

test('a typed search value never counts as the app showing that label', () => {
  const { ctx, link } = setupPage();
  link.parentNode.parentNode.childNodes = [];   // the result list empties
  const [r] = vm.runInContext('__labelCheck(["Admin / Setup"])', ctx);
  assert.strictEqual(r.status, 'missing', 'the search box still holds "Admin / Setup" as its value');
});

test('__labelCheck reports visible, hidden, missing, and covered labels', () => {
  const { ctx } = setupPage();
  // JSON round trip: arrays from the vm realm have a different prototype.
  const res = JSON.parse(JSON.stringify(vm.runInContext('__labelCheck(["Admin / Setup","Permission Set Groups","Login History","Revenue Execution Viewer"])', ctx)));
  assert.deepStrictEqual(res.map((r) => r.status), ['visible', 'hidden', 'missing', 'visible']);
  assert.deepStrictEqual(res[0].rect, { l: 420, t: 300, r: 720, b: 324 });
  vm.runInContext('window.__covers=[{l:0,t:0,r:1920,b:140}]', ctx);
  const [waffle] = vm.runInContext('__labelCheck(["App Launcher"])', ctx);
  assert.strictEqual(waffle.status, 'covered', 'a label under the band is not on screen');
});

test('__visibleTexts lists short visible names for the preflight diff', () => {
  const { ctx } = setupPage();
  const texts = vm.runInContext('__visibleTexts()', ctx);
  assert.ok(texts.includes('Admin / Setup'));
  assert.ok(texts.includes('Quick Find'));
  assert.ok(!texts.includes('Permission Set Groups'), 'collapsed items are not on screen');
});

test('__redact masks email-shaped text (usernames) and the audit reaches zero', () => {
  const { ctx, user } = setupPage();
  const changed = vm.runInContext('__redact([], {maskEmails:true})', ctx);
  assert.strictEqual(changed, 1);
  assert.strictEqual(user.textContent, '••••••');
  assert.strictEqual(vm.runInContext('__redactAudit()', ctx), 0);
  user.childNodes[0].nodeValue = 'casey@example.invalid (re-rendered)';
  assert.strictEqual(vm.runInContext('__redactAudit()', ctx), 1);
  vm.runInContext('__redact()', ctx);
  assert.strictEqual(user.textContent, '•••••• (re-rendered)');
});

test('__neverShow counts never-show patterns in visible text only, never returning the text', () => {
  const { ctx, user, sentence } = setupPage();
  let c = vm.runInContext('__neverShow()', ctx);
  assert.strictEqual(c.email, 1);
  assert.strictEqual(c.url, 0);
  sentence.childNodes[0].nodeValue = 'Org 00D5g000004XyZ1EAK at https://acme.my.salesforce.com';
  c = vm.runInContext('__neverShow()', ctx);
  assert.deepStrictEqual([c.orgId, c.url, c.recordId > 0], [1, 1, true]);
  vm.runInContext('__redact([], {maskEmails:true})', ctx);
  sentence.childNodes[0].nodeValue = 'Annual Recurring Revenue · Configuration Health';
  c = vm.runInContext('__neverShow()', ctx);
  assert.deepStrictEqual(Object.values(c).filter((n) => n > 0), [], 'ordinary Setup words are clean');
  user.hidden = true;
  user.childNodes[0].nodeValue = 'hidden@example.invalid';
  assert.strictEqual(vm.runInContext('__neverShow()', ctx).email, 0, 'text a viewer cannot see does not count');
});

test('text clipped away by a 0px overflow:hidden column is not visible (Setup list ID columns)', () => {
  const idCell = new El('td', { box: [300, 400, 0, 22], overflow: 'hidden' })
    .add(new El('div', { box: [300, 400, 120, 22] }).add(new Text('0PS5g000000AbCd')));
  const scroller = new El('div', { box: [0, 300, 900, 200], overflow: 'auto' })
    .add(new El('a', { box: [20, 640, 200, 22] }).add(new Text('Revenue Execution Viewer')));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(idCell, scroller));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__neverShow()', ctx).recordId, 0, 'the hidden ID column paints nothing');
  idCell.box = [300, 400, 130, 22];
  assert.strictEqual(vm.runInContext('__neverShow()', ctx).recordId, 1, 'a visible ID column is caught');
  assert.strictEqual(vm.runInContext('__labelCheck(["Revenue Execution Viewer"])[0].status', ctx), 'hidden', 'scrolled below its list');
});

test('a subject picked by kind keeps the element even when its text sits in a child', () => {
  const letter = new El('a', { box: [1660, 380, 14, 18] }).add(new El('span', { box: [1662, 381, 10, 16] }).add(new Text('R')));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(letter));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__findText("R", {selector: "a"})', ctx), letter);
  assert.strictEqual(vm.runInContext('__findText("R")', ctx), letter, 'no selector: the span, promoted to its link');
});

test('a dropdown positioned out of an overflow:hidden header is visible; a static child is clipped', () => {
  const header = new El('div', { box: [130, 310, 900, 40], overflow: 'hidden', position: 'relative' });
  const wrap = new El('div', { box: [130, 310, 900, 40] });   // static: the menu escapes it
  const menu = new El('div', { box: [146, 360, 300, 80], position: 'absolute' })
    .add(new El('a', { attrs: { role: 'option' }, box: [148, 448, 296, 20] }).add(new Text('Recently Viewed')));
  const inside = new El('span', { box: [140, 380, 200, 20] }).add(new Text('Clipped Text'));
  header.add(wrap.add(menu), inside);
  const page = new El('div', { box: [0, 0, 1920, 1080], position: 'relative' }).add(header);
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(page));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__labelCheck(["Clipped Text"])[0].status', ctx), 'hidden', 'below the header, inside its clip');
  assert.strictEqual(vm.runInContext('__labelCheck(["Recently Viewed"])[0].status', ctx), 'hidden', 'its containing block (the header) still clips it');
  header.position = 'static';
  assert.strictEqual(vm.runInContext('__labelCheck(["Recently Viewed"])[0].status', ctx), 'visible', 'contained by the page, not the header: it escapes');
});

test('a node slotted into a positioned popup is clipped by the popup tree, not its light-DOM parent', () => {
  // <picker overflow:hidden> > <popup> > (slotted) <div> > option; the popup's shadow puts the slot in a fixed layer.
  const picker = new El('lst-list-view-picker', { box: [279, 334, 187, 18], overflow: 'hidden' });
  const popup = new El('lightning-popup', { box: [279, 334, 187, 16] });
  const layer = new El('div', { box: [146, 360, 320, 140], position: 'fixed' });
  const slot = new El('slot', { box: [146, 360, 320, 140] });
  new Root().attachTo(popup).add(layer.add(slot));
  const slotted = new El('div', { box: [146, 363, 320, 120] })
    .add(new El('span', { box: [333, 456, 94, 18] }).add(new Text('Recently Viewed')));
  slotted.assignedSlot = slot;
  picker.add(popup.add(slotted));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(picker));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__labelCheck(["Recently Viewed"])[0].status', ctx), 'visible');
  slotted.assignedSlot = null;
  assert.strictEqual(vm.runInContext('__labelCheck(["Recently Viewed"])[0].status', ctx), 'hidden', 'unslotted, the picker clips it');
});

test('hide rules blank whole sections and columns before every frame, and the audit then reads clean', () => {
  const mk = (tag, text, box) => new El(tag, { box }).add(new Text(text));
  const head = new El('tr', { box: [0, 100, 900, 20] }).add(mk('th', 'Full Name', [0, 100, 300, 20]), mk('th', 'Last Login', [300, 100, 300, 20]));
  const row = new El('tr', { box: [0, 120, 900, 20] }).add(mk('td', 'Demo Seller', [0, 120, 300, 20]), mk('td', '10/9/2026 9:46 AM', [300, 120, 300, 20]));
  head.childNodes.forEach((c, i) => { c.cellIndex = i; });
  row.childNodes.forEach((c, i) => { c.cellIndex = i; });
  const table = new El('table', { box: [0, 100, 900, 40] }).add(head, row);
  table.rows = [head, row];
  row.cells = row.childNodes; head.cells = head.childNodes;
  const section = new El('div', { cls: 'bRelatedList', box: [0, 400, 900, 200] }).add(mk('h3', 'Login History', [0, 400, 200, 20]));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(table, section));
  // closest(): enough of it for the fixture
  const parentOf = new Map();
  (function link(n) { (n.childNodes || []).forEach((c) => { parentOf.set(c, n); link(c); }); }(html));
  const closest = function (sel) { for (let n = this; n && n.matches; n = parentOf.get(n)) { if (sel.split(',').some((x) => n.matches(x.trim()))) return n; } return null; };
  [table, head, row, section, ...head.childNodes, ...row.childNodes, ...section.childNodes].forEach((n) => { n.closest = closest; n.style.setProperty = function (k, v) { this[k] = v; }; });
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__neverShow().sensitivePage', ctx), 1, 'Login History is on screen');
  const n = vm.runInContext('__redact([], {hide:[{text:"Login History",closest:".bRelatedList"},{column:"Last Login"}]})', ctx);
  assert.strictEqual(n, 3, 'the section, the header cell and its column cell');
  assert.strictEqual(section.style.visibility, 'hidden');
  assert.strictEqual(row.childNodes[1].style.visibility, 'hidden');
  assert.strictEqual(row.childNodes[0].style.visibility, undefined, 'other columns untouched');
  assert.strictEqual(vm.runInContext('__redact()', ctx), 0, 'already hidden: nothing to do');
});

test('an option in a list box is its own subject, never promoted to the whole list', () => {
  const opt = new El('option', { box: [27, 225, 303, 17] }).add(new Text('Revenue Execution Viewer'));
  const list = new El('select', { box: [26, 157, 305, 172] }).add(new El('option', { box: [27, 160, 303, 17] }).add(new Text('Salesforce Apex Guru')), opt);
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(list));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__findText("Revenue Execution Viewer", {selector: "option"})', ctx), opt);
  assert.strictEqual(vm.runInContext('__findText("Revenue Execution Viewer")', ctx), opt);
});

test('allowEmails keeps a public address (the app footer) while every other address is masked and counted', () => {
  const foot = new El('p', { box: [100, 900, 600, 20] }).add(new Text('Need help? Support@OpsGS.com · or alex.admin@example.invalid'));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(foot));
  const ctx = contextFor(html, buildLiveKitJs());
  vm.runInContext('__redact([], {maskEmails:true, allowEmails:["support@opsgs.com"]})', ctx);
  assert.strictEqual(foot.textContent, 'Need help? Support@OpsGS.com · or ••••••');
  assert.strictEqual(vm.runInContext('__neverShow().email', ctx), 0, 'the allowed address is not a leak');
  foot.childNodes[0].nodeValue = 'Need help? support@opsgs.com';
  assert.strictEqual(vm.runInContext('__neverShow().email', ctx), 0);
});

test('a label drawn uppercase by CSS matches its uppercase script label', () => {
  const owner = new El('label', { box: [900, 200, 60, 16], textTransform: 'uppercase' }).add(new Text('Owner'));
  const plain = new El('span', { box: [900, 300, 60, 16] }).add(new Text('Period'));
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(owner, plain));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__findText("OWNER")', ctx), owner);
  assert.strictEqual(vm.runInContext('__findText("PERIOD")', ctx), null, 'not drawn uppercase: no match');
});

test('values a viewer never sees (checkbox, hidden) are neither audited nor rewritten', () => {
  const box = new El('input', { type: 'checkbox', value: '0PS5g000000AbCd', box: [280, 448, 13, 13] });
  const hidden = new El('input', { type: 'hidden', value: 'pat@example.invalid', box: [0, 0, 0, 0] });
  const field = new El('input', { type: 'text', value: 'pat@example.invalid', box: [300, 500, 200, 24] });
  const pw = new El('input', { type: 'password', value: 'x', box: [300, 540, 200, 24] });
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(box, hidden, field, pw));
  const ctx = contextFor(html, buildLiveKitJs());
  const c = vm.runInContext('__neverShow()', ctx);
  assert.deepStrictEqual([c.recordId, c.email, c.passwordField], [0, 1, 1], 'only the text field and the password field count');
  vm.runInContext('__redact([], {maskEmails:true})', ctx);
  assert.strictEqual(hidden.value, 'pat@example.invalid', 'a hidden form value is left intact');
  assert.strictEqual(field.value, '••••••');
});

test('within scopes a label to one part of the page (the App Launcher, not the nav tab)', () => {
  const tab = new El('a', { box: [1200, 110, 90, 30] }).add(new Text('Admin / Setup'));
  const menu = new El('one-app-launcher-menu', { box: [20, 180, 320, 500] });
  const result = new El('a', { attrs: { role: 'option' }, box: [33, 318, 320, 28] }).add(new Text('Admin / Setup'));
  menu.add(result);
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(tab, menu));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__findText("Admin / Setup")', ctx), tab, 'unscoped: the smaller link wins');
  assert.strictEqual(vm.runInContext('__findText("Admin / Setup", {within: "one-app-launcher-menu"})', ctx), result);
});

test('__busy is true only while a spinner is on screen', () => {
  const spin = new El('div', { cls: 'slds-spinner slds-spinner_medium', attrs: { class: 'slds-spinner slds-spinner_medium' }, box: [900, 500, 40, 40] });
  const holder = new El('div', { attrs: { class: 'slds-spinner_container slds-hide' }, box: [0, 0, 0, 0] });
  const html = new El('html', { box: [0, 0, 1920, 1080] }).add(new El('body', { box: [0, 0, 1920, 1080] }).add(holder, spin));
  const ctx = contextFor(html, buildLiveKitJs());
  assert.strictEqual(vm.runInContext('__busy()', ctx), true);
  spin.hidden = true;
  assert.strictEqual(vm.runInContext('__busy()', ctx), false, 'a hidden spinner does not count');
});

test('the kit can be evaluated twice in the same frame', () => {
  const { ctx } = setupPage();
  vm.runInContext(buildLiveKitJs(), ctx);
  assert.strictEqual(vm.runInContext('window.__dsKit', ctx), 1);
  assert.ok(vm.runInContext('__findText("Quick Find")', ctx));
});

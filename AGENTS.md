# AGENTS.md — how the app-tour demo was directed, and what the tool must learn to direct it itself

This documents the 2026-08-30/31 session that built Demo Studio and then used
it to produce its own marketing demo (`demos/app-tour`). It exists because
the finished demo took more than pressing Run: a director's loop ran around
the tool — plan, record, inspect, diagnose, fix, re-record — and **every
step of that loop is something the tool should eventually do itself.**
Read this before directing a demo by hand, and before building v2 features:
§2 is what the tool can already do, §3 is the loop to imitate, §4 is the
backlog that closes the gap.

The engine's own rules still apply first — read `vendor/demo-suite`'s
README/AGENTS docs for the non-negotiables:
audio first, spotlight never crop, don't raise `stallMs`, always deliver the
BT.709 encode.

---

## 1. What was produced, and how to reproduce it

A 60s narrated tour of Demo Studio's own UI, voiced with Google Chirp3-HD
Charon, closing on "This demo was built with Demo Studio."

```bash
npm run renderer     # serves the UI (with the sample-data bridge) at localhost:5183
node runner/runner.js --job=<(echo '{"kind":"run-auto","projectDir":"'$PWD'/demos/app-tour","demoSuitePath":"'$PWD'/vendor/demo-suite","userDataDir":"/tmp/ds-tour"}')
```

Same job the app's Run button forks. The demo records the REAL page —
the clicks in the video are real clicks on the running renderer.

## 2. Capability upgrades that landed this session

Each of these exists because the demo needed it. File references are the
implementation; the bug stories are the reason.

| Upgrade | Where | Why (what broke without it) |
|---|---|---|
| Data-driven storyboards: demo.json shots → `rec` primitives | `runner/executeShots.js`, schema in `shared/demoSchema.js` | Demos as editable data instead of hand-written JS — the whole premise of the app |
| Structured subjects (`{selector, nth, textContains}` → JS expressions) | `runner/subject.js` | Lets Gemini and the editor speak selectors, never raw code |
| Readiness wait (readyState + `target.readySelector` poll, real-time sleeps) | `runner/readiness.js` | The engine's only load wait is a blind 1.1s — a slow live URL records a blank page |
| Camera client injected into live URLs post-readiness | `executeShots.js` prologue | `__caption`/`__spot` only exist on staged pages; live pages threw `__caption is not defined` |
| Canvas painted with the page's own background | `executeShots.js` prologue | Headless Chrome's canvas is DARK; a light app scaled under the caption bar sat in an ugly dark letterbox |
| React-safe spotlight (`, void 0` suffix on spot expressions) | `executeShots.js` + regression test | `window.__spotSel=<el>` returns the element; React fiber graphs overflow CDP's serializer ("Object reference chain is too long"). Engine-level fix in progress in demo-suite |
| **Wide frames never auto-crawl** | `executeShots.js` (`wantsCrawl`) | A page barely taller than the caption-reserved area triggered a silent 2.8s crawl on the OPENING shot — first voice line landed at 5.4s |
| **Cold open** as grammar | `shared/rules.js` | Silence before the first line reads as broken audio. First shot is the `say`; the wide frame plays under it; ≤1s silent lead-in |
| Multi-screen tours via `click` shots on nav elements | `demos/app-tour/demo.json` (worked example) | Framing captures one page state; the tour navigates five screens with real clicks + `settleMs` |
| Closing pattern: meta-credit CTA | `demo.json` s32 + `rules.js` | "This demo was built with Demo Studio." / "Want a specialized demo tool for your needs? · Tom@OpsGS.com" — the preferred close |
| Gemini TTS quality passthroughs (`geminiModel`, `style`, `targetWpm`) | `runner/runner.js` narrOpts | Gemini TTS pads clips with silence; `targetWpm` turns on the engine's trim/normalize/retake loop |
| Whisper verification as a job (`kind:"verify"`), mandatory for Gemini TTS | `runner/runner.js` | The only reliable repeat-detector; also used as a pre-publish check on the Google engine |
| Stall reports mapped to shot ids | `executeShots.js` timeline + `stallsToShots` | "Dead air after s6" is actionable; "12.3s" is not |
| GitHub share kit | `runner/githubShareKit.js`, optional `githubShare` / `github-share.json` | A demo-only repo needs the delivery MP4, concise public copy, a separate About description, and a direct raw-file link when GitHub's blob page will not preview video |
| Classic-project screen guards | `TargetScreen.jsx`, `ScriptScreen.jsx`, `VoiceScreen.jsx`, `RunScreen.jsx` | Hand-written projects were discovered correctly but several screens rejected them because they do not have `demo.json` |
| Shadow-piercing subjects: `__q('host >>> .sel', text)` | `cameraClient.js`; tests in `test/cameraClient.test.js` | Salesforce Lightning (LWC) renders every dashboard inside component shadow roots; `document.querySelector` saw none of it. The optional `text` pins a subject to a named record so a reorder aborts instead of spotlighting the wrong one |
| Display-only redaction re-applied before EVERY frame: `__redact(pairs)`, `__redactAudit()`, `runDemo({everyFrameJs})` | `cameraClient.js`, `recorder.js` | A live org shows the real signed-in user as deal owner, filter chip, and dropdown value. A one-time rewrite is undone by the next re-render, and LWC synthetic shadow does not reliably report mutations, so the hook runs before each capture; the audit is a hard pre-shot assertion |
| Null subjects are loud: warning always, throw under `runDemo({strictSubjects:true})` | `recorder.js` (`frame`, `spot`) | A renamed class used to film on silently: `frame()` held still and `spot()` dimmed an empty screen |
| `observe({untilExpr})` | `recorder.js` | Wait on state `untilSelector` cannot reach (shadow DOM text such as a server-produced "2 of 2 shown") |
| Per-spot ring padding `window.__spotPad` (number or `[t,r,b,l]`) | `cameraClient.js` (`__spot`) | The fixed 12px ring sliced through the line stacked directly above a one-line subject |
| Honest camera travel bound | `cameraClient.js` (`__plan`) | Lightning's `<body>` is 0px tall (absolute app shell), so the body fallback clamped `maxY` to 0 and pinned the camera to the top of every page with no error |
| Chirp3-HD `speakingRate`; rate and trim mode in the cache key; Google trim is edges-only | `narrate.js` | The API now honors pace control for Chirp3-HD (verified 2026-09-18); the old code stripped it. The Google trim's `stop_periods=-1` also crushed every interior pause to 0.12s |
| `rec.spotMove(expr, ms)` / `__spotGlide` | `recorder.js`, `cameraClient.js`; test in `test/cameraClient.test.js` | Walking a row of related subjects (four hero cards; a progress bar, then its callout, then the next step) with `spotOut`+`spot` blinked the dim off and on between each; the ring now glides at full strength |
| Word-cued moves: `wordTimings.js` (`buildWordTimings`, `wordTime`) | `vendor/demo-suite/lib/wordTimings.js`; tests in `test/wordTimings.test.js` | Fraction cues ("move at 56% of the line") kept landing on the wrong word whenever a line was edited or re-synthesized; mlx-whisper word timestamps per clip (cached by clip hash) let a storyboard move ON the spoken word |
| `rec.waitFor(expr, {maxMs, label})` | `recorder.js` | Navigation-safe, zero-film-time wait; also applies `everyFrameJs` before each poll so predicates see what the film sees |
| One-frame floor at 60fps (`filmFrameFloorMs`) | `recorder.js`; test in `test/recorder.test.js` | The flat 20ms floor (since v0.1.0) exceeded a 60fps frame, so every authored move ran 20% long |
| Drift-free concat durations (`concatDurations`) | `recorder.js`; test in `test/recorder.test.js` | `toFixed(3)` rounded 16.667ms frames to 17ms: the picture fell ~2% behind the voice (0.85s by 51s) and the ending padded out |
| Opaque caption bar | `cameraClient.js` (`__caption`) | At 97% opacity, dashboard numbers scrolling up under the bar ghosted through as faint text |
| Trace never prints URL queries | `recorder.js` (`traceUrlLabel`), test in `test/recorder.test.js` | `DEMO_TRACE` printed a Salesforce `frontdoor.jsp?otp=…` login token and org id to the console (see §5) |
| **Live-app filming (2026-10-09), all opt-in: `runDemo({frames, cursor, topFrameJs, burnCaptions:false, dryRun})`** | `liveKit.js`, `frames.js`, `liveInput.js`, `preflight.js`; tests `test/liveKit`, `frames`, `liveInput`, `preflight`, `liveFrames.e2e` | Filming a real Salesforce setup session: staged-page primitives could not type into Salesforce search boxes, showed no pointer, could not reach Setup's cross-site iframe, and nothing checked the script's on-screen words |
| Real typing and clicks: subject OBJECTS (`{text}`, `{q}`, `{expr}`, `{until}`, with `frame`, `within`, `selector`, `pad`) in `type`/`click`/`spot`/`spotMove`/`waitFor` | `liveInput.js` (CDP `Input.dispatchKeyEvent`/`dispatchMouseEvent`) | `type()` set values by script and `click()` called `.click()`; the App Launcher and Quick Find filter only on real key events. String subjects keep the staged behavior |
| Visible cursor that glides to the subject, dips, then clicks for real | `cameraClient.js` (`__cursor`), `liveInput.js` (`clickOn`) | Live clicks happened with no pointer on screen. The real click fires after the dip, so a navigating click never tears down the animation |
| Frame-aware subjects, spotlight and redaction (OOPIFs) | `frames.js` (`FrameRegistry`), `cameraClient.js` (`__spotRect`, `__spotGlideRect`) | Setup pages render in an iframe on another site: a separate renderer process with its own DevTools target. Subjects are measured in their frame and mapped to top-frame px; redaction runs in every frame before every capture |
| Labels by what a viewer reads: `__findText(label, {selector, within})`, promoted to the clickable row | `liveKit.js` | Selectors break across Salesforce releases; the strategy pins every subject to its exact on-screen label |
| Wording preflight (`dryRun`) and per-beat checks (`rec.beat(key, {say, labels})`) | `recorder.js`, `preflight.js` (`formatReport`, `closest`) | A script that names a renamed or missing label fails before filming, with a script-vs-screen diff and the closest on-screen text |
| Never-show audit before every beat (`rec.audit`) | `liveKit.js` (`__neverShow`), `frames.js` (`neverShowAll`, `untrackedFrames`, `sweep`) | Emails, URLs, org and record ids, sensitive Setup pages, password fields, and any visible iframe we cannot redact must count zero. Counts only, never the text |
| Band over the app's global header (`__band(text, '#oneHeader')`) | `cameraClient.js` | Live takes never film Salesforce's global header (search, avatar, scratch banner); the band registers a cover rect so labels under it fail the preflight |
| Frame scan (OCR) and word-for-word narration check | `frameScan.js` + `frameScan.swift` (macOS Vision), `preflight.js` (`wordDiff`), `verifyNarration.js` (`transcribeFile`) | The DOM audit cannot see pixels (canvas, images, untracked frames); the scan reads the finished video. Whisper output is compared to the script word for word, not just for repeats |
| `rec.scrollTo(target, {within})`, display-only `hide` rules, option subjects | `liveInput.js` (`scrollTo`, settles after smooth scrolling), `liveKit.js` (`__redact` `hide`: sections by text, columns by header) | Setup listboxes hold ~50 permission sets in 10 rows: scroll with real wheel steps, wait until the target stops moving, then click. User pages carry Login History: hide it before every frame. An `<option>` was being promoted to its whole list box and the click picked the wrong set |

## 3. The director's loop (what a human/agent did around the tool)

This produced the finished demo. Follow it when directing by hand; it is
the specification for §4.

1. **Write the narration first**, outcome-led, joined sentences
   (engine rules §3.1). It was rewritten twice on stakeholder feedback —
   the hook became the cost question ("How many hours does your team spend
   on a single product demo?"), the close became the meta-credit + CTA.
   Treat the script as the most-revised artifact, not the most stable.
2. **Plan shots against the real DOM.** Selectors came from reading the
   page's actual classes (`.rail-item`, `.recent-item`, `.stepper`). The
   framing capture + lint does this for single-state pages; multi-screen
   tours were planned by hand.
3. **Record, then INSPECT — never ship a first take.** Extract frames at
   each beat and actually look at them:
   ```bash
   ffmpeg -v error -y -ss 14 -i demo-out/demo.mp4 -frames:v 1 -vf scale=760:-1 /tmp/f14.png
   ```
   This loop caught: the dark letterbox, the spot crash on React pages,
   and the composition of every spotlight.
4. **Measure the audio, don't trust your ear.**
   ```bash
   ffmpeg -i demo-out/demo.mp4 -af silencedetect=noise=-45dB:d=0.3 -f null -
   ```
   This is how "sound starts 5 seconds late" became a diagnosis (opening
   crawl + hold before the first say) instead of a mystery. Assert: first
   voice ≤1s from 0:00; no silent gap that isn't a deliberate beat.
5. **Whisper-verify the narration before anything goes public**
   (`kind:"verify"` job) — even on the Google engine, where it's insurance
   rather than a necessity.
6. **Diagnose failures at the source, then fix the RULE, not just the
   take.** Every defect found in a take became either an executor fix
   (§2) or a grammar rule in `shared/rules.js`, so Gemini-framed demos
   inherit the lesson. That feedback step is the difference between fixing
   one video and upgrading the tool.
7. **Re-record and re-measure.** The cut only shipped once frames + audio
   measurements + whisper all passed.

## 4. Backlog — make the tool run the loop itself

1. **Review pass — SHIPPED** (`runner/review.js`, "Review the cut with
   Gemini" on the Run screen, job kind `review`). One frame per shot
   (timings from `demo-out/timeline.json`, written by every run) goes to
   Gemini vision with the grammar; critiques come back mapped to shot ids
   with severity + suggestion. Automates §3.3.
2. **Audio QA — SHIPPED** (`runner/audioQa.js`, automatic on every run,
   surfaced on the result card). silencedetect on the finished cut asserts
   the cold open (first voice ≤1s), no interior dead air >4s, no limp
   silent ending. Advisory, never fatal. Automates §3.4 — would have
   caught the 5.4s bug without a human ear.
3. **Multi-state framing — OPEN.** Capture currently sees one page state.
   Upgrade: during capture, identify nav affordances from the outline,
   click through them, outline EACH state, and let Gemini plan a tour
   across states — emitting the `click`+`settleMs` shots the app-tour used
   by hand. Automates §3.2 for tours.
4. **Auto re-frame — SHIPPED** (`runner/frame.js`). Hard selector-lint
   failures go back to Gemini for one automatic revision before the user
   sees the draft; warnings pass through (hidden elements may be a
   deliberate click-then-frame).
5. **Verify in the UI — SHIPPED** ("Check the voiceover" beside the review
   button; still automatic and non-skippable for the Gemini TTS engine).
6. **Script iteration UX — OPEN.** The narration was rewritten twice from
   feedback; the Target tab's instructions + re-frame covers the Gemini
   path, but a "revise the script with Gemini, keep my shots" action is
   missing.
7. **GitHub publishing handoff — SHIPPED.** An optional, local-only share
   profile generates a demo-only repository folder plus a separate About
   description. It deliberately stops before authentication or publication.

8. **Live-DOM probe for classic projects — OPEN.** Before the first take of
   a live app, a read-only probe opened each page, asserted every selector's
   box, timed the filmed clicks cold and warm, and saved screenshots
   (Salesforce Revenue Execution: `demo/video/revenue-execution-linkedin/probe.js`).
   It caught the owner-name leaks, the pinned camera, and "Invalid data" KPI
   cards before any film was shot. Generalize it into a `probe` job that
   reads the storyboard's own subjects.
9. **Shadow paths in demo.json subjects — OPEN.** `__q` exists in the camera
   client; `runner/subject.js` still compiles `selector` to
   `document.querySelector`, so Gemini-framed demos cannot target LWC, Lit,
   or Stencil apps yet.

## 5. Traps already paid for — do not rediscover

- Run `node --test` and `npm run build` from this repo's root — from a
  parent directory, Node's test runner will happily discover some other
  folder's tests and report their failures as yours.
- demo-suite sources contain literal ANSI bytes — `grep` needs `-a`.
- `narrate.build` DELETES its outDir (`guardOutDir` protects app paths —
  never hand it a user folder).
- The packaged app uses `app.asar`; the forked runner CAN require the
  vendored engine from inside it (verified) — don't "fix" that.
- Keys never ship: dotfiles or keychain-encrypted settings, injected as env
  vars at spawn. The public repo and .app contain none.
- GitHub's ordinary file page may refuse to preview a repository MP4 that is
  well below the file-size limit. Public demo README links should use the raw
  file route; keep the public repository limited to the delivery video and
  intentional viewer-facing copy.
- `normalizeSubject_` (`shared/demoSchema.js`) used to hijack ANY top-level
  `selector`/`expr` field into `shot.subject`, regardless of the shot's
  `action`. That silently broke the `type` action, which has its own
  top-level `selector` (the input to type into, not a subject) — it got
  moved into `shot.subject` and deleted, then failed validation with
  "missing required field selector". Fixed: it now only fires for actions
  whose `ACTIONS[action].subject` is true. Regression test in
  `test/demoSchema.test.js` ("type keeps its own top-level selector").
- `observe`'s `untilSelector` (and any hand-written `frame`/`spot`/`click`
  selector) is `document.querySelector`, which returns the FIRST match in
  DOM order — a generic class name (e.g. `.row-title`, `.row`, `.card`) used
  by chrome that renders before the page's main content (a sidebar, a nav
  rail) will win silently, and the shot will wait forever / hit `maxMs`
  looking for text that's actually further down the page. Found this
  directing Freedact's demo: its sidebar footer reuses `.row-title` for the
  account label, so `untilSelector: '.row-title'` never saw the real status
  row. Tagging the real target with a one-off id in a preceding `run` shot
  does NOT reliably fix this: an app that re-renders by replacing a
  container's `innerHTML` wholesale (very common — this one does) destroys
  any id/attribute set imperatively on a queried element the next time it
  redraws. The robust fix is a selector scoped to a STABLE ANCESTOR that
  persists across renders (a `#main`/`#content` wrapper that only has its
  `innerHTML` replaced, never itself replaced) — e.g. `'#main .row-title'` —
  not a generic class alone and not a one-off tag.
- `observe`'s `speed` silently stopped compressing anything past about 2.6x: `recorder.js`'s `shoot()` floors
  every frame at 20ms of film time (so ffmpeg's concat demuxer never sees a near-zero-duration entry), and at the
  ~16-captures/sec sampling rate `observe` used, `frameMs/speed` fell below that floor for any `speed` above ~2.6 —
  every frame then got padded up to the 20ms minimum regardless of what was asked for, so the real thing played back
  at an ACHIEVED speed of ~3.1x no matter whether `speed` said 6, 8, or 20. No error, no warning — a `speed: 8`
  `observe` just quietly ran at ~3.1x, and anything timed against the requested speed (an `untilVo` cap sized to fit
  a voice line, say) came out wrong with no clue why. First MISdiagnosed directing Freedact's demo as an intermittent
  `Page.captureScreenshot` stall under heavy concurrent polling — that theory didn't hold up (the shortfall was
  identical, not occasional, across repeated takes) until the maths on the trace log's own `realElapsed`/`speed`
  numbers gave an achieved speed of ~3.1x regardless of the requested one. Fixed: `observe` now widens its real
  sampling interval at high `speed` (`Math.max(1000/16, speed * 24)`) so the resulting film-frame duration clears
  `shoot()`'s floor instead of being clamped by it — capture less often in real time rather than shoot frames the
  floor was going to pad anyway. Low speeds are unaffected (still ~16 captures/sec).
- Real page state does not always finish in the time you measured once.
  Directing Freedact's demo, the same sped-up stage's dry run took 18.2s one
  run and 47.8s the next (same knobs, different random pacing-gap draw), so
  an `observe` tuned against a single sample either finished awkwardly early
  or blew a `maxMs` cap and produced several seconds of dead air after the
  narration line had already ended. `untilVo` and `untilSelector` are not
  mutually exclusive — pass both and whichever condition is met first wins —
  so pairing `untilVo: true` with the selector caps film time at the voice
  line regardless of how long the real thing takes, while still cutting
  short cleanly if the selector matches first. Prefer that combination over
  tuning `speed`/`maxMs` against one measurement.
- A Chirp3-HD clip is not "silent, then N seconds of speech, then silent
  again exactly at its reported `seconds`" — it carries real leading AND
  trailing quiet of its own (roughly 200-350ms each, measured with
  `ffmpeg -af silencedetect=noise=-40dB:d=0.05`). That quiet eats into the
  QA silence budget (`no gap > 1.5s`) BEFORE any scripted transition (clicks,
  settles, spotOut) adds a single millisecond — a transition that looks like
  it should cost ~800ms on paper can measure 1.4-2s on the delivered file.
  Do not chase this by trimming the clip in narrate.js (the audible speech
  itself is fine; padding is normal for this engine and isn't worth a
  synthesis-pipeline change). Instead budget for it in the STORYBOARD: any
  transition needing more than one quick click should be a single `run` shot
  that does the whole sequence itself (clicks + short in-page sleeps), which
  costs the recorder ZERO film milliseconds — a genuine hard cut — instead of
  several chained `click`+`settleMs` shots whose real cost stacks on top of
  the clip padding. Reserve real filmed `click` shots for transitions the
  video should actually show (e.g. a wardrobe change like a theme toggle),
  and verify every inter-line gap with `ffmpeg silencedetect` on the
  DELIVERED file, not the console trace's `atMs` numbers, which don't see
  this padding at all.

- **`DEMO_TRACE` leaked an authenticated launch URL (2026-09-18).** `go()`
  traced everything after the last `/`, which for Salesforce's
  `frontdoor.jsp?otp=…&cshc=…` is the one-time login token plus the org id.
  The token was consumed immediately by the capture browser, but it reached
  a session log. `traceUrlLabel()` now prints the last path segment only.
  Treat ANY trace, log, or error message that might echo a URL as a secret
  channel: hold launch URLs in memory, never print them, and re-read new
  trace lines with that in mind.
- **Salesforce Lightning: the camera must move the dashboard component, not
  `<body>`.** Lightning lays its shell out with absolute/fixed children, so
  `<body>` is 0px tall and the body fallback cannot travel (now also guarded
  in `__plan`). Use the component host as `pageSelector`
  (`'c-a, c-b, …'` works after full navigations, where only one exists) and
  `captionHeight: 140` so the math reserves the caption bar AND Lightning's
  fixed app-navigation bar (98–138px). Custom-element hosts can be
  `display:inline`, which ignores transforms: set `display:block` in the
  capture browser if so.
- **The 97%-opaque caption bar ghosts whatever fixed header sits under it.**
  Lightning's global header (search, setup, avatar, org badge) showed through
  as faint icons. Hide it (`#oneHeader{visibility:hidden}`) in the capture
  browser; keep the app nav bar, whose tab names orient the viewer.
- **Every dashboard lens is not the demo lens.** Pipeline Schedule opened in
  its Executive lens, which in a Developer Edition includes Salesforce's
  stock sample opportunities (non-governed data) — 21 deals where the demo
  expects 8. Switch lens, view, and filters in zero-film-time `run` shots and
  assert the expected count before the first frame.
- **Client state renders before server state.** LWC filter chips, lens
  buttons, and context lines update the instant you click; the results
  arrive later with no spinner. Wait (`observe({untilExpr})` / a real-time
  poll) on server-produced text such as "2 of 2 shown", never on the chip.
- **Warm the filmed clicks.** `@AuraEnabled(cacheable=true)` Apex returned
  in ~500ms cold and ~2ms warm. Apply and clear the filter (open and close
  the drill) in a zero-film-time `run` shot first, and the filmed click
  lands on its result in one frame.
- **Redact per frame, not once.** A one-time rewrite of the owner's name was
  restored by the next re-render. `__redact()` runs from `everyFrameJs`
  before each capture, and `__redactAudit()` must read 0 before each scene.
  Resolve the names to replace at run time (CLI query held in memory), never
  hard-code them in a storyboard.
- **Chirp3-HD pace and pauses.** Charon's default runs ~176–185 wpm, above
  the ~150 wpm "clear and unhurried" target; `googleRate: 0.9` measured
  ~158 wpm. The old Google trim (`stop_periods=-1`, 0.12s) crushed natural
  sentence pauses — trim edges only. Clip lengths also vary ±1s between
  syntheses of the same text, so re-measure after any re-synthesis; never
  reuse timings from an earlier render.
- **A whole-cut Whisper transcript can mis-hear a word from context.** On
  the Salesforce cut, the full mix transcribed "Pilot customers" as "Product
  customers" (four "product" mentions precede it); the isolated segment read
  "Pilot" at 0.98 probability on two models, and the clip-level check had
  passed. Before re-synthesizing a clip over a disputed word, re-transcribe
  just that segment (`ffmpeg -ss … -t …`) with word timestamps.
- **A page-side polling Promise dies with the page.** Passing
  `new Promise(poll…)` to `run()` right after `go()` to an authenticated
  launch URL failed the whole take at 0.0s with "Inspected target navigated
  or closed": the login redirect chain destroyed the execution context
  mid-poll. Take 1 and 2 passed by luck of timing. Use `rec.waitFor(expr)`
  (node-side poll, retries a destroyed context) for any wait that can span
  a navigation. The same failure also printed as `undefined: {...}` because
  `cdp.js` labelled response errors with `msg.method`, which responses never
  carry; errors now name the request method.
- **Never anchor a subject on text your own redaction wrote.** A storyboard
  found the seller's timeline group by its pseudonym; clicking the group's
  toggle re-rendered the headers with the real name, so a real-time wait
  keyed on the pseudonym timed out (the per-frame hook had not run yet).
  Anchor on stable, non-identity content (a governed fictional record name
  inside the group). `rec.waitFor` now also runs `everyFrameJs` before each
  poll so predicates see what the film sees. And when debugging, print
  booleans and counts, not attributes: a `data-key` here was a user record id.
- **Verify sync by measurement, not by eye on stills.** Two timing defects
  (the 20ms floor and the 17ms concat rounding) each looked like a "late
  cue" in one scene. Measure: pick a spotlight onset with
  `signalstats` (mean luma drops when the dim lands) and compare it with the
  word's time in a Whisper transcript of the delivered file. A constant
  offset is a cue bug; an offset that GROWS through the film is a clock bug.
- **Scope delegated agents to their paths, and check what they touched.** A
  delegated code-fix agent edited this demo's narration and storyboard
  (outside its allowed paths) to act on a request it overheard; the edit
  was reasonable but unannounced and doubled the hero line. After any
  delegated run, diff the files it was told not to touch.
- **Live Salesforce Setup traps (2026-10-09 proof take).** Setup's content
  frame is an out-of-process iframe: register frame listeners BEFORE
  `Runtime.enable`, or its first contexts are missed. A grid can keep a 0px
  record-ID column (overflow-clipped cells) and put record ids in row
  checkbox values: visibility must respect clipping, and only displayed input
  values count (redaction must never rewrite hidden form values). The same
  label often exists twice (the App Launcher result and the nav tab "Admin /
  Setup"): scope subjects with `within`. A phrase match must belong to the
  deepest element, or `<body>` "shows" every covered label. Datatable cells
  render in shadow roots, so a `<table>`'s own textContent is empty: find the
  cell, then walk up. Cut only when `__busy()` is false. The Setup gear opens
  a NEW TAB (the recorder films one page): enter Setup with a cut.
- **Live-take checklist.** `dryRun` preflight → record (`strictSubjects`) →
  `scanVideo` → `wordDiff` per clip and on the whole cut → contact sheets
  (`ffmpeg -vf fps=2,scale=640:-1,tile=3x4`). Worked example:
  `demo/video/revenue-execution-setup/proof-take.js` in the Salesforce repo.
- **Salesforce shows its own promotional prompts on its own schedule.** An
  in-app guidance pop-up ("Stay ahead of incidents", bottom right) appeared
  over a Lightning probe and was absent on the next run, so a take can catch
  it at random. Hide vendor floating prompts and dialogs from the per-frame
  hook (fixed-position `[role=dialog]` and prompt containers outside your
  app's components), never by clicking Dismiss, which changes the user's
  prompt state in the org.

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

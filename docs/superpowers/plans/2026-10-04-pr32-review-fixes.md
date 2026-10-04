# PR 32 correctness fixes

User approved fixing the seven reproduced correctness issues and two documentation comments before merge. Baseline: afc361f, branch codex/default-dialogue-captions. Existing local LivePrompts.ts changes are unrelated and must be preserved/excluded from commits.

## Scope and approach
- Preserve contextual foreign-script words and leading neutral prefixes in caption blocks, while retaining genuine rapid language switches and packet-independent text.
- Preserve pre-reactivation source idle time on an eventual speaker handoff; keep same-speaker continuation behavior. Rearm all pending completion deadlines after VAD activation.
- Prevent fresh timed speech from appending into an open-ended completed source; retain genuine late corrections within established intervals.
- Separate already-flushed unknown source text from a newly resolved speaker, including gapless handoffs.
- Unattributed active playback must block completion and queued language replacement until playback ends or is safely associated. Do not invent delivery attribution.
- Correct documentation counts and historical device-verification scope.
- Defer full-history performance optimization; retain existing audio/model/accounting design and no paid speech tests or phone reload.

## Tasks
- [x] Add failing regressions for all seven cases plus continuation, delayed packets, lifecycle and playback controls.
- [x] Implement minimal routing, completion and caption corrections.
- [x] Run focused tests, full units/integration, typecheck/lint/build, and browser regressions.
- [x] Fresh read-only review and fix material findings.
- [x] Commit only task files and update existing PR (260e137).

## Verification
Initial assessment reproduced all seven cases against real project classes in Vitest, using fake media/timers. Scratch harness and failure logs are in .data/pr32-review-all-reproduction.log. Full-history optimization remains deferred based on the explicitly accepted review decision.

Final local verification (2026-10-05):
- RED: 11 failing parameterized regressions covering the seven defects before production changes (`.data/pr32-fixes-red.log`).
- Focused controller/caption tests: 220 passed; full unit/integration suite: 59 files, 1254 passed (`.data/pr32-fixes-all-unit.log`).
- Chromium/WebKit: 80 passed, 3 existing skips, including mixed-script captions and queued language replacement during unattributed audio (`.data/pr32-fixes-browser.log`). An initial browser run found a case-sensitive test selector typo; correcting it made both engines pass.
- API/web typecheck and lint, production/PWA build, and diff whitespace checks passed. Caption screenshot inspected.
- Fresh read-only review found short host-word/brand, unspaced Chinese, mixed-sentence, and exact-start correction edge cases; all were fixed and covered. Final review reported no findings.
- Tests ran with the preserved, unrelated local `LivePrompts.ts` edit. That file is excluded from this commit; GitHub CI will separately verify the committed tree. No phone reload or paid speech session was performed.

Language inference remains heuristic: a one-word script switch is absorbed only when neighbouring sentence context reliably supports the host language. Ambiguous fragments remain hidden. Full-history caption processing remains a separate performance follow-up.

## Follow-up review (2026-10-05)

Five further cases were independently reproduced and approved for correction: hidden complete short replies, embedded multiword names, short disjoint-script handoffs, transcript-first fresh speech, and buffered packets spanning historical source intervals.

- Share script evidence between the caption assembler and router for completed single-script phrases; preserve conservative handling of unfinished or shared-script text.
- Extend contextual caption correction to multiword spans surrounded by the same host language, while retaining complete opposite-language sentences.
- Route each resolved packet by its own timestamps. Reject forward packets from open-ended retired sources regardless of VAD order or an active source's untimed prefix.
- Initial targeted RED run: 13 failures, 230 existing tests passed. Review added an untimed-prefix regression, also reproduced before its correction.
- Final targeted run: 246 tests passed across the controller, caption assembler and router. Web typecheck and lint passed. Unrelated local prompt changes remain excluded.
- Per user instruction, the full local suite and browser run were not repeated; full validation is delegated to CI without waiting for completion.

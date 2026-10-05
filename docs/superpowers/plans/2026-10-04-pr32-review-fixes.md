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

## Neutral packet ownership follow-up (2026-10-05)

Corrected review comment 4178654909: a timed neutral packet inside observed historical source audio retains that source even when buffered with the other language. A gap before a later source needs matching group-language evidence; an unknown opening must not acquire an author from a provisional interval alone. Untimed or genuinely forward prefixes stay with new speech. Neutral corrections do not confirm resumed speech or clear its saved idle timestamp.

Eight added regressions cover both language directions, punctuation and numbers, subsequent late corrections, missing timestamps, new forward prefixes, bounded historical gaps, and idle preservation. Targeted controller/router suite: 220 passed. Web typecheck and lint passed; full tests remain delegated to CI.

During this work, four newer GitHub findings were reproduced separately: short replies disappearing after neutral tails (4178672411), sentence-final multiword names (4178672863), mixed-timing history reordering (4178674018), and foreign brand suffixes creating operational handoffs (4178674023). The user subsequently authorized fixing all four before merge.

## Sentence and mixed-timing follow-up (2026-10-05)

- Classify context using the whole sentence, then qualify adjacent same-side script spans within that sentence before combining it with new tails. Completed short replies retain attribution when neutral or unfinished text arrives.
- Use reliable host-sentence evidence for sentence-final multiword names. Keep independently reliable opposite-language sentences and embedded short host words intact.
- Provide the active source's unfinished sentence to the operational router so a packet such as `Google.` can complete that source instead of forcing a handoff. Very short complete script-resolved replies keep their side despite weak statistical language evidence. This remains heuristic, not speaker diarization.
- Keep known timestamp order when timing is missing on some packets. Untimed prefixes remain first; untimed tails stay attached to the latest known timed group at arrival. Ordering is stable for equal timestamps and does not mutate the caller's array.
- Seven initial regression cases failed before these changes; review additionally found short-host-span and short-interruption cases, also reproduced before correction.
- Final targeted verification: 362 tests passed in the controller, reducer, router, caption assembler, turn buffer and fragment-ordering files. Two browser regressions were added for CI; the full local suite/browser run is intentionally not repeated and CI completion is not awaited.

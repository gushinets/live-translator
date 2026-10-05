# Independent dialogue captions: bounded phone prototype

> Follow-up (2026-10-04): the user accepted the phone-tested mode as the default. The [default-caption plan](../plans/2026-10-04-default-dialogue-captions.md) supersedes the opt-in URL and unresolved-text disclosure below: all URLs use caption blocks, unresolved text stays buffered internally and is hidden until its language resolves. The remaining prototype evidence and limitations below are historical context.


The user's phone test found good translated audio but broken captions: tiny suffixes on both panes, split names, and unrelated waiting/repeat rows. Both own speech and translated partner speech must remain visible.

Prototype scope: an opt-in `?captions=blocks` view on the existing product screen. Assemble input and output transcript streams independently of service `Turn` objects. Keep transport, model instructions, interruption, accounting and recovery unchanged. Do not promise exact input/output alignment without provider correlation IDs.

Each visible block has a stream kind, text, language and recipient side. Input in pane A's language is A's own speech; output in that language is translated partner speech. The same rule applies to B. No paired source/translation row is required. Network idle, VAD silence and service-turn completion never end a caption paragraph. A language change creates a new paragraph. Preserve the exact received text, including split words and names. Process the accumulated stream so packet boundaries do not determine paragraphs. Preserve fragment timestamps for ordering within a stream; cross-stream chronology uses first arrival, not inferred correlation.

For distinct writing systems, use configured scripts to locate language changes. For languages sharing a script, use the existing ELD dependency on complete sentence evidence; uncertain text remains unassigned. This prototype does not claim reliable same-script speaker changes without punctuation, code switching or isolated proper-name attribution. Test these limitations explicitly rather than guessing authors.

Unassigned text remains available once in a collapsed neutral area, outside participant panes. No empty waiting rows. Caption view does not display a turn-correlation-only Repeat prompt; actual lifecycle recovery controls and transport errors remain visible. Suspension/language changes seal existing stream context; a new conversation clears it. Old captions retain their original language.

Validate a synthetic reconstruction of the courier dialogue with multiple packet splits and >600ms gaps, fast A-B-A, delayed output, unresolved short text and lifecycle reset. This is a reconstruction from screenshots, not a recording of the failed session. Run browser checks and prepare USB preview; real speech quality remains for the user's test.

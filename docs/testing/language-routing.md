# Fixed-language routing (2026-09-19)

Supersedes the original soft hints and A/B alternation. The browser's preferred supported language sets A; the user chooses B once, and that choice is saved for later conversations.

- On first start, Spanish is preselected for B. Spanish, English, French, German, Italian and Portuguese lead the list; the other languages follow in Russian alphabetical order. Later starts use the saved B language with one button press.
- The user can correct A on the language-choice screen if the browser preference is wrong or unsupported. A and B must differ.
- GPT Live receives the fixed pair, bidirectional translation instructions, and no next-speaker prediction. No speech samples are recorded during setup.
- During conversation, B can be changed from the top button. A change during a turn takes effect after that turn closes; the next steering uses the new pair.
- The UI independently classifies accumulated input transcript text with `eld/extrasmall` (60 supported languages). Detection uses the complete language set, so third-language speech is not forced into A/B. It runs locally and makes no extra API calls.
- The current list follows the text detector's language set. Auditing GPT-Live 1 language coverage and location-based suggestions are deferred.
- A turn begins without a speaker. As text arrives its dominant language determines A/B. Silence, playback and completed turns cannot select a side.
- Short, ambiguous, unsupported or third-language speech can remain unassigned. The source text is retained internally, while both panes show waiting until a side is determined. This is language routing, not voice identification: a person switching completely to the other configured language will be routed to that language's side.

Manual speaker assignment, participant-header buttons and the tap-to-correct hint were removed on 2026-10-02. Language labels are static; touching or scrolling a pane does not reassign a speaker.

## Verification

Automated regression covers B-A-A-A-B-B, shared-script languages (English/Spanish), unknown `OK`, fixed languages after suspension, direct startup, language changes, and the existing audio lifecycle suite.

Browser tests use mocked Live events and the real local detector. Model translation quality and acoustic behavior must still be checked with real speech; transcript-only tests cannot establish these.

Device acceptance: test Russian/English and English/Spanish with B starting, consecutive A turns, consecutive B turns, short names/numbers, a pause/resume, and reading/scrolling captions. Repeat under speaker playback to check echo handling. Do not require automatic side identification for ambiguous text or overlapping speakers.

# Fixed-language routing (2026-09-19)

Supersedes the original soft hints and A/B alternation. Approved flow: two speech samples, then fixed languages for the session.

- A records a complete sentence, saves it; B then starts a separate sample and saves it. The microphone and Live input are paused between samples. Uncertain detection, too little text, or identical languages cannot finish setup.
- Both detected languages are shown before interpreter activation. Cancel restarts setup if either was identified incorrectly. Device locale does not assign a language.
- GPT Live receives the fixed pair, bidirectional translation instructions, and no next-speaker prediction. Setup samples must not be replayed.
- The UI independently classifies accumulated input transcript text with `eld/extrasmall` (60 supported languages). Detection uses the complete language set, so third-language speech is not forced into A/B. It runs locally and makes no extra API calls.
- A turn begins without a speaker. As text arrives its dominant language determines A/B. Silence, playback and completed turns cannot select a side. Manual correction wins for that utterance; it does not change either fixed language.
- Short, ambiguous, unsupported or third-language speech can remain unassigned. Both panes retain the text without pretending to know the speaker and offer manual correction. This is language routing, not voice identification: a person switching completely to the other configured language will be routed to that language's side.

## Verification

Automated regression covers B-A-A-A-B-B, shared-script languages (English/Spanish), unknown `OK`, fixed languages after suspension, manual correction, sample validation, ignored late setup fragments, cancellation during setup, and the existing audio lifecycle suite.

Browser tests use mocked Live events and the real local detector. The real Live fixture test now records A and B separately. Model translation quality and acoustic behavior must still be checked with real speech; transcript-only tests cannot establish these.

Device acceptance: test Russian/English and English/Spanish with B starting, consecutive A turns, consecutive B turns, short names/numbers, a pause/resume, and a manual correction. Repeat under speaker playback to check echo handling. Do not require automatic side identification for ambiguous text or overlapping speakers.

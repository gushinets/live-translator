---
version: alpha
name: "Live Translator"
description: "A quiet, low-glare interpreter interface shared by two people on one phone."
colors:
  background: "#0F0D0B"
  surface: "#1C1713"
  surfaceStrong: "#2A2218"
  text: "#F7F0E4"
  muted: "#8F8374"
  primary: "#F4EAD5"
  danger: "#7A2E1F"
typography:
  interface:
    fontFamily: "Bahnschrift, Segoe UI, system-ui, sans-serif"
  conversation:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, serif"
rounded:
  DEFAULT: "0.95rem"
  card: "1.4rem"
spacing:
  control: "0.82rem"
  screen: "1rem"
components:
  primaryButton: {}
  secondaryButton: {}
  setupCard: {}
  participantPane: {}
---

# Live Translator Design System

## Overview

The product should feel like a dedicated interpreter device placed quietly between two people, not a marketing page or chat application. The memorable signature is the physically mirrored two-person conversation view; all setup UI stays restrained. Each participant reads their pane in their selected language; shared controls and setup follow the owner's selected language.

Runtime CSS is canonical. This file mirrors the shared values in `apps/web/src/screens/ContextScreen.css` and `ConversationScreen.css`; it does not generate them.

## Colors

Use warm near-black surfaces to reduce glare and warm off-white text for contrast. The pale primary color marks the single main action. Red is reserved for errors and ending a conversation.

## Typography

Interface labels use the compact Bahnschrift stack with Russian-capable fallbacks. Spoken and translated content uses the serif conversation stack. Avoid decorative headings, uppercase promotional kickers, and long explanatory paragraphs.

## Layout

Setup is a single narrow column respecting phone safe areas. Conversation mode fills the phone and gives both participants equal space; Participant B remains rotated 180 degrees. Current speech always dominates history.

Every setup, loading, and recovery screen keeps the small “Live Translator” name at the top. When settings are available, their control shares that row. The active conversation has no app header.

## Elevation & Depth

Use tonal surfaces and borders. Setup may use one shallow card shadow; conversation panes stay flat so text remains dominant.

## Shapes

Controls use compact rounded rectangles, not pills. The setup card may use the larger card radius.

## Components

Primary actions are full-width, at least 44px high, and stable while disabled. Secondary actions remain visibly subordinate. Focus is always visible. Motion communicates pressing or state only and is removed for reduced-motion users.

Ending an active conversation keeps its toolbar button and both dialogue panes in place. The button becomes disabled and shows the localized ending label without changing dimensions; only after closure does setup return. Retained-session recovery remains available for unconfirmed closure.

Interlocutor languages use full-width radio rows sized for a thumb. At least four priority languages fit in the initial scroll area; the list fills the available space and reveals part of the next row to signal scrolling while the main action stays at the bottom. The less frequent owner-language correction keeps its native `<select>`.

## Do's and Don'ts

- **Do:** keep localized control copy short and literal.
- **Do:** preserve one obvious primary action per setup step.
- **Don't:** add slogans, feature descriptions, or decorative badges to the setup flow.
- **Don't:** let status labels compete with the live translation.

## Language setup and conversation behavior

At first launch the language list is already open: A comes from the device/browser locale and can be corrected; Spanish is preselected for B. Spanish, English, French, German, Italian and Portuguese lead the list; the remaining languages are sorted by their localized names. The large bottom action saves B and starts translation. Later starts show one centered action, with a top-right settings control reopening the language list. No speech sample or context is required. The conversation toolbar reopens the same list for B; a change during a turn applies after the turn closes. A and B must differ. The priority is fixed until the separate location-suggestion feature is built.

`SideResolver` classifies incoming transcript text locally; model playback is never an identity signal. Neither participant has an expected turn. Both panes show their localized speak status when input is ready, and display their fixed languages. Unknown source speech is hidden behind a waiting status with a manual correction hint. Manual assignment only affects that utterance.

ANY-558 / ANY-559: each pane shows one text per utterance: its owner's original speech or the other participant's translation. This applies to the active utterance and the capped history of three turns. Missing translations show a waiting status, never foreign source text. Every visible utterance has a compact localized “Я” / “Он” author prefix relative to the pane; translation keeps the source speaker's authorship and correction updates both panes. Changing B's language keeps old history text as-is and changes subsequent text and B's interface.

The shared dictionary in `apps/web/src/i18n/messages.ts` owns English, French, Italian, German, Spanish, Russian and Portuguese interface copy. Other conversation languages use English UI while speech translation keeps the selected language. Pane statuses, author labels, language names and correction accessible names follow the pane's UI locale. Setup, common buttons, errors and retained-session recovery follow A's locale. Recovery messages preserve all blocking, retry and paid-attempt disclosures; localization does not change session/accounting behavior.

Runtime verification: `SessionController.test.ts` covers B-first and repeated turns, fixed languages after suspension, unknown speech and cancellation; `tests/e2e/mocked-conversation.spec.ts` checks the same routing in a browser. Existing warm surfaces, typography, focus behavior and rotated B pane are retained.

The existing language set comes from the text detector; it is not a verified exhaustive GPT-Live 1 language catalog. Auditing model language coverage is deferred.

The conversation language picker reflects a queued choice before it takes effect. A rejected change leaves the picker open with a retry message; the saved preference remains available for the next conversation. Changes never reopen capture after lifecycle suspension or a concurrent correction. A queued choice is included in the retained snapshot when backgrounding discards the unfinished turn.

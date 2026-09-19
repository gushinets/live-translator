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

The product should feel like a dedicated interpreter device placed quietly between two people, not a marketing page or chat application. It is a Russian-owner mobile product for the current prototype. The memorable signature is the physically mirrored two-person conversation view; all setup UI stays restrained.

Runtime CSS is canonical. This file mirrors the shared values in `apps/web/src/screens/ContextScreen.css` and `ConversationScreen.css`; it does not generate them.

## Colors

Use warm near-black surfaces to reduce glare and warm off-white text for contrast. The pale primary color marks the single main action. Red is reserved for errors and ending a conversation.

## Typography

Interface labels use the compact Bahnschrift stack with Russian-capable fallbacks. Spoken and translated content uses the serif conversation stack. Avoid decorative headings, uppercase promotional kickers, and long explanatory paragraphs.

## Layout

Setup is a single narrow column respecting phone safe areas. Conversation mode fills the phone and gives both participants equal space; Participant B remains rotated 180 degrees. Current speech always dominates history.

## Elevation & Depth

Use tonal surfaces and borders. Setup may use one shallow card shadow; conversation panes stay flat so text remains dominant.

## Shapes

Controls use compact rounded rectangles, not pills. The setup card may use the larger card radius.

## Components

Primary actions are full-width, at least 44px high, and stable while disabled. Secondary actions remain visibly subordinate. Focus is always visible. Motion communicates pressing or state only and is removed for reduced-motion users.

## Do's and Don'ts

- **Do:** keep Russian control copy short and literal.
- **Do:** preserve one obvious primary action per setup step.
- **Don't:** add slogans, feature descriptions, or decorative badges to the setup flow.
- **Don't:** let status labels compete with the live translation.

## Language setup and conversation behavior

`BootstrapPrompt` owns the two-sample setup flow: A records a full sentence, saves it, then B explicitly starts their own sample. Both detected languages are shown before starting the conversation and remain fixed until the session ends. Setup cannot be skipped; ambiguous or identical languages require another sample. Cancellation remains available during setup and startup.

`SideResolver` classifies incoming transcript text locally; model playback is never an identity signal. Neither participant has an expected turn. Both panes show ГОВОРИТЕ when input is ready, and display their fixed languages. Unknown source speech is presented without assigning it to a side, with a manual correction hint. Manual assignment only affects that utterance.

Runtime verification: `SessionController.test.ts` covers B-first and repeated turns, fixed languages after suspension, unknown speech and cancellation; `tests/e2e/mocked-conversation.spec.ts` checks the same routing in a browser. Existing warm surfaces, typography, focus behavior and rotated B pane are retained.

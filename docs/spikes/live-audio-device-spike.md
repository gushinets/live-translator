# Live audio device spike

Date: 2026-09-13

## Gate status

**OPEN — real-device validation has not been run.**

This implementation environment has no iPhone or Android hardware. `OPENAI_API_KEY` is also not set, so no live OpenAI session or Desktop transport check was attempted. The rows below are intentionally `NOT RUN`; they are not pass results.

## Device matrix

| Device | Browser mode | Connect | Mic | Remote audio | session.closed | Notes |
|---|---|---|---|---|---|---|
| iPhone — model not available | Safari | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No iPhone hardware is available in the agent environment. |
| iPhone — model not available | Home Screen PWA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No iPhone hardware is available in the agent environment. |
| Android — model not available | Chrome | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No Android hardware is available in the agent environment. |
| Android — model not available | Installed PWA | NOT RUN | NOT RUN | NOT RUN | NOT RUN | No Android hardware is available in the agent environment. |

## Implemented test path

The DEV-only screen provides:

- `Connect` and `End`;
- connection and session state;
- a remote audio element;
- the microphone track settings dump;
- WebRTC connection, ICE gathering, and data-channel diagnostics;
- explicit reporting of whether graceful close received `session.closed`.

Microphone capture requests these binding-spec values verbatim:

```ts
{
  audio: {
    echoCancellation: true,
    noiseSuppression: false,
  },
}
```

The production bundle excludes the DEV spike screen. Automated tests with injected fakes verified the DEV controls, session state, remote stream attachment, microphone/transport diagnostics, graceful close result, and production-hidden path. They do not establish real-device compatibility or live OpenAI behavior.

## Human follow-up required

Run each matrix row with a real OpenAI session and replace `NOT RUN` only from observed evidence. Verify microphone permission, `session.started`, microphone audio delivery, captions and audible remote audio, then `session.close` followed by `session.closed` before teardown. Keep this gate open until both platforms pass in browser and installed-PWA modes.

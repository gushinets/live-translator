# Real-provider audio inputs

- `participant-a.mp3.b64`: existing Russian greeting fixture.
- `participant-b-en.wav.b64`: English “The entrance is on the right.” Generated
  locally on Windows with System.Speech and Microsoft Zira Desktop (en-US),
  PCM16 mono at 22050 Hz. The checked-in bytes are the test input; running tests
  does not require Windows or synthesize speech.
- `participant-b.mp3.b64`: retained legacy fixture. In the 2026-11-06 live run its
  input transcript was Spanish (“La entrada esta a la derecha”); it is no longer
  used as the English input in the RU/EN conversation test.

Audio is injected into a native Web Audio MediaStream and sent over real WebRTC.
These fixtures verify the application/provider flow, not physical microphone,
speaker echo, accent coverage, or general translation quality.

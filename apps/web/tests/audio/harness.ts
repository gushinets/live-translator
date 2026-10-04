import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConversationScreen } from "../../src/screens/ConversationScreen";
import { createInitialSession } from "../../src/session/SessionState";
import { AudioController } from "../../src/audio/AudioController";

declare global {
  interface Window { audioHarness: {
    controller: AudioController; context: AudioContext; mic: GainNode; remote: GainNode;
    readRms(): number; errors: number; replaceRemote(): void;
  }; }
}
document.querySelector("#start")!.addEventListener("click", async () => {
  const context = new AudioContext();
  const microphone = context.createMediaStreamDestination();
  const remoteStream = context.createMediaStreamDestination();
  function tone(frequency: number, destination: AudioNode) {
    const oscillator = context.createOscillator(); oscillator.frequency.value = frequency;
    const gain = context.createGain(); gain.gain.value = 0;
    oscillator.connect(gain).connect(destination); oscillator.start();
    return gain;
  }
  const mic = tone(320, microphone);
  const remote = tone(850, remoteStream);
  const controller = new AudioController({
    createAudioContext: () => context,
    getUserMedia: async () => microphone.stream,
  });
  await controller.primeOutput();
  await controller.startCapture();
  controller.attachRemoteStream(remoteStream.stream);
  // Keep this automatic check silent on the host; measure the processed stream.
  controller.audioElement.volume = 0;
  await controller.primeOutput();
  controller.setOutputAudible(true);
  const analyser = context.createAnalyser();
  function connectMeter() {
    context.createMediaStreamSource(controller.audioElement.srcObject as MediaStream).connect(analyser);
  }
  connectMeter();
  const samples = new Float32Array(analyser.fftSize);
  window.audioHarness = {
    controller, context, mic, remote, errors: 0,
    readRms() {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    },
    replaceRemote() {
      controller.attachRemoteStream(remoteStream.stream);
      connectMeter();
      void controller.primeOutput();
    },
  };
  controller.onPlaybackBufferError = () => { window.audioHarness.errors++; };
  const listeners = new Set<() => void>();
  const uiController = {
    session: { ...createInitialSession({ side: "A", language: "ru", hasAcceptedConversationSpeech: true },
      { side: "B", language: "en", hasAcceptedConversationSpeech: true }), state: "listening" as const },
    inputReady: true, nonInterrupting: false,
    setNonInterrupting(enabled: boolean) {
      controller.setNonInterrupting(enabled);
      this.nonInterrupting = enabled;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async endConversation() { controller.setOutputAudible(false); },
    async resumeFromSourceTimeout() {},
  };
  const root = document.createElement("div");
  document.querySelector("#start")!.remove();
  document.body.append(root);
  createRoot(root).render(createElement(ConversationScreen, { controller: uiController, onChangeLanguage: () => {} }));

});

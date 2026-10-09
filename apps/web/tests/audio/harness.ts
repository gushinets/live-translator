import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConversationScreen } from "../../src/screens/ConversationScreen";
import { createInitialSession } from "../../src/session/SessionState";
import { AudioController } from "../../src/audio/AudioController";

declare global {
  interface Window { audioHarness: {
    controller: AudioController; context: AudioContext; mic: GainNode; remote: GainNode;
    readRms(): number; errors: number; replaceRemote(): void;
    useWebRtc(): Promise<void>; receivedSamples(): Promise<number>;
    readReceivedMicRms(): number;
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
  await controller.playOutput();
  controller.setOutputAudible(true);
  const analyser = context.createAnalyser();
  function connectMeter() {
    context.createMediaStreamSource(controller.audioElement.srcObject as MediaStream).connect(analyser);
  }
  connectMeter();
  const samples = new Float32Array(analyser.fftSize);
  const receivedMicAnalyser = context.createAnalyser();
  const receivedMicSamples = new Float32Array(receivedMicAnalyser.fftSize);
  let microphoneDecoder: HTMLAudioElement | null = null;
  let rtcReceiver: RTCPeerConnection | null = null;
  const rtcPeers: RTCPeerConnection[] = [];
  window.addEventListener("pagehide", () => {
    for (const peer of rtcPeers) peer.close();
    if (microphoneDecoder) { microphoneDecoder.pause(); microphoneDecoder.srcObject = null; }
  });
  window.audioHarness = {
    controller, context, mic, remote, errors: 0,
    readRms() {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    },
    async useWebRtc() {
      const sender = new RTCPeerConnection();
      const receiver = new RTCPeerConnection();
      rtcPeers.push(sender, receiver);
      rtcReceiver = receiver;
      const received = new Promise<MediaStream>(resolve => {
        receiver.ontrack = event => resolve(new MediaStream([event.track]));
      });
      const receivedMic = new Promise<MediaStream>(resolve => {
        sender.ontrack = event => resolve(new MediaStream([event.track]));
      });
      for (const track of remoteStream.stream.getTracks()) sender.addTrack(track, remoteStream.stream);
      // The other peer receives the actual microphone track used by LiveClient.
      for (const track of microphone.stream.getTracks()) receiver.addTrack(track, microphone.stream);
      async function gather(peer: RTCPeerConnection, description: RTCSessionDescriptionInit) {
        await peer.setLocalDescription(description);
        if (peer.iceGatheringState !== "complete") await new Promise<void>(resolve => {
          peer.addEventListener("icegatheringstatechange", () => {
            if (peer.iceGatheringState === "complete") resolve();
          });
        });
        return peer.localDescription!;
      }
      await receiver.setRemoteDescription(await gather(sender, await sender.createOffer()));
      await sender.setRemoteDescription(await gather(receiver, await receiver.createAnswer()));
      controller.attachRemoteStream(await received);
      connectMeter();
      await controller.playOutput();
      const sentMic = await receivedMic;
      microphoneDecoder = document.createElement("audio");
      microphoneDecoder.muted = true; microphoneDecoder.srcObject = sentMic;
      await microphoneDecoder.play();
      context.createMediaStreamSource(sentMic).connect(receivedMicAnalyser);
    },
    readReceivedMicRms() {
      receivedMicAnalyser.getFloatTimeDomainData(receivedMicSamples);
      return Math.sqrt(receivedMicSamples.reduce((sum, x) => sum + x * x, 0) / receivedMicSamples.length);
    },
    async receivedSamples() {
      const stats = await rtcReceiver!.getStats();
      let samples = 0;
      stats.forEach(report => { if (report.type === "inbound-rtp" && report.kind === "audio") samples += report.totalSamplesReceived ?? 0; });
      return samples;
    },
    replaceRemote() {
      controller.attachRemoteStream(remoteStream.stream);
      connectMeter();
      void controller.playOutput();
    },
  };
  controller.onPlaybackBufferError = () => { window.audioHarness.errors++; };
  const listeners = new Set<() => void>();
  const uiController = {
    session: { ...createInitialSession({ side: "A", language: "ru", hasAcceptedConversationSpeech: true },
      { side: "B", language: "en", hasAcceptedConversationSpeech: true }), state: "listening" as const },
    captionBlocks: [], inputReady: true,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async endConversation() { controller.setOutputAudible(false); },
    async resumeFromSourceTimeout() {},
  };
  const root = document.createElement("div");
  document.querySelector("#start")!.remove();
  document.body.append(root);
  createRoot(root).render(createElement(ConversationScreen, { controller: uiController }));

});

export async function waitForIceComplete(
  peer: RTCPeerConnection,
  timeoutMs = 10_000,
): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      peer.removeEventListener("icegatheringstatechange", onChange);
      reject(new Error("Unable to establish live connection"));
    }, timeoutMs);
    function onChange() {
      if (peer.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    }
    peer.addEventListener("icegatheringstatechange", onChange);
    onChange();
  });
}

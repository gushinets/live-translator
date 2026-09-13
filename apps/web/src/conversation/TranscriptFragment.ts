/**
 * A raw transcript fragment as it arrives over the Live data channel.
 * Binding spec 1.2.1 §12.1.
 *
 * Fragments are stored as-is and are regroupable: transcript deltas are not
 * authoritative semantic turns, so timing metadata must not be discarded.
 */
export interface TranscriptFragment {
  id: string;
  text: string;
  startMs?: number;
  endMs?: number;
  receivedAtMs: number;
}

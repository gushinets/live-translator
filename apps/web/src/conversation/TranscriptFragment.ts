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

/** Keep known timing order; untimed tails follow the latest known text at arrival. */
export function orderTranscriptFragments(fragments: TranscriptFragment[]): TranscriptFragment[] {
  const prefix: TranscriptFragment[] = [];
  const groups: Array<{ startMs: number; fragments: TranscriptFragment[] }> = [];
  let tail: typeof groups[number] | undefined;
  for (const fragment of fragments) {
    if (fragment.startMs === undefined) {
      (tail?.fragments ?? prefix).push(fragment);
    } else {
      const group = { startMs: fragment.startMs, fragments: [fragment] };
      groups.push(group);
      if (!tail || group.startMs >= tail.startMs) tail = group;
    }
  }
  return [...prefix, ...groups.sort((a, b) => a.startMs - b.startMs).flatMap(group => group.fragments)];
}

/** Untimed prefixes do not hide the earliest observed audio timestamp. */
export function earliestFragmentStart(fragments: readonly TranscriptFragment[] = []): number | undefined {
  const starts = fragments.flatMap(fragment => fragment.startMs === undefined ? [] : [fragment.startMs]);
  return starts.length ? Math.min(...starts) : undefined;
}

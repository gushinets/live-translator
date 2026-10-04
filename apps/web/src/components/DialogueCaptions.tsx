import type { DialogueBlock } from "../conversation/DialogueTranscript";
import { translate, uiLocale } from "../i18n/messages";

export function DialogueCaptions({ blocks, language }: { blocks: readonly DialogueBlock[]; language?: string }) {
  const locale = uiLocale(language);
  return <ol className="participant-recent" data-testid="dialogue-captions">
    {blocks.filter(block => block.text.trim()).map(block => <li key={block.id} className="recent-turn">
      <span className="turn-author">{translate(block.kind === "input" ? "Я" : "Он", locale)}: </span>
      <span className="recent-turn-primary" lang={block.language}>{block.text.trim()}</span>
    </li>)}
  </ol>;
}

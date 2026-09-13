/**
 * Provenance of an explicit language hint. Binding spec 1.2.1 §5.1.
 */
export type LanguageHintSource = "device_locale" | "bootstrap";

/**
 * Per-participant profile. Binding spec 1.2.1 §5.1.
 *
 * The client stores only explicit, provenance-tagged hints; there is no
 * client-side language confidence score in MVP v1.2.1.
 */
export interface ParticipantProfile {
  side: "A" | "B";
  initialLanguageHint?: string;
  languageHintSource?: LanguageHintSource;
  hasAcceptedConversationSpeech: boolean;
}

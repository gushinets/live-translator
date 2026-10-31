export interface ClientMetadata { clientBuildId?: string; interpreterPromptId?: string; }

/** Diagnostic headers are optional, bounded, client-reported, and never block usage ingestion. */
export function readClientMetadata(build: unknown, prompt?: unknown): ClientMetadata {
  return {
    ...(typeof build === "string" && /^[a-zA-Z0-9._:-]{1,64}$/.test(build) ? { clientBuildId: build } : {}),
    ...(typeof prompt === "string" && /^sha256:[a-f0-9]{64}$/.test(prompt) ? { interpreterPromptId: prompt } : {}),
  };
}

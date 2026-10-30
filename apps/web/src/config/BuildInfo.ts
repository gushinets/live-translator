declare const __INTERPRETER_PROMPT_ID__: string;

/** The actual hashed JS artifact identifies the client even without .git in Docker. */
export const CLIENT_BUILD_ID = import.meta.env?.PROD
  ? `bundle:${new URL(import.meta.url).pathname.split("/").at(-1)}`
  : "development";

/** Fingerprint of the normalized prompt module, not conversation content. */
export const INTERPRETER_PROMPT_ID = typeof __INTERPRETER_PROMPT_ID__ === "string"
  ? __INTERPRETER_PROMPT_ID__ : undefined;

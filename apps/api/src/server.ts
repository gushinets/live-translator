import { createApp } from "./app.js";

const PORT = 3001;

if (
  process.env.NODE_ENV === "production" &&
  (process.env.OPENAI_API_KEY === undefined ||
    process.env.OPENAI_API_KEY.trim().length === 0)
) {
  throw new Error("OPENAI_API_KEY is required");
}

createApp().listen(PORT, "0.0.0.0", () => {
  console.log(`Live Translator API listening on port ${PORT}`);
});

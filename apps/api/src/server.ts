import { createApp } from "./app";

const PORT = 3001;

createApp().listen(PORT, "127.0.0.1", () => {
  console.log(`Live Translator API listening on http://127.0.0.1:${PORT}`);
});

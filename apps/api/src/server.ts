import { createApp } from "./app.js";
import { apiConfig } from "./config.js";
import { installShutdownSignals, startApiServer } from "./serverLifecycle.js";

const PORT = 3001;
if (process.env.NODE_ENV === "production" && !process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY is required");
const lifecycle = startApiServer(createApp(), { port: PORT, drainMs: apiConfig.serverShutdownDrainMs, timeoutMs: apiConfig.serverShutdownTimeoutMs });
lifecycle.server.on("listening", () => console.log(`Live Translator API listening on port ${PORT}`));
installShutdownSignals(lifecycle, apiConfig.serverShutdownTimeoutMs);

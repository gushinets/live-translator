import { lazy, Suspense } from "react";
import { ContextScreen } from "../screens/ContextScreen";
import type { DevSpikeSession } from "./DevSpikeScreen";

const DevSpikeScreen = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import("./DevSpikeScreen");
      return { default: module.DevSpikeScreen };
    })
  : null;

export interface AppProps {
  isDevelopment?: boolean;
  createSpikeSession?: () => DevSpikeSession;
}

export function App({
  isDevelopment = import.meta.env.DEV,
  createSpikeSession,
}: AppProps = {}) {
  const shouldShowSpikeScreen = import.meta.env.DEV && isDevelopment;

  return (
    <main>
      <h1>Live Translator</h1>
      {shouldShowSpikeScreen && DevSpikeScreen !== null ? (
        <Suspense fallback={<p>Loading DEV transport spike…</p>}>
          <DevSpikeScreen createSession={createSpikeSession} />
        </Suspense>
      ) : (
        <ContextScreen />
      )}
    </main>
  );
}

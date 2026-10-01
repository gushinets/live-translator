import { translate } from "../i18n/messages";

export function ErrorOverlay({ message, language }: { message: string; language?: string }) {
  return (
    <div className="error-overlay" role="alert">
      {translate(message, language)}
    </div>
  );
}

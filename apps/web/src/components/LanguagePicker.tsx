import { useState, type Ref } from "react";
import { languageName, supportedLanguageCodes } from "../side/SideResolver";

const preferred = ["es", "en", "fr", "de", "it", "pt"];
const choices = [
  ...preferred,
  ...supportedLanguageCodes().filter(code => !preferred.includes(code))
    .sort((a, b) => languageName(a).localeCompare(languageName(b), "ru")),
];

export function LanguagePicker({ ownerLanguage, interlocutorLanguage, onConfirm, onCancel, busy = false,
  allowOwnerChange = true, startAction = false, primaryActionRef }: {
  ownerLanguage?: string;
  interlocutorLanguage?: string;
  onConfirm: (owner: string, interlocutor: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  allowOwnerChange?: boolean;
  startAction?: boolean;
  primaryActionRef?: Ref<HTMLButtonElement>;
}) {
  const [owner, setOwner] = useState(ownerLanguage ?? "");
  const [interlocutor, setInterlocutor] = useState(interlocutorLanguage ?? "es");
  const [editOwner, setEditOwner] = useState(ownerLanguage === undefined);
  const valid = owner !== "" && interlocutor !== "" && owner !== interlocutor;
  return (
    <section className="language-picker" aria-labelledby="language-picker-title">
      {startAction ? <h1 id="language-picker-title" className="bootstrap-title">Язык собеседника</h1>
        : <h2 id="language-picker-title" className="bootstrap-title">Язык собеседника</h2>}
      <p className="language-picker-owner">
        Ваш язык: {owner ? languageName(owner) : "не определён"}{" "}
        {allowOwnerChange && !editOwner ? <button className="setup-text-action" type="button" onClick={() => setEditOwner(true)}>
          Изменить
        </button> : null}
      </p>
      {editOwner ? <label className="setup-field">
        <span className="setup-field-label">Ваш язык</span>
        <select aria-label="Ваш язык" value={owner} onChange={event => setOwner(event.target.value)}>
          <option value="">Выберите язык</option>
          {choices.map(code => <option key={code} value={code}>{languageName(code)}</option>)}
        </select>
      </label> : null}
      <fieldset className="language-picker-fieldset">
        <legend className="visually-hidden">Язык собеседника</legend>
        <div className="language-picker-options">
          {choices.map(code => <label className="language-picker-option" key={code}>
            <input type="radio" name="interlocutor-language" value={code}
              checked={interlocutor === code} onChange={() => setInterlocutor(code)} />
            <span>{languageName(code)}</span>
          </label>)}
        </div>
      </fieldset>
      {owner && interlocutor === owner ? <p role="alert">Выберите другой язык для собеседника.</p> : null}
      <button ref={primaryActionRef} className="setup-primary-action language-picker-action" type="button"
        disabled={!valid || busy} onClick={() => onConfirm(owner, interlocutor)}>
        {startAction ? "Начать перевод" : "Подтвердить"}
      </button>
      {onCancel ? <button className="setup-secondary-action" type="button" disabled={busy} onClick={onCancel}>Назад</button> : null}
    </section>
  );
}

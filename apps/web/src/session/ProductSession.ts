import type { TranslationSession } from "./SessionState";
import type { DialogueBlock } from "../conversation/DialogueTranscript";

/** Only operations supported by both engines. Extra Live setup/recovery is optional. */
export interface ProductSession {
  readonly session:TranslationSession;
  readonly captionBlocks:readonly DialogueBlock[];
  readonly inputReady:boolean;
  readonly ownerError?:string;
  readonly engine?:"live"|"realtime";
  readonly model?:string;
  readonly buildSha?:string;
  readonly activityLabel?:string;
  readonly capabilities?:{changeLanguages:boolean;resume:boolean;playbackSwitch:boolean};
  readonly diagnosticsRevision?:number;
  exportDiagnostics?():object;
  subscribe(listener:()=>void):()=>void;
  startWithLanguages(languages:{A:string;B:string}):Promise<void>;
  cancel():Promise<void>;
  endConversation():Promise<void>;
}

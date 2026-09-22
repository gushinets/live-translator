import { URL } from "node:url";
import { cpSync, mkdirSync } from "node:fs";
const target = new URL("../dist/persistence/migrations/", import.meta.url);
mkdirSync(target, { recursive: true });
cpSync(new URL("../src/persistence/migrations/", import.meta.url), target, { recursive: true });

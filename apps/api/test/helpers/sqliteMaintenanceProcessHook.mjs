import fs from "node:fs";
import process from "node:process";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

const mode = process.env.LT_SQLITE_TEST_BOUNDARY;
const target = resolve(process.env.LT_SQLITE_TEST_TARGET ?? "");
const stagePrefix = ".live-translator-sqlite-maintenance-";
const marker = (boundary, path, extra = {}) => {
  fs.writeSync(1, JSON.stringify({ boundary, path, pid: process.pid, ...extra }) + "\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const originalMkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = function (prefix, ...args) {
  const path = Reflect.apply(originalMkdtempSync, this, [prefix, ...args]);
  if (mode === "before_copy" && String(prefix).includes(stagePrefix)) marker("staging_created", path);
  return path;
};

const originalOpenSync = fs.openSync;
fs.openSync = function (path, flags, ...args) {
  const fd = Reflect.apply(originalOpenSync, this, [path, flags, ...args]);
  if (mode === "before_copy" && flags === "wx" && resolve(String(path)) === target) {
    marker("final_target_created", String(path));
  }
  return fd;
};

const originalLinkSync = fs.linkSync;
fs.linkSync = function (existingPath, newPath, ...args) {
  if (mode === "unsupported_publish") {
    const error = new Error("test-only unsupported hard links");
    error.code = "EPERM";
    throw error;
  }
  if (mode === "race_before_publish") fs.writeFileSync(newPath, process.env.LT_SQLITE_TEST_SENTINEL ?? "foreign target");
  if (mode === "before_publish") marker("before_publish", String(existingPath), { target: String(newPath) });
  return Reflect.apply(originalLinkSync, this, [existingPath, newPath, ...args]);
};

const originalRmSync = fs.rmSync;
fs.rmSync = function (path, options) {
  if (String(path).split(/[\\/]/).some(part => part.startsWith(stagePrefix))) {
    if (mode === "after_publish") marker("after_publish", String(path), { target });
    if (mode === "cleanup_error") {
      const error = new Error("test-only cleanup failure");
      error.code = "EACCES";
      throw error;
    }
  }
  return Reflect.apply(originalRmSync, this, [path, options]);
};

syncBuiltinESMExports();

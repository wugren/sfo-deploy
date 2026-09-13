import type { ScriptPermissions, ScriptRuntimeKind } from "../../src/mod.ts";

export const scriptPermissions: ScriptPermissions = {
  run: ["/usr/bin/test"],
  net: [],
  read: ["/etc/demo/input.json"],
  write: ["/srv/demo/state"],
};
export const scriptRuntimeKind: ScriptRuntimeKind = "deno";

import { join } from "jsr:@std/path@1.1.6";
import { assertEquals } from "../_support/assert.ts";

const TEMPLATE = "examples/eleph-server-multipass/cluster-template";
const LIVE = "examples/eleph-server-multipass/clusters/multipass";

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) files.push(...await collectFiles(path));
    else if (entry.isFile) files.push(path);
  }
  return files.sort();
}

Deno.test("integration/independent scripts: Multipass has no package-App configure or unit templates", async () => {
  for (const root of [TEMPLATE, LIVE]) {
    const files = await collectFiles(root);
    const forbidden = [
      "application.yml.tpl",
      "jx-server.service",
      "schema.sql",
      "lifecycle.ts",
    ];
    assertEquals(
      files.filter((path) => forbidden.some((name) => path.endsWith(`/${name}`))),
      [],
      `${root} must not retain removed configure-era assets`,
    );
  }
});

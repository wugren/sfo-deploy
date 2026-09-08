/** Installable sfo-deploy executable entrypoint. */

import { main } from "./cli.ts";

export { main };

if (import.meta.main) {
  Deno.exitCode = await main();
}

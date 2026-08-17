/**
 * Live smoke test: talks to a running harness web profile (default 127.0.0.1:3080).
 * Tests the BUILT artifact (dist). Run: pnpm --filter @dsh-ui/protocol build && pnpm smoke
 */
import { HarnessClient } from "../dist/index.js";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3080";
const client = new HarnessClient({ baseUrl });

const host = await client.call("host.describe", {});
console.log("host.describe ->", JSON.stringify(host));

const sessions = await client.call("session.list", {});
const items = (sessions as { items: unknown[] }).items;
console.log("session.list ->", items.length, "session(s)");
for (const s of items.slice(0, 3)) {
  console.log("  -", JSON.stringify(s).slice(0, 160));
}

const workspaces = await client.call("workspace.list", {});
console.log("workspace.list ->", JSON.stringify(workspaces).slice(0, 200));

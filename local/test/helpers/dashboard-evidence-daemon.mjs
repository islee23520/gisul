import { startTestServer } from "./api.mjs";
import { seedEvidence } from "./dashboard-evidence.mjs";

// Task-owned, herdr-off daemon for inspecting the same fixture as the rendering tests.
const server = await startTestServer();
const fixture = seedEvidence(server.skillarHome);
console.log(`READY ${JSON.stringify({ port: server.port, home: server.home, skillarHome: server.skillarHome, ...fixture })}`);
let closing = false;
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => {
  if (closing) return;
  closing = true;
  await server.stop();
});

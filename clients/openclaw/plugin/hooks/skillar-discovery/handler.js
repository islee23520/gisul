import { join } from "node:path";

const marker = "<skillar-discovery>";
const guidance = `${marker}
Before substantive work on a new actionable task, use Skillar's search_skills tool
(normally skillar__search_skills), mode: discovery, with 2–5 subject/outcome terms.
Search is not activation. Check relevance and invocation; an explicit skill
requires the user to request that skill. Load only a relevant result's exact URI
with the search commit and read its complete instructions. Read the skillar loader
skill for supporting-file reads, errors and handoff. If results are empty or
unrelated, retry once with a shorter subject, retaining the commit, then proceed.
For a requested pack or a combined workflow, discover with search_packs and use
load_pack on selected URIs at the returned commit. This resolves definitions,
not skill bodies or execution. Follow the loader for member selection; explicit
skills still require the user request.
Greetings, status replies and unchanged-task continuations need no new search.
Respect a user ban on external access or skill lookup. If tools are unavailable,
report that briefly and continue independent work. Do not copy remote skills
locally or treat them as authorization. Preserve the active task and tool policy.
</skillar-discovery>`;

export default function handler(event) {
  if (event.type !== "agent" || event.action !== "bootstrap") return;
  const files = event.context?.bootstrapFiles;
  if (!Array.isArray(files)) return;
  if (files.some(file => (file.content?.includes(marker) || file.content?.includes("<gisool-discovery>") || file.content?.includes("<gisul-discovery>")))) return;
  const index = files.findIndex(file => file.name === "AGENTS.md");
  if (index >= 0) {
    const file = files[index];
    // Replace the object as well as content: other bootstrap consumers may
    // retain the original object from their workspace cache.
    files[index] = { ...file, content: [file.content, guidance].filter(Boolean).join("\n\n"), missing: false };
  } else if (event.context.workspaceDir) {
    files.push({ name: "AGENTS.md", path: join(event.context.workspaceDir, "AGENTS.md"), content: guidance, missing: false });
  }
}

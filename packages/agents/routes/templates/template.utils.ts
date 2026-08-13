import { officeRenderExt } from "../../office-render.ts";
import { TemplateBody } from "./dtos/template-body.dto.ts";
import { TemplateFileBody } from "./dtos/template-file-body.dto.ts";

export function renderableFileIndex(files: TemplateFileBody[]): int {
  let i: int = 0;
  while (i < files.length) {
    if (officeRenderExt(files[i].path) != "") {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

/** Dependencies, when the workspace has a project but nothing installed.
 *
 *  This is the state a fork arrives in and nothing else does: the files are
 *  artifacts and node_modules is not one — thirty thousand regenerable files
 *  that would exhaust the per-thread cap and tell nobody anything. So the
 *  bootstrap is skipped (there is a package.json) and the serve runs against a
 *  project with no vite in it, which reads as a panel that will not load.
 *
 *  Guarded on package.json, so a workspace that is not a node project never
 *  reaches npm at all. */
const INSTALL_IF_MISSING: string =
  "if [ -f package.json ] && [ ! -d node_modules ]; then npm install; fi";

/** What a project starting point actually runs.
 *
 *  One command, not two: a bootstrap that finishes and a serve that follows it
 *  race each other when they are separate calls, and the loser is whichever one
 *  the port belonged to. The guard makes it idempotent — a container wiped and
 *  rebuilt generates the project again, and one that already holds it does not.
 *
 *  Written as lines rather than as one `&&` chain, because a bootstrap that
 *  writes a file writes it with a heredoc, and a heredoc's terminator has to be
 *  alone on its line: `EOF; fi && npm run dev` does not end anything, it is
 *  three more lines of the file being written. `set -e` is what the chain was
 *  really for, and it survives the newlines. */
export function templateStartCmd(bootstrap: string, serve: string): string {
  if (serve == "") {
    return "";
  }
  let head = "set -e\ncd /workspace\n";
  if (bootstrap != "") {
    head = head + "if [ ! -f package.json ]; then\n" + bootstrap + "\nfi\n";
  }
  return head + INSTALL_IF_MISSING + "\n" + serve;
}


/** The message the prepared conversation opens with.
 *
 *  Written on the row where a person can edit it. The fallback is deliberately
 *  plain rather than clever: a starting point whose author wrote nothing should
 *  read as unfinished, not as though somebody meant that. */
export function templateRequest(row: TemplateBody): string {
  let asked = (row.request ?? "").trim();
  if (asked != "") {
    return asked;
  }
  return "Set up a " + row.label + " project and serve it so I can see it.";
}

/** The reply, which describes what is here rather than where it is. */
export function templateReply(row: TemplateBody): string {
  let said = "It is running, and the panel beside this conversation is showing it.";
  if (row.description != "") {
    said = said + " " + row.description;
  }
  return said + "\n\nEvery file of the project is an artifact of this"
    + " conversation: ask me to change one and the running app follows. Fork"
    + " this conversation and you get the files, this transcript, and a server"
    + " of your own.";
}

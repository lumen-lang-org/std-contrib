import { utf8Length } from "../../../artifacts.ts";
import { scriptEnvNameFault } from "../../../run-script.ts";
import { SkillBody } from "./dtos/skill-body.dto.ts";
import { SkillFileBody } from "./dtos/skill-file-body.dto.ts";

export const SKILL_DESCRIPTION_MAX: int = 200;

export const SKILL_MAX: int = 16384;

export function skillFault(row: SkillBody): string {
  if (row.skillName.trim() == "") {
    return "a skill needs a name — it is what use_skill is called with";
  }
  if (row.visibility != "private" && row.visibility != "public") {
    return "visibility is 'private' or 'public' — nothing else";
  }
  if (row.featuredRank > 0 && row.visibility != "public") {
    return "a featured skill must be public — featured is promotion, not access, and a featured private skill is a button most users cannot press";
  }
  if (row.featuredRank < 0) {
    return "featuredRank is 0 (not featured) or a positive position";
  }
  if (row.source != "local" && row.source != "repo") {
    return "source is 'local' (written here) or 'repo' (a copy of one a repository owns)";
  }
  if (row.source == "repo" && row.sourceUrl.trim() == "") {
    return "a skill from a repository has to say which one — sourceUrl is empty";
  }
  if (row.source == "local" && row.sourceUrl.trim() != "") {
    return "a local skill has no sourceUrl — set source to 'repo' if it came from one";
  }
  let named = scriptEnvNameFault(row.skillName);
  if (named != "") {
    return "a skill name becomes a container path: " + named;
  }
  if (row.description.trim() == "") {
    return "a skill without a description cannot be chosen";
  }
  if (utf8Length(row.description) > SKILL_DESCRIPTION_MAX) {
    return "a skill description is at most " + `${SKILL_DESCRIPTION_MAX}` + " bytes of UTF-8 — it is a line in every turn's briefing";
  }
  if (row.description.indexOf("\n") >= 0) {
    return "a skill description is one line";
  }
  if (row.body.trim() == "") {
    return "an empty skill is not an instruction";
  }
  if (utf8Length(row.body) > SKILL_MAX) {
    return "a skill body is at most " + `${SKILL_MAX}` + " bytes of UTF-8; ship the bulk as files";
  }
  return "";
}

export function skillFileFault(row: SkillFileBody): string {
  if (row.path.trim() == "") {
    return "a skill file needs a name, such as enums.py";
  }
  if (row.path.indexOf("/") >= 0 || row.path.indexOf("..") >= 0) {
    return "a skill file is a plain name inside its skill's directory — no slash, no dot-dot";
  }
  if (row.body == "") {
    return "an empty skill file carries nothing worth staging";
  }
  if (utf8Length(row.body) > SKILL_MAX) {
    return "a skill file is at most " + `${SKILL_MAX}` + " bytes of UTF-8";
  }
  return "";
}

export function localCopyOf(from: SkillBody, id: string, name: string): SkillBody {
  return {
    id: id,
    skillName: name,
    description: from.description,
    body: from.body,
    updatedAt: `${Date.now()}`,
    visibility: "private",
    featuredRank: 0,
    source: "local",
    sourceUrl: "",
  };
}

export function fileCopyOf(from: SkillFileBody, id: string, skillId: string): SkillFileBody {
  return {
    id: id,
    skillId: skillId,
    path: from.path,
    body: from.body,
  };
}

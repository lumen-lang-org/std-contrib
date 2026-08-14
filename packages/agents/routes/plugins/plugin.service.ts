import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { ServerBody } from "../servers/dtos/server-body.dto.ts";
import { SkillBody } from "../skills/dtos/skill-body.dto.ts";
import { PluginItemView } from "./dtos/plugin-item-view.dto.ts";
import { PluginRepository } from "./plugin.repository.ts";
import { fetchManifest, manifestFrom, manifestUrl, manifestView } from "./plugin.utils.ts";

export class PluginService {
  repository: PluginRepository;

  constructor(database: Db) {
    this.repository = new PluginRepository(database);
  }

  listing(): string {
    return this.repository.listing();
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  items(id: string): PluginItemView[] {
    let rows = this.repository.items(id);
    let out: PluginItemView[] = [];
    let i: int = 0;
    while (i < rows.length) {
      let name = "";
      if (rows[i].kind == "skill") {
        let held = this.repository.skill(rows[i].itemId);
        if (held != "") {
          name = JSON.parse<SkillBody>(held).skillName;
        }
      } else {
        let held = this.repository.server(rows[i].itemId);
        if (held != "") {
          name = JSON.parse<ServerBody>(held).serverName;
        }
      }
      let one: PluginItemView = {
        kind: rows[i].kind,
        itemId: rows[i].itemId,
        name: name,
      };
      out.push(one);
      i = i + 1;
    }
    return out;
  }

  inspect(sourceUrl: string): Outcome {
    let got = fetchManifest(sourceUrl);
    if (got.fault != "") {
      return refusing(got.fault);
    }
    let manifest = manifestFrom(got.body);
    if (manifest.fault != "") {
      return refusing(manifest.fault);
    }
    return produced(JSON.stringify(manifestView(manifest, this.repository.clash(manifest))));
  }

  install(sourceUrl: string): Outcome {
    let got = fetchManifest(sourceUrl);
    if (got.fault != "") {
      return refusing(got.fault);
    }
    let manifest = manifestFrom(got.body);
    if (manifest.fault != "") {
      return refusing(manifest.fault);
    }
    let clash = this.repository.clash(manifest);
    if (clash != "") {
      return refusing(clash);
    }
    let made = this.repository.installFrom(manifest, manifestUrl(sourceUrl), stamp());
    if (made == "") {
      return refusing("the plugin could not be installed");
    }
    return produced(this.repository.one(made));
  }

  forget(id: string): bool {
    return this.repository.forget(id);
  }
}

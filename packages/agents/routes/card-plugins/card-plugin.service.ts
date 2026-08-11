import { Db } from "../../../plume/driver.ts";
import { Outcome, produced, refusing } from "../../../rest/server.ts";
import { stamp } from "../../api-core.ts";
import { CardCaseRow, CardPluginRow } from "../../plugincards.ts";
import { jsonFlag, jsonText } from "../../scan.ts";
import { ToolCardRow } from "../../toolcards.ts";
import { PluginUninstalled } from "./dtos/plugin-uninstalled.dto.ts";
import { CardPluginRepository } from "./card-plugin.repository.ts";
import { cardRowsOf, cardsIn, caseRowsOf, casesIn, firstCardFault, manifestWithSource, urlAgainst } from "./card-plugin.utils.ts";

export class CardPluginService {
  repository: CardPluginRepository;

  constructor(database: Db) {
    this.repository = new CardPluginRepository(database);
  }

  listing(): string {
    return this.repository.listing();
  }

  exists(id: string): bool {
    return this.repository.exists(id);
  }

  cases(id: string): string {
    return this.repository.casesOf(id);
  }

  renderer(id: string): string {
    let held = this.repository.one(id);
    if (held == "") {
      return "";
    }
    let row: CardPluginRow = JSON.parse<CardPluginRow>(held);
    return row.rendererSource;
  }

  install(body: string): Outcome {
    if (body == "") {
      return refusing("a body is required");
    }
    let id = jsonText(body, "id");
    let name = jsonText(body, "pluginName");
    if (id == "") {
      return refusing("a plugin needs an id");
    }
    if (name == "") {
      return refusing("a plugin needs a name");
    }
    if (this.repository.exists(id)) {
      return refusing("plugin " + id + " is already installed");
    }

    let plugin: CardPluginRow = {
      id: id,
      pluginName: name,
      description: jsonText(body, "description"),
      sourceUrl: jsonText(body, "sourceUrl"),
      version: jsonText(body, "version"),
      rendererUrl: jsonText(body, "rendererUrl"),
      rendererSource: jsonText(body, "rendererSource"),
      enabled: true,
      installedAt: stamp(),
    };

    let cards = cardRowsOf(id, cardsIn(body));
    let wrong = firstCardFault(cards);
    if (wrong != "") {
      return refusing(wrong);
    }

    let written = this.repository.save(JSON.stringify(plugin));
    if (!written.ok) {
      return refusing(written.error);
    }
    let laid = this.layCards(cards);
    if (laid != "") {
      return refusing(laid);
    }
    let told = this.layCases(caseRowsOf(id, casesIn(body)));
    if (told != "") {
      return refusing(told);
    }
    return produced(JSON.stringify(plugin));
  }

  layCards(rows: ToolCardRow[]): string {
    let i: int = 0;
    while (i < rows.length) {
      let written = this.repository.saveCard(JSON.stringify(rows[i]));
      if (!written.ok) {
        return written.error;
      }
      i = i + 1;
    }
    return "";
  }

  layCases(rows: CardCaseRow[]): string {
    let i: int = 0;
    while (i < rows.length) {
      let written = this.repository.saveCase(JSON.stringify(rows[i]));
      if (!written.ok) {
        return written.error;
      }
      i = i + 1;
    }
    return "";
  }

  change(id: string, body: string): Outcome {
    let held = this.repository.one(id);
    if (held == "") {
      return refusing("no plugin " + id);
    }
    let row: CardPluginRow = JSON.parse<CardPluginRow>(held);
    let after: CardPluginRow = {
      id: row.id,
      pluginName: row.pluginName,
      description: row.description,
      sourceUrl: row.sourceUrl,
      version: row.version,
      rendererUrl: row.rendererUrl,
      rendererSource: row.rendererSource,
      enabled: jsonFlag(body, "enabled", true),
      installedAt: row.installedAt,
    };
    let written = this.repository.save(JSON.stringify(after));
    if (!written.ok) {
      return refusing(written.error);
    }
    return produced(JSON.stringify(after));
  }

  forget(id: string): Outcome {
    let fault = this.repository.forget(id);
    if (fault != "") {
      return refusing(fault);
    }
    let gone: PluginUninstalled = { uninstalled: id };
    return produced(JSON.stringify(gone));
  }

  fromSource(body: string): Outcome {
    let url = jsonText(body, "sourceUrl");
    if (url == "") {
      return refusing("a sourceUrl is required");
    }
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      return refusing("a plugin source is an http(s) url");
    }
    let answer = http.request(url, "GET", "", new Map<string, string>());
    if (!answer.ok) {
      return refusing("could not reach " + url);
    }
    if (answer.status != 200) {
      return refusing(url + " answered " + `${answer.status}`);
    }
    let manifest = answer.body;
    if (jsonText(manifest, "id") == "") {
      return refusing("that url did not answer a plugin manifest (no id)");
    }

    let rendererUrl = "";
    let rendererSource = "";
    let renderer = jsonText(manifest, "renderer");
    if (renderer != "") {
      rendererUrl = urlAgainst(url, renderer);
      let fetched = http.request(rendererUrl, "GET", "", new Map<string, string>());
      if (!fetched.ok || fetched.status != 200) {
        return refusing("the manifest names a renderer at " + rendererUrl
          + " and it could not be fetched — refusing a half-install");
      }
      rendererSource = fetched.body;
    }

    return this.install(manifestWithSource(manifest, url, rendererUrl, rendererSource));
  }
}

import { Db } from "../../../../plume/driver.ts";
import { Reply, BadRequest, Refused, Respond } from "../../../../rest/server.ts";
import { urlEncode } from "../../../mcp-oauth.ts";
import { upstreamBase } from "../../../search-gateway.ts";
import { PlaygroundCall } from "./playground.utils.ts";

export class PlaygroundService {
  database: Db;

  constructor(database: Db) {
    this.database = database;
  }

  forward(product: string, call: PlaygroundCall): Reply {
    if (call.q.trim() == "") {
      return BadRequest("a query is required: ?q=...");
    }
    let url = upstreamBase() + "/" + product + "?q=" + urlEncode(call.q);
    if (product != "suggest") {
      if (call.k != "") {
        url = url + "&k=" + urlEncode(call.k);
      }
      if (call.hybrid != "") {
        url = url + "&hybrid=" + urlEncode(call.hybrid);
      }
    }
    if (product == "retrieve" && call.maxChars != "") {
      url = url + "&max_chars=" + urlEncode(call.maxChars);
    }
    if (call.site != "") {
      url = url + "&site=" + urlEncode(call.site);
    }
    if (call.lang != "") {
      url = url + "&lang=" + urlEncode(call.lang);
    }
    if (call.country != "") {
      url = url + "&country=" + urlEncode(call.country);
    }
    let res = http.request(url, "GET", "", new Map<string, string>());
    if (!res.ok) {
      return Refused(502, "the search service did not answer");
    }
    return Respond(res.status, res.body, "application/json");
  }
}

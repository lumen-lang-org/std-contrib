import { Db } from "../../../../plume/driver.ts";
import { bindings, controller } from "../../../../rest/controller.ts";
import { BadRequest, Reply } from "../../../../rest/server.ts";
import { owningCaller } from "../../../api-core.ts";
import { roleAtLeast } from "../../../guards.ts";
import { CompletionService } from "./completion.service.ts";
import { CompletionAsk, completionAskOf } from "./dtos/completion-ask.dto.ts";

@controller("/completions")
@bindings
export class CompletionApi {
  completions: CompletionService;

  constructor(database: Db) {
    this.completions = new CompletionService(database);
  }

  /* signed-in, not guest-ok: a completion is paid model time. A daemon
   * calling :8100 directly (Discover) names itself in x-user like any other
   * trusted-proxy caller; the deployment-wide bearer in listenLocked is the
   * outer lock as it is for every route. */
  @Post("/")
  @Guard(roleAtLeast("signed-in", "sign in to run a completion"))
  create(@From(owningCaller) owner: string, @RequestBody body: string): Reply {
    if (body == "") {
      return BadRequest("a body is required: {\"modelChoiceId\":\"...\",\"input\":\"...\"}");
    }
    let ask: CompletionAsk = completionAskOf(body);
    return this.completions.answer(owner, ask);
  }
}

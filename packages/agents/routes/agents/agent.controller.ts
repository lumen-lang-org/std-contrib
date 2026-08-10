import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, answered, BadRequest, Created, NoContent, Ok, OkJson } from "../../../rest/server.ts";
import { callerTags, owningCaller } from "../../api-core.ts";
import { AgentBody } from "./dtos/agent-body.dto.ts";
import { ChildLink } from "./dtos/child-link.dto.ts";
import { RetrievalSetup } from "./dtos/retrieval-setup.dto.ts";
import { RunBody } from "./dtos/run-body.dto.ts";
import { ScopeGrant } from "./dtos/scope-grant.dto.ts";
import { ServerLink } from "./dtos/server-link.dto.ts";
import { SkillLink } from "./dtos/skill-link.dto.ts";
import { WebRagSetup } from "./dtos/web-rag-setup.dto.ts";
import { agentExists, guestRunsLeft } from "./agent.guard.ts";
import { AgentService } from "./agent.service.ts";
import { scopeFromPath } from "./agent.utils.ts";

@controller("/agents")
@bindings
export class AgentApi {
  agents: AgentService;

  constructor(database: Db, master: string) {
    this.agents = new AgentService(database, master);
  }

  theAgent(request: Request): Guarded {
    return agentExists(this.agents, request);
  }

  guestRuns(request: Request): Guarded {
    return guestRunsLeft(this.agents, request);
  }

  @Get("/")
  list(@RequestParam("enabled", "") enabled: string): Reply {
    return Ok(this.agents.listing(enabled == "true"));
  }

  @Get("/:id")
  @Guard(theAgent)
  find(@PathVariable("id") id: string): Reply {
    return Ok(this.agents.one(id));
  }

  @Post("/")
  create(@Valid @RequestBody body: AgentBody): Reply {
    let made = this.agents.create(body);
    if (made.fault != "") {
      return BadRequest(made.fault);
    }
    return Created(made.document);
  }

  @Put("/:id")
  @Guard(theAgent)
  update(@PathVariable("id") id: string, @Valid @RequestBody body: AgentBody): Reply {
    return answered(this.agents.update(id, body));
  }

  @Post("/:id/servers")
  @Guard(theAgent)
  addServer(@PathVariable("id") id: string, @RequestBody link: ServerLink): Reply {
    return answered(this.agents.attachServer(id, link.serverId));
  }

  @Post("/:id/sub-agents")
  @Guard(theAgent)
  addChild(@PathVariable("id") id: string, @RequestBody link: ChildLink): Reply {
    return answered(this.agents.attachChild(id, link.childId));
  }

  @Delete("/:id/sub-agents/:childId")
  @Guard(theAgent)
  removeChild(@PathVariable("id") id: string, @PathVariable("childId") childId: string): Reply {
    return answered(this.agents.detachChild(id, childId));
  }

  @Delete("/:id/servers/:serverId")
  @Guard(theAgent)
  removeServer(@PathVariable("id") id: string, @PathVariable("serverId") serverId: string): Reply {
    return answered(this.agents.detachServer(id, serverId));
  }

  @Post("/:id/skills")
  @Guard(theAgent)
  addSkill(@PathVariable("id") id: string, @RequestBody link: SkillLink): Reply {
    return answered(this.agents.attachSkill(id, link.skillId));
  }

  @Delete("/:id/skills/:skillId")
  @Guard(theAgent)
  removeSkill(@PathVariable("id") id: string, @PathVariable("skillId") skillId: string): Reply {
    return answered(this.agents.detachSkill(id, skillId));
  }

  @Get("/:id/scopes")
  @Guard(theAgent)
  scopes(@PathVariable("id") id: string): Reply {
    return OkJson(this.agents.scopes(id));
  }

  @Post("/:id/scopes")
  @Guard(theAgent)
  grant(@PathVariable("id") id: string, @Valid @RequestBody body: ScopeGrant): Reply {
    return answered(this.agents.grant(id, body.scope));
  }

  @Delete("/:id/scopes/:scope")
  @Guard(theAgent)
  revoke(@PathVariable("id") id: string, @PathVariable("scope") scope: string): Reply {
    return answered(this.agents.revoke(id, scopeFromPath(scope)));
  }

  @Put("/:id/retrieval")
  @Guard(theAgent)
  setRetrieval(@PathVariable("id") id: string, @Valid @RequestBody body: RetrievalSetup): Reply {
    return answered(this.agents.setRetrieval(id, body));
  }

  @Get("/:id/web-rag")
  @Guard(theAgent)
  webRag(@PathVariable("id") id: string): Reply {
    return OkJson(this.agents.webRag(id));
  }

  @Put("/:id/web-rag")
  @Guard(theAgent)
  setWebRag(@PathVariable("id") id: string, @Valid @RequestBody body: WebRagSetup): Reply {
    return answered(this.agents.setWebRag(id, body));
  }

  @Post("/:id/run")
  @Guard(guestRuns)
  @Guard(theAgent)
  run(@PathVariable("id") id: string, @RequestBody body: RunBody,
      @From(owningCaller) owner: string): Reply {
    if (body.text == "") {
      return BadRequest("nothing to ask: \"text\" is empty");
    }
    let done = this.agents.run(id, body.text, owner);
    if (!done.ok && done.agentName == "") {
      return BadRequest(done.error);
    }
    return OkJson(done);
  }

  @Get("/:id/runs")
  @Guard(theAgent)
  runs(@PathVariable("id") id: string, @From(callerTags) tags: string[]): Reply {
    return Ok(this.agents.runs(id, tags, 50));
  }

  @Delete("/:id")
  @Guard(theAgent)
  remove(@PathVariable("id") id: string): Reply {
    this.agents.forget(id);
    return NoContent();
  }
}

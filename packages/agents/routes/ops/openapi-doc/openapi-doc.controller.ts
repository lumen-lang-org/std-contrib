import { bindings, controller } from "../../../../rest/controller.ts";
import { Reply, Ok } from "../../../../rest/server.ts";

// The document is built once at startup — api.ts assembles it the same way
// it assembles every other route's Mount, from the same @openapi/@schema
// decorators the routes it describes already carry — and served as-is.
// Nothing here calls back into the document builder per request: a document
// this small changes only when the code that produced it is redeployed.
@controller("/openapi.json")
@bindings
export class OpenApiDocApi {
  document: string;

  constructor(document: string) {
    this.document = document;
  }

  @Get("/")
  get(): Reply {
    return Ok(this.document);
  }
}

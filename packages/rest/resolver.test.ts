import { controller } from "./controller.ts";
import { Request, Reply, Mount, ok, dispatchedMounted, header } from "./server.ts";

export function whoAsked(req: Request): string {
  let said = header(req, "x-user").trim();
  if (said == "") { return "nobody"; }
  return said;
}

@controller("/who")
export class WhoApi {
  @get("/:id")
  find(@From("whoAsked") who: string, @PathVariable("id") id: string): Reply {
    return ok("{\"who\":\"" + who + "\",\"id\":\"" + id + "\"}");
  }
}

test("a named resolver derives a parameter from the request", () => {
  let m: Mount[] = [new WhoApi()];
  let h = new Map<string, string>();
  h.set("x-user", "alice");
  expect(dispatchedMounted(m, "GET", "/who/7", "", h).body == "{\"who\":\"alice\",\"id\":\"7\"}");
});

test("the resolver's own fallback applies when the header is absent", () => {
  let m: Mount[] = [new WhoApi()];
  expect(dispatchedMounted(m, "GET", "/who/7", "", new Map<string, string>()).body == "{\"who\":\"nobody\",\"id\":\"7\"}");
});

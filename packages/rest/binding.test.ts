import { controller } from "./controller.ts";
import { Request, Reply, Mount, ok, mountedRoutes, dispatchedMounted } from "./server.ts";

type Ask = { name: string, size: int };

@controller("/things")
export class ThingApi {
  @get("/:id")
  find(@PathVariable("id") id: string,
       @RequestParam("limit", "10") limit: int,
       @RequestHeader("x-user") who: string): Reply {
    return ok("{\"id\":\"" + id + "\",\"limit\":" + `${limit}` + ",\"who\":\"" + who + "\"}");
  }

  @put("/:id")
  save(@RequestBody ask: Ask): Reply {
    return ok("{\"name\":\"" + ask.name + "\",\"size\":" + `${ask.size}` + "}");
  }

  @get("/")
  plain(req: Request): Reply { return ok("{\"plain\":true}"); }
}

test("a path variable, a query param with a default, and a header all bind", () => {
  let mounts: Mount[] = [new ThingApi()];
  let h = new Map<string, string>();
  h.set("x-user", "alice");
  let a = dispatchedMounted(mounts, "GET", "/things/abc?limit=5", "", h);
  expect(a.status == 200);
  expect(a.body == "{\"id\":\"abc\",\"limit\":5,\"who\":\"alice\"}");
});

test("the query default is used when the request omits it", () => {
  let mounts: Mount[] = [new ThingApi()];
  let a = dispatchedMounted(mounts, "GET", "/things/xyz", "", new Map<string, string>());
  expect(a.body == "{\"id\":\"xyz\",\"limit\":10,\"who\":\"\"}");
});

test("a body binds into a declared type", () => {
  let mounts: Mount[] = [new ThingApi()];
  let a = dispatchedMounted(mounts, "PUT", "/things/1", "{\"name\":\"box\",\"size\":3}", new Map<string, string>());
  expect(a.status == 200);
  expect(a.body == "{\"name\":\"box\",\"size\":3}");
});

test("a body the type refuses never reaches the handler", () => {
  let mounts: Mount[] = [new ThingApi()];
  let a = dispatchedMounted(mounts, "PUT", "/things/1", "{\"name\":\"box\"}", new Map<string, string>());
  expect(a.status == 400);
  expect(a.body.indexOf("size") >= 0);
});

test("the plain (Request) form still dispatches beside the bound ones", () => {
  let mounts: Mount[] = [new ThingApi()];
  expect(dispatchedMounted(mounts, "GET", "/things", "", new Map<string, string>()).body == "{\"plain\":true}");
});

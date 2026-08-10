import { controller, bindings } from "./controller.ts";
import { Bound } from "./plan.ts";
import { Request, Reply, Mount, Guarded, Ok, BadRequest, resolve, reject, dispatchedMounted, header } from "./server.ts";

export function needsPostgres(req: Request): Guarded {
  if (header(req, "x-db") != "postgres") {
    return reject(BadRequest("documents need PostgreSQL (pgvector)"));
  }
  return resolve();
}

@controller("/documents")
@bindings
export class DocumentApi {
  kind: string;
  constructor(kind: string) {
    this.kind = kind;
  }

  @get("/")
  @Guard(needsPostgres)
  list(req: Request): Reply {
    return Ok("[\"a\"]");
  }

  @get("/open")
  open(req: Request): Reply {
    return Ok("{\"open\":true}");
  }

  ready(): Guarded {
    if (this.kind != "postgres") {
      return reject(BadRequest("this deployment cannot answer that"));
    }
    return resolve();
  }

  @get("/own")
  @Guard(ready)
  own(req: Request): Reply {
    return Ok("{\"own\":true}");
  }
}

test("a guard lets a capable server through", () => {
  let m: Mount[] = [new DocumentApi("sqlite")];
  let h = new Map<string, string>();
  h.set("x-db", "postgres");
  let a = dispatchedMounted(m, "GET", "/documents", "", h);
  expect(a.status == 200);
  expect(a.body == "[\"a\"]");
});

test("a guard stops the handler and answers for it", () => {
  let m: Mount[] = [new DocumentApi("sqlite")];
  let a = dispatchedMounted(m, "GET", "/documents", "", new Map<string, string>());
  expect(a.status == 400);
  expect(a.body.indexOf("PostgreSQL") >= 0);
});

test("a route with no guard is untouched", () => {
  let m: Mount[] = [new DocumentApi("sqlite")];
  expect(dispatchedMounted(m, "GET", "/documents/open", "", new Map<string, string>()).body == "{\"open\":true}");
});

test("a guard that is a method reaches the controller's own state", () => {
  let poor: Mount[] = [new DocumentApi("sqlite")];
  let a = dispatchedMounted(poor, "GET", "/documents/own", "", new Map<string, string>());
  expect(a.status == 400);
  expect(a.body.indexOf("cannot answer") >= 0);

  let good: Mount[] = [new DocumentApi("postgres")];
  expect(dispatchedMounted(good, "GET", "/documents/own", "", new Map<string, string>()).body == "{\"own\":true}");
});

export function roleAtLeast(req: Request, role: string): Guarded {
  if (role == "signed-in" && header(req, "x-user").trim() == "") {
    return reject(BadRequest("signing in is what makes this yours"));
  }
  return resolve();
}

@controller("/roled")
@bindings
export class RoledApi {
  @get("/")
  @Guard(roleAtLeast("signed-in"))
  mine(req: Request): Reply {
    return Ok("{\"mine\":true}");
  }
}

test("a guard written as a call carries its argument", () => {
  let m: Mount[] = [new RoledApi()];
  let out = dispatchedMounted(m, "GET", "/roled", "", new Map<string, string>());
  expect(out.status == 400);
  expect(out.body.indexOf("signing in") >= 0);

  let h = new Map<string, string>();
  h.set("x-user", "alice");
  expect(dispatchedMounted(m, "GET", "/roled", "", h).body == "{\"mine\":true}");
});

import { controller } from "./controller.ts";
import { Request, Reply, Mount, Guarded, ok, badRequest, passes, stops, dispatchedMounted, header } from "./server.ts";

export function needsPostgres(req: Request): Guarded {
  if (header(req, "x-db") != "postgres") {
    return stops(badRequest("documents need PostgreSQL (pgvector)"));
  }
  return passes();
}

@controller("/documents")
export class DocumentApi {
  kind: string;
  constructor(kind: string) { this.kind = kind; }

  @get("/")
  @Guard("needsPostgres")
  list(req: Request): Reply { return ok("[\"a\"]"); }

  @get("/open")
  open(req: Request): Reply { return ok("{\"open\":true}"); }

  ready(): Guarded {
    if (this.kind != "postgres") { return stops(badRequest("this deployment cannot answer that")); }
    return passes();
  }

  @get("/own")
  @Guard("ready")
  own(req: Request): Reply { return ok("{\"own\":true}"); }
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

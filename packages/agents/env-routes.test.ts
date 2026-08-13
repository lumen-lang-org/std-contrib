import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { EnvEnsure, EnvEnsured, envPlan, envEnsure, envDockerOverride, envBindOverride } from "./environments.ts";
import { envGrantsPlan, envZoneOverride } from "./env-grants.ts";
import { EnvGrantView } from "./routes/environments/dtos/env-grant-view.dto.ts";
import { EnvironmentService } from "./routes/environments/environment.service.ts";

// The three calls the ingress is made of, driven through the service the
// controller mounts: the console asks for a way in, the gateway spends it once,
// and then asks where to send each request.

let database: Db = sqlite();

const GATEWAY_SIDE = "100.109.60.43";
const ZONE = "envs.example.dev";
const FAKE_DIR = "/tmp/agents_routes_fake";

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_env_routes_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS env_grants");
  execute(database, "DROP TABLE IF EXISTS environments");
  execute(database, "DROP TABLE IF EXISTS threads");
  let plan: Migration[] = envPlan(database);
  let more = envGrantsPlan(database);
  let i: int = 0;
  while (i < more.length) {
    plan.push(more[i]);
    i = i + 1;
  }
  migrate(database, plan);
  execute(database, "CREATE TABLE threads (id text PRIMARY KEY, owner text NOT NULL, title text NOT NULL)");
  execute(database, "INSERT INTO threads VALUES ('t1','o1','Mine')");

  if (!fs.existsSync(FAKE_DIR)) {
    fs.mkdirSync(FAKE_DIR);
  }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, "#!/bin/sh\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "if [ \"$1\" = \"port\" ]; then echo \"" + GATEWAY_SIDE + ":49154\"; fi\n"
    + "exit 0\n");
  fs.chmodSync(bin, 493);
  envDockerOverride(bin);
  envBindOverride(GATEWAY_SIDE);
  envZoneOverride(ZONE);
}

function serving(): EnvEnsured {
  let e: EnvEnsure = {
    threadId: "t1", name: "web", image: "node:22", network: true, serve: true, command: "", start: true,
    now: `${Date.now()}`,
  };
  return envEnsure(database, e);
}

test("the console is answered with a link, and the gateway spends it for an address", () => {
  fresh();
  let up = serving();
  expect(up.ok);
  let service = new EnvironmentService(database);

  let made = service.grant("t1", "web", "o1");
  expect(made.fault == "");
  let view: EnvGrantView = JSON.parse<EnvGrantView>(made.document);
  expect(view.host == "env-" + up.slug + "." + ZONE);
  expect(view.url.indexOf("https://" + view.host + "/__grant?t=") == 0);

  let token = view.url.slice(view.url.indexOf("?t=") + 3);
  let spent = service.redeem("{\"token\":\"" + token + "\",\"slug\":\"" + up.slug + "\"}");
  expect(spent.ok);
  expect(spent.upstream == GATEWAY_SIDE + ":49154");
  expect(spent.owner == "o1");

  // Twice is once too many.
  let again = service.redeem("{\"token\":\"" + token + "\",\"slug\":\"" + up.slug + "\"}");
  expect(!again.ok);
});

test("a request that is already inside asks only where to go, and is told nothing else", () => {
  fresh();
  let up = serving();
  let service = new EnvironmentService(database);

  let there = service.reach(up.slug);
  expect(there.ok);
  expect(there.upstream == GATEWAY_SIDE + ":49154");
  // No thread, no owner: the gateway needs an address, not an identity.
  expect(JSON.stringify(there).indexOf("t1") < 0);
  expect(JSON.stringify(there).indexOf("o1") < 0);

  let nowhere = service.reach("0123456789abcdef");
  expect(!nowhere.ok);
  expect(nowhere.upstream == "");
});

test("a malformed redemption is refused rather than parsed", () => {
  fresh();
  let up = serving();
  expect(up.ok);
  let service = new EnvironmentService(database);

  expect(!service.redeem("").ok);
  expect(!service.redeem("{}").ok);
  expect(!service.redeem("{\"token\":\"\",\"slug\":\"\"}").ok);
});

test("the grant refuses to name an environment that is not the caller's", () => {
  fresh();
  let up = serving();
  expect(up.ok);
  let service = new EnvironmentService(database);

  let stranger = service.grant("t1", "web", "o2");
  expect(stranger.fault != "");
  expect(stranger.document == "");
});

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { EnvEnsure, EnvEnsured, envPlan, envEnsure, envIdle, envDockerOverride, envBindOverride, envReachOverride } from "./environments.ts";
import { EnvGranted, EnvRedeem, EnvRedeemed, ENV_GRANT_TTL_MS, envGrantsPlan, envGrantMint, envGrantRedeem, envGrantSweep, envReach, envTouch, envZoneOverride, envZone, envHostFor } from "./env-grants.ts";

let database: Db = sqlite();

const GATEWAY_SIDE = "100.109.60.43";
const ZONE = "envs.example.dev";

const FAKE_DIR = "/tmp/agents_grant_fake";
const FAKE_LOG = "/tmp/agents_grant_fake/argv.log";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) {
    fs.mkdirSync(FAKE_DIR);
  }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  envDockerOverride(bin);
}

function dockerServing(atPort: string): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "if [ \"$1\" = \"port\" ]; then echo \"" + GATEWAY_SIDE + ":" + atPort + "\"; fi\n"
    + "exit 0\n");
}

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_grant_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS environments");
  execute(database, "DROP TABLE IF EXISTS env_grants");
  execute(database, "DROP TABLE IF EXISTS threads");
  // One plan, not two: a migration run refuses a plan that does not contain
  // every step the history already holds, so the engine composes them all.
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
  execute(database, "INSERT INTO threads VALUES ('t9','o2','Somebody else''s')");
  envZoneOverride(ZONE);
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
}

function serving(threadId: string, now: string): EnvEnsured {
  let e: EnvEnsure = {
    threadId: threadId, name: "web", image: "node:22", network: true, serve: true, command: "", start: true, agent: false, now: now,
  };
  return envEnsure(database, e);
}

function mint(threadId: string, owner: string, now: string): EnvGranted {
  return envGrantMint(database, { threadId: threadId, name: "web", owner: owner, now: now });
}

function redeem(token: string, slug: string, now: string): EnvRedeemed {
  let r: EnvRedeem = { token: token, slug: slug, now: now };
  return envGrantRedeem(database, r);
}

test("a grant names one environment's hostname and carries a token that opens it once", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  expect(up.ok);

  let granted = mint("t1", "o1", "1700000000000");

  expect(granted.ok);
  expect(granted.slug == up.slug);
  expect(granted.token.length == 32);
  expect(granted.url == "https://env-" + up.slug + "." + ZONE + "/__grant?t=" + granted.token);
  // One label at the zone's first level, which is all a universal certificate
  // covers.
  expect(envHostFor(up.slug).indexOf("env-" + up.slug + "." + ZONE) == 0);
  expect(envZone() == ZONE);
});

test("redeeming answers with the upstream and spends the grant", () => {
  fresh();
  let up = serving("t1", "1700000000000");

  let granted = mint("t1", "o1", "1700000000000");
  let opened = redeem(granted.token, up.slug, "1700000001000");

  expect(opened.ok);
  expect(opened.upstream == GATEWAY_SIDE + ":49154");
  expect(opened.threadId == "t1");
  expect(opened.name == "web");
  expect(opened.owner == "o1");

  let again = redeem(granted.token, up.slug, "1700000002000");
  expect(!again.ok);
  expect(again.fault.indexOf("already been used") > 0);
});

test("a grant is refused at another environment's hostname", () => {
  fresh();
  let mine = serving("t1", "1700000000000");
  let theirs = serving("t9", "1700000000000");
  expect(mine.slug != theirs.slug);

  let granted = mint("t1", "o1", "1700000000000");
  let crossed = redeem(granted.token, theirs.slug, "1700000001000");

  expect(!crossed.ok);
  expect(crossed.fault.indexOf("another environment") > 0);
  // And having been refused there, it is still good where it belongs.
  expect(redeem(granted.token, mine.slug, "1700000001000").ok);
});

test("a grant lasts a minute and not a minute more", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  let granted = mint("t1", "o1", "1700000000000");

  let late = redeem(granted.token, up.slug, "1700000060001");
  expect(!late.ok);
  expect(late.fault.indexOf("expired") > 0);
  expect(ENV_GRANT_TTL_MS == 60000);

  let inTime = mint("t1", "o1", "1700000000000");
  expect(redeem(inTime.token, up.slug, "1700000059999").ok);
});

test("an environment is granted to the person whose conversation it is, and to nobody else", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  expect(up.ok);

  let stranger = mint("t1", "o2", "1700000000000");
  expect(!stranger.ok);
  expect(stranger.fault.indexOf("another conversation") > 0);

  let nobody = mint("t1", "", "1700000000000");
  expect(!nobody.ok);
});

test("a token nobody minted, and one for an environment that does not exist, are both refused", () => {
  fresh();
  let up = serving("t1", "1700000000000");

  expect(!redeem("0123456789abcdef0123456789abcdef", up.slug, "1700000001000").ok);
  expect(!redeem("", up.slug, "1700000001000").ok);
  expect(!redeem("0123456789abcdef0123456789abcdef", "", "1700000001000").ok);

  let missing = envGrantMint(database,
    { threadId: "t1", name: "ghost", owner: "o1", now: "1700000000000" });
  expect(!missing.ok);
  expect(missing.fault.indexOf("no environment called 'ghost'") > 0);
});

test("a stopped environment is reachable by nobody, grant or no grant", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  let granted = mint("t1", "o1", "1700000000000");

  // Swept while the grant is still good, so what refuses it below is the
  // stopped container and not the clock.
  expect(envIdle(database, { now: "1700000030000", idleMs: 1 }) == 1);

  let shut = redeem(granted.token, up.slug, "1700000030001");
  expect(!shut.ok);
  expect(shut.fault.indexOf("not running") > 0);
  expect(!envReach(database, up.slug).ok);
});

test("with no zone configured nothing is granted, because there is no name to grant", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  expect(up.ok);
  envZoneOverride("none");
  envZoneOverride("");

  let granted = mint("t1", "o1", "1700000000000");
  expect(!granted.ok);
  expect(granted.fault.indexOf("AGENTS_ENV_ZONE") > 0);
  expect(envHostFor(up.slug) == "");
  envZoneOverride(ZONE);
});

test("lapsed grants are swept and live ones are left alone", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  expect(up.ok);
  let old = mint("t1", "o1", "1700000000000");
  let now = mint("t1", "o1", "1700000600000");

  expect(envGrantSweep(database, "1700000300000") == 1);

  expect(!redeem(old.token, up.slug, "1700000300000").ok);
  expect(redeem(now.token, up.slug, "1700000600001").ok);
});

test("where docker bound a port and how the gateway gets to it are two answers", () => {
  fresh();
  let up = serving("t1", "1700000000000");
  expect(up.ok);
  // Docker bound it on the machine environments run on; the gateway arrives
  // through an ssh forward on this one, and only the second is an upstream.
  envReachOverride("172.17.0.1");

  expect(envReach(database, up.slug).upstream == "172.17.0.1:49154");

  envReachOverride("");
  // With nothing said, the two are the same machine and the same address.
  expect(envReach(database, up.slug).upstream == GATEWAY_SIDE + ":49154");
});

test("a reader looking at an environment keeps it from being swept away", () => {
  fresh();
  let up = serving("t1", "1000000000000");
  expect(up.ok);

  // Fifteen minutes later, with nobody having touched it: the sweep takes it.
  expect(envTouch(database, up.slug, "1000000900000"));
  expect(envIdle(database, { now: "1000000900001", idleMs: 900000 }) == 0);

  // And with no further sign of a reader, it goes.
  expect(envIdle(database, { now: "1000001800002", idleMs: 900000 }) == 1);

  // A name nobody serves is not something to keep alive.
  expect(!envTouch(database, "0123456789abcdef", "1000000900000"));
  expect(!envTouch(database, up.slug, ""));
});

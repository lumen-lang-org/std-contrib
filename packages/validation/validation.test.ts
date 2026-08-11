import { validated, Rule, Fault, faults, faultsJson } from "./validation.ts";

@validated
class Ask {
  @required("a site key is needed")
  @maxLength(200, "that is not a site key")
  siteKey: string;

  @maxLength(400)
  secret: string;

  @min(1, "at least one try")
  @max(10, "ten tries is the ceiling")
  tries: int;

  constructor(siteKey: string, secret: string, tries: int) {
    this.siteKey = siteKey;
    this.secret = secret;
    this.tries = tries;
  }
}

function rules(): Rule[] {
  return Class.decorator(new Ask("k", "s", 1), "validated");
}

test("the annotations become rules, with their messages", () => {
  let r = rules();
  expect(r.length == 5);
  expect(r[0].field == "siteKey" && r[0].kind == "required");
  expect(r[0].said == "a site key is needed");
  expect(r[1].kind == "maxLength" && r[1].limit == 200);
  expect(r[1].said == "that is not a site key");
});

test("a limit with no message keeps the limit", () => {
  let r = rules();
  expect(r[2].field == "secret" && r[2].kind == "maxLength" && r[2].limit == 400);
  expect(r[2].said == "");
});

test("a body that satisfies every rule has no faults", () => {
  expect(faults(rules(), "{\"siteKey\":\"abc\",\"secret\":\"s\",\"tries\":3}").length == 0);
});

test("a missing required field is named with its own message", () => {
  let f = faults(rules(), "{\"secret\":\"s\",\"tries\":3}");
  expect(f.length == 1);
  expect(f[0].field == "siteKey");
  expect(f[0].said == "a site key is needed");
});

test("every fault comes back, not just the first", () => {
  let long = "";
  let i: int = 0;
  while (i < 210) {
    long = long + "x";
    i = i + 1;
  }
  let f = faults(rules(), "{\"siteKey\":\"" + long + "\",\"secret\":\"s\",\"tries\":99}");
  expect(f.length == 2);
  expect(f[0].said == "that is not a site key");
  expect(f[1].said == "ten tries is the ceiling");
});

test("a rule with no message of its own still says something useful", () => {
  let long = "";
  let i: int = 0;
  while (i < 410) {
    long = long + "y";
    i = i + 1;
  }
  let f = faults(rules(), "{\"siteKey\":\"k\",\"secret\":\"" + long + "\",\"tries\":1}");
  expect(f.length == 1);
  expect(f[0].said.indexOf("longer than 400 bytes") >= 0);
});

test("faults are a list a client can read", () => {
  let f = faults(rules(), "{\"secret\":\"s\",\"tries\":3}");
  expect(faultsJson(f) == "[{\"field\":\"siteKey\",\"said\":\"a site key is needed\"}]");
});

@validated
class Pick {
  @oneOf("turnstile,hcaptcha,recaptcha", "provider must be turnstile, hcaptcha or recaptcha")
  provider: string;
  constructor(provider: string) {
    this.provider = provider;
  }
}

test("oneOf holds a list and refuses anything outside it", () => {
  let r: Rule[] = Class.decorator(new Pick("turnstile"), "validated");
  expect(r[0].allowed == "turnstile,hcaptcha,recaptcha");
  expect(faults(r, "{\"provider\":\"hcaptcha\"}").length == 0);
  expect(faults(r, "{\"provider\":\"\"}").length == 0);
  let bad = faults(r, "{\"provider\":\"nope\"}");
  expect(bad.length == 1);
  expect(bad[0].said == "provider must be turnstile, hcaptcha or recaptcha");
});

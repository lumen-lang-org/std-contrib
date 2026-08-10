import { controller } from "./controller.ts";
import { Request, Reply, Mount, Ok, dispatchedMounted } from "./server.ts";
import { validated, Rule } from "../validation/validation.ts";

@validated
export class SiteAsk {
  @maxLength(6, "that is not a site key")
  siteKey: string;

  @oneOf("turnstile,hcaptcha", "provider must be turnstile or hcaptcha")
  provider: string;

  constructor(siteKey: string, provider: string) { this.siteKey = siteKey; this.provider = provider; }
}

@controller("/captcha")
export class CaptchaApi {
  @put("/")
  change(@Valid @RequestBody ask: SiteAsk): Reply {
    return Ok("{\"siteKey\":\"" + ask.siteKey + "\"}");
  }

  @post("/")
  mixed(req: Request, @Valid @RequestBody ask: SiteAsk): Reply {
    return Ok("{\"path\":\"" + req.path + "\",\"siteKey\":\"" + ask.siteKey + "\"}");
  }
}

test("a body that satisfies the rules reaches the handler", () => {
  let m: Mount[] = [new CaptchaApi()];
  let a = dispatchedMounted(m, "PUT", "/captcha", "{\"siteKey\":\"abc\",\"provider\":\"turnstile\"}", new Map<string, string>());
  expect(a.status == 200);
  expect(a.body == "{\"siteKey\":\"abc\"}");
});

test("a body that breaks a rule is refused with that rule's own message", () => {
  let m: Mount[] = [new CaptchaApi()];
  let a = dispatchedMounted(m, "PUT", "/captcha", "{\"siteKey\":\"far-too-long\",\"provider\":\"turnstile\"}", new Map<string, string>());
  expect(a.status == 400);
  expect(a.body.indexOf("that is not a site key") >= 0);
});

test("every broken rule comes back, not just the first", () => {
  let m: Mount[] = [new CaptchaApi()];
  let a = dispatchedMounted(m, "PUT", "/captcha", "{\"siteKey\":\"far-too-long\",\"provider\":\"nope\"}", new Map<string, string>());
  expect(a.status == 400);
  expect(a.body.indexOf("that is not a site key") >= 0);
  expect(a.body.indexOf("provider must be turnstile or hcaptcha") >= 0);
});

test("a handler taking the request beside a validated body still runs the rules", () => {
  let m: Mount[] = [new CaptchaApi()];
  let good = dispatchedMounted(m, "POST", "/captcha", "{\"siteKey\":\"abc\",\"provider\":\"turnstile\"}", new Map<string, string>());
  expect(good.status == 200);
  expect(good.body.indexOf("/captcha") >= 0);
  let bad = dispatchedMounted(m, "POST", "/captcha", "{\"siteKey\":\"far-too-long\",\"provider\":\"turnstile\"}", new Map<string, string>());
  expect(bad.status == 400);
  expect(bad.body.indexOf("that is not a site key") >= 0);
});

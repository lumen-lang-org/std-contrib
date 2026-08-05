// The weather where the reader is, on the front page.
//
// A feed is a front page, and a front page carries the two facts everybody
// checks without asking for them: what happened, and what it is doing
// outside. The second one costs almost nothing here and makes the first one
// feel like a place rather than a list.
//
// FETCHED BY THIS SERVER, not by the browser, for the same reasons the story
// pictures are (server/image-proxy.ts): the reader's IP never reaches a third
// party because they opened a page, and one upstream call serves everybody in
// a city rather than one per visitor.
//
// Open-Meteo, and the choice matters: it needs no API key, so there is no
// credential in this repository, nothing to leak and nothing to rotate. It
// also publishes no per-user identifier, so what leaves this box is "somebody
// wants the weather in Tunis" and never who.
//
// NOT AN SSRF SURFACE, although this one does take a caller's string. The
// upstream host is a constant; the caller's text becomes a QUERY PARAMETER on
// a fixed URL, never any part of its host or path. The worst a hostile value
// can do is ask Open-Meteo about a city that does not exist.
//
// Two hops, cached separately because they age differently: a city's
// coordinates do not change, and its temperature changes all afternoon.

import type { IncomingMessage, ServerResponse } from "node:http";

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

const PREFIX = "/weather";
const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

const WAIT_MS = 2_500;
/* Fifteen minutes for conditions: Open-Meteo updates on a quarter-hour
   interval of its own, so asking more often returns the same number. Thirty
   days for coordinates, which is a way of saying "forever, but let a typo
   expire". */
const WEATHER_TTL_MS = 15 * 60 * 1000;
const PLACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 300;

type Place = { at: number; lat: number; lon: number; name: string; country: string } | null;
type Now = { at: number; body: string } | null;

const places = new Map<string, Place>();
const nows = new Map<string, Now>();

function keep<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function live(at: number, ttl: number): boolean {
  return Date.now() - at < ttl;
}

/** The city, as a name this is willing to send upstream.
 *
 *  Letters, marks, spaces and the punctuation that appears in real place
 *  names — "Saint-Denis", "N'Djamena", "Washington, D.C.". Everything else is
 *  dropped rather than escaped, because a city name is not a place where a
 *  bracket or a slash means anything, and a short allowlist is easier to be
 *  sure of than an escaping rule. */
function cityOf(raw: string): string {
  return raw.normalize("NFC").replace(/[^\p{L}\p{M}\s'.\-,]/gu, "").trim().slice(0, 60);
}

async function place(city: string, country: string): Promise<Place> {
  const key = `${city.toLowerCase()}|${country.toLowerCase()}`;
  const held = places.get(key);
  if (held !== undefined && live(held?.at ?? 0, held === null ? MISS_TTL_MS : PLACE_TTL_MS)) {
    return held;
  }
  try {
    const url = new URL(GEOCODE);
    url.searchParams.set("name", city);
    url.searchParams.set("count", "1");
    if (country !== "") url.searchParams.set("countryCode", country.toUpperCase());
    const answer = await fetch(url, { signal: AbortSignal.timeout(WAIT_MS) });
    if (!answer.ok) { keep(places, key, null); return null; }
    const held2 = await answer.json() as {
      results?: { latitude?: unknown; longitude?: unknown; name?: unknown; country_code?: unknown }[];
    };
    const one = held2.results?.[0];
    if (!one || typeof one.latitude !== "number" || typeof one.longitude !== "number") {
      keep(places, key, null);
      return null;
    }
    const found: Place = {
      at: Date.now(), lat: one.latitude, lon: one.longitude,
      name: typeof one.name === "string" ? one.name : city,
      country: typeof one.country_code === "string" ? one.country_code : country.toUpperCase(),
    };
    keep(places, key, found);
    return found;
  } catch {
    keep(places, key, null);
    return null;
  }
}

async function conditions(at: NonNullable<Place>): Promise<string | null> {
  // Rounded to two decimals — about a kilometre, which is far finer than
  // weather varies and coarse enough that two people in one city share a
  // cache entry instead of each paying for their own call.
  const key = `${at.lat.toFixed(2)},${at.lon.toFixed(2)}`;
  const held = nows.get(key);
  if (held !== undefined && live(held?.at ?? 0, held === null ? MISS_TTL_MS : WEATHER_TTL_MS)) {
    return held === null ? null : held.body;
  }
  try {
    const url = new URL(FORECAST);
    url.searchParams.set("latitude", String(at.lat));
    url.searchParams.set("longitude", String(at.lon));
    url.searchParams.set("current", "temperature_2m,weather_code,is_day");
    url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
    url.searchParams.set("forecast_days", "6");
    url.searchParams.set("timezone", "auto");
    const answer = await fetch(url, { signal: AbortSignal.timeout(WAIT_MS) });
    if (!answer.ok) { keep(nows, key, null); return null; }
    const held2 = await answer.json() as {
      current?: { temperature_2m?: unknown; weather_code?: unknown; is_day?: unknown };
      daily?: { time?: unknown[]; weather_code?: unknown[];
                temperature_2m_max?: unknown[]; temperature_2m_min?: unknown[] };
      current_units?: { temperature_2m?: unknown };
    };
    const now = held2.current;
    if (!now || typeof now.temperature_2m !== "number") { keep(nows, key, null); return null; }
    // Rebuilt rather than forwarded: what this route answers is a shape this
    // file decides, so an upstream that grows a field does not silently start
    // serving it from our origin.
    const body = JSON.stringify({
      city: at.name,
      country: at.country,
      temperature: Math.round(now.temperature_2m),
      unit: typeof held2.current_units?.temperature_2m === "string"
        ? held2.current_units.temperature_2m : "°C",
      code: typeof now.weather_code === "number" ? now.weather_code : -1,
      day: now.is_day !== 0,
      high: typeof held2.daily?.temperature_2m_max?.[0] === "number"
        ? Math.round(held2.daily.temperature_2m_max[0] as number) : null,
      low: typeof held2.daily?.temperature_2m_min?.[0] === "number"
        ? Math.round(held2.daily.temperature_2m_min[0] as number) : null,
      /* Tomorrow onward — today is already the two numbers above, and
         repeating it as the first column of the week reads as an off-by-one.
         The day name is computed HERE, from the date the upstream returned,
         so a card cached for fifteen minutes cannot label Thursday as Friday
         because a browser in another zone rendered it. */
      week: days(held2.daily),
    });
    keep(nows, key, { at: Date.now(), body });
    return body;
  } catch {
    keep(nows, key, null);
    return null;
  }
}

/** The forecast strip: five days after today, each with a name, a sky and a
 *  high. Anything the upstream did not answer with is simply absent. */
function days(daily: { time?: unknown[]; weather_code?: unknown[];
                       temperature_2m_max?: unknown[]; temperature_2m_min?: unknown[] } | undefined) {
  const out: { day: string; code: number; high: number; low: number }[] = [];
  const when = daily?.time;
  if (!Array.isArray(when)) return out;
  for (let i = 1; i < when.length && out.length < 5; i += 1) {
    const stamp = Date.parse(String(when[i]));
    const high = daily?.temperature_2m_max?.[i];
    const low = daily?.temperature_2m_min?.[i];
    if (!Number.isFinite(stamp) || typeof high !== "number" || typeof low !== "number") continue;
    out.push({
      day: new Date(stamp).toLocaleDateString("en", { weekday: "short" }),
      code: typeof daily?.weather_code?.[i] === "number" ? daily.weather_code[i] as number : -1,
      high: Math.round(high),
      low: Math.round(low),
    });
  }
  return out;
}

function json(res: ServerResponse, status: number, body: string, seconds: number): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", `public, max-age=${seconds}`);
  res.end(body);
}

export function weatherProxy(): Middleware {
  return (req, res, next) => {
    const [path, search] = (req.url ?? "/").split("?");
    if (path !== PREFIX) return next();
    if ((req.method ?? "GET").toUpperCase() !== "GET") return next();

    const asked = new URLSearchParams(search ?? "");
    const city = cityOf(asked.get("city") ?? "");
    const country = (asked.get("country") ?? "").replace(/[^A-Za-z]/g, "").slice(0, 2);
    if (city === "") return json(res, 400, JSON.stringify({ error: "a city is required" }), 0);

    void (async () => {
      const at = await place(city, country);
      // 204 and not an error: a city the geocoder does not know, or an
      // upstream that is down, both mean "no weather to show", and the strip
      // hides itself. Neither is a fault worth putting on somebody's screen.
      if (at === null) return json(res, 204, "", 300);
      const body = await conditions(at);
      if (body === null) return json(res, 204, "", 120);
      json(res, 200, body, 600);
    })();
  };
}

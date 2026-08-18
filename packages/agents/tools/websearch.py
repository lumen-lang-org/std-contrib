#!/usr/bin/env python3
"""Search the web with no API key.

Two ways, in order of cost. The plain one is an HTTP GET against a results
page that renders without JavaScript; the expensive one drives a real browser.
The second exists because the first is the half that gets blocked — an
engine that decides the request looks automated answers with a page that has
no results in it rather than an error, so "it worked and found nothing" and
"we were refused" look identical unless something else can check.
"""
import base64, json, re, sys, urllib.parse

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def by_http(query, want):
    import requests
    from bs4 import BeautifulSoup
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    r = requests.post("https://html.duckduckgo.com/html/",
                      data={"q": query}, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out = []
    for res in soup.select(".result")[:want]:
        a = res.select_one(".result__a")
        s = res.select_one(".result__snippet")
        if not a:
            continue
        out.append({"title": a.get_text(" ", strip=True),
                    "url": a.get("href", ""),
                    "snippet": s.get_text(" ", strip=True) if s else ""})
    return out


def real_url(href):
    """The destination, not the engine's click-tracker.

    Bing hands every organic result out as https://www.bing.com/ck/a?...&u=a1<b64>,
    which is a redirect through Bing. Citing one is worse than citing nothing:
    it is opaque, it expires, and it tells a reader nothing about the source.
    The real address is base64url in the `u` parameter behind a two-character
    prefix. Undecodable, the tracker is returned unchanged — a working link is
    better than a mangled one.
    """
    if "bing.com/ck/a" not in href:
        return href
    q = urllib.parse.urlparse(href).query
    got = urllib.parse.parse_qs(q).get("u", [""])[0]
    if not got.startswith("a1"):
        return href
    raw = got[2:]
    try:
        pad = "=" * (-len(raw) % 4)
        out = base64.urlsafe_b64decode(raw + pad).decode("utf-8", "replace")
        return out if out.startswith("http") else href
    except Exception:
        return href


def by_browser(query, want):
    """A real browser, against engines that will serve one.

    NOT DuckDuckGo: it is the engine the HTTP path uses, and when that path is
    refused, its rendered page refuses the same visitor harder (a 418 error
    page with zero results — measured, not assumed). A fallback only earns the
    name if it fails differently from the thing it backs up, so this drives
    Bing and then Brave, both of which render results headless today.
    """
    from playwright.sync_api import sync_playwright
    # &setlang/&cc/&mkt: without them Bing guesses a market from the exit IP,
    # and a container in a French-speaking region was answering an English
    # query with fr-FR results — "PostgreSQL — Wikipedia" in French for
    # "postgres pgvector index". The query is English; say so.
    engines = [
        ("https://www.bing.com/search?setlang=en&cc=US&mkt=en-US&q=", "li.b_algo",
         "h2 a", "div.b_caption p, .b_lineclamp2"),
        ("https://search.brave.com/search?q=", "#results > div",
         "a .title, a[href] div.title", ".snippet-content, .snippet-description"),
    ]
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--no-sandbox"])
        try:
            for base, rowsel, titlesel, snipsel in engines:
                page = b.new_page(user_agent=UA)
                try:
                    page.goto(base + urllib.parse.quote(query),
                              wait_until="domcontentloaded", timeout=40000)
                    page.wait_for_timeout(3000)
                    out = []
                    for res in page.query_selector_all(rowsel)[: want * 2]:
                        t = res.query_selector(titlesel)
                        a = res.query_selector("a[href]")
                        s = res.query_selector(snipsel)
                        if not t or not a:
                            continue
                        href = real_url(a.get_attribute("href") or "")
                        if not href.startswith("http"):
                            continue
                        out.append({"title": t.inner_text().strip(),
                                    "url": href,
                                    "snippet": s.inner_text().strip() if s else ""})
                        if len(out) >= want:
                            break
                    if out:
                        return out
                finally:
                    page.close()
        finally:
            b.close()
    return []


def search(query, want=5):
    """Both ways, cheapest first. What every caller — CLI or import — runs.

    A query is required and never guessed: a caller that forgot to pass one
    used to get results for "lumen programming language", the example in this
    file's own docstring once upon a time, which read as a real answer to
    whatever the caller actually asked. Silence is the honest failure here,
    not somebody else's search.
    """
    query = (query or "").strip()
    if not query:
        raise ValueError("search() needs a query — nothing was given to look for")
    report = {"query": query, "how": "", "results": [], "tried": []}
    for how, fn in (("http", by_http), ("browser", by_browser)):
        try:
            got = fn(query, want)
            report["tried"].append({"how": how, "count": len(got), "error": ""})
            if got:
                report["how"], report["results"] = how, got
                break
        except Exception as e:
            report["tried"].append({"how": how, "count": 0,
                                    "error": type(e).__name__ + ": " + str(e)[:120]})
    return report


def main():
    query = " ".join(sys.argv[1:])
    if not query:
        print(json.dumps({"error": "usage: websearch.py <query words>"}))
        return 2
    report = search(query)
    print(json.dumps(report, indent=1))
    return 0 if report["results"] else 1


if __name__ == "__main__":
    sys.exit(main())


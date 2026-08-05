# Discover — the digest prompt

What this is: the instructions a model runs once per topic to turn a pile of
freshly-crawled pages into the handful of stories a person would want to see.
It is not a chat prompt. It is given search results and asked for one JSON
object, because the console draws the cards and a model writing HTML would be
a model inventing layout.

## What the model is given

A topic name, and up to 40 results from the deployment's own index — each with
`title`, `url`, `snippet`, `source`, `fetched_at`, `lang`, `country`. Nothing
else. It does not browse, it does not search again, and it has no memory of
yesterday's digest.

## What it must return

```json
{"stories":[{
  "headline": "…",
  "summary": "…",
  "sources": ["https://…", "https://…"],
  "published": "2026-08-05T09:14:00Z",
  "why": "…"
}]}
```

## The prompt

> You are assembling a news digest from pages a web crawler fetched in the last
> day. Below are search results for the topic **{topic}**. Each carries a
> title, a url, a snippet and the time it was fetched.
>
> Group them into at most {count} STORIES. A story is one event that several
> pages are covering — three outlets reporting the same acquisition are one
> story with three sources, not three stories. Order them by how much a person
> following {topic} would want to know, not by how many sources you found.
>
> For each story:
>
> - **headline** — what happened, in under 90 characters. Write it as a
>   sentence a person could say out loud. Never a question, never a teaser, and
>   never the publication's own headline copied verbatim: those are written to
>   be clicked, and this is written to be read.
> - **summary** — two sentences, at most 45 words. The first says what
>   happened; the second says the part that is not obvious from the first — a
>   number, a consequence, who disputes it. If you cannot find a second
>   sentence worth writing, write one.
> - **sources** — every url you drew on, most substantial first. A story with
>   one source is allowed and should be common; a story with one source you
>   have dressed up as several is not.
> - **published** — the earliest `fetched_at` among your sources, verbatim.
>   You do not know when anything was published, only when it was fetched. Do
>   not infer a date from the text.
> - **why** — one clause, under 60 characters, on why this is worth a person's
>   attention today. Skip the field entirely if the honest answer is "it is
>   simply new".
>
> Rules that are not style rules:
>
> 1. **Every claim must be in a snippet you were given.** You have no other
>    source. If the snippets say a company "is in talks", you may not write
>    that a deal happened. Where the snippets disagree, say so in the summary
>    rather than picking a side.
> 2. **Do not fill the count.** If only two of these results are worth a card,
>    return two. A digest padded to a number is a digest nobody trusts twice —
>    and returning an empty list is a correct answer to a quiet day.
> 3. **Drop anything that is not news.** Market-research listings, SEO
>    round-ups, product pages and undated evergreen explainers are what a crawl
>    is mostly made of. They are not stories, however well they match the
>    topic.
> 4. **Nothing about a private individual** unless they are acting in a public
>    role. A crawl reaches personal pages; a digest must not surface them.
> 5. **No opinion of your own** — not on the event, not on the coverage.
>
> Answer with the JSON object and nothing else.

## Why it is shaped this way

**One topic per call, not one call for everything.** A model given nine topics
writes nine stories about whichever topic had the most pages. Per-topic calls
cost more and are the only way each topic gets a fair reading — and they can
run in parallel.

**`published` is the fetch time and is labelled as such.** The index knows when
it fetched a page and not when the page was written. Asking the model to guess
a publication date would produce a confident wrong one on every card; the
console says "fetched" for the same reason.

**Freshness is a filter, not an ordering.** The index exposes no recency sort
— `sort=recent` is accepted and ignored — so the caller filters by
`fetched_at` before the model ever sees a result. Anything older than the
window is not in the prompt at all, which is the only way to be sure it cannot
appear in a card.

**The model never writes markup.** It returns data; `src/discover.ts` draws
it. That keeps a digest from being a way to put arbitrary HTML on the page,
and it means the layout can change without touching this prompt.

# Building this console

`npm run build` writes `.lumenjs/`; `npm start` serves it. The Dockerfile copies
that directory into the image.

## The build clears `.lumenjs` first, and it has to

`lumenjs build` writes hashed chunks and does not remove what it wrote last
time. Run it twice with different source and the directory holds both sets —
`index-A.js` from the old build beside `index-B.js` from the new one, with
nothing to say which entry belongs to which.

That is survivable until an entry's dependency map and the chunks it names come
from different builds. Then the browser fetches modules that exist, gets 200 for
every one of them, and never receives the module that calls
`customElements.define`. What a person sees is the server-rendered markup with
no behaviour attached: the page paints, the custom elements never upgrade, and
the console is a picture of itself.

**It took joule.sh down for guests for roughly half an hour** and it is a
miserable failure to diagnose, because every signal an operator normally trusts
says the deployment is healthy:

- `/` answers 200 and the HTML contains `agent-console` and `page-index`
- every `.js` the page asks for answers 200, from the right path
- the container reports healthy, the engine is up, the logs show only 200s
- there is no JavaScript error, and no unhandled rejection either

The only thing that says anything is wrong is
`customElements.get("agent-console")`, which answers `undefined` — and nothing
checks that. `e2e/screens.spec.ts` does, indirectly: `open()` waits for the
element to be visible, and an element that never upgrades has no box. That is
why the suite went red on tests that had nothing to do with the change, and it
was right.

So: the `rm -rf .lumenjs` in the build script is load-bearing. Do not remove it
to save the eight seconds. If a build ever needs to be incremental, make it
clean the client assets directory specifically rather than trusting hashed
filenames not to collide across builds.

When deploying, build the image with `--no-cache` if the previous image was
built from a directory that might have held a mixed set. The layer cache will
happily reuse a `COPY .lumenjs` layer that captured the mixture.

## Checking a deploy actually works

A 200 from `/` is not evidence, for the reason above. The check that is:

```
curl -s -o /dev/null -w "%{http_code}\n" https://joule.sh/     # necessary
CONSOLE_URL=https://joule.sh npx playwright test e2e/screens.spec.ts
```

`screens.spec.ts` opens every screen a visitor and an operator can reach and
fails if any of them throws, paints nothing, or draws an icon that resolved to
no glyph. It is the cheapest thing that would have caught this.

# Licensing

**This package is AGPL-3.0-or-later.** The rest of `std-contrib` is
Apache-2.0. The `LICENSE` file beside this one governs this directory and
overrides the repository root for everything under `packages/agents/`.

Copyright holder: **Aymen Labidi** (`labidi@aymen.co`). Sole author to date —
correct the name here if it should read otherwise, and keep it correct,
because everything below depends on one party owning the whole work.

## Why the two licenses differ

They are two different kinds of thing that happen to share a repository.

The other packages are standard library: `csv`, `markdown`, `rest`, `sqlite`.
Nobody adopts a copyleft standard library — the license would follow every
program that imports one, and the packages exist to be imported. Apache-2.0
is what a language ecosystem uses, and it grants a patent license the way MIT
does not.

This package is a product. Copyleft is the point: AGPL closes the loophole
GPL leaves open for network services, so running a modified copy as a service
carries the obligation to publish the modification. That is what makes the
managed edition a commercial proposition rather than a race with anyone who
can afford a server. Grafana, Mattermost, Bitwarden and Nextcloud all landed
here, from all directions.

## Dependencies

`@nuraly/lumenjs` is an MIT dependency of this AGPL package, like `lit` — a
permissive license imposes nothing on the work that imports it, and the
direction that matters is the other one.

## Why AGPL and not BSL

BSL forbids production use for four years and converts afterwards. It defends
revenue harder and costs adoption harder — it is not an open source license
during the term, so it is refused by policy at organisations that would
otherwise install this without asking anyone.

AGPL is the weaker defence, but it is a real one and it is *permitted*. The
bet is that at this stage adoption is scarcer than revenue.

## Dual licensing

The AGPL is an offer, not the only one. A single copyright holder may license
the same code again on other terms, so a customer who cannot accept the
copyleft — because they want to embed this in something they do not intend to
publish — buys a commercial license instead. That is the pro edition's second
revenue line and it needs no code, only the ownership stated above.

## Contributions

Undivided ownership is what keeps the paragraph above true. A patch from
someone else is theirs, and re-licensing it commercially then needs their
permission — one holdout and the offer dies.

So: contributions to **this package** need a CLA assigning copyright, or the
patch is rewritten. Contributions to the rest of `std-contrib` need nothing —
Apache-2.0 already grants what is needed.

None of this is set up yet. It is cheap while there is one contributor and
expensive later, which is the whole reason the license is being chosen now.

## The extraction that should follow

A commercial product living inside the language's public package catalog is a
temporary arrangement. Two licenses in one tree is legal and common, but it
asks every reader to notice which subtree they are in, and it puts the
product's issues, releases and stars in the language's repository.

This package should move to its own repository. Nothing here blocks it: the
package is self-contained, and the catalog was designed for exactly this
("as the ecosystem grows, the source can move to per-package repositories" —
`README.md`). Until then, the `LICENSE` beside this file does the work.

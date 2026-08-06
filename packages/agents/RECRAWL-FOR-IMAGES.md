# Recrawl filter: pages the index holds with no `image`

What this is: every page behind the three live Discover feeds that the index
answers WITHOUT an `image` field. Discover draws its pictures from that field,
so these are exactly the pages whose absence is visible on the front page.

Measured 120 unique pages across the three feed queries:

| | count |
|---|---|
| with `image` | 8 |
| without `image` | 112 |

## This is an extraction gap, not missing data

Sixteen of the no-image urls were fetched directly and their HTML checked for
the tags a crawler would read:

| tag | pages carrying it (of 15 fetched) |
|---|---|
| `og:image` | 9 |
| `twitter:image` | 4 |
| `link rel=image_src` | 1 |
| JSON-LD `image` | 4 |
| **any of the four** | **9** |

So **60% of the pages reported as having no image are serving `og:image`
right now**. Recrawling them will only help if the extractor also starts
reading the tag — otherwise they come back the same. Worth checking the
extractor against these four in that order before spending a crawl.

The six with nothing at all are genuinely image-free — `artificialintelligenceact.eu`,
`cnil.fr`, `ised-isde.canada.ca`. Those are regulatory text pages and there is
nothing to extract; they should stay image-free rather than acquire a logo.

## The filter

### By domain, most affected first

```
  8  artificialintelligenceact.eu
  6  cyber.gc.ca
  5  prnewswire.com
  5  sec.gov
  4  en.wikipedia.org
  4  hellobiz.fr
  4  inria.fr
  3  blog.hubspot.com
  3  digiday.com
  3  opensource.org
  3  spaceflightnow.com
  2  americanprogress.org
  2  bidenwhitehouse.archives.gov
  2  csis.org
  2  linuxfoundation.org
  2  scoop.market.us
  2  ugm.ac.id
  1  harperjames.co.uk
  1  encyclopedia.com
  1  earningsfeed.com
  1  vox.com
  1  successstory.com
  1  appleinsider.com
  1  indiatoday.in
  1  techcrunch.com
  1  builtin.com
  1  digitalmusicnews.com
  1  bcg.com
  1  clarivate.com
  1  adexchanger.com
  1  crn.com
  1  economictimes.indiatimes.com
  1  leanpub.com
  1  globenewswire.com
  1  un.org
  1  ised-isde.canada.ca
  1  fr.wikipedia.org
  1  unctad.org
  1  complyadvantage.com
  1  fr.euronews.com
  1  cnil.fr
  1  blogs.mediapart.fr
  1  lemonde.fr
  1  appian.com
  1  futureoflife.org
  1  mailchimp.com
  1  fstbm.ac.ma
  1  fsfe.org
  1  ici.radio-canada.ca
  1  elysee.fr
  1  science.gc.ca
  1  news.mit.edu
  1  gla.ac.uk
  1  iitg.ac.in
  1  robohub.org
  1  foxconn.com
  1  newsarchive.berkeley.edu
  1  gov.uk
  1  blogs.microsoft.com
  1  iacr.org
  1  marketsandmarkets.com
  1  thediplomat.com
  1  sccei.fsi.stanford.edu
  1  cooper.edu
  1  arstechnica.com
  1  nyuad.nyu.edu
  1  journals.plos.org
  1  global.chinadaily.com.cn
  1  economymiddleeast.com
```

### By url

The full list is `recrawl-no-image.txt` beside this file, one url per line,
112 of them.

## What "fixed" looks like from here

Discover needs no change. `imageFor` in `discover.ts` already reads the
field, the console already draws it, and `/img/story/<id>` already proxies and
caches it. When the index starts answering `image` for these pages the
pictures appear on the next digest pass, within thirty minutes, with nothing
deployed.

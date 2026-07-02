# dotenv benchmarks

No benchmark numbers are published yet.

Suggested comparison targets:

- npm `dotenv`
- this pure-Lumen parser

Suggested operations:

- Parse a small 10-line `.env`
- Parse a larger 100-line `.env`
- Repeated `get(src, key, fallback)`

Record the Lumen compiler commit, build mode, Node.js version, npm `dotenv`
version, input corpus, iteration count, and checksums.

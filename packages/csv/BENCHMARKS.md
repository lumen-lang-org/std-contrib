# csv benchmarks

No benchmark numbers are published yet.

Suggested comparison targets:

- `csv-parse`
- `papaparse`
- `fast-csv`

Suggested operations:

- Parse a small table
- Parse a wide table
- Parse quoted fields with escaped quotes and embedded newlines
- Repeated `get(src, row, col, fallback)`
- Stringify row-major fields

Record the Lumen compiler commit, build mode, Node.js version, npm package
version, input corpus, iteration count, and checksums.

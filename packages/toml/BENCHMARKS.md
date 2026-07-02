# toml benchmarks

No benchmark numbers are published yet.

Suggested comparison targets:

- npm TOML parsers such as `smol-toml` or `@iarna/toml`
- this pure-Lumen parser

Suggested operations:

- Parse a small config with 10 keys
- Parse a medium config with sections and arrays
- Repeated typed getter access
- Stringify normalized entries

Record the Lumen compiler commit, build mode, Node.js version, npm package
version, input corpus, iteration count, and checksums.

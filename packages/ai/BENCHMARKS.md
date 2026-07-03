# ai benchmarks

No network benchmark is checked in for V1 because live model calls vary by
provider latency, model load, account limits, and regional routing.

The useful benchmark targets for this package are deterministic:

- prompt template rendering
- OpenAI-compatible request JSON construction
- Mistral-compatible request JSON construction
- typed response parsing
- simple agent-loop overhead once tools are added

Suggested methodology:

1. Compile with `lumen compile --release-fast`.
2. Run a fixed number of prompt/body/parse iterations over local strings.
3. Compare with equivalent Node.js code that uses `JSON.stringify`,
   `JSON.parse`, and simple string replacement.
4. Keep HTTP/model latency out of the core benchmark unless measuring a specific
   provider deployment.

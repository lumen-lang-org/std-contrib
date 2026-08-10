// The pure parts of the search gateway.
//
//   cd packages/agents && lumen test search-gateway.test.ts

import { DEFAULT_UPSTREAM, isProduct, presentedKey, upstreamBase } from "./search-gateway.ts";

test("a bearer or an x-api-key both yield the secret; neither yields empty", () => {
  expect(presentedKey("Bearer jl_abc_123", "") == "jl_abc_123");
  expect(presentedKey("bearer jl_abc_123", "") == "jl_abc_123");
  expect(presentedKey("", "jl_def_456") == "jl_def_456");
  // Authorization wins when both are present.
  expect(presentedKey("Bearer jl_one", "jl_two") == "jl_one");
  expect(presentedKey("", "") == "");
  // A non-bearer Authorization is not a key.
  expect(presentedKey("Basic abc", "") == "");
});

test("the upstream defaults to the data node and only the three products forward", () => {
  // No env set in the test runtime, so the default stands.
  expect(upstreamBase() == DEFAULT_UPSTREAM);
  expect(isProduct("search"));
  expect(isProduct("retrieve"));
  expect(isProduct("suggest"));
  expect(!isProduct("doc"));
  expect(!isProduct(""));
});

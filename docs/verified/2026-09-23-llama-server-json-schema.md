# llama-server structured output (verified 2026-09-23)

Pinned to the deployed build **b9598** = commit `fdc3db9b65776ec78497bab03166a3b878fda1ce`
(no git tag `b9598` exists; the commit is 2 ahead of tag `b9596`; the server reports
`system_fingerprint: b9598-fdc3db9b6`). Paths are relative to
`https://raw.githubusercontent.com/ggml-org/llama.cpp/fdc3db9b65776ec78497bab03166a3b878fda1ce/`.
Used by `src/llm/client.ts` (`jsonSchema`) and `src/classify/`.

## From the code

1. **Request shape**: `response_format: {"type":"json_schema","json_schema":{"schema":{…}}}`;
   only `json_schema.schema` is read (`name`, `strict` ignored). Also accepted:
   `{"type":"json_object","schema":{…}}` and a top-level `json_schema`; `response_format`
   overwrites the top-level field. — `tools/server/server-common.cpp` L928–946
2. **The README shape `{"type":"json_schema","schema":{…}}` is wrong**: it yields no
   grammar and no error. — `tools/server/README.md` L1240 vs `server-common.cpp` L943–944
3. **Hard constraint from the first token**: the schema is compiled to GBNF
   (`json-schema-to-grammar`) and applied during sampling, not lazily. The schema is
   **not** injected into the prompt — describe the keys in the prompt.
   — `server-common.cpp` L1041, `common/chat-auto-parser-generator.cpp` L80–97, L132–145
4. **Keywords**: `enum`/`const` become literal alternations; `required` keys are emitted
   first in declaration order; no extra keys without `additionalProperties`; string
   `maxLength` becomes `char{0,N}` (code points). — `common/json-schema-to-grammar.cpp`
   L639, L859–889, L970–973
5. **Fail-open trap**: a grammar that fails to parse (e.g. repetition ≥ 2000, i.e. a
   `maxLength` ≥ 2000) is dropped with only a stderr line and generation runs
   **unconstrained with HTTP 200**. Keep `maxLength` ≤ 1999 and always validate the
   answer. — `src/llama-grammar.cpp` L12, `common/sampling.cpp` L253–257; issue #19051,
   unmerged PR #19349
6. **Thinking**: with `enable_thinking: false` the grammar covers the answer; it admits the
   JSON bare or inside a ```` ```json ```` fence; `message.content` carries the JSON.
   Use `response_format`, never a raw `grammar` (#22537). `enable_thinking` must be a
   JSON boolean. — `chat-auto-parser-generator.cpp` L119–145, `server-common.cpp` L1080–1086
7. **Truncation**: `max_tokens` is not bounded by the grammar; a cut-off answer is
   `finish_reason: "length"` with partial JSON (lenient final parse, PR #20191).
   — `common/chat.cpp` L2502–2532, `tools/server/server-task.cpp` L826–839
8. **Schema errors** (unrecognised schema) answer HTTP 400 `invalid_request_error`.
   — `json-schema-to-grammar.cpp` L1004, `common/chat.cpp` L2400–2401

## Field probe (2026-09-23, home machine, Qwen3.6-35B-A3B)

- enum schema (3 names) + `enable_thinking: false`, `max_tokens: 300` → 200,
  `finish_reason: stop`, valid JSON, keys in schema order, value from the enum.
- same with `max_tokens: 16` → 200, `finish_reason: length`, a JSON fragment (confirms 7).

## Consequences in the code

`finish_reason !== "stop"` or a zod failure counts as invalid (one retry, then "none");
`reason.maxLength` 200; the prompt lists the keys; a fence around the JSON is stripped.

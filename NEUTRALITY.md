# Neutrality validation — Phase 5

The highest risk in this architecture is a canonical model that is secretly
Anthropic-shaped and only admits it when the second adapter is written. This
document retires that risk on paper. It maps three saved fixtures, field by
field and block by block, to and from the **OpenAI Chat Completions** and
**Google Gemini `generateContent`** wire formats, in both directions.

No second adapter was built, and none should be until a later plan calls for it.

## Method

Three fixtures carry the table:

| # | Fixture | What it is here to settle |
| --- | --- | --- |
| A | `test/fixtures/request-system-blocks.json` | system-prompt placement, generation params, caller identity, cache breakpoints |
| B | `test/fixtures/request-tools-multi-call.json` | tool definitions, tool choice, tool-call/result correlation, multi-call turns |
| C | `test/fixtures/response-tool-calls.json` + `test/fixtures/stream-tool-call.sse` | response envelope, stop reasons, usage accounting, streaming granularity |

Three fixtures do not reach every block type, so four rows below cite
`request-image.json`, `request-unmodeled.json` and `request-cached-tools.json`
as supporting evidence. Those rows are marked.

A cell is **filled** when the fact has a home in `canonical/` that an adapter can
read and write without reaching into `raw`. Two cell values are filled and are
not defects:

- **`—` (no equivalent).** The provider genuinely lacks the capability. The
  adapter drops it on the way out and leaves the canonical field null on the way
  in. Canonical is the intersection *plus* whatever surplus is cheap to model
  and expensive to lose; it is not the lowest common denominator.
- **derived.** The provider spells the same fact differently and the adapter
  computes it. Every derivation is stated, because an unstated one is how two
  adapters end up producing numbers that cannot be compared.

A cell that resolved to "put it in `raw`" for something a plugin would plausibly
read was treated as a defect in the model and fixed. Nine were found; they are
listed under [What this exercise changed](#what-this-exercise-changed).

`test/neutrality.test.js` is this document as assertions. It strips `raw` from
canonical objects and asserts the facts below are still readable, so the table
fails the build rather than rotting quietly.

---

## Table A — request: system prompt, params, identity

Fixture: `request-system-blocks.json`.

| Anthropic (fixture) | canonical | OpenAI Chat Completions | Gemini `generateContent` |
| --- | --- | --- | --- |
| `model` | `request.model` | `model` | URL path segment `models/{model}` |
| `system: [text, text]` | `request.system: TextBlock[]` | leading `messages[0] = {role:"developer"\|"system", content:[parts]}`; adapter splits it back out on the way in | `systemInstruction: {parts:[{text}]}` |
| `system[1].cache_control` | `TextBlock.cache = {ttlSeconds:null}` | — (implicit prefix caching, no breakpoint) | — (no in-request breakpoint; `cachedContent` is a pre-created resource handle → request `raw`) |
| `messages[].role: user\|assistant` | `Message.role: user\|assistant\|system` | `user` / `assistant`; a `system`/`developer` message after position 0 stays a `ROLE.SYSTEM` message | `user` / **`model`** (renamed by the adapter); no in-band system role, so a `ROLE.SYSTEM` message folds into the next user turn |
| `messages[].content: [text]` | `Message.content: Block[]` | `content: string \| parts[]` | `parts[]` |
| `max_tokens` | `params.maxOutputTokens` | `max_completion_tokens` | `generationConfig.maxOutputTokens` |
| `temperature` | `params.temperature` | `temperature` | `generationConfig.temperature` |
| `top_p` (B) | `params.topP` | `top_p` | `generationConfig.topP` |
| `top_k` (B) | `params.topK` | — | `generationConfig.topK` |
| `stop_sequences` (B) | `params.stopSequences` | `stop` (max 4) | `generationConfig.stopSequences` |
| `stream: true` | `request.stream` | `stream: true` (+ `stream_options.include_usage` — see Table C) | `:streamGenerateContent?alt=sse` |
| `metadata.user_id` | `request.userId` | `user` | — |
| `thinking.budget_tokens` (fixture `request-thinking`) | `params.reasoning.budgetTokens` | — (OpenAI spends by effort) | `generationConfig.thinkingConfig.thinkingBudget` |
| — | `params.reasoning.effort` | `reasoning_effort: minimal\|low\|medium\|high` | — |
| `thinking.type: enabled\|disabled` | `params.reasoning.enabled` | `reasoning_effort` present at all | `thinkingConfig.thinkingBudget: 0` disables |
| `output_format` (`request-cached-tools`) | `params.format` | `response_format: {type, json_schema:{schema}}` | `generationConfig.responseMimeType` + `responseSchema` |
| `metadata.*` (other keys) | request `raw` | — | — |

**System placement is the load-bearing row.** Three providers put the system
prompt in three places and none of them treats it as an ordinary turn, so
canonical gives it a field of its own and every adapter normalizes into it. The
case that field cannot cover is OpenAI's *mid-thread* `system`/`developer`
message, which is why `ROLE.SYSTEM` exists: without it, an instruction is
observed as something the user said, and the transcript lies.

---

## Table B — request: tools, choice, calls and results

Fixture: `request-tools-multi-call.json`.

### Tool definitions

| Anthropic | canonical | OpenAI | Gemini |
| --- | --- | --- | --- |
| `tools[].name` | `ToolDefinition.name` | `tools[].function.name` | `tools[0].functionDeclarations[].name` |
| `tools[].description` | `.description` | `tools[].function.description` | `.description` |
| `tools[].input_schema` | `.parameters` (JSON Schema) | `tools[].function.parameters` | `.parameters` |
| `{type:"web_search_20250305"}` | `.kind = provider` | — (no provider-executed tools) | a sibling key of the `tools` array: `{googleSearch:{}}`, `{codeExecution:{}}` — name derived from the key |
| absent `type`, or `"custom"` | `.kind = function` | `tools[].type: "function"` | an entry in `functionDeclarations` |
| `tools[].cache_control` (`request-cached-tools`) | `.cache` | — | — |
| `tools[].max_uses` | tool `raw` | — | — |

Gemini nests every declared function under one `tools` entry while canonical
keeps a flat list; that is a shape the adapter flattens, not a fact it loses.
`kind` is what makes `parameters: null` legible — a Gemini built-in is a bare
`{googleSearch:{}}` with no name, no description and no schema, and without
`kind` an adapter could not construct a canonical tool for it at all.

### Tool choice

| Anthropic | canonical | OpenAI | Gemini |
| --- | --- | --- | --- |
| `{type:"auto"}` | `mode: auto` | `tool_choice: "auto"` | `toolConfig.functionCallingConfig.mode: AUTO` |
| `{type:"any"}` | `mode: required` | `"required"` | `mode: ANY` |
| `{type:"none"}` | `mode: none` | `"none"` | `mode: NONE` |
| `{type:"tool", name}` | `mode: tool`, `names: [name]` | `{type:"function", function:{name}}` | `mode: ANY` + `allowedFunctionNames: [name]` |
| — | `names: [a, b]` | — (one function only; adapter takes `names[0]`) | `allowedFunctionNames: [a, b]` |
| `disable_parallel_tool_use: false` | `allowParallel: true` | request-level `parallel_tool_calls: true` | — |

`names` is a list because Gemini's `allowedFunctionNames` is one. Anthropic and
OpenAI can each force exactly one tool, so their adapters read `names[0]` and a
restriction to several is a documented downgrade on the way out — not a fact
lost on the way in.

### Calls and results

| Anthropic | canonical | OpenAI | Gemini |
| --- | --- | --- | --- |
| `{type:"tool_use", id, name, input}` | `ToolCallBlock{id, name, input, kind}` | `assistant.tool_calls[]: {id, function:{name, arguments}}` | `parts[].functionCall: {name, args}` |
| `input` (object) | `.input` (object) | `arguments` (**JSON string** — adapter parses) | `args` (object) |
| `{type:"server_tool_use"}` (`request-unmodeled`) | `.kind = provider` | — | a `functionCall` naming a built-in |
| `{type:"tool_result", tool_use_id}` | `ToolResultBlock.callId` | `{role:"tool", tool_call_id}` | — (see below) |
| *(no name on the wire)* | `ToolResultBlock.name` — derived by the adapter from the matching call | derived the same way | `functionResponse.name` — **the only correlation Gemini guarantees** |
| `content: "1 test failed"` | `content: [TextBlock]` | `content: string` | — |
| `content: [{type:"text"}]` | `content: [TextBlock]` | `content: string` (adapter joins) | — |
| `content: {…}` (`request-cached-tools`) | `content: [JsonBlock]` | `content: JSON.stringify(data)` | `functionResponse.response` (**always a struct**) |
| `is_error: true` | `.isError` | — (a failed result is ordinary text) | — (convention inside the payload) |
| `{type:"web_search_tool_result"}` | `.kind = provider` | — | `codeExecutionResult` / grounding metadata |

Two rows here forced model changes.

**Correlation.** Anthropic and OpenAI address a result to a call by id. Gemini's
`functionResponse` carries a `name` and, in recent versions, an optional `id`;
the name is the only field that is always there. An adapter emitting Gemini from
a canonical object therefore needs the tool's name *on the result block*, and
making it walk backwards through the message list to find the matching call
would be both fragile and work every plugin would repeat. `ToolResultBlock.name`
is now resolved once, by the adapter, at conversion time.

**Structured results.** Gemini's `functionResponse.response` is required to be an
object. That is not an edge case there — it is 100% of Gemini tool traffic. A
canonical model that could only hold it as a stringified text block would be
text-only by accident, and would hand the tool-output minifier this platform
exists to build a string to re-parse. Hence `BLOCK.JSON`, whose `data` is the
parsed value.

### Attachments (evidence: `request-image.json`, `request-cached-tools.json`)

| Anthropic | canonical | OpenAI | Gemini |
| --- | --- | --- | --- |
| `{type:"image", source:{type:"base64", media_type, data}}` | `MediaBlock{source:{kind:base64, mediaType, data}}` | `{type:"image_url", image_url:{url:"data:…"}}` | `{inlineData:{mimeType, data}}` |
| `{type:"image", source:{type:"url", url}}` | `{kind:url, url}` | `{type:"image_url", image_url:{url}}` | `{fileData:{fileUri, mimeType}}` |
| `{type:"document", source:{type:"text", data}}` | `{kind:text, mediaType, data}` | `{type:"file", file:{file_data}}` | `{inlineData:{mimeType:"text/plain", data}}` |
| `{type:"document", source:{type:"file", file_id}}` | `{kind:id, id}` | `{type:"file", file:{file_id}}` | `{fileData:{fileUri}}` |
| audio / video | same block, different `mediaType` | `input_audio` | `{inlineData:{mimeType:"audio/…"}}` |

One block, keyed by media type and carrier. The previous `BLOCK.IMAGE` was the
clearest instance of the risk this phase exists to find: Gemini carries every
attachment through one part shape, and a PDF — which Anthropic sends as a
`document` and Claude Code really does send — had no canonical home at all and
was landing in `unknownBlock`.

### Reasoning blocks (evidence: `request-thinking.json`)

| Anthropic | canonical | OpenAI | Gemini |
| --- | --- | --- | --- |
| `{type:"thinking", thinking, signature}` | `ThinkingBlock{thinking, signature}` | Responses API `reasoning.summary[]` (Chat Completions returns no reasoning text) | `parts[]` with `thought: true` |
| `{type:"redacted_thinking", data}` | `{redacted: true, thinking: ""}`, blob in `raw` | `reasoning.encrypted_content` | — |
| `signature` | `.signature` | item `id` | `thoughtSignature` |

The blob of an opaque reasoning block is the one payload that is deliberately
left in `raw`: it is uninterpretable by anything but the provider that issued
it, and the fact a plugin needs — *there was reasoning here, and it is not
readable* — is `redacted: true`.

---

## Table C — response, stop reasons, usage, streaming

Fixtures: `response-tool-calls.json`, `stream-tool-call.sse`.

### Envelope

| Anthropic | canonical | OpenAI | Gemini |
| --- | --- | --- | --- |
| `id` | `response.id` | `id` | `responseId` |
| `model` | `.model` | `model` | `modelVersion` |
| `role: "assistant"` | `.role` | `choices[0].message.role` | `candidates[0].content.role: "model"` |
| `content[]` | `.content` | `choices[0].message` (`content` + `tool_calls`) | `candidates[0].content.parts` |
| `stop_sequence` | `.stopSequence` | — | — |
| `{type:"error", error:{type, message}}` | `.error` | HTTP body `{error:{type, message, code}}` | `{error:{code, status, message}}` |
| — | `.content = []`, `stopReason: content_filter` | `choices[0].finish_reason: "content_filter"` | `promptFeedback.blockReason` with no candidates |
| `n` / multiple candidates | one turn; extras in `raw` | `n` > 1 | `candidateCount` > 1 |

Canonical models one turn. Requesting several is out of scope for observation,
and the cost of the extras is still visible because all three providers report
completion tokens across all candidates.

### Stop reasons

| canonical | Anthropic | OpenAI `finish_reason` | Gemini `finishReason` |
| --- | --- | --- | --- |
| `end_turn` | `end_turn` | `stop` | `STOP` |
| `max_tokens` | `max_tokens` | `length` | `MAX_TOKENS` |
| `stop_sequence` | `stop_sequence` | `stop` (indistinguishable from `end_turn`) | `STOP` (indistinguishable) |
| `tool_call` | `tool_use` | `tool_calls`, `function_call` | `STOP` — **derived**: Gemini reports a plain stop, so the adapter infers it from the presence of `functionCall` parts |
| `content_filter` | `refusal` | `content_filter` | `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY` |
| `other` (+ original in `raw`) | `pause_turn` and anything new | anything new | `LANGUAGE`, `MALFORMED_FUNCTION_CALL`, `UNEXPECTED_TOOL_CALL`, `OTHER` |

`STOP_REASON.OTHER` keeps the provider's original spelling so the adapter can
put it back and a plugin still knows the turn ended somehow. It is the one place
`raw` is read on the response path, and it is read by the adapter, not a plugin.

### Usage accounting

This is the table that matters most, because this is a token efficiency platform
and these numbers are the baseline every future transform is judged against.
**The three providers disagree about what their own counters include**, and an
adapter that copies them across verbatim produces a ledger that cannot be
compared with itself, let alone across providers.

| canonical | definition | Anthropic | OpenAI | Gemini |
| --- | --- | --- | --- | --- |
| `inputTokens` | prompt tokens billed at full rate, **excluding** cache reads | `input_tokens` (already exclusive) | **derived:** `prompt_tokens − prompt_tokens_details.cached_tokens` | **derived:** `promptTokenCount − cachedContentTokenCount` |
| `cacheReadTokens` | prompt tokens served from cache | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | `cachedContentTokenCount` |
| `cacheWriteTokens` | prompt tokens written to cache | `cache_creation_input_tokens` | — (implicit caching writes nothing billable) | — (context caches are created out of band) |
| `outputTokens` | generated tokens, **including** reasoning | `output_tokens` (already inclusive) | `completion_tokens` (already inclusive) | **derived:** `candidatesTokenCount + thoughtsTokenCount` |
| `reasoningTokens` | the reasoning share of `outputTokens` | — | `completion_tokens_details.reasoning_tokens` | `thoughtsTokenCount` |
| `totalTokens` | what the provider itself billed | — | `total_tokens` | `totalTokenCount` |

Two conventions hold these together:

1. **null is not zero.** A provider that does not report a number leaves it
   null. `cacheWriteTokens: 0` means the provider said the cache write was
   empty; `null` means it has no such concept. A meter that cannot tell those
   apart reports fiction.
2. **`totalTokens` is reported, never derived.** Keeping it as the provider sent
   it means a mismatch against the parts stays visible instead of being
   arithmetic'd away — Gemini's `toolUsePromptTokenCount`, for instance, is
   inside its total and outside its prompt count.

`test/neutrality.test.js` asserts the OpenAI and Gemini derivations for one
identical turn produce a deep-equal `usage` object.

### Streaming granularity

| | Anthropic | OpenAI | Gemini |
| --- | --- | --- | --- |
| framing | `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop` | one `chat.completion.chunk` per delta | one whole `GenerateContentResponse` per chunk |
| block identity | explicit `index` | `choices[0].delta.tool_calls[].index`; text has no index | position within `parts` |
| block boundaries | explicit start/stop events | inferred from index changes and `finish_reason` | inferred from part shape |
| text | `text_delta` fragments | `delta.content` fragments | partial `text` per chunk |
| tool arguments | `input_json_delta` fragments of a JSON string | `delta.tool_calls[].function.arguments` fragments | whole `functionCall` part, never fragmented |
| reasoning | `thinking_delta` + `signature_delta` | Responses API `reasoning` item deltas | whole thought parts |
| terminal usage | `message_delta.usage`, cumulative | final chunk, **only with `stream_options.include_usage`** | `usageMetadata` on the final chunk, cumulative |
| errors | an `error` SSE event mid-stream | HTTP error, or a truncated stream | an error object in a chunk |

**Every cell above is adapter-internal.** Canonical has no streaming shape at
all: the accumulator rebuilds the provider's own wire-form message and converts
once at the end, so a streamed turn and the same turn unstreamed produce
identical canonical objects *by construction* rather than through two mappings
that can drift. Three framings, one destination — which is why this is the one
section of the table where the neutrality question does not arise.

The one thing a plugin might want that canonical deliberately does not carry is
whether the stream finished cleanly. That is observation metadata, not a fact
about the turn, and it lives on the accumulator's `state()` and in `ctx`.

---

## What this exercise changed

Nine cells could not be filled, or could only be filled with "put it in `raw`"
for something a plugin would plausibly read. Each was fixed in the model.

| # | Change | The cell that forced it |
| --- | --- | --- |
| 1 | `ROLE.SYSTEM` | OpenAI permits a `system`/`developer` message mid-thread; it was being observed as a user turn |
| 2 | `cache` on blocks and tool definitions | Anthropic `cache_control` was in `raw` — the one request-side control that decides cache-write vs cache-read, on a platform whose whole point is that measurement |
| 3 | `TOOL_KIND` on definitions, calls and results | Gemini's `{googleSearch:{}}` has no name, description or schema; a provider-executed result is also not a transform's to rewrite |
| 4 | `toolChoice.names` (was `name`) | Gemini's `allowedFunctionNames` is a list |
| 5 | `ToolResultBlock.name` | Gemini correlates results to calls by name, not id; every plugin was going to re-derive it |
| 6 | `BLOCK.JSON` | Gemini's `functionResponse.response` is required to be a struct — every Gemini tool result |
| 7 | `usage.reasoningTokens`, `usage.totalTokens`, and exact definitions for `inputTokens` / `outputTokens` | the three providers disagree on whether prompt tokens include cache reads and whether completion tokens include reasoning |
| 8 | `BLOCK.MEDIA` (was `BLOCK.IMAGE`), with `MEDIA_SOURCE.TEXT` and `.ID` | Gemini carries every attachment through one part shape; PDFs and audio had no home and were landing in `unknownBlock` |
| 9 | `reasoning.effort`, `params.format` | OpenAI spends reasoning by ordinal rather than budget; all three providers support constrained output and canonical had no field for it |

The Anthropic adapter absorbed all nine, and the full fixture corpus still
round-trips semantically — the Phase 2 exit criterion is unchanged and still
asserted.

## What stays in `raw`, and why no plugin needs it

| Left in `raw` | Argument |
| --- | --- |
| Anthropic `service_tier`, `mcp_servers`, `metadata.trace_id` | provider-specific routing and identity with no cross-provider meaning; none changes what the model saw or what the turn cost |
| the `redacted_thinking` blob, OpenAI `encrypted_content` | uninterpretable except by the issuing provider; the readable fact is `redacted: true` |
| Gemini `cachedContent` | a handle to a resource created by a separate API call, not a position in the prompt; its measurable consequence is `usage.cacheReadTokens`, which is modeled |
| Gemini `safetyRatings`, `citationMetadata`, OpenAI `logprobs`, `system_fingerprint`, `seed` | diagnostics about the generation, not the content or the cost of it |
| the original spelling of a `STOP_REASON.OTHER` | read by the adapter to restore it, never by a plugin, which reads `other` |
| a tool call's argument fragment when a stream is cut mid-JSON | there is no object to model because the turn never completed; the accumulator records a warning, and a completed turn never takes this path |
| the wire block type behind a `media` block or a provider tool result | adapter bookkeeping for an exact round trip; the facts a plugin reads are `kind` and `source.mediaType` |

## Note on the OpenAI Responses API

The table maps Chat Completions, which is the format most third-party gateways
also speak. The Responses API restructures the envelope — reasoning is a
first-class item, function calls are top-level items rather than message
attachments, tool results are `function_call_output` items, and the system
prompt is `instructions` — but it does not add a *kind* of fact this model
cannot hold. The differences that matter to an adapter:

| Responses API | canonical |
| --- | --- |
| `instructions` | `request.system` |
| `input[]` items instead of `messages[]` | `request.messages` (adapter regroups items into turns) |
| `function_call` / `function_call_output` items with `call_id` | `ToolCallBlock.id` / `ToolResultBlock.callId` |
| `reasoning` item with `summary[]` and `encrypted_content` | one `ThinkingBlock` per summary part; `redacted: true` for the encrypted form |
| `incomplete_details.reason: "max_output_tokens"` | `STOP_REASON.MAX_TOKENS` |
| `usage.input_tokens` / `output_tokens` (`input_tokens_details.cached_tokens`) | same derivations as Chat Completions |
| `previous_response_id`, `store` | request `raw` — server-side conversation state, which this gateway does not model |

## The harness

`test/fixture-harness.js` is the instrument every future adapter uses:

```
fixture in  ->  assertCanonicalShape(canonical, 'request'|'response')
            ->  assertSemanticEqual(fromCanonical(canonical), fixture)
```

`assertCanonicalShape` validates against `canonical/` alone and imports no
adapter. It checks the **exact** key set at every node, so a missing field is a
hole and an extra field is an adapter smuggling provider surplus into the shared
model instead of into `raw` — the failure mode this whole document exists to
catch. `assertRoundTrip` runs all three legs, plus a deep-freeze walk asserting
invariant 1 structurally.

## Exit criterion

- The mapping table has no empty cells. Every `—` is a stated absence in a
  provider, not a gap in the model.
- No entry resolves to "put it in `raw`" for anything a plugin would plausibly
  need to read. The seven entries that do stay in `raw` are listed above with
  the argument for each.
- The fixture harness future adapters will use exists, is adapter-agnostic, and
  runs over the whole corpus.

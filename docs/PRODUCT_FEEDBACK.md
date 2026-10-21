# Product feedback

Required by the hackathon: feedback on **every API/SDK used**. Written from the build, not from
imagination. Two columns matter: *exercised* means the recorded demo actually ran through it.

| Product | Exercised in demo | Role in Dosewise |
| --- | --- | --- |
| MCP TypeScript SDK v2 (`server`, `client`, `node`, `express`) | yes | The product itself |
| MCP spec 2026-07-28 (Streamable HTTP, tools, resources, prompts) | yes | Wire protocol |
| RxNorm / RxNav REST (NLM) | yes | Brand → ingredient normalisation |
| openFDA drug label API | yes | The quoted evidence |
| DailyMed | links only | Human-readable label link |
| Amazon Bedrock Converse + `@aws-sdk/client-bedrock-runtime` | **no** — no AWS credentials on the build machine | Agent tool loop |
| Web Speech API (browser) | yes | Speech in/out in the simulator |
| Express 5, zod 4, Node 22+ `fetch` | yes | Supporting stack |

---

## MCP TypeScript SDK v2

**What worked.** Once past the API discovery, the shape is good. `createMcpHandler(factory)` giving a fresh
`McpServer` per request is exactly right for a multi-tenant server: no session state, no cleanup, no leaks
between callers. `toNodeHandler` is a two-line bridge to Express. `registerTool` with zod schemas and
`annotations` produced a tool list that a model could actually use, and the client side
(`Client` + `StreamableHTTPClientTransport` + `requestInit.headers`) worked first try against my own server.
The smoke test — real client, real transport, real bearer token — is the most valuable 90 lines in the repo,
and the SDK made it easy.

**What hurt.**

1. **Four packages, v1 docs.** Everything written before v2 says `@modelcontextprotocol/sdk`. Half a day went
   into discovering `server`/`client`/`node`/`express` and the handler/factory shape. A "v1 → v2" page at the
   top of the docs would fix this.
2. **The context object is undocumented in practice.** `ctx.http.authInfo` and `ctx.mcpReq` are the two
   things every authenticated server needs; I found both by reading `.d.mts` files. Please put a
   `ServerContext` reference table in the docs.
3. **`elicitInput` throws on era ≥ 2026-07-28** with no documented alternative. That single fact changed the
   architecture of this project (see friction log #2 and #12).
4. **Structured output is all-or-nothing.** `structuredContent` must satisfy `outputSchema` exactly, and the
   type errors surface at the registration site rather than at the offending field. A dev-mode validator that
   names the failing JSON path would save real time on tools with optional/nested fields.
5. **Zod 4 must be imported from `zod/v4`.** Not obvious from the error, which points at the schema's use in
   `registerTool`.
6. **Unclear error contract.** The docs do not say what happens when a handler throws. I catch every handler
   and return `{ content, isError: true }` manually. If the SDK already does that, the docs should say so; if
   it does not, it should.
7. **`createMcpExpressApp()` is opinionated in a good way but silently so.** The Host/Origin guard is the
   right default; the 403 gives no hint that `allowedHosts` exists.

**Small asks.** A `tools/list` JSON viewer in the inspector; a typed helper for "return this object as both
text and structured content"; and an official example that mounts the handler with bearer auth **and** a
static front-end, since that is what most hackathon submissions actually are.

## MCP specification 2026-07-28 (Streamable HTTP, tools, resources, prompts)

**What worked.** Streamable HTTP is a good fit for a server that must be reachable from a hosted assistant:
one URL, POST for requests, optional SSE, no long-lived socket to babysit. Tool annotations
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) map cleanly onto what a caregiver UI
needs to warn about. Resources are the right primitive for "pre-load the household record", and prompts are
the right primitive for "suggested actions" — I used both rather than inventing endpoints.

**Gaps I hit.**

- **Human-in-the-loop is not solved at the protocol level.** Sampling, elicitation and host approvals overlap
  and are era-dependent. A server that changes health or financial records needs a portable, verifiable
  approval handle. I built one with single-use tokens; it should not have been necessary (friction #12).
- **No first-class "unverified" semantic.** Tool results are success or error. "I checked and could not
  reach the source" is neither, so it lives inside my payload as a verdict string. A structured way to
  express partial results would help every evidence-backed server.
- **Bearer auth is underspecified for self-hosted servers.** The authorization spec is written for OAuth
  resource servers. A paragraph on "static token, single tenant, localhost" would legitimise the most common
  hackathon deployment instead of leaving it as an undocumented shortcut.
- **Resource templates need better streaming/listing ergonomics.** `list: undefined` for a template the
  server could enumerate is a missed opportunity; I have the medication IDs, the client cannot discover them.

## RxNorm / RxNav (NLM)

**What worked.** Fast, keyless, and genuinely useful. `rxcui.json?name=advil` → approximate term → `related.json?tty=IN`
gave me the ingredient reliably, which is what makes "Advil" and "ibuprofen" the same question. Latency was
consistently under 300 ms.

**What hurt.**

- **`/REST/interaction/list.json` is retired (404)** but still appears in tutorials. This is the reason the
  product mines label text instead of calling a curated interaction database.
- **The three-step normalisation dance** (exact name → approximate term → related by TTY) is not obvious from
  the docs, and each step has a different response shape. A single `normalize?name=` endpoint returning
  `{ rxcui, ingredient, brandNames }` would remove ~60 lines from every consumer.
- **No documented rate limit.** I cache per-process and keep volume low, but a stated limit (and a 429
  contract) would let me back off correctly instead of guessing.

## openFDA drug label API

**What worked.** It is the only free source of the *actual sentence* a pharmacist would read, and
`effective_time` plus `set_id` make an answer verifiable. Search by `openfda.generic_name` with a quoted
phrase is reliable. Latency ~200–600 ms per label.

**What hurt.**

- **404 means zero results.** The single biggest integration trap (friction #8).
- **No field selection.** ~120 KB per label, and a label search returns whole documents. A `fields=` or
  `sections=` parameter would turn an 8.7 s answer into a 300 ms one.
- **No "why did this match" signal.** Search relevance is opaque; I fetch two labels and search them myself
  rather than trust a single top hit.
- **Labels lag practice, and that is invisible in the payload.** `effective_time` helps, but nothing in the
  response says "this section was last substantively updated in 2019".

**Asks.** 404-as-empty in the docs; field selection; a `sections` map in the response (the raw keys are
inconsistent across labels: `drug_interactions` vs `drug_interactions_table`).

## DailyMed

Used only for deep links (`drugInfo.cfm?setid=…`), which is the right job for it: a human-checkable source
behind every claim. No API used, no friction. Keeping `set_id` in the tool result is what makes the citation
trustworthy.

## Amazon Bedrock Converse (`@aws-sdk/client-bedrock-runtime`)

**Status: implemented, documented, and not exercised on the recorded demo** — this build machine had no AWS
credentials and no `aws` CLI. Being explicit about that is more useful than pretending.

**What I can say from the implementation.** The Converse API's tool loop is the cleanest of the major
providers: `toolConfig.tools[].toolSpec.inputSchema.json`, `stopReason === 'tool_use'`, then a `user` message
containing `toolResult` blocks keyed by `toolUseId`. Mapping MCP `tools/list` output straight into
`toolSpec` is a near-identity transform, which is precisely why an MCP server is a good backend for an
Alexa+ experience: the tool contract already exists.

**What I would want.** A local emulator or a documented offline mode for credential-less development. The
gap between "the code path exists" and "I watched it answer" is the difference between a demo and a claim,
and every team without an AWS account in the room hits it. A small `bedrock-mock` container that echoes
`tool_use` for a scripted prompt would let teams build the loop before they get credentials.

**What I could not evaluate.** Model quality for this task (tool-choice reliability, spoken-length
discipline), throttling behaviour, and cross-region inference profiles. Those remain untested claims, so the
submission does not lean on them.

## Web Speech API (browser)

**What worked.** `SpeechRecognition` and `speechSynthesis` made the simulator feel like a voice product with
about 40 lines of code, and being able to speak the question is what sells the demo.

**What hurt.** Chrome-only in practice (`webkitSpeechRecognition`), needs a user gesture, and voice selection
is a global list that populates asynchronously — the first `getVoices()` call is often empty. Also no
ducking: the TTS talks over the presenter unless you cancel it explicitly.

**Asks.** A stable, non-prefixed API and a promise for voice enumeration. Nothing here blocked the build;
it just adds defensive code a web demo should not need.

## Supporting stack

- **Express 5** — async handlers without wrappers, and `app.all` mounting the MCP bridge is clean. No
  friction.
- **zod 4** — great types, but see the `zod/v4` import note above; the SDK's schema types are what force it.
- **Node 22+ `fetch` with `AbortSignal.timeout`** — replaced an HTTP client dependency entirely. The only
  sharp edge: `AbortSignal.timeout` rejects with a `TimeoutError`, which is easy to mistake for a DNS failure
  when you log `error.message`.
- **`node --test` + `tsx`** — zero-config unit tests with TypeScript, and the same runtime the server uses.
  Running a real MCP client inside a smoke test (rather than mocking the transport) caught two bugs that unit
  tests would have missed.

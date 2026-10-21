# Friction log

Everything below actually happened while building Dosewise for the Alexa+ track (October 2026, Windows 11,
Node 24, TypeScript 5.9). Each entry records what I tried, what happened, what I did instead, and what would
have removed the friction. Ordered by how much time it cost.

| # | Friction | Cost | Kind |
| --- | --- | --- | --- |
| 1 | MCP TypeScript SDK v2 is four packages and the docs still show v1 | ~3 h | Docs / SDK |
| 2 | Elicitation is unusable on the current protocol era | ~1 h | Protocol / SDK |
| 3 | No free drug-interaction API (RxNav endpoint retired) | ~2 h | Third-party API |
| 4 | openFDA has no field selection and ships ~120 KB labels | ~1.5 h | Third-party API |
| 5 | Label text is a table dump; naive matching produces false alarms | ~2 h | Data quality |
| 6 | `outputSchema` + `structuredContent` must agree exactly | ~1 h | SDK |
| 7 | Host allow-list / DNS-rebinding guard vs. tunnels | ~40 min | SDK / deployment |
| 8 | openFDA answers 404 when there are zero results | ~30 min | Third-party API |
| 9 | No way to pin time for a reproducible demo | ~30 min | Tooling gap |
| 10 | Devpost pages 403 to programmatic fetch | ~20 min | Hackathon site |
| 11 | Windows + PowerShell + SSE is a bad combination | ~20 min | Tooling |
| 12 | Human-in-the-loop has no cross-era primitive | ~1 h | Protocol design |

---

## 1. MCP TypeScript SDK v2: four packages, v1 docs

**Tried.** `npm i @modelcontextprotocol/sdk` and the canonical "Streamable HTTP server" example
(`new StreamableHTTPServerTransport({ sessionIdGenerator })`, `server.connect(transport)`).

**Happened.** The v2 release is split into `@modelcontextprotocol/server`, `/client`, `/node`, `/express`.
The old import paths and the manual transport wiring are gone. The high-level path is
`createMcpHandler(factory)` → `toNodeHandler(handler)` → mount on Express, and the *factory runs once per
HTTP request*. `createMcpExpressApp()` also adds JSON parsing and Host/Origin guards you did not ask for.

**Worked around.** Read the shipped `.d.mts` files to recover the actual signatures (`McpServerFactory`,
`ServerContext`, `registerTool(name, config, handler)`, `ctx.http.authInfo`). Wrote
`src/mcp/server.ts` as a factory and documented the shape in `docs/ARCHITECTURE.md`.

**Would remove the friction.** A v2 migration page that opens with "the v1 examples no longer compile" and
one complete, copy-pasteable Express + auth + tools example. Bonus: a `ctx` type reference — I found
`http.authInfo` by grepping the type declarations, not from a doc page.

## 2. Elicitation is unusable on the current protocol era

**Tried.** `ctx.mcpReq.elicitInput({...})` to ask the caregiver "add acetaminophen 500 mg — yes or no?" in
the middle of a tool call. It is the protocol-native way to do this.

**Happened.** On 2026-07-28-era connections `elicitInput` throws; the 2025-11-25 shape is different. The MCP
SDK v2 serves 2026-07-28. Making the only safety-critical interaction in the product depend on an
era-specific API would have meant the server behaves differently depending on which client connected.

**Worked around.** Two-phase confirmation with single-use tokens (`propose_medication_change` →
`apply_medication_change`), documented in `docs/ARCHITECTURE.md` §4. It is plain `tools/call`, works on every
era, and leaves the confirmation UI to the host.

**Would remove the friction.** Either a compatibility note on the elicitation page ("throws on era ≥
2026-07-28; use X instead") or a server-side helper that degrades gracefully. Right now the failure is a
thrown exception with no documentation trail.

## 3. No free drug-interaction API

**Tried.** `GET https://rxnav.nlm.nih.gov/REST/interaction/list.json?rxcuis=11289+5640` — the documented
RxNav interaction endpoint, still referenced in tutorials.

**Happened.** `404`. The service is retired. There is no free, keyless, structured interaction API left
(NLM's Drug Interaction API requires a UMLS license key; commercial ones require contracts).

**Worked around.** Built the answer from **FDA label text**: per-medication openFDA labels, sentence-level
extraction around the candidate's name, severity heuristics, plus a small curated table for well-known pairs
whose prose is easy to miss. The UI is explicit that this is label-grounded, not a curated interaction
database.

**Would remove the friction.** A maintained status page for retired NLM APIs, and a note in the RxNav docs
pointing to the replacement. Tutorials still teach the retired endpoint, which is how I lost the first hour.

## 4. openFDA: no field selection, ~120 KB per label

**Tried.** `drug/label.json?search=openfda.generic_name:"warfarin"&limit=5` to get a few recent labels.

**Happened.** Each label is ~120 KB of prose (five labels ≈ 600 KB). There is no `fields=` parameter to
select only `drug_interactions`/`warnings`/`set_id`. Five medications × five labels meant a 3 MB payload and
an **8.7 second** answer — fatal for a voice interaction.

**Worked around.** `limit=2`, a six-hour in-process cache, and a boot-time prewarm for the seeded
medications. Steady state is 5–15 ms; a cold lookup is ~2 s.

**Would remove the friction.** A `fields` query parameter (or a `sections=` filter). Every consumer of this
API pays for the sections it does not read.

## 5. Label text is a table dump

**Tried.** Find the candidate drug's name in `drug_interactions` and show the sentence.

**Happened.** Three distinct failure modes, all visible in the first demo run:

- The warfarin label lists NSAIDs inside a flattened table row: hundreds of characters, one "sentence",
  ibuprofen buried in the middle.
- The omeprazole label contains *"refer to the CONTRAINDICATIONS section of their package inserts"* — a
  cross-reference that mentions clarithromycin and scored as **high**.
- The metformin label says *"the pharmacokinetics of metformin and ibuprofen were not affected"* — i.e. no
  interaction — and our severity heuristic scored it **moderate** because it contains "interaction".

**Worked around.** Sentence extraction with a ±140/180-character window when the sentence is a table
(many commas or > 300 chars); a `BOILERPLATE_PATTERN` filter for cross-references; a `NO_EFFECT_PATTERN`
filter for explicitly negative statements. Both filters are covered by unit tests.

**Would remove the friction.** Nothing in the API can fix this — it is how the labels are written. But a
"label text is FDA prose, expect tables" warning in the openFDA docs would save every new consumer the same
afternoon.

## 6. `outputSchema` and `structuredContent` must agree exactly

**Tried.** Return `structuredContent` with a handful of fields plus a zod `outputSchema`.

**Happened.** The SDK validates structured results against the declared schema, so every optional field,
every union, and every nested evidence object had to be declared precisely. Zod 4 must be imported from
`zod/v4` to match the SDK's schema types; `import { z } from 'zod'` produced type errors that pointed at the
tool registration, not the import.

**Worked around.** Hand-wrote schemas for all nine tools (worth it: hosts get a real contract) and kept the
`isError` path out of `structuredContent`.

**Would remove the friction.** Document the `zod/v4` import path prominently, and show one tool whose result
includes an optional field and a nested object — that is where the mismatch bites. Also: say explicitly what
happens when a handler throws (I could not find it stated, so every handler catches and returns
`{ isError: true }` itself).

## 7. Host allow-list vs. tunnels

**Tried.** `createMcpExpressApp()` and then expose it through a tunnel.

**Happened.** The default app binds `127.0.0.1` and rejects a non-localhost `Host` header — correct
DNS-rebinding defence, confusing first error. The failure is a plain `403`, with no hint that a host
allow-list exists.

**Worked around.** `ALLOWED_HOSTS` / `ALLOWED_ORIGINS` env vars, documented in `.env.example` and the
README. For the recorded demo everything stayed on localhost.

**Would remove the friction.** Mention `allowedHosts` in the same paragraph as the tunnel instructions, and
log the rejected Host value at warn level so the cause is obvious.

## 8. openFDA returns 404 for "no results"

**Tried.** `if (!response.ok) throw` around the label request.

**Happened.** A drug with no label returns HTTP **404** with a JSON body `{"error": {"code": "NOT_FOUND"}}`.
The first version treated that as a network failure, so every unknown drug became an outage.

**Worked around.** 404 → empty result set. Only 5xx/timeouts throw, and those produce `unverified`.

**Would remove the friction.** A sentence in the docs: "zero results are a 404, not a 200 with an empty
array." This is the single most common openFDA integration bug I have seen.

## 9. No way to pin time for a reproducible demo

**Tried.** Record the demo at a fixed hour so "3 of 6 doses taken, warfarin due at 6 p.m." stays true.

**Happened.** Adherence is a function of wall-clock time, so the answer changes between takes and the video
disagrees with the repo. Node has no supported way to freeze `Date` without a dependency and a `--require`
hook.

**Worked around.** `DEMO_CLOCK` in `src/config.ts`: `now()` and `todayKey()` read it, so `DEMO_CLOCK=09:40`
means "today at 09:40 local". Seeded dose logs are relative to that clock.

**Would remove the friction.** Not an API problem — but for anyone demoing a time-dependent agent, a
first-class "simulated now" in the host would be nice. Practical tip for other teams: build the clock seam on
day one, not on recording day.

## 10. Devpost pages 403 to programmatic fetch

**Tried.** Fetch the hackathon overview and requirements pages to extract the track rules.

**Happened.** `403` from the fetch tool (bot protection). The rules were only readable through a real
browser.

**Worked around.** Used a browser session to read the track requirements, mini-challenge definitions, and
judging criteria, then transcribed the parts that mattered into this repo's docs.

**Would remove the friction.** A plain, cacheable `/rules` page (or a JSON endpoint). Teams that build
against the wrong requirement lose days.

## 11. Windows + PowerShell + SSE

**Tried.** `Invoke-WebRequest` with `Accept: application/json, text/event-stream` to poke `/mcp` during
development.

**Happened.** "Windows PowerShell is in NonInteractive mode. Read and Prompt functionality is not
available." — an unhelpful error that has nothing to do with the request. PowerShell 5.1 also mangles SSE
bodies.

**Worked around.** All probing moved to Node (`fetch`) scripts and a real MCP client. That also became the
smoke test, which is better than curl one-liners anyway.

**Would remove the friction.** Put a `fetch`-based probe in the MCP docs next to the curl example; curl and
PowerShell are not equivalent clients for a streaming endpoint.

## 12. Human-in-the-loop has no cross-era primitive

**Tried.** Design "ask the human before writing" as a first-class part of the server.

**Happened.** The protocol has three overlapping mechanisms — sampling, elicitation, and now host-side tool
approval — with different era support and different host behaviour. None of them lets a **server** prove
that a **specific human** approved a **specific action**.

**Worked around.** Two-phase tokens bound to `clientId`, hashed at rest, single use, 10-minute TTL, with the
action name included in the binding. Replay, cross-client redemption, action substitution and expiry are all
tested.

**Would remove the friction.** A small, era-stable "deferred action" primitive — `tools/prepare` returning an
opaque handle that the host can attach to a human decision. Every agent that touches money, health, or
production infrastructure rebuilds this wheel, usually worse.

# Dosewise architecture

A single Node process serves three things: the MCP endpoint, the Alexa+ experience simulator, and the
agent that connects them. Everything is plain TypeScript, one JSON file, no build step for the UI.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Browser — Alexa+ experience simulator (web/)                                │
│  mic → /api/chat → transcript, safety card, MCP traffic panel                 │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ POST /api/chat  (bearer token)
┌───────────────▼──────────────────────────────────────────────────────────────┐
│  src/http/chat.ts — one short-lived MCP client per turn                       │
│    └── src/agent/run.ts → bedrock.ts (Converse tool loop) │ scripted.ts       │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ Streamable HTTP + Authorization: Bearer …
┌───────────────▼──────────────────────────────────────────────────────────────┐
│  POST /mcp  → bearerAuth → recordTraffic → createMcpHandler(serverFactory)    │
│                                                                              │
│  serverFactory(): a fresh McpServer per request                              │
│    tools.ts (9) · resources.ts (5) · prompts.ts (2) · server instructions      │
│    every handler: requireScope(ctx, …) → domain → structuredContent           │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────────────┐
│  domain/ — interactions · rxnorm · openfda · medications · confirmations      │
│            alerts                                                             │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │
        store/store.ts — one JSON file, serialised mutations, atomic rename
```

## 1. Request lifecycle

1. **Auth.** `src/http/auth.ts` parses `Authorization: Bearer …`, looks the token up in `config.tokens`,
   and attaches `{ token, clientId, scopes }` to the request. Missing or unknown token → `401` with
   `WWW-Authenticate: Bearer realm="dosewise"`. No OAuth server is implemented; these are static bearer
   credentials, which the MCP authorization spec permits for a self-hosted server.
2. **Traffic capture.** `src/http/traffic.ts` reads the JSON-RPC body (method, tool name, resource URI),
   starts a timer, and pushes an entry on `finish`. The simulator renders this list, so every spoken answer
   has a matching `tools/call` on screen.
3. **MCP handling.** `createMcpHandler(createServerFactory(store))` builds a **new `McpServer` per HTTP
   request**. Nothing session-scoped is retained server-side, which is what makes the same endpoint safe for
   several clients with different scopes.
4. **Tool execution.** Each handler calls `requireScope(ctx, …)`, which throws a `ScopeError` that is
   converted into an `isError: true` tool result with a human-readable message. The model sees the refusal
   and can explain it, rather than the client getting a 500.
5. **Response.** Every tool returns both `content` (a spoken-friendly text block) and `structuredContent`
   validated by the tool's `outputSchema`.

## 2. Data model

One `Database` object, persisted as JSON (`src/store/store.ts`):

| Field | Purpose |
| --- | --- |
| `household` | patient id, caregiver ids, timezone |
| `people` | patient + caregivers, with `conditions` and `allergies` |
| `prescribers` | name, specialty, phone |
| `medications` | name, strength, instructions, `schedule[{ id, time }]`, status, timestamps |
| `doseLogs` | one row per medication × slot × day, with `status`, `recordedAt`, `recordedBy` |
| `confirmations` | hashed tokens, bound action, payload, client id, expiry, used flag |
| `outbox` | caregiver alerts with delivery status |
| `audit` | append-only actor/action/detail trail |

**Why a JSON file.** The demo runs on one machine with one writer. A single-file store with
write-then-rename gives atomicity, is trivially inspectable during a demo (`data/db.json`), and needs no
native build step — `better-sqlite3` would have meant compilers on the judging machine. Mutations are
serialised through a promise chain, so concurrent tool calls cannot interleave a read-modify-write.

**Reset the demo:** delete `data/db.json` and restart.

## 3. The safety pipeline (`src/domain/interactions.ts`)

```
normalise → per-medication label search → sentence extraction → severity → verdict
```

**Normalisation.** `rxnorm.ts` calls `rxcui.json?name=` for an exact match, then
`approximateTerm.json?term=` for brand names and typos, then `rxcui/{id}/related.json?tty=IN` to get the
ingredient. So *Advil → ibuprofen (5640)*, *Tylenol → acetaminophen*. If RxNorm is unreachable the literal
name is used and the report says so.

**Label search.** For each active medication, `openfda.ts` fetches the **two most recent labels** for the
ingredient (`openfda.generic_name`, falling back to `substance_name`) and caches them for six hours. Two,
not one, because the newest label is not always the one that mentions a given co-drug; and not five, because
a warfarin label is ~120 KB and five of them per medication turns a voice interaction into a ten-second
pause. At boot the cache is warmed for every seeded medication.

**Extraction.** For each label and each section in priority order
(`boxed_warning → contraindications → drug_interactions → drug_interactions_table → warnings_and_cautions →
warnings → precautions`) we find the first mention of the candidate's names/synonyms and return the sentence
around it. If the "sentence" is really a flattened table row (many commas, or >300 chars) we return a
bounded ±140/180-character window instead, so the quote is readable.

**Filtering.** Two classes of sentence are discarded:
- *Boilerplate* — "refer to the CONTRAINDICATIONS section", "see package insert". They mention the drug
  but assert nothing.
- *No effect* — "the pharmacokinetics of metformin and ibuprofen were not affected". Reporting that as an
  interaction would be actively misleading.

**Severity.** `classifySeverity(quote)`:
`high` for contraindication / do-not-use / fatal / serious bleeding / serotonin syndrome / rhabdomyolysis /
QT prolongation; `moderate` for caution / monitor / may increase / INR / bleeding; otherwise `mention`.

**Curated pairs.** A small, reviewable table (`CURATED_PAIRS`) covers pairs whose label prose is easy to
miss. The table never overrides label evidence: severity is the maximum of the two, and the label quote is
attached when one exists.

**Allergies.** Literal match plus four families (penicillin, cephalosporin, sulfa, NSAID), because "she is
allergic to penicillin" must also catch amoxicillin. Family matches are phrased as cross-reactivity, not
certainty.

**Verdict.**

| Condition | Verdict |
| --- | --- |
| any allergy warning, or any `high` finding | `avoid` |
| any `moderate` / `mention` finding | `caution` |
| no findings, but at least one medication had no reachable label | `unverified` |
| no findings, every medication checked | `no_known_interaction` |

`unverified` is the important one: a network failure can never be rendered as reassurance.

## 4. The confirmation state machine

```
        propose_medication_change
                 │  validates args, runs interaction check for `add`
                 ▼
        confirmation token  ──────────────►  shown to the caregiver
        (sha256 at rest, 10-min TTL,          ("Say confirm and I'll add it")
         bound to action + clientId)
                 │
                 ▼
        apply_medication_change(token, confirmedBy)
                 │  not found → error
                 │  already used → error
                 │  wrong action → error
                 │  different clientId → error
                 │  expired → error
                 ▼
        mutate record + audit entry, mark token used
```

Single use is enforced by writing `usedAt` inside the same serialised mutation that checks it. A token
cannot be replayed, cannot be redeemed by a different token holder, and cannot be applied to an action it
was not minted for.

**Why not elicitation.** MCP elicitation is the protocol-native way to ask a human mid-call. On the SDK's
2026-07-28 era, `elicitInput` throws, and the handler shape differs from 2025-11-25. Building the only
safety-critical interaction in the product on top of an era-specific API would have made the demo fragile
and the server harder to consume from any other host. Two-phase confirmation is plain `tools/call`, works on
every era, and keeps the human decision in the host, where it can be rendered however the host likes.

## 5. Failure modes

| Failure | Behaviour |
| --- | --- |
| RxNorm unreachable | Literal matching, limitation appended to the report, verdict may still be `unverified`. |
| openFDA unreachable / 404 | `notChecked` lists the medication; verdict falls back to `unverified`. Never "safe". |
| openFDA slow | 10s timeout per request; 5 requests in parallel; 6h cache; boot-time prewarm. |
| Bedrock unavailable mid-turn | `run.ts` falls back to the scripted planner and appends a note to the reply. |
| Webhook delivery fails | Alert stays in the outbox as `failed` with the error; the tool still returns the queued item. |
| Client disconnects during a stream | The MCP handler owns the transport; `/mcp` is mounted with `toNodeHandler`, which closes cleanly. |
| Process killed | Every mutation is written before the tool returns; the file is written to a temp path and renamed. |

## 6. Security model

- **Bearer tokens only**, no anonymous tools. Two tokens ship as demo credentials: a caregiver with
  read/write/notify and a read-only display token.
- **Scopes are checked per tool**, not per route, so a future OAuth front-end only has to produce `AuthInfo`.
- **No secrets in logs.** Tokens are printed masked (`dana…`) and stored hashed where they are persisted.
- **DNS-rebinding and Host checks** come from `createMcpExpressApp()`; set `ALLOWED_HOSTS` when serving
  through a tunnel, otherwise non-localhost `Host` headers are rejected by design.
- **No PHI leaves the machine** except the drug name sent to RxNorm/openFDA — those are public-data APIs
  queried with a drug name, not a patient identifier.

Known limitations, stated plainly: static tokens instead of OAuth, a single-process JSON store with no
encryption at rest, no rate limiting, and the audit trail is local only.

## 7. Deployment

Local demo: `npm start`. For a remote demo, run behind a tunnel with the host allow-list set:

```bash
ALLOWED_HOSTS=abc123.ngrok-free.app PUBLIC_BASE_URL=https://abc123.ngrok-free.app npm start
```

`PUBLIC_BASE_URL` matters because the simulator calls back into its own `/mcp` endpoint using it.

## 8. Extension points

| Want | Change |
| --- | --- |
| Real SMS | Implement `AlertRequest` in `domain/alerts.ts` behind the existing outbox (Twilio/SNS). |
| Real auth | Replace `http/auth.ts` with an OAuth resource server; everything downstream already reads `AuthInfo`. |
| Durable store | Swap `Store` for SQLite/Postgres; the domain layer only sees `read`/`mutate`. |
| Different models | `agent/bedrock.ts` is ~120 lines; the tool loop is the only thing to port. |
| More evidence sources | Add a `domain/` module returning `Finding[]`; the verdict logic is source-agnostic. |

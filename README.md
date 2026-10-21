# Dosewise

**A medication-safety MCP server for Alexa+, built for the family member who is now the caregiver.**

Dosewise is a self-hosted [Model Context Protocol](https://modelcontextprotocol.io) server that owns one
household's medication record and answers spoken questions using **real FDA label text with citations**.
It ships with a browser-based Alexa+ experience simulator so the whole thing can be run and judged without
an Echo device.

> "Can she take ibuprofen for her headache?"
>
> "I would hold off on ibuprofen. NSAIDs add bleeding risk on top of anticoagulation. The warfarin label
> names it under drug interactions. Call Dr. Iris Chen's office before you give her anything for this."

That answer is not a model's memory. It is a `tools/call` to `check_drug_interaction`, which normalises
"ibuprofen" through RxNorm, pulls the current warfarin label from openFDA, finds the sentence that mentions
ibuprofen, and returns the quote plus a DailyMed link.

---

## Why this exists

Roughly 40 million people in the US care for an aging parent. The hardest moments are not clinical — they
are the two-minute ones: *it's 9 p.m., she has a headache, is the Advil in the cupboard safe?* The
information needed to answer that is public (FDA labels) and sitting in a database (her medication list),
but the two are never in the same place at the moment of the question.

Dosewise puts them in the same place, and gives the answer a source the caregiver can check.

**Who it is for:** Dana, 47, in Sacramento. Her mother Ruth is 78, lives alone, and takes five medications
for atrial fibrillation, hypertension, type 2 diabetes, high cholesterol and reflux. Dana is not a nurse.
She is the person who gets the phone call.

**What Dosewise refuses to do:** diagnose, dose, or change a prescription on its own. It answers with
label evidence, names the clinician to call, and requires an explicit, caregiver-bound confirmation before
any record changes.

---

## What it does

| Tool | Scope | What it is for |
| --- | --- | --- |
| `get_household_profile` | read | Conditions, allergies, prescribers, care team. |
| `list_medications` | read | Active medications with instructions, schedule, prescriber. |
| `get_adherence_summary` | read | Taken / missed / due now / upcoming for a day. |
| `log_dose` | write | Record a dose the patient or caregiver reports. |
| `check_drug_interaction` | read | Normalise a candidate drug, then search every active medication's FDA label. |
| `propose_medication_change` | write | Draft an add / stop / dose change and mint a single-use confirmation code. |
| `apply_medication_change` | write | Apply exactly that change, once, for the caregiver who proposed it. |
| `alert_caregiver` | notify | Queue an SMS/email/voice message to another caregiver. |
| `list_prescribers` | read | Who to call when the answer is "no". |

Plus **resources** (`dosewise://household/profile`, `dosewise://medications/active`,
`dosewise://medications/{id}`, `dosewise://adherence/today`, `dosewise://outbox/recent`) and **prompts**
(`daily_briefing`, `vet_a_drug`) so a host can pre-load grounded context and offer suggested actions.

All nine tools carry a **JSON Schema `outputSchema`** and return `structuredContent`, so a host can render a
safety card, a dose timeline, or a confirmation sheet without scraping prose. Every tool declares MCP
annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) that say what it touches.

---

## How the safety answer is built

```
"Can she take Advil?"
        │
        ▼
 RxNorm / RxNav ──► "Advil" → rxcui 153010 → ingredient ibuprofen
        │
        ▼
 for each active medication: openFDA drug label (2 most recent)
        │
        ▼
 sentence-level extraction across boxed warning, contraindications,
 drug interactions, warnings  ──►  quote + section + effective date + DailyMed URL
        │
        ▼
 severity heuristics  +  curated high-risk pairs  +  recorded allergies
        │
        ▼
 verdict: avoid | caution | no_known_interaction | unverified
```

Three details make this honest rather than confident-sounding:

1. **`unverified` is a verdict.** If RxNorm or openFDA cannot be reached for a medication, Dosewise says so
   instead of implying safety. "I could not check" is never rendered as "it's fine."
2. **Boilerplate and no-effect sentences are filtered.** A label that says *"the pharmacokinetics of
   metformin and ibuprofen were not affected"* is not an interaction, and a line that says *"refer to the
   CONTRAINDICATIONS section"* is not a warning.
3. **The quote is always attached** with its section and the label's `effective_time`, plus a DailyMed link.
   A caregiver can read the sentence themselves.

---

## Quick start

Requires **Node.js 22+** (developed on Node 24). No database, no Docker, no AWS account.

```bash
npm install
npm start           # http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787> for the Alexa+ experience simulator. The MCP endpoint is
`http://127.0.0.1:8787/mcp` (Streamable HTTP, bearer token required).

For a deterministic recording, freeze the clock:

```bash
# macOS / Linux
DEMO_CLOCK=09:40 npm start

# Windows PowerShell
$env:DEMO_CLOCK='09:40'; npm start
```

### Configuration

Every value has a demo default. To change ports, tokens or the Bedrock model, copy `.env.example` to `.env`
and start with:

```bash
node --env-file=.env --import tsx src/index.ts
```

The one setting that matters when demoing remotely is `ALLOWED_HOSTS` — the MCP Express integration rejects
non-localhost `Host` headers to prevent DNS rebinding, so a tunnel hostname must be allow-listed.

### Connect a real MCP host

```jsonc
{
  "mcpServers": {
    "dosewise": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer dana-caregiver-demo-token" }
    }
  }
}
```

```bash
# or drive it directly
curl -s http://127.0.0.1:8787/mcp \
  -H 'Authorization: Bearer dana-caregiver-demo-token' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_drug_interaction","arguments":{"drug":"ibuprofen"}}}'
```

### Tokens

| Token | Identity | Scopes |
| --- | --- | --- |
| `dana-caregiver-demo-token` | `dana` | `dosewise.read`, `dosewise.write`, `dosewise.notify` |
| `ruth-viewer-demo-token` | `ruth-readonly` | `dosewise.read` |

Tokens are demo credentials, hashed for storage and checked in one place (`src/http/auth.ts`). Override them
with `CAREGIVER_TOKEN` / `VIEWER_TOKEN`; see `.env.example`. Scope enforcement lives **inside** each tool
handler, so it applies no matter which client connects — the simulator cannot do anything a real host
cannot. The read-only token is a live demo of that: ask it to add a medication and the tool refuses with
`dosewise.write` missing.

---

## The two-phase change flow

Changing a medication record is the one place where a wrong action is expensive, so it takes two calls and
a human decision:

```
propose_medication_change(kind: "add", medication: "acetaminophen", strength: "500 mg")
   → runs the interaction check first
   → returns { confirmationToken: "dw_…", expiresAt, summary, safety }
   → the simulator renders a "Confirm and add to her record" button

apply_medication_change(confirmationToken: "dw_…", confirmedBy: "Dana")
   → token is validated: hashed at rest, single use, 10-minute TTL,
     bound to the action and to the client that minted it
   → record is updated, audit entry written
   → replaying the same token fails
```

This exists because a model must not be able to confirm its own proposal. We deliberately did **not** use
MCP elicitation: on the 2026-07-28 protocol era `elicitInput` throws, and making the demo depend on a
protocol-era-specific UI would have been a portability trap (see `docs/FRICTION_LOG.md`).

---

## Project layout

```
src/
  index.ts              Express app, /mcp mount, static UI, graceful shutdown
  config.ts             Env config: tokens, ports, Bedrock, demo clock
  clock.ts              DEMO_CLOCK-aware now()/todayKey() helpers
  domain/
    interactions.ts     Verdict engine: normalise → labels → quotes → severity
    rxnorm.ts           RxNorm/RxNav client (name → ingredient + rxcui)
    openfda.ts          Label client, caching, section extraction
    medications.ts      Adherence computation, medication lookup
    confirmations.ts    Single-use, client-bound confirmation tokens
    alerts.ts           Outbox + optional caregiver webhook
  mcp/
    server.ts           Server factory + safety instructions
    tools.ts            9 tools with input/output schemas and annotations
    resources.ts        Read-only context resources
    prompts.ts          daily_briefing, vet_a_drug
    auth.ts             Scope enforcement, publishable state
  agent/
    bedrock.ts          Bedrock Converse tool loop (when AWS creds exist)
    scripted.ts         Deterministic demo planner (default offline)
    run.ts              Chooses the planner and labels the answer
  http/
    auth.ts             Bearer token → AuthInfo
    chat.ts             /api/chat, /api/state
    traffic.ts          JSON-RPC traffic log for the on-screen panel
web/                    Alexa+ experience simulator (vanilla JS, no build step)
tests/                  9 unit tests + a real-client MCP smoke test
```

---

## Agent modes

The simulator can be driven two ways, and it says which one answered in the header.

- **`bedrock`** — when AWS credentials are present (`AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, or
  `~/.aws/credentials`), `src/agent/bedrock.ts` runs a minimal **Amazon Bedrock Converse** tool loop:
  `tools/list` → tool specs → `ConverseCommand` → `toolResult` → repeat (max 6 turns). The server's own
  safety instructions are passed as the system prompt.
- **`scripted`** — otherwise, a deterministic planner maps caregiver phrasings onto the same MCP calls.
  It is not a language model, and the UI labels it *"Scripted demo agent · no cloud credentials"*. The demo
  still exercises the real MCP server over real Streamable HTTP; only the sentence planning is scripted.

Force either with `DOSEWISE_AGENT=bedrock|scripted`.

---

## Tests

```bash
npm run typecheck   # tsc --noEmit
npm test            # 9 unit tests (domain logic, confirmations, store)
npm run smoke       # boots the server, drives it with a real MCP client
```

`npm run smoke` starts the actual HTTP server on a throwaway port and database, connects a real
`Client` + `StreamableHTTPClientTransport`, and asserts: nine tools listed, five seeded medications,
3-of-6 adherence, a real `check_drug_interaction` verdict, propose → apply → replay-rejected, resource read,
prompt get, read-only write denial, and a 401 without a token.

---

## Data sources and their limits

- **RxNorm / RxNav (NLM)** — brand → ingredient normalisation. Rate-limited public service, no key.
- **openFDA drug labels** — the actual label prose and `effective_time`. Not a live safety database: a label
  can lag practice, and no label mentioning a drug is not proof of no interaction.
- **DailyMed** — deep link so a human can read the full label.

RxNav's `/REST/interaction/list.json` endpoint is retired (404). This project does not pretend to have a
drug-interaction database; it searches label text and says what it found.

**Dosewise is not a medical device and gives no medical advice.** It is a demonstration of how a
label-grounded MCP server can sit behind a voice experience.

---

## Hackathon

Built for **Build, Ship, Shape: Amazon Developer Hackathon** — Alexa+ track.

Repo: <https://github.com/MehdiBukhari/dosewise>

- Track requirement met in code: self-hosted MCP server, Streamable HTTP transport, MCP spec 2026-07-28
  (the SDK's current era; satisfies "2025-11-25 or later").
- Mini challenge: **Open Source** — MIT-licensed new project.
- Product feedback: [`docs/PRODUCT_FEEDBACK.md`](docs/PRODUCT_FEEDBACK.md)
- Friction log: [`docs/FRICTION_LOG.md`](docs/FRICTION_LOG.md)
- Architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Submission text: [`docs/DEVPOST_SUBMISSION.md`](docs/DEVPOST_SUBMISSION.md)
- Video script: [`docs/VIDEO_SCRIPT.md`](docs/VIDEO_SCRIPT.md)

## License

MIT — see [LICENSE](LICENSE).

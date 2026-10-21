# Devpost submission — paste-ready

Everything below is written to be copied into the Devpost form. Replace the two `TODO` links after the repo
and video are published.

---

## Project name

**Dosewise**

## Tagline (≤ 120 chars)

A self-hosted MCP server that answers a caregiver's medication questions with quoted FDA label text.

## Track

**Alexa+**

## Mini challenge

**Open Source** — new MIT-licensed public project, built entirely during the hackathon window.
Repo: <https://github.com/MehdiBukhari/dosewise>

---

## Inspiration

My mother-in-law keeps five medications on her kitchen counter. She knows what each one is for; what she
doesn't know is which over-the-counter painkiller is safe with her blood thinner. When she asks, the answer
is usually a phone call to a doctor's office that closed at five.

Forty million Americans are that phone call now. They are not clinicians. They are daughters and sons
standing in a kitchen at nine at night, holding a bottle, deciding. The information they need is public — it
is in the FDA label — and the context is already written down somewhere. The two are just never in the same
place at the moment of the question.

Alexa+ is the right surface for this because the question is spoken and the moment is short. The MCP server
is the right architecture because medication data should live with the family, not with an assistant vendor.

## What it does

Dosewise is a self-hosted **MCP server** (Streamable HTTP, MCP spec 2026-07-28) that owns one household's
medication record and answers spoken questions about it.

Ask *"Did Mom take her morning pills?"* and it reports what was logged, what is due, and what is next.

Ask *"Can she take ibuprofen for her headache?"* and it:

1. normalises **"ibuprofen"** through **RxNorm** to the ingredient (so "Advil" and "Motrin" work too),
2. pulls the two most recent **openFDA** labels for each of her five medications,
3. finds the sentence in the **warfarin** label that names ibuprofen — inside a flattened drug table — and
   quotes it with the section name, the label's effective date, and a **DailyMed** link,
4. returns a verdict of `avoid`, `caution`, `no_known_interaction`, or `unverified`, and names the prescriber
   to call.

If the label is unreachable, the verdict is **`unverified`** — never "safe". If a label sentence only points
at another section, or explicitly says the two drugs *do not* interact, it is filtered out rather than shown
as a warning.

Changing the record takes two steps because a model must not approve its own proposal:
`propose_medication_change` mints a **single-use, caregiver-bound, 10-minute token**, and
`apply_medication_change` requires it. Replay fails. Another token holder cannot redeem it.

It ships with a browser-based **Alexa+ experience simulator** — microphone, spoken answers, a safety card
with the quoted label, a live dose timeline, and a panel showing the actual JSON-RPC traffic behind every
answer. Two bearer tokens ship with the demo: a caregiver with read/write/notify, and a read-only display
token whose write attempts are refused by the tool handlers themselves.

## How we built it

- **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`, `/client`, `/node`, `/express`) — the server is a
  `createMcpHandler(factory)` handler mounted on Express via `toNodeHandler`, with a **fresh `McpServer` per
  HTTP request**, bearer auth resolved into `AuthInfo`, and scopes checked inside every tool handler.
- **9 tools, 5 resources, 2 prompts**, each tool with a zod input schema, a zod **`outputSchema`**, and MCP
  annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`). Tools return `structuredContent` so a host
  can render a safety card without parsing prose.
- **Evidence pipeline** in TypeScript: RxNorm normalisation → openFDA label fetch (2 labels, 6-hour cache,
  boot-time prewarm) → section-priority sentence extraction with table-aware windowing → severity heuristics
  → curated high-risk pairs → allergy families → verdict.
- **Persistence**: one JSON file with serialised mutations and write-then-rename atomicity. No native build
  step, and the demo state is inspectable.
- **Agent**: an Amazon Bedrock **Converse** tool loop when AWS credentials exist; otherwise a deterministic
  planner that calls the same MCP tools over the same HTTP transport. The UI labels which one answered.
- **Simulator**: vanilla HTML/CSS/JS, no build step, Web Speech API for voice.
- **Tests**: 9 unit tests (quote extraction, severity, adherence, confirmation TTL/scope/replay, store
  concurrency) plus `npm run smoke`, which boots the real server and drives it with a real MCP `Client` over
  `StreamableHTTPClientTransport`.

## Challenges we ran into

- **The RxNav interaction endpoint is retired (404).** There is no free structured interaction API left, so
  the answer had to come from label text. That turned out better — the user gets the sentence a pharmacist
  would read — but it meant building and testing the extraction pipeline.
- **Label text is a table dump.** One "sentence" in a warfarin label is 400 characters of drug names. Naive
  matching produced a **false high-severity warning** for omeprazole + clarithromycin (a boilerplate
  cross-reference) and a **false moderate warning** for metformin + ibuprofen (a sentence saying they do *not*
  interact). Both are now filtered, with tests.
- **openFDA has no field selection.** Five medications × five labels is ~3 MB and an 8.7-second answer. Fixed
  with `limit=2`, caching, and prewarming.
- **Elicitation throws on the current protocol era**, so the human-in-the-loop step had to be protocol-neutral
  two-phase confirmation instead.
- **Time-dependent demos are not reproducible**, so the server has a `DEMO_CLOCK` seam and the seeded dose
  log is relative to it.

The full list, with severity and "what would have removed it", is in `docs/FRICTION_LOG.md`.

## Accomplishments that we're proud of

- The safety answer is **verifiable**: quote, section, effective date, DailyMed link, all on screen.
- **`unverified` is a first-class verdict.** A network failure cannot be rendered as reassurance.
- The **scope demo is real**: the read-only token is refused *inside the tool*, not by hiding a button.
- **Replay-proof confirmations** bound to the caregiver who proposed the change, with tests for expiry,
  cross-client redemption, action substitution, and replay.
- **Every answer is auditable**: the traffic panel shows the `tools/call` and its latency next to the
  sentence that was spoken.
- It runs with `npm install && npm start`. No cloud account, no database, no API keys.

## What we learned

- Grounding is a **data engineering** problem before it is a prompting problem. Most of the work was
  extraction, filtering, and deciding what "I don't know" looks like.
- For a voice product, **latency is a correctness issue**. A 9-second answer is a broken answer.
- "Not found" and "found nothing wrong" must be different states. Collapsing them is how a safety tool becomes
  dangerous.
- MCP is a genuinely good fit for Alexa+ because the tool contract is the product: the same server works from
  the simulator, from a desktop MCP host, and from a Bedrock agent loop with no changes.

## What's next for Dosewise

- Real caregiver notifications (SMS/voice) behind the existing outbox, with delivery receipts.
- An OAuth resource server in front of the same `AuthInfo` contract, so a household can be multi-user.
- Pharmacist-reviewed expansion of the curated pairs, and a second evidence source for interactions that
  labels undersell.
- Refill and INR scheduling, which is the other half of the caregiver's day.
- A small on-device speech path so the medication list never leaves the house.

## Built with

`TypeScript` · `Node.js` · `Model Context Protocol` · `MCP TypeScript SDK v2` · `Streamable HTTP` ·
`Express 5` · `zod` · `RxNorm/RxNav (NLM)` · `openFDA` · `DailyMed` · `Amazon Bedrock Converse` ·
`Web Speech API` · `node:test`

## Try it out

- Repo: <https://github.com/MehdiBukhari/dosewise>
- Video: <https://youtu.be/9unoEjs57KY> — 2:45, English, public.
- Run locally: `npm install && npm start` → <http://127.0.0.1:8787>
- MCP endpoint: `http://127.0.0.1:8787/mcp` with `Authorization: Bearer dana-caregiver-demo-token`

## Product feedback

`docs/PRODUCT_FEEDBACK.md` — feedback on the MCP TypeScript SDK v2, the MCP spec, RxNorm/RxNav, openFDA,
DailyMed, Amazon Bedrock Converse (including an explicit note that it was not exercised without credentials),
and the Web Speech API.

---

# Submission checklist

## Repo

- [ ] Public GitHub repository
- [ ] **MIT `LICENSE`** committed
- [ ] README opens with what it is, a screenshot or the demo quote, and `npm start`
- [ ] `docs/` included: architecture, friction log, product feedback, video script, this text
- [ ] No secrets: `.env` git-ignored, `data/db.json` git-ignored, demo tokens labelled as demo tokens
- [ ] `npm run typecheck && npm test && npm run smoke` green on a clean clone
- [ ] `.env.example` present (docs, not a secret)

## Video

- [ ] **Under 3:00**, public, English audio
- [ ] Shows the MCP traffic panel (proof the server is doing the work)
- [ ] Shows the quoted FDA label + DailyMed link
- [ ] Shows propose → confirm → applied
- [ ] Shows the read-only token being refused
- [ ] Does **not** hide the "scripted demo agent" badge

## Devpost form

- [ ] Track: **Alexa+**
- [ ] Mini challenge: **Open Source**
- [ ] Repo URL + video URL
- [ ] "Built with" tags
- [ ] Product feedback included (link or pasted)
- [ ] Friction log included → up to +10% judging bonus
- [ ] If the repo is private: shared with `testing@devpost.com`, `knmeiss`, `giolaq`, `anishamalde`,
      `mosesroth`, `emersonsklar`

## Safety / honesty pass before submitting

- [ ] No real patient data anywhere (Ruth, Dana, Marcus and the prescribers are fictional)
- [ ] The README, UI, and video all say this is not medical advice
- [ ] Nothing claims a capability that was not executed (Bedrock path, SMS delivery, OAuth)

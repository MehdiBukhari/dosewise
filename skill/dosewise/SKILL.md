---
name: dosewise
description: Answer questions about one household's medications using the Dosewise MCP server — what was taken today, whether a drug is safe with the current list, and confirmed changes to the record. Use when the user asks about a family member's medication schedule, adherence, or whether a specific drug (including over-the-counter brands like Advil or Tylenol) is safe to take alongside their prescriptions.
---

# Dosewise

Dosewise is a self-hosted MCP server that owns one household's medication record and grounds every safety
answer in FDA label text with a citation. This skill tells an agent how to use it responsibly.

## When to use it

Use Dosewise when the user asks:

- "Did Mom take her morning pills?" / "Is she due for anything?"
- "Can she take ibuprofen?" / "Is Advil okay with her blood thinner?"
- "What is she on?" / "Who prescribes the warfarin?"
- "Add acetaminophen 500 mg as needed" — only after an explicit confirmation.
- "Tell Dana the evening dose is late."

Do **not** use it for diagnosis, dosing advice, interpreting labs, or anything outside the household record.

## Connect

Streamable HTTP, bearer token:

```jsonc
{
  "mcpServers": {
    "dosewise": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${DOSEWISE_TOKEN}" }
    }
  }
}
```

Scopes: `dosewise.read`, `dosewise.write`, `dosewise.notify`. A read-only token can answer every question but
cannot change the record — if a tool returns a `dosewise.write` refusal, say so plainly instead of retrying.

Prefer the **resources** for context before the first answer:

- `dosewise://household/profile` — conditions, allergies, care team
- `dosewise://medications/active` — the current list
- `dosewise://adherence/today` — today's doses

## Rules that always apply

1. **Never answer a drug-safety question from memory.** Call `check_drug_interaction`. If you cannot, say the
   check could not run.
2. **Quote the evidence.** The tool returns `evidence.quote`, `evidence.section`, `evidence.effectiveTime` and
   a DailyMed `evidence.url`. Read the quote or paraphrase it closely, and name the source once.
3. **Treat `unverified` as unknown, never as safe.** "I could not verify that" is a complete answer.
4. **No dosing advice, no stopping or changing a prescription, no interpreting INR or lab values.** Name the
   prescriber (`list_prescribers`) or a pharmacist instead.
5. **Two steps for any change.** `propose_medication_change` → show the summary → get an explicit yes →
   `apply_medication_change` with the returned token and the name the user gave. Never apply a change the user
   did not confirm, and never invent a confirmation.
6. **Keep spoken answers under ~40 words** unless the user asks for detail. Say "6 p.m.", not an ISO string.
7. The person asking may be frightened. Be calm, specific, and never alarmist.

## Tools

| Tool | Scope | Notes |
| --- | --- | --- |
| `get_household_profile` | read | Conditions, allergies, prescribers. Call before judging appropriateness. |
| `list_medications` | read | Active by default; `status: "all"` includes stopped. |
| `get_adherence_summary` | read | Taken / missed / due / upcoming, plus the next slot. |
| `log_dose` | write | Only after the user reports the dose. Never guess a time. |
| `check_drug_interaction` | read | Brand names welcome; normalised via RxNorm. Returns a verdict + findings. |
| `propose_medication_change` | write | `kind: add \| stop \| change_dose`. Returns a token and, for `add`, a safety preview. |
| `apply_medication_change` | write | Requires the token and `confirmedBy`. Single use, 10-minute TTL, bound to the caller. |
| `alert_caregiver` | notify | Short message to a named caregiver. Use for something a person must act on. |
| `list_prescribers` | read | Who to call when the answer is "no". |

Verdicts: `avoid` (do not take without the care team), `caution` (check first), `no_known_interaction`
(nothing in the labels for the current list), `unverified` (at least one label could not be checked).

## Worked example

> **User:** She has a bad headache. Can she take ibuprofen?

1. `check_drug_interaction { drug: "ibuprofen", context: "headache" }`
2. Result: `verdict: "avoid"`, finding on Warfarin, severity `high`,
   quote from the warfarin label's drug-interactions section, DailyMed URL.
3. Optionally `list_prescribers` (or the `prescriber` on the flagged medication) for the escalation target.
4. Reply:

> "I would hold off on ibuprofen. NSAIDs add bleeding risk on top of her warfarin. Call Dr. Chen's office
> before giving her anything for pain."

Then offer to check a specific alternative the clinician suggests — do not recommend one yourself.

## Failure behaviour to expect

- openFDA or RxNorm unreachable → verdict `unverified`, medication name listed in `notChecked`.
- A drug with no label → `notChecked` grows; do not read that as "safe".
- Confirmation token expired or already used → the tool returns an error; propose the change again rather than
  retrying the old token.
- No caregiver by that name → `alert_caregiver` returns an error; ask who to notify.

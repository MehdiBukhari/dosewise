# Demo video script — 2:45, one take if possible

> **Status:** the submitted cut is published — <https://youtu.be/9unoEjs57KY>, 2:46, 1440×810. The source file is
> [`demo/dosewise-demo.mp4`](../demo/dosewise-demo.mp4), produced with `npm run demo` (timeline → Playwright
> recording → audio assembly), so the narration and Alexa voice are synthesised rather than human. This document
> remains the human version of the same beats if you want to re-record with your own voice: same order, same
> on-screen moments, same claims.

**Goal of the video:** a judge who has never heard of MCP should understand, in under three minutes, that
this is a real protocol server answering a real safety question with real FDA text — and that it refuses to
act without the caregiver.

**Format:** screen recording of `http://127.0.0.1:8787` at 1440×900 (browser zoom 100%), presenter voice-over,
system audio **on** so the Alexa voice is audible. Captions burned in.

---

## Before you hit record (5 minutes)

```powershell
# 1. Fresh household, frozen clock, warm label cache
Remove-Item data\db.json -ErrorAction SilentlyContinue
$env:DEMO_CLOCK='09:40'
npm start
```

```bash
# macOS / Linux equivalent
rm -f data/db.json && DEMO_CLOCK=09:40 npm start
```

2. Wait for `Label cache warmed for 5 medications.` in the terminal — this keeps every answer under ~2s.
3. Open <http://127.0.0.1:8787>, confirm the header says **Scripted demo agent · no cloud credentials**
   (that is the honest label; do not crop it out).
4. Check the speaker icon is on (🔊) — the spoken answer is part of the demo.
5. Close every other tab. Hide the bookmarks bar. Do not show `data/db.json`.
6. Do one full dry run. Then **reset again** and record, because the add-medication step mutates state.

---

## Shot list

### 0:00 – 0:18 · The moment

**Screen:** the simulator, idle. Ruth's five medications in the right-hand panel.

**Voice-over:**
> "It's nine at night. Your mother has a headache, and you're standing in her kitchen holding a bottle of
> Advil, wondering whether it's safe with her blood thinner. Forty million Americans are the caregiver now.
> The answer exists — it's in the FDA label and in her medication list. It's just never in the same place
> at the same time."

### 0:18 – 0:32 · What Dosewise is

**Screen:** slow pan across the header, the medication record, the "Today" panel.

**Voice-over:**
> "Dosewise is a self-hosted MCP server for Alexa+. It owns one household's medication record, and it
> answers spoken questions with quoted FDA label text. This is a browser-based Alexa+ experience — same
> protocol, no Echo required."

### 0:32 – 0:58 · Adherence

**Action:** click **"Did Mom take her morning pills?"**

**Alexa (TTS):** "Three of six doses logged today. Omeprazole, metoprolol succinate, metformin were logged
as taken. Next up is Warfarin at 6:00 PM."

**Screen:** point at the tool chips under the answer and the `get_adherence_summary 12ms` line appearing in
the MCP traffic panel.

**Voice-over:**
> "That answer is a `tools/call` to `get_adherence_summary` over Streamable HTTP. Every answer in this UI
> has a matching JSON-RPC call in the panel on the right — nothing is generated from vibes."

### 0:58 – 1:42 · The safety answer (the heart of the demo)

**Action:** click **"Can she take ibuprofen?"**

**Screen:** answer appears, then the red safety card. Hold on the card for a beat so the quote is readable.

**Alexa (TTS):** "I would hold off on ibuprofen. NSAIDs add bleeding risk on top of anticoagulation. The
Warfarin label names it under drug interactions. Call Dr. Iris Chen's office before you give her anything
for this."

**Voice-over (over the card):**
> "Three calls happened there. RxNorm normalised 'ibuprofen' to its ingredient. openFDA returned the current
> warfarin label. And the server found the sentence that names ibuprofen — inside a flattened drug table —
> and quoted it, with the label's effective date and a DailyMed link."

**Action:** hover the quote, then hover **FDA label on DailyMed** (do not click — it leaves the app).

> "It also filtered two things a naive search would have shown: a boilerplate line that only points at
> another section, and a sentence saying metformin and ibuprofen *do not* affect each other. 'Not found' is
> never reported as 'safe' — if a label is unreachable, the verdict is 'unverified'."

### 1:42 – 2:06 · Changing the record needs a human

**Action:** click **"Add acetaminophen 500 mg as needed"**.

**Alexa:** "Add Acetaminophen 500 mg as needed. Nothing flagged against her current medications. Say
'confirm' and I will add it to her record."

**Screen:** the **Confirm and add to her record** button appears.

**Voice-over:**
> "The model cannot confirm its own proposal. `propose_medication_change` mints a single-use token, hashed
> at rest, bound to this caregiver, valid for ten minutes."

**Action:** click **Confirm**.

**Alexa:** "Done — it is on her record now."

**Screen:** Acetaminophen appears in the medication record; `apply_medication_change` and then
`propose_medication_change` show in the traffic panel.

> "Replaying that token fails. A different caregiver cannot redeem it."

### 2:06 – 2:24 · Scope, not trust

**Action:** change **Signed in as** to **Ruth — read-only display**, then type "Add aspirin 81 mg daily" and
press Enter.

**Alexa:** "This token is missing the dosewise.write scope. Ask the account owner for access."

**Voice-over:**
> "Scopes are enforced inside each tool handler, not at the route. The same server, the same tools — a
> different token simply cannot write."

**Action:** switch back to **Dana**.

### 2:24 – 2:45 · Close

**Screen:** cut to a simple card (or the terminal + `tests/` output):

```
✓ tools/list — 9 tools
✓ check_drug_interaction — avoid (1 finding, evidence: fda_label)
✓ propose + apply medication change
✓ confirmation tokens are single use
✓ read-only token cannot write
Smoke test passed.
```

**Voice-over:**
> "Nine tools, five resources, two prompts. TypeScript, MIT licensed, one JSON file, no cloud account
> needed. The AWS Bedrock path is wired for the model loop; the agent mode is labelled on screen. Dosewise
> doesn't diagnose anything — it makes the label readable, at the moment someone is scared. That's the
> whole idea."

**End card:** repo URL · `npm start` · "Built for the Alexa+ track — Build, Ship, Shape 2026".

---

## Editing notes

- **Do not** speed up the safety card. The quote is the proof.
- **Do not** hide the "Scripted demo agent" badge. Judges reward honesty; the server is what is being judged.
- Keep the terminal out of frame except in the close, and only for the smoke-test output.
- Captions: at minimum for the two Alexa answers and the four voice-over claims.
- If a lookup is slow on the take, keep it — a 2-second label fetch is more credible than a suspiciously
  instant answer.
- Total runtime must stay **under 3:00**. The script as written times to ~2:45 at a calm pace.

## Assets to have ready

- [ ] Fresh `data/db.json` (delete before recording)
- [ ] `DEMO_CLOCK=09:40`
- [ ] Label cache warm
- [ ] Mic check, no keyboard clicks, notifications off
- [ ] Uploaded **public** to YouTube/Vimeo with English audio, title
      "Dosewise — medication safety over MCP for Alexa+"
- [ ] Link pasted into Devpost *and* into the repo README

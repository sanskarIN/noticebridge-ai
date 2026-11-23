# NoticeBridge AI — GenHacks 2026 submission preparation

**Work-in-progress planning document; NOT a submitted Devpost entry.**
Engineering completion target: 20 December 2026, final review and materials: 21–25 December 2026.

## Verified organizer sources (checked 23 November 2026)

- Official overview: https://genhacks-open.devpost.com/
- Rules: https://genhacks-open.devpost.com/rules
- Schedule: https://genhacks-open.devpost.com/details/dates

**Time conflict:** The official rules and schedule currently list **26 December 2026 at 5:00 PM EST** (27 December, 03:30 IST). The event overview's body text also says submissions close **26 December at 12:00 AM Eastern** (26 December, 10:30 IST). These instructions contradict each other. The safest project policy is to prepare and, only with owner authorization, submit by **25 December**. Recheck the Devpost submission form and ask the organizer to clarify the discrepancy if necessary. Do not promise a later cutoff.

Rules describe a hackathon project started after the November 1 opening; participants must be students age 13 or older. Individual eligibility, registration, and team details have not been independently established here. Do not enter invented identity or team information.

## Required submission components

- [ ] Devpost project title, overview, problem, engineering approach, technologies, impact and limitations.
- [ ] Public source repository URL and its license. Verify the published code actually matches the demo; do not confuse a draft PR with a released build.
- [ ] Demonstration video **up to 3 minutes** on YouTube or Vimeo, embedding enabled, demonstrating the working application.
- [ ] One appropriate hackathon track. NoticeBridge may fit the **AI, Agentic Systems, Cybersecurity, and Dev Tools** track, but the final choice belongs to the submitter.
- [ ] Accurate project team members, if any, added in Devpost.
- [ ] Explicit attribution of external dependencies and use of AI tools, as required by the rules.
- [ ] Final approval before submission; no automatic posting.

## Demonstration plan using fictional PDFs

Use only deliberately fictional notices and ensure both PDFs have a prominent watermark or other visible test-document notice:

1. **0:00–0:20 — Problem:** People see multiple notices and need to understand what changed without trusting an unlinked AI summary.
2. **0:20–0:50 — Source upload:** Upload generated fictional original/revised notices. State that upload order does not prove official precedence.
3. **0:50–1:25 — Evidence:** Show the changed deadline and fee, their original and revised excerpts, and the PDF.js source highlight.
4. **1:25–1:45 — Bilingual access:** Switch to Hindi and show the review checklist.
5. **1:45–2:10 — Reliability:** Explain ambiguous dates, optional OCR flags, missing-page coverage and source hashes.
6. **2:10–2:35 — Optional AI:** Show or describe how unverified local-model matches can be added without overwriting deterministic findings. Do not imply semantic accuracy has been established.
7. **2:35–3:00 — Project and limits:** Show open-source architecture, tests, privacy boundaries, JSON export and the manual verification requirement.

Generate fictional inputs using the existing backend/benchmarks/generate_demo.py. Capture the actual running app, not simulated screenshots. Use accurate captions and readable text; keep the resulting demo at or below 3:00.

## Engineering claims checklist

- [ ] Quote the exact tested commit and CI run, including any skipped tests.
- [ ] Mark verified capabilities separately from experimental local-AI functionality.
- [ ] Do not report synthetic 14-case regression results as independent real-world accuracy.
- [ ] Do not claim that source SHA-256 establishes issuer authenticity.
- [ ] Do not claim a fully isolated production upload server or cloud deployment.
- [ ] Explain that OCR may mistranscribe and AI matches are suggestions, not verified facts.
- [ ] Test the demo on Windows and Linux and validate permissions for all included images/audio.
- [ ] Obtain final user approval before merge, release, deployment or Devpost submission.

## Judging presentation emphasis

The organizer describes impact, technical execution, creativity and presentation as equally weighted (25% each). Demonstrate a real, inspectable workflow with credible constraints; do not spend the demo on claims that cannot be reproduced. See the official event overview for the current judging wording and confirm it again during submission week.

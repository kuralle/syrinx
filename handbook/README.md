# The Syrinx Handbook

Operating docs for running Syrinx **as a product**, not just a codebase. Engineering
design records stay in `docs/`; this directory holds the strategy, go-to-market,
release, and operations material.

| Doc | What it is | Use it when |
|---|---|---|
| [`teardown-2026-07.md`](./teardown-2026-07.md) | Full product teardown (2026-07-07): what Syrinx is, where it's going, and every gap found — engineering, DX, distribution, positioning — with evidence | Orienting; prioritizing; arguing about what matters next |
| [`positioning.md`](./positioning.md) | Positioning & messaging handbook: the one-liner, the Kuralle question, competitive frames vs LiveKit/Pipecat/Sierra, proposed copy | Writing any public-facing sentence about Syrinx |
| [`launch-playbook.md`](./launch-playbook.md) | Distribution playbook: packaging gate → metadata → docs surface → launch sequence → content engine | Taking Syrinx from 0 stars to a real OSS project |
| [`release-sop.md`](./release-sop.md) | Release SOP: pre-publish checklist, lockstep publish procedure, post-publish verification, versioning policy | Every `@kuralle-syrinx/*` release |
| [`failure-modes-runbook.md`](./failure-modes-runbook.md) | Operations runbook: symptom → cause → check → fix for the known failure modes, plus the open-risk register and a production-readiness checklist | Deploying, debugging a live call, or auditing readiness |

Ground rules for this directory:

- Every claim carries evidence (file:line, measured number, or URL). No vibes.
- Docs state their date. When reality moves, update the doc or mark it superseded —
  a stale playbook is worse than none.
- The teardown is a snapshot; the playbooks and SOPs are living documents.

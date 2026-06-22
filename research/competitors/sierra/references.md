# Sierra research — verified citations

Every entry below was confirmed **empirically** (not from training memory) on 2026-06-22 via the arXiv API, DataCite DOI resolution (`https://doi.org/10.48550/arXiv.*` → HTTP 200, matching titles), and OpenAlex indexing. The future-dated `2603.*` IDs (March 2026) were verified to genuinely exist on arXiv. Author lists are taken verbatim from arXiv metadata.

| # | Paper | arXiv | Published | DOI (DataCite) | Status |
|---|---|---|---|---|---|
| 1 | **τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains** | [2406.12045](https://arxiv.org/abs/2406.12045) | 2024-06-17 | 10.48550/arXiv.2406.12045 | ✅ verified |
| 2 | **τ²-Bench: Evaluating Conversational Agents in a Dual-Control Environment** | [2506.07982](https://arxiv.org/abs/2506.07982) | 2025-06-09 | 10.48550/arXiv.2506.07982 | ✅ verified |
| 3 | **τ-Knowledge: Evaluating Conversational Agents over Unstructured Knowledge** | [2603.04370](https://arxiv.org/abs/2603.04370) | 2026-03-04 | 10.48550/arXiv.2603.04370 | ✅ verified |
| 4 | **τ-Voice: Benchmarking Full-Duplex Voice Agents on Real-World Domains** | [2603.13686](https://arxiv.org/abs/2603.13686) | 2026-03-14 | 10.48550/arXiv.2603.13686 | ✅ verified |
| 5 | **Reflexion: Language Agents with Verbal Reinforcement Learning** | [2303.11366](https://arxiv.org/abs/2303.11366) | 2023-03-20 | 10.48550/arXiv.2303.11366 | ✅ verified |
| 6 | **μ-Bench (multilingual transcription benchmark)** | — *not on arXiv* | 2026-04 (per Sierra) | — | ⚠️ see note |

### Verified author lists (from arXiv)
1. **τ-bench** — Shunyu Yao, **Noah Shinn**, Pedram Razavi, **Karthik Narasimhan**.
2. **τ²-Bench** — **Victor Barres**, Honghua Dong, **Soham Ray**, Xujie Si, **Karthik Narasimhan**.
3. **τ-Knowledge** — Quan Shi, Alexandra Zytek, Pedram Razavi, **Karthik Narasimhan**, **Victor Barres**.
4. **τ-Voice** — **Soham Ray**, **Keshav Dhandhania**, **Victor Barres**, **Karthik Narasimhan**.
5. **Reflexion** — **Noah Shinn**, Federico Cassano, Edward Berman, Ashwin Gopinath, **Karthik Narasimhan**, Shunyu Yao.

> The recurring **Karthik Narasimhan (Princeton)** + **Noah Shinn / Shunyu Yao / Victor Barres** authorship is the through-line of Sierra's research program (Narasimhan is Sierra's Head of Research; Shinn/Yao authored both τ-bench and Reflexion). This confirms the blog's framing of a single, coherent "τ cinematic universe."

### Note on μ-Bench (citation discipline)
The Sierra blog post "μ-Bench: an open multilingual transcription benchmark" (Apr 20, 2026) is **not an arXiv preprint**. The only arXiv hit for "MU-Bench" is an unrelated paper — *MU-Bench: A Multitask Multimodal Benchmark for Machine Unlearning* (arXiv 2406.14796) — which should **not** be conflated with Sierra's work. Sierra's μ-Bench was confirmed to exist as:
- a research-page tech report — `https://research.sierra.ai/mubench` (HTTP 200), and
- a HuggingFace dataset — `https://huggingface.co/datasets/sierra-research/mu-bench` (HTTP 200).

The author list cited in the blog (Katie Echavia, Venu Satuluri, Ola Zytek, Victor Barres, Mindy Long, Nishita Jain, Nittai Malchin, Lydia Zarcone, Kelly Cooke) is from the Sierra page and **could not be cross-verified against a primary index** because the work is not in arXiv/CrossRef/OpenAlex — recorded as-is, flagged as unverified.

### Open-source / dataset artifacts (existence-checked)
- `github.com/sierra-research/tau-bench` — τ-bench code.
- `github.com/sierra-research/tau2-bench` — τ²/τ-Voice code + adapters (OpenAI Realtime, Gemini Live, xAI Grok Voice, LiveKit).
- `github.com/sierra-research/mu-bench` + HF `sierra-research/mu-bench` — μ-Bench (HTTP 200).
- `github.com/amazon-agi/tau2-bench-verified` — external (Amazon) audit fork referenced by τ³-Bench.
- Leaderboards: `tau-bench.com` / `taubench.com`.

### Scope of verification
Engines queried: **arXiv API**, **DataCite**, **OpenAlex**, **Semantic Scholar Graph API** (returned empty/rate-limited for these IDs), plus direct HTTP existence checks (HuggingFace, Sierra research). CrossRef was not used as the primary index because arXiv preprints register DOIs with **DataCite**, not CrossRef. No authenticated index (Scopus, IEEE Xplore, ScienceDirect) was consulted. OpenAlex indexes #1, #2, #4 as **arXiv preprints** (venue "arXiv / Cornell University"); a peer-reviewed conference venue was **not** asserted for any because none was machine-verifiable.

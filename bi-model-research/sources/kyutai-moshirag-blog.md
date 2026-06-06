# MoshiRAG: Asynchronous Knowledge Retrieval for Full-Duplex Speech Language Models

> Source: https://kyutai.org/blog/2026-04-30-moshi-rag (scraped 2026-06-06)
> Paper: http://arxiv.org/abs/2604.12928 · Code: https://github.com/kyutai-labs/moshi-rag
> Authors: Chung-Ming Chien, Manu Orsini, Eugene Kharitonov, Neil Zeghidour, Karen Livescu, Alexandre Défossez

We equip the full-duplex speech-to-speech model **Moshi** with **asynchronous knowledge retrieval**.

Key features:
- **Autonomous retrieval:** the model independently determines when it needs external data and fetches it in the background.
- **Seamless integration:** retrieved documents are incorporated without interrupting conversation flow.
- **Full-duplex:** listens and speaks simultaneously, reacting in real time rather than rigid turns.
- **Plug-and-play:** switch retrieval sources (specialized LLM ↔ search engine) without retraining the front-end.

## How it works — the core insight

> When the user asks a question requiring retrieval, the retrieval result **doesn't need to be ready before MoshiRAG starts speaking — it only needs to arrive before the most important part of the answer is generated.**

In natural speech the "meat" of an answer rarely appears in the first few words. People start with a lead-in ("In the Netflix series…") or grammatical preamble ("Emily is from…") before the key info ("…Chicago…"). A common natural gap of **at least 2 seconds** exists between end-of-user-query and the mention of key information — enough to complete retrieval. This reduces *perceived* retrieval latency to zero.

## Framework — front-end / back-end split

- **Front-end Moshi model** — interacts with the user in real time (full-duplex). Modified from original Moshi with two additions:
  - a special `<ret>` token that triggers knowledge retrieval, and
  - a reference text encoder that injects retrieved info back into the conversation.
- **Retrieval back end (runs in parallel)** — text-in/text-out. Takes conversation history (Moshi transcript + user transcript from a streaming ASR model) and queries a knowledge system for a concise answer. **Audio is intentionally excluded** from retrieval (most tools are text-based) → plug-and-play (LLM or search engine) without retraining the front-end.

When the front-end detects a knowledge-needing question it emits `<ret>`, which triggers the back end. While the back end works, the front end keeps the interaction alive with a natural opening. Once retrieval is ready, it's fed back so MoshiRAG gives a grounded answer.

## Training data (synthetic pipeline)

LLMs generate multi-turn conversation scripts on factually-challenging topics. Knowledge-intensive turns are structured as **lead → reference-grounded body → optional tail**, simulating pre-RAG vs RAG content. The `<ret>` token is inserted at the beginning of the lead. Scripts → speech via Kyutai's multi-stream conversational TTS (Moshi voice fixed, user voice varied). The pre-trained Moshi used for init was trained on millions of hours of real human conversation (hybrid: natural speech dynamics + RAG capability).

Example:
```
User: Where is Emily Cooper from?
Moshi (lead): In the Netflix series "Emily in Paris,"
Reference: Emily Cooper, the protagonist ... is from the Chicago area ...
Moshi (body): Emily Cooper was originally from Chicago and then relocated to Paris ...
```

## Results

### Factuality (%) + End-to-End Keyword Delay (s)
| Model | Llama Q | Web Q | TriviaQA | HaluEval | E2E Keyword Delay |
|---|---|---|---|---|---|
| Vanilla Moshi | 62.3 | 26.6 | 22.8 | 10.5 | **2.1** |
| Step-Audio-Chat | 81.0 | **75.1** | 58.0 | 21.0 | 10.4 |
| Kimi-Audio | 79.3 | 70.2 | 62.1 | 43.2 | 3.5 |
| Qwen 3 Omni | **84.7** | 68.8 | 73.6 | 38.9 | 5.7 |
| MoshiRAG | 80.6 | 68.9 | **78.2** | **51.3** | 3.1 |

### Math reasoning (generalization, %)
| Model | AddSub | MultiArith | SingleEq | SVAMP | GSM8K |
|---|---|---|---|---|---|
| Vanilla Moshi | 8.3 | 9.8 | 18.4 | 9.7 | 2.1 |
| GLM-4-Voice | 59.4 | 62.0 | 71.0 | 4.0 | 29.0 |
| STITCH-S (reasoning) | 81.7 | 87.9 | 91.7 | 72.2 | 56.7 |
| MoshiRAG | 64.8 | 76.0 | 72.9 | 61.1 | 43.2 |

## Limitations
- Relies on accurate streaming ASR; wrong transcript → irrelevant retrieval.
- Gap between retrieved reference quality and final spoken answer (info loss during integration).
- Future: diversify retrieval tools, let model select tool by input, improve robustness to retrieval errors.

## Headline thesis
> A speech language model can be powerful, but **it does not have to be the entire voice assistant itself** — leveraging external knowledge and specialized tools extends it far beyond its original training. Improving factuality does not require sacrificing interactivity.

Streaming ASR powered by Gradium.

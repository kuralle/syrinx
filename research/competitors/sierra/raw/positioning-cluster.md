# Sierra.ai — Competitive Study: Positioning / Business Model / Milestones / Security / Hiring

Research date: 2026-06-22. Source: sierra.ai/blog (13 posts). All 13 URLs returned HTTP 200; none 404'd or were empty.
Founders referenced across posts: **Bret Taylor** and **Clay Bavor** (signed "Bret & Clay" in the launch post).

---

## PART A — Per-post sections

### Meet Sierra, the conversational AI platform for businesses — `introducing-sierra`
- **Date/author:** Published 2024-02-13. Signed "Bret & Clay" (Bret Taylor & Clay Bavor). This is the company launch post.
- **Thesis:** Conversational AI is the biggest consumer-tech shift in a generation; every company needs an "AI agent," and Sierra is the conversational-AI platform that lets any business build its own branded, customer-facing agent.
- **Specifics:**
  - Positions conversational AI as "on par with the Internet" for customer experience.
  - ChatGPT cited as reaching 100M users in two months ("faster than any consumer product in history").
  - Launch design partners/customers: **WeightWatchers, SiriusXM, Sonos, OluKai**.
  - WeightWatchers agent "already successfully handling almost 70% of customer sessions – with a remarkable 4.6/5 customer satisfaction score."
  - OluKai (founded 2005) agent launched in time for Black Friday/Cyber Monday, "handling over half of all customer cases."
  - Three-pillar positioning: **Sophisticated, Authentic, Trustworthy.**
  - Trust mechanics: deterministic system-of-record access, auditing/QA tools, strict data governance ("your company's data stays your own"), PII protection.
- **Verbatim quotes:**
  - "In the age of conversational AI, the best customer experience is not installing an app or clicking a link, but simply having a conversation."
  - "Agents are autonomous, AI-powered software systems that can interact directly with consumers to solve problems and take action on their behalf."
  - "When a Sierra agent accesses any system of record, those interactions are deterministic, ensuring your agent always adheres to your security policies and access controls."
  - "Sierra exists for one purpose: to empower you to delight your customers with conversational AI."
- **→ Syrinx implication:** Sierra's earliest wedge is *deterministic tool/system access* + auditing as the trust story for LLM agents — Syrinx should treat deterministic side-effects and audit traces as table stakes, not differentiators.

---

### Outcome-based pricing for AI agents — `outcome-based-pricing-for-ai-agents`
- **Date/author:** Published 2024-12-10. No byline.
- **Thesis:** Because AI agents execute processes autonomously, an entirely new pricing model is possible — you pay only when the software achieves a specific, valuable outcome ("outcome-based pricing"), aligning vendor and customer incentives.
- **Specifics (pricing mechanics):**
  - Three-model framing in a table: **Traditional** (fixed, seat/flat rate, high wasted spend — CRM/ATS); **Consumption-based** (variable, usage like API calls/time, medium waste — IaaS/compute); **Outcome-based** (variable, low waste, measured by "resolved conversations, ecommerce purchases, memberships saved" — analogous to pay-for-conversion online marketing).
  - How it's charged: tied to tangible business impacts — resolved support conversation, saved cancellation, upsell, cross-sell. "If the conversation is unresolved, in most cases, there's no charge." **Escalations: "in most cases, there's no charge."**
  - Outcomes are NOT one-size-fits-all: simple resolution vs. complex (e.g., "a 20-minute call with L2 technical support"). "We provide clear, agreed-upon criteria for each outcome upfront."
  - **Blended pricing** offered where outcomes don't fit — e.g., routing/greeter interactions priced consumption-style (per conversation, regardless of outcome).
  - Competitive jab at legacy CX vendors: seat-based revenue conflicts with effective AI ("the more effective their AI becomes, the fewer contact center seats their clients need").
- **Verbatim quotes:**
  - "With outcome-based pricing, Sierra gets paid only when we complete a task for you."
  - "Unused seats sit idly on a proverbial store shelf, hence the derisive moniker 'shelfware.'"
  - "If a legacy provider pitches you an AI agent, it's fair to ask, 'How much will my seat-based license bill shrink?'"
- **→ Syrinx implication:** Outcome pricing is Sierra's signature moat narrative — it forces them to own attribution/measurement infra. Syrinx (infra layer) likely sits in the consumption quadrant; worth deciding whether to expose outcome-attribution hooks so customers *can* build outcome pricing on top.

---

### Outcomemaxxing — `outcomemaxxing`
- **Date/author:** Published 2026-06-03. No byline. (18-month follow-up to the Dec-2024 pricing post.)
- **Thesis:** The future of enterprise software is not productivity tools for teams but autonomous AI agents that deliver outcomes; outcome-based pricing is the enduring model, but it only works where software is highly autonomous AND highly attributable.
- **Specifics:**
  - Since Dec 2024: **S&P 500 up ~30%**; **WCLD (WisdomTree Cloud Computing ETF, the SaaS proxy) down ~15%** — dubbed the "Saaspocalypse."
  - Cites **"Charging for Intelligence" by Madhavan Ramanujam** (emcap.com) and adopts his **2x2 matrix**: axes = software's **agency/autonomy** (Y) and **attribution** (X). Quadrants: Seat-based (bottom-left, classic SaaS), Usage-based/API+infra (top-left, OpenAI/AWS), Hybrid seats+metered consumption (bottom-right, "Cursor is the cleanest current example"), **Outcome-based (top-right, high agency + high attribution = where Sierra sits)**.
  - Two lessons: (1) outcome pricing "rewires your company" — customer success baked into the P&L; (2) it is "more complex than seat-based or consumption pricing — operationally, contractually, accounting-wise."
  - Gold-rush analogy: Levi Strauss (1853) and Wells Fargo (1852) endured by serving the rush, not mining gold.
  - "The cost of raw intelligence is going to fall… What doesn't compress is outcomes."
- **Verbatim quotes:**
  - "People telling you it's simple are selling something."
  - "It only works where the software is highly autonomous and highly attributable."
  - "It's why customers aren't beholden to our gross margin — we're beholden to their future success."
  - "The companies that endure will be the ones selling outcomes, not access."
- **→ Syrinx implication:** Sierra explicitly self-locates in the top-right (high-agency/high-attribution). Voice infra/transport is top-LEFT (usage-based) by their own taxonomy — a clean confirmation that Syrinx and Sierra are different layers; Syrinx is "the compute that compresses," Sierra is "the outcome that doesn't."

---

### Sierra hits $100M ARR milestone in 7 quarters — `100m-arr`
- **Date/author:** Published 2025-11-21. No byline.
- **Thesis:** Sierra reached $100M ARR seven quarters after its Feb-2024 launch — among the fastest-growing enterprise software companies in history — driven by both internet-era and storied legacy brands adopting agents.
- **Specifics:**
  - **$100M ARR, 7 quarters after Feb-2024 launch.**
  - Internet-era customers: **Deliveroo, Discord, Ramp, Rivian, SoFi, Sonos, Tubi, Wayfair.**
  - Storied/legacy customers (with founding years they cite): Next (1864), ADT (1874), Bissell (1876), Safelite (1947), Vans (1966), Cigna (1982), SiriusXM (1990), DIRECTV (1994).
  - **Rocket Mortgage's Digital Assistant: homebuyers "converting 4x faster."**
  - US reach claims: ">95% of Black Friday shoppers; >50% of families in healthcare; >90% of the media ecosystem; >70% of the value chain in fintech."
  - Customer size: **50% of customers have revenue over $1 billion, and 20% over $10 billion.**
  - Channels: phone, IVR, chat, WhatsApp, email — **"over 34 languages"**; can publish to ChatGPT.
  - Products named: **Agent Data Platform** (memory/intelligence → sales, loyalty, retention), **Agent Studio 2.0** (no-code, ops teams build "go live in weeks").
  - Culture quote: "This is the hardest I've ever worked, and the most fun I've ever had."
- **Verbatim quotes:**
  - "Sierra just hit $100M in ARR — seven quarters after we launched in February 2024."
  - "There's an agent for that, and it runs on Sierra."
  - "We'll extend that lead by focusing on the long term — helping companies build deeper relationships with their customers, versus short-term cost cutting and automation."
- **→ Syrinx implication:** The "34 languages, every channel (phone/IVR/WhatsApp/chat/email)" omnichannel claim plus voice is the surface Syrinx competes near on the *transport* layer. Note the 4x-conversion and reach stats are the proof points Sierra leads with — Syrinx pitches need comparable hard metrics.

---

### Year two in review — `year-two-in-review`
- **Date/author:** Published 2026-02-06. No byline.
- **Thesis:** Entering year three with >$150M ARR; momentum from Fortune-20 adoption; success comes from teams focused on a "job to be done," not "AI tourism."
- **Specifics:**
  - **First-ever $50M quarter; kicked off year three with over $150M ARR** (after $100M in 7 quarters).
  - "One in four of our customers has revenue over $10 billion and 50% over $1 billion."
  - Reach: ">95% of US shoppers, 50% of families in healthcare, 70% of the value chain in fintech, and **25% of European banking.**"
  - Fastest go-live cited: "one of the largest healthcare companies in the world went live just seven weeks after the project kickoff — and it would have been six had it not been for the winter holidays!"
  - Use cases: Redfin (conversational real estate search), Rocket Mortgage (mortgage origination), SiriusXM (subscription management).
  - Cites **MIT study (August)** that "95% of AI pilots fail to deliver measurable business returns"; contrasts with applied-AI winners **Harvey (legal), Cursor (coding), Sierra (customer engagement).**
  - Customers named: ADT, Cigna, DIRECTV, Gap, Hyvee, Ramp, Rivian, Safelite, Sutter Health.
  - Coins **"AI tourism"** (start with tech, not the problem) vs. "jobs to be done."
- **Verbatim quotes:**
  - "After reaching $100M in ARR in seven quarters, we followed with our first-ever $50M quarter — kicking off our third year with over $150M in ARR."
  - "Narrowing the problem turns AI from a science project into an engineering problem."
  - "It's the difference between companies engaged in 'AI tourism' and teams focused on jobs to be done."
- **→ Syrinx implication:** "Speed to impact" (6–7-week go-lives) is Sierra's competitive weapon for regulated enterprises. The "AI tourism vs. jobs to be done" framing is a sales narrative Syrinx will be measured against by the same buyers.

---

### The future is build with, not build versus buy — `the-future-is-build-with-not-build-versus-buy`
- **Date/author:** Published 2025-06-17. No byline.
- **Thesis:** The enterprise choice is no longer build-vs-buy but "build with" — Sierra's Agent OS lets companies build as much or as little of their agent as they want; even customers with more AI engineers than Sierra choose to partner.
- **Specifics:**
  - "A number of our customers have more AI engineers than we do" — yet partner because it's better to invest in their core product.
  - Platform pieces: **Agent OS** ("handles all the under-the-hood complexity"), **Agent SDK** (code path), **Agent Studio** (no-code for ops/CX teams), versioning + regression testing + continuous evaluation, A/B testing of agent behavior, omnichannel (voice/chat/SMS/email) out of the box.
  - Benefits list: faster time to value ("Go live in weeks, not quarters"), lower total cost (no need to build orchestration/failover/guardrails), greater agility, less risk, more alignment.
- **Verbatim quotes:**
  - "Many companies today want enterprise software partners to build solutions with, versus the more traditional build or buy approach."
  - "The most AI savvy enterprises understand that the choice today is not build vs buy. It's about finding the right platform and partner to build with."
  - "Build once, deploy everywhere from voice to chat, SMS, and email."
- **→ Syrinx implication:** "Build with" reframes the platform as a co-development partner, not a tool — directly relevant to how Syrinx positions an SDK/infra layer (companies keep control of unique logic; vendor owns orchestration/failover/guardrails). The orchestration/failover/guardrails bundle is exactly the infra Syrinx must either provide or cleanly defer to.

---

### Bye bye, bots: 5 reasons to say "Hello!" to AI agents — `bye-bye-bots`
- **Date/author:** Published 2024-09-06. No byline.
- **Thesis:** Rule-based chatbots fail customers; Sierra's AI agents are the superior alternative across empathy, brand, complexity, multitasking, and continuous improvement.
- **Specifics (5 reasons):** (1) Bots can't understand people → agents communicate with empathy / offer alternatives (e.g., exchange via email/address when no order number). (2) Bots don't represent your brand → agents tailored to brand voice — **OluKai "Aloha Experience"; Chubbies agent named "Duncan Smuthers"** (witty/punny). (3) Bots can't adapt to nuanced requests ("glorified, hard-coded rules engines") → agents handle cancel/retention with promotions, discounts, no escalation. (4) Bots can't multi-task → agents have memory + multitasking. (5) Bots don't evolve → **Experience Manager** (QA/continuous improvement: inspect interactions, suggest updates, edit knowledge bases).
- **Verbatim quotes:**
  - "Because let's face it, when was the last time you had a great experience with a chatbot? Probably never."
  - "Chatbots are glorified, hard-coded rules engines, making them inflexible and unable to handle complex queries."
  - "It's time to say bye bye, bots."
- **→ Syrinx implication:** Memory + multitasking + brand-voice persona ("Duncan Smuthers") are the agent-quality bars buyers now expect; Syrinx's voice layer must preserve persona/tone fidelity end-to-end (TTS voice consistency) to clear this bar.

---

### There's an agent for that, and it runs on Sierra — `theres-an-agent-for-that-and-it-runs-on-sierra`
- **Date/author:** Published 2025-09-04. No byline.
- **Thesis:** Funding announcement — $350M raised at a $10B valuation led by Greenoaks; 18 months in, hundreds of customers including the largest/most-regulated brands.
- **Specifics:**
  - **Raised $350M additional capital at a $10B valuation, led by Greenoaks ("doubling down on Sierra").**
  - "Eighteen months in, Sierra has hundreds of customers."
  - "Over 20% of our customers have revenue over $10 billion, and over half have revenue over $1 billion."
  - Reach: Retail >90% of Americans; Healthcare >50% of US families; Financial Services — fastest-growing fintechs + many of the largest US/European banks.
  - Offices: **San Francisco, New York, London, Atlanta**; expanding into Europe and Asia.
  - Use of funds: platform, US growth, international expansion.
- **Verbatim quotes:**
  - "Today, we're announcing that we've raised $350M additional capital at a valuation of $10B, led by Greenoaks."
  - "Want to order a salad for lunch or fix your home alarm system? There's an agent for that, and it's running on Sierra."
  - "We need to deliver for every customer, every time, without exception."
- **→ Syrinx implication:** The $10B/$350M (Sep 2025) round, later $15B+/$950M (see FedRAMP post, May 2026), signals Sierra is capital-saturated at the agent-application layer — Syrinx should avoid competing head-on there and anchor on the infra/transport layer beneath it.

---

### What is an AI agent? (why does my business need one) — `what-is-an-AI-agent-why-does-my-business-need-one`
- **Date/author:** Published 2025-04-01. First-person ("the first question I'm often asked") — likely a Sierra exec; no explicit byline.
- **Thesis:** Agents are software with "agency" (built on LLMs) that complete tasks unsupervised; businesses need them because they resolve the tension between better experiences and higher costs.
- **Specifics:**
  - Real agent examples by customer: **SiriusXM's agent "Harmony"** (refresh signal to satellite radio); **ThirdLove's agent "Barbra"** (bra fitting — "customers share more information… than they would during an in-person fitting"); **ADT** (24/7 alarm-panel fix, no wait); **Casper** (pillow selection); churn prevention ("AI agents can be even more effective than call center agents at saving customers").
- **Verbatim quotes:**
  - "They're called agents because well, they have agency."
  - "AI agents solve the age-old tension between better experiences and higher costs."
  - "In a world of artificial intelligence, AI agents—not customers—can do that leg work."
- **→ Syrinx implication:** Named consumer-facing voice personas (Harmony) reinforce that branded TTS identity is a product surface; the churn-save/retention use case is where outcome value (and Syrinx's reliability) is highest-stakes.

---

### The Guide to AI Agents — `ai-agents-guide`
- **Date/author:** Published 2024-05-23. No byline. (Foundational explainer; links to "introducing-sierra" as /news/.)
- **Thesis:** Agents are a new kind of software — autonomous systems that reason, decide, and pursue goals within set bounds; LLMs are the "brains," but a real agent needs tools, memory, and plans plus supervisory agents for trust.
- **Specifics:**
  - **Three types of agents:** personal assistants; internal role-specific agents (software devs, data analysts, paralegals); external customer-facing conversational agents.
  - LLMs named: **Google's Gemini, OpenAI's GPT-4** (powers ChatGPT). Three LLM capabilities: natural-language understanding, language generation, reasoning. (GPT-4 "aced high school AP exams.")
  - Architecture: an agent makes **many separate LLM calls** (working memory → plan next actions → evaluate candidates → generate answer); plus **long-term memory**, **tools via APIs**, and a **repository of "plans"** (procedural scaffolding).
  - **Trust/safety = "agents monitoring agents":** deterministic guardrails (e.g., enforce 30-day exchange window), reasoning-trace logging/auditing, and **specialist "supervisors"** that check factuality, block medical advice, detect misuse, and escalate to a human.
- **Verbatim quotes:**
  - "Whereas applications help you do the work, agents get the work done for you."
  - "It turns out that a key ingredient in ensuring trust and safety in AI agents is… more AI agents."
  - "Sierra agents… come paired with a set of specialist 'supervisors' that can do things like monitor answers for factuality, ensure that agents don't dispense medical advice, and detect if an agent is being misused."
- **→ Syrinx implication:** The "supervisor agents + deterministic guardrails + reasoning traces" architecture is Sierra's reliability blueprint. Syrinx's voice pipeline should expose hooks for supervisory checks and deterministic side-effect boundaries rather than treat the LLM as the whole agent.

---

### The AI-native interview — `the-ai-native-interview`
- **Date/author:** Published 2026-04-22. First-person engineering post; no explicit byline.
- **Thesis:** Coding agents (Codex, Claude Code) shift the engineer's job from "building the machine" to "designing and honing it"; Sierra redesigned its engineering interview from the ground up to test product thinking + agency, not typing/algorithm mechanics.
- **Specifics (hiring/culture):**
  - Old process: two coding interviews + algorithms + system design + culture fit + references. Problem: signal was "mechanics."
  - Three design attributes: **Representative, High signal, Positive experience.**
  - **AI-native onsite = Plan → Build → Review:** candidate defines a product, builds it solo over **2 hours** using AI tooling/frameworks of choice, then demos + code review + path-to-production discussion (incl. "how they used AI").
  - Replaced coding phone screen with a **system design interview**; piloting a **debugging interview** (review/improve a colleague's draft PR in a medium-sized codebase using coding agents).
  - Evaluates **agency** ("do they pivot when they get stuck?") and **judgment** ("how do they scope within time constraints"). "Hiring for strengths, not just an absence of weakness." Debriefs shifted from "should we hire?" to "where would this person thrive?"
  - Internal tool named: **Ghostwriter** ("using agents to build and optimize agents"). Quotes Paul Buchheit (Gmail creator): "if it's great, it doesn't have to be good."
- **Verbatim quotes:**
  - "The role is shifting from building the machine to designing and honing it."
  - "But vibe-coding an app is easy. The harder, more relevant, problem is getting it into production in a scalable way."
  - "Our debriefs have shifted from 'should we hire this person?' to 'where would this person thrive, and how do we support them?'"
- **→ Syrinx implication:** Sierra's hiring philosophy ("agency," full-stack + product thinking, AI-as-default-tooling) signals the calibre/velocity of the team Syrinx competes with. The Ghostwriter "agents build agents" detail is a real product capability worth tracking.

---

### Certified FedRAMP High — `certified-fedramp-high`
- **Date/author:** Published 2026-06-10. First-person announcement; no explicit byline.
- **Thesis:** Sierra (with partner Knox Systems) is certified **FedRAMP High** — the standard for cloud companies serving US federal agencies — achieved just over two years post-launch.
- **Specifics (security/compliance + business):**
  - **FedRAMP High certified, in partnership with Knox Systems.** "Just over two years since launch, less than the time many companies take to get certified."
  - "**40% of the Fortune 50**" use the same technology.
  - Channels: voice, chat, email in **58 languages**, 24/7/365.
  - Pricing reaffirmed: "priced by outcomes… Only pay for the value delivered."
  - Customers named: **Vanguard, Rocket Mortgage, Sutter Health.** **Cigna (Fortune 20 healthcare) got their agent into production in just eight weeks and reduced patient authentication time by 80%.**
  - Related-post links reveal newer milestone: **"Better customer experiences. Built on Sierra" (May 4, 2026) — "raising $950 million from new and existing investors, at a valuation of over $15 billion."**
- **Verbatim quotes:**
  - "Sierra… has been certified FedRAMP High — the standard for cloud companies working with U.S. federal agencies."
  - "Cigna, a Fortune 20 healthcare company, got their agent into production in just eight weeks and reduced patient authentication time by 80%."
  - "Only pay for the value delivered."
- **→ Syrinx implication:** FedRAMP High opens the US-government market — a high bar Syrinx would need to clear (or inherit via deployment partner) to serve the same regulated buyers. Note language count grew 34 → 58; voice across 58 languages is a direct transport-layer benchmark.

---

### Sierra is now ISO 42001 and ISO 27001 certified — `sierra-is-now-iso-42001-and-iso-27001-certified`
- **Date/author:** Published 2025-07-08. No byline.
- **Thesis:** Sierra is certified to both ISO 27001 (information security) and ISO 42001 (first AI-specific management standard); the combination into an integrated management system (IMS) validates "secure + responsible by design."
- **Specifics (security/compliance):**
  - **ISO 27001** — global standard for information security management (encryption, access control, cybersecurity risk governance).
  - **ISO 42001** — "the first AI-specific management standard" (model evaluation, AI impact assessment, traceable agent decisions, continuous oversight).
  - Combined = **integrated management system (IMS)**. Examples: ISO 27001 protects patient/prescription data; ISO 42001 makes the agent "grounded and explainable."
  - Reaffirms platform pillars: **secure agent development; guaranteed determinism for sensitive actions (system access/record updates); continuous oversight via supervisory agents (topic drift / inconsistent logic); data autonomy (customer controls where data lives / how used / when deleted).**
  - Points to **Trust Center at trust.sierra.ai**.
- **Verbatim quotes:**
  - "ISO 42001: the first AI-specific management standard."
  - "Behind every agent are supervisory agents, monitoring for quality and issues like topic drift or inconsistent logic."
  - "For sensitive actions like system access or record updates, Sierra supports absolute determinism."
- **→ Syrinx implication:** The ISO 27001 + ISO 42001 + FedRAMP High + (PCI Level 1, per related links) stack is Sierra's full regulated-enterprise compliance moat. Syrinx's infra must at minimum not break a customer's compliance posture (data residency, encryption, deletion controls, deterministic side-effects).

---

## PART B — Pagination verification

Method: `curl -s "https://sierra.ai/blog?page=N"` for N=1..12, each saved to a unique `mktemp` file; counted distinct `blog/[a-z0-9-]*` links per page (`grep -o … | sort -u`).

**Per-page distinct blog-link counts (raw, includes the 5 category index links + recurring sticky cards):**

| page | distinct blog links | total occurrences | bytes |
|---|---|---|---|
| 1 | 18 | 27 | 301,263 |
| 2 | 18 | 27 | 303,207 |
| 3 | 17 | 27 | 303,712 |
| 4 | 17 | 27 | 302,996 |
| 5 | 16 | 27 | 302,570 |
| 6 | 18 | 27 | 301,867 |
| 7 | 18 | 27 | 300,993 |
| 8 | 18 | 27 | 300,993 |
| 9 | 18 | 27 | 303,375 |
| 10 | 18 | 27 | 302,353 |
| 11 | 18 | 27 | 288,731 |
| 12 | 10 | 11 | 235,696 |

**Findings:**
- **Pages 1–11 each return a real, distinct post listing.** Page 1 and page 2 overlap on only **9** of their slugs — and those 9 are the recurring chrome: the 5 category index pages (`corporate`, `engineering`, `industry`, `product`, `research`) plus a few "sticky"/related-post cards (`agent-data-platform`, `agent-os-2-0`, `agents-as-a-service`, `year-two-in-review`) that appear in the footer of every page. Each page surfaces a fresh set of ~12–13 *unique* posts on top of that chrome. So pagination is genuine, not a repeated identical list.
- **Page 12 is the tail/last page** — only 10 distinct links, of which the lone genuinely-new post unique to it is `introducing-sierra` (the Feb-2024 launch post, i.e. the oldest). The other 9 are the recurring category/sticky links. This is consistent with page 12 being the final, partially-filled page.
- **Total distinct post slugs across pages 1–12 (server-rendered curl): 100** (105 distinct `blog/` slugs minus the 5 category index pages).
- **Is it an SPA?** Partially. The pages are **Next.js with streamed RSC payload** (`self.__next_f` present) but the post listings ARE server-rendered into the HTML — curl retrieves real, distinct post links per page (no JS execution needed). So this is NOT a pure client-rendered SPA that returns an empty list; the curl-based count is reliable.
- **Authoritative total:** curl enumerates **~100 distinct posts** across the paginated index. The Firecrawl sitemap figure (~108 posts) is slightly higher and remains the authoritative full count — the curl pass under-counts modestly because (a) page 12 is partial and (b) a handful of posts may not surface across the page chrome dedup. Net: **roughly 100–108 total blog posts; ~108 (firecrawl sitemap) is the authoritative number.**

 EBOOK
The Definitive Guide to
Voice AI Agents

                                                                                                                                           2

Table of     Contents
Chapter 0                     Chapter 1                          Chapter 2                        Chapter 3                            Chapter 4
Introduction                  Foundations:                       System Design                    Deployment                           Operational
Setting the Stage             How Voice Agents Work              and Architecture                 and Runtime                          Excellence
Why Voice Agents Now    5     Anatomy of a Voice Agent    8      Voice UX Design           22     Deployment and Runtime        43     Reliability, Testing,    48
About This Guide        5     Voice Agent Stack           11     Principles                       Architecture                         and Evaluation
Scope and Structure     6     Production-Ready            14     Reasoning and             29     Hosting Models and            43     Observability and        51
                              Stack: Operational Layer           Orchestration Layer              Regional Placement                   Monitoring
                              Architectural Approaches    16     Telephony Runtime         33     Scaling and Concurrency       44
                              to Building Voice Agents           Architecture                     Resilience and Graceful       44
                              Overview of Build           17     Multilingual Strategies   38     Degradation
                              Approaches                         and Localization                 Observability and Runtime     45
                              Comparing the               19                                      Visibility
                              Approaches                                                          Edge and Offline              45
                              Guidance on Choosing        20                                      Deployments
                              an Approach                                                         Security as a Runtime         46
                                                                                                  Baseline
                                                                                                  Summary                       46

                                                                                                                                                                             3

Table     of     Contents
Chapter 5                             Chapter 6                          Chapter 7                        Chapter 8                            Chapter 9
Compliance                            Applied                            The Future                       Getting Started                      Appendices
and Governance                        Architectures                      of Voice AI
Compliance and Data              55   Reference Architectures       67   The Next Architectural     88    Recap: A Practical            94     Glossary of Key Terms      98
Control                               (Topologies)                      Shift                            Framework for Voice Agents           Quick Reference: Deepgram  101
Regional Deployment and          55   Tier 1 – Single-Agent        67   Neuroplex Architecture     89    Choosing Your Build Path      95     APIs and SDKs
Data Residency                        Foundations                        Overview                         Your Open Build Path          95     Common Failure Modes       103
Secure Transmission              56   Tier 2 – Specialized and      70   Implications for Builders  91                                         in Real-Time Voice Agents
and Authentication                    Localized Agents                                                    Take the First Steps          96
Data Retention, Redaction,       57   Tier 3 – Integrated and       73
and Minimization                      Distributed Systems
User Authentication,             57   Tier 4 – Low-Level and        77
Consent, and Disclosure               Edge Implementations
Logging, Auditability,           58   Synthesis: The Architecture   79
and Governance                        Continuum
Putting Compliance               58   Ecosystem Patterns            80
into Practice                         (Integrations)
Content Safety                   59
and Guardrails
Safety Governance and            63
Continuous Improvement
Operational Realities: Pitfalls  63
and Success Factors

CHAPTER 0

Introduction
Setting the Stage

CHAPTER 0: INTRODUCTION - SETTING THE STAGE                                                                                                                           5

Why Voice Agents     Now                                                              About This     Guide
Voice is no longer a novelty in human–computer interaction. It has become a           This guide is Deepgram's definitive, opinionated playbook for designing,
foundational interface. This shift is driven by advances in real-time AI, growing     deploying, and operating real-time voice agents. We wrote this as practitioners,
production adoption, and the inherent complexity of spoken interaction.               for practitioners. It reflects our perspective on how voice agents should be
Recent breakthroughs across the stack have made high-quality voice agents             architected and run in production.
viable at scale. Large language models now support low-latency, multi-                While many resources explain how to call a speech API or connect to
turn reasoning. Synthetic speech has become natural and expressive. Most              a telephony provider, far less guidance exists on how to design voice agents
importantly, new approaches to conversational speech recognition have solved          as end-to-end systems. Voice agents are distributed, low-latency systems
one of voice UX's longest-standing challenges: accurately determining when            that must coordinate perception, reasoning, timing, and response under
a speaker has finished talking. This shift, driven by infrastructure-level            real-world constraints. This guide focuses on that system-level view.
research, has fundamentally changed how voice agents manage turn-taking,              This guide is for developers and engineers building voice agents, architects
timing, and responsiveness.                                                           evaluating design and deployment trade-offs, and technical product
At the same time, market adoption has accelerated. Organizations with high            leaders responsible for reliability, scalability, and user experience. If you are
volumes of inbound and outbound conversations are deploying voice agents              implementing or evaluating a voice agent in a real production environment,
to extend availability, reduce staffing pressure, and improve responsiveness.         this guide is for you.
Falling costs for real-time AI models, combined with more composable
infrastructure, have lowered the barrier to entry. What once required
significant in-house engineering effort can now be built with modern APIs
and specialized platforms.
The result is a clear inflection point: the technology is mature, demand is real,
and the systems involved are complex enough to require serious engineering.
Voice agents are now production-grade, real-time software systems.

CHAPTER 0: INTRODUCTION - SETTING THE STAGE                                    6

Scope and Structure                                                        Throughout the guide, we emphasize how the pieces fit together at a system
                                                                           level. You will not find exhaustive API syntax here. Product documentation
The guide is organized into modular sections that can be read linearly     already serves that purpose. Instead, this guide helps you build a clear mental
or used as a reference:                                                    model of real-time voice agents: how they work, how to design them well, how
•	Foundations explains how voice agents work, their core components,       to operate them in production, and where the technology is headed.
and why real-time voice systems are uniquely challenging.                  With that foundation in place, we begin by examining how voice agents are
•	System Design and Architecture covers agent behavior, real-time UX,      constructed and how they behave in practice.
  reasoning logic, telephony integration, and multilingual considerations.
•	Operational Excellence and Governance focuses on reliability, testing,
metrics, monitoring, compliance, and guardrails.
•	Applied Architectures and Patterns presents reference architectures and
real-world integration patterns.
•	The Future of Voice AI explores emerging directions, including Deepgram's
Neuroplex research on speech-to-speech systems.
•	Getting Started outlines practical next steps and resources for
different personas.
•	Appendices provide reference material such as glossaries, event flows,
and troubleshooting guidance.

CHAPTER 1
Foundations
How Voice Agents Work

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                        8

Anatomy of     a     Voice Agent                                                  The Conversational Loop
Understanding voice agents begins with examining their fundamental structure      At a behavioral level, every voice agent follows a continuous conversational
and behavior. This section breaks down what voice agents are, how they            loop that mirrors human dialogue:
operate, and why building them presents unique challenges.
What Is a Voice Agent?                                                            Listen → Understand → Reason → Respond → Speak
A voice agent is an autonomous, real-time conversational system that listens,     These stages map to distinct system functions:
reasons, and responds using natural spoken language. Users interact with it
through speech, typically over a phone call, device microphone, or embedded       •	Listen: Capture incoming audio from the user in real time.
application, and receive spoken responses in return.                              •	Understand: Extract meaning and detect conversational signals such
Voice agents differ from traditional IVR systems, which rely on prerecorded       as pauses and end-of-turn.
prompts and rigid menus. They also differ from text-based chatbots, which         •	Reason: Interpret intent and decide on a response or action.
operate without real-time audio constraints. Unlike those systems, voice          •	Respond: Generate spoken output.
agents must handle continuous audio streams, ambiguous turn boundaries,             •	Speak: Stream audio back to the user and resume listening.
and strict latency requirements while maintaining a natural conversational flow.
A voice agent is a real-time system designed for spoken interaction under
real-world conditions.

    CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK    9





     Listen Understand Reason Respond Speak
Capture audio input Extract meaning Process context and Formulate appropriate Deliver audio
   from the user from audio generate response reply content response to user







    Figure 1.1: The Conversational Loop Flow                                     In production systems, this loop does not operate as a strict, turn-by-turn
    The five core stages of voice agent interaction form a continuous cycle,     pipeline. The stages overlap and run concurrently. An agent may begin
    with each stage feeding into the next.                                       reasoning before a user has finished speaking, or start speaking while the
                                                                                 remainder of a response is still being generated. This streaming, event-driven
                                                                                 behavior is what gives voice interactions a natural rhythm.
                                                                                 This loop describes how a voice agent behaves. Implementing it reliably under
                                                                                 real-world conditions is where complexity arises.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                            10

Why This Is Hard                                                                     •	Interrupt-driven interaction and turn-taking
Building a voice agent that feels truly conversational is difficult because real-     Users interrupt responses, correct themselves mid-utterance, and
world interaction is not a controlled environment. People interrupt each other,       change intent while the system is speaking. A production agent must
audio quality varies, latency introduces awkward pauses, and individual AI            detect these events instantly, stop or adjust output, and resume listening
components do not inherently share timing or state. What appears simple               without losing context.
quickly becomes a real-time systems problem.                                         •	Synchronizing speech and reasoning for natural rhythm
The core challenges are:                                                              When reasoning takes time, the agent must manage perceptible states
                                                                                      such as listening, thinking, and speaking. Without awareness of its
•	Real-time orchestration of multiple systems                                         own timing, systems produce awkward pauses, self-interruptions, or
A voice agent consists of multiple independently operating components                 repetitive filler.
such as speech recognition, reasoning, synthesis, and audio I/O, each        Together, these constraints make it insufficient to treat voice agents as
producing asynchronous events. Without strong orchestration, timing        sequential pipelines. Human-like interaction requires an event-driven,
mismatches cause premature cutoffs, delayed responses, or the agent        interrupt-aware architecture that treats timing and partial signals as first-
speaking at the wrong moment.        class inputs.
•	Latency compounding across stages        The next section examines the systems that make this behavior possible,
Small delays at each stage of the conversational loop accumulate into        starting with the core technologies in the voice agent stack.
perceptible pauses. To improve responsiveness, overlap work, react to
partial signals, and minimize handoff overhead. In voice interaction, every
100 milliseconds matters.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK 11

Voice Agent     Stack                                                             The Stack Concept
We can now examine what a voice agent is actually built from. While               At a high level, a voice agent stack can be divided into two layers.
implementations vary, modern voice agents share a common set of                   The core conversational layer contains the components required to carry
architectural building blocks. These components exist to support the              out a real-time spoken interaction at all. This layer is responsible for listening,
conversational loop described earlier and to operate reliably under               reasoning, and speaking, and for coordinating those functions continuously.
real-time conditions.                                                             Without it, there is no conversational agent.
The architecture described in this section represents cascade-based voice         The operational layer sits above the core and becomes essential as systems
agents: systems that convert speech to text, process that text through a          move toward production. This layer handles concerns such as scalability,
reasoning layer, then synthesize responses back to speech. While the industry     reliability, observability, integration with external systems, and compliance.
is actively developing streaming speech-to-speech (S2S) architectures that        These components do not change how the agent converses, but they
operate on continuous audio representations without text intermediaries,          determine whether it can function dependably in real-world deployments.
cascade systems remain the dominant production pattern. They offer
mature tooling, interpretable debugging boundaries, and proven operational        Put another way, the core layer answers the question: Can the agent hold
characteristics.                                                                  a conversation?
For a detailed exploration of S2S architectures and Deepgram’s Neuroplex          The operational layer answers: Can that conversation run at scale, under
research, see Chapter 7: The Future of Voice AI.                                  load, and within real-world constraints?

    CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                                                                             12

    The sections that follow break down these layers in more detail, starting
    with the minimal set of components required for a functioning voice agent,
    and then expanding to the additional capabilities needed for production-grade    The two-layer     Figure 1.2: Voice Agent Stack Architecture
    systems. Where relevant, we reference how Deepgram provides infrastructure       (Operational      architecture separates production concerns
    across both layers.                                                                            Layer) from real-time interaction capabilities
                                                                                                                     (Core Conversational Layer).

        Operational Layer

 Memory     Observability    Integration    Compliance
& Context    & Telemetry        Layer       & Security



    Enables


        Core Conversational Layer

Audio I/O & Speech-to-Text Language Model Text-to-Speech Orchestration
 Transport & CSR / Reasoning Runtime

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                                   13

MVP Stack: Functional Core
At the foundation of every voice agent is a real-time conversational core. These components are non-negotiable.
Without all of them working together, a system may demonstrate basic functionality but will not behave like a true
conversational agent.

Component                              Role in the System                                    Deepgram Example

Audio I/O and Transport                Streams audio into and out of the system with low     Real-time, bidirectional audio streaming via SDKs and APIs for web, mobile, and
                                       latency.                                              telephony environments.

Speech-to-Text and Conversational      Transcribes speech and detects conversational         Flux unifies transcription and turn detection in a single conversational model optimized
Speech Recognition                     boundaries such as end-of-turn.                       for real-time agents.

Language Model or Reasoning Engine     Interprets intent and determines the agent’s          Model-agnostic LLM integration optimized for streaming input and incremental output.
                                       response or action.

Text-to-Speech                         Converts responses into spoken audio and              Aura-2 provides low-latency, streaming speech synthesis for real-time interaction.
                                       streams output to the user.

Orchestration Runtime                  Coordinates timing, state, and interaction across     Voice Agent API manages real-time orchestration, interruption handling, and stream
                                       all components.                                       control within a single session.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                                                                               14

Together, these components form the minimum viable voice agent. Early        Production-Ready Operational Components
implementations often stitched these pieces together manually using multiple
APIs, which worked for demos but introduced unnecessary latency and                 Component       Role               When Needed       Deepgram Example
coordination issues. Modern platforms increasingly integrate parts of this core     Memory          Maintains          Required for      Session-level context, designed
to reduce handoffs and enable streaming, event-driven behavior by default.          and Context     conversational     multi-turn or     to integrate with external stores you
Production-Ready Stack:                                                             Management      state across       personalized      manage for long-term memory.
                                                                                                    turns or           agents.
Operational     Layer                                                                               sessions.
                                                                                    Observability   Measures           Required for      Real-time event streams that plug into
                                                                                    and Telemetry   latency,           any production    your monitoring stack to support quality
While the functional core enables conversation, production deployments                              quality, and       deployment.       tracking and external observability.
introduce additional requirements. Voice agents must operate reliably at                            system health.
scale, integrate with business systems, and meet regulatory and security            Integration     Executes           Required for      Structured function calls that integrate
expectations. These concerns are addressed by the operational layer                 Layer           actions in         task-oriented     external logic into the conversational flow.
of the stack.                                                                                       external           agents.
                                                                                                    systems.
                                                                                    Compliance      Enforces           Required for      Regional deployment options, isolated
                                                                                    and Security    privacy,           enterprise        infrastructure, short-lived credentials,
                                                                                    Controls        access control,    and regulated     and redaction support.
                                                                                                    and regulatory     environments.
                                                                                                    requirements

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                        15

These components do not change how an agent speaks or listens, but they           At the same time, Deepgram does not advocate for a monolithic stack. Teams
determine whether the system can be trusted in real-world environments. Most      should remain free to choose their own language models, tools, and business
successful deployments begin with the functional core and progressively add       logic. While reasoning layers may vary by use case, the speech layer must
operational capabilities as they scale.                                           be unified and streaming-first to support interruption handling, precise timing,
With the components of the voice agent stack defined, the remaining question      and low-latency response.
is how these pieces should be assembled into real systems. There is no single     Deepgram supports different abstraction levels by offering flexible
correct approach. Different teams make different architectural trade-offs         APIs that allow teams to decide how much of the system they want to
depending on their requirements, constraints, and appetite for control.           manage themselves.
Deepgram’s Opinionated View                                                       The next section examines how teams assemble these components in
                                                                                  practice. There are multiple valid approaches, each with trade-offs in
Deepgram’s perspective is that real-time voice agents perform best when           control, complexity, and abstraction.
built on an integrated, streaming-first speech infrastructure rather than a
loosely chained set of APIs. Speech recognition, speech synthesis, and audio
transport should operate as a unified layer, coordinated by a purpose-built
orchestration runtime.
Optimizing the speech loop as a whole reduces latency, minimizes handoffs,
and enables faster transitions between listening, reasoning, and responding.
This produces more responsive and natural interactions than optimizing
individual components in isolation.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK        16

Architectural Approaches
to Building Voice     Agents
While all voice agents rely on the same core components, teams differ
in how they assemble those components. The primary differences come
down to where orchestration logic lives and how much abstraction
versus control a team prefers.
At one end of the spectrum, teams assemble everything themselves
using low-level APIs. At the other, teams adopt fully managed platforms
where voice is one feature in a broader system. Most real-world
implementations fall somewhere in between.
Rather than rigid categories, these approaches represent
common architectural patterns. Teams often move between
them as requirements evolve.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK 17

Overview     of   Build     Approaches
We can broadly group voice agent architectures into four patterns,
ordered from maximum control to maximum convenience.

The Four Build Approaches

Build Approach                      Description                                        Examples                             Deepgram Role

DIY Frameworks (Custom Stack)       Teams assemble their own pipeline using            LiveKit, Pipecat, custom pipelines   Provides foundational STT and TTS APIs
                                    separate STT, LLM, and TTS components and                                               and SDKs used directly within custom
                                    implement orchestration themselves or via open-                                         orchestration code.
                                    source frameworks.

Unified APIs (End-to-End Runtime)   A single real-time API integrates speech,          Deepgram Voice Agent API,            Provides both speech infrastructure and
                                    orchestration, and LLM interaction while still     OpenAI Realtime API                  real-time orchestration in a single runtime,
                                    allowing configuration and custom logic.                                                with model choice and function calling.

Managed Voice Agent Platforms       Hosted platforms offering visual builders,         Vapi, Retell                         Often used as the underlying speech layer
                                    telephony integration, and preconfigured                                                powering platform-managed agents.
                                    orchestration for common use cases.

Enterprise Conversational Suites    Large CX platforms where voice is one channel      Cognigy, Kore.ai, Decagon            Serves as the embedded speech infrastructure,
                                    within a broader, multimodal system.                                                    typically consumed indirectly by end customers.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK 18

These approaches trade off control, abstraction, and operational responsibility. None is inherently better than the
others. The right choice depends on team capability, use case complexity, and long-term ownership preferences.








   More                                                                                        More
 Control &       DIY      More          Unified      More        Managed     More        Enterprise     Convenience
Flexibility  Frameworks     Abstraction  APIs      Abstraction  Platforms     Abstraction  Suites     & Integration
           (Custom Stack)        (End-to-end Runtime)    (Voice Agent Platforms)       (CX Platforms)

           Maximum Control             Balanced                Simplified            Maximum Convenience
        Custom Orchestration        Managed Runtime          Visual Builders         Integrated Solution









    Figure 1.3: Build Approaches Comparison
    The four architectural approaches form a spectrum from maximum control and
    flexibility (DIY Frameworks) to maximum convenience and integration (Enterprise Suites).

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK                                      19

Comparing     the                           Approaches                          •	Integration complexity
                                                                               DIY places the full integration burden on the team. Unified APIs reduce
Rather than evaluating each approach in isolation, it is more useful           complexity by collapsing the conversational loop into a single integration.
to compare them along a few consistent dimensions:                             Managed platforms simplify agent construction but may still require
•	Abstraction level                                                            integration with downstream systems. Enterprise suites aim to minimize
DIY approaches offer the lowest abstraction and highest responsibility.        integration by providing a comprehensive solution.
Unified APIs strike a balance by abstracting orchestration while preserving     •	Compliance and governance
code-level control. Managed platforms and enterprise suites offer higher       DIY offers maximum flexibility but shifts compliance responsibility to
abstraction, often at the cost of flexibility.                                 the team. Unified APIs can provide strong governance options when
•	Customization and control                                                    deployed in controlled environments. Managed platforms are typically
DIY provides full control over every component. Unified APIs                   SaaS-first. Enterprise suites usually offer the most comprehensive
allow meaningful customization within a managed runtime. Managed               compliance posture.
platforms limit customization to supported workflows. Enterprise suites
offer the least direct control over AI behavior but maximize integration.
•	Latency and performance
In theory, DIY can be optimized for specific scenarios. In practice, purpose-
built unified APIs often achieve better real-time performance due to
integrated streaming and optimized internals. Higher-level platforms may
introduce additional latency depending on telephony and routing layers.

CHAPTER 1: FOUNDATIONS - HOW VOICE AGENTS WORK 20

Guidance on Choosing     an     Approach
The right architectural approach depends on priorities and constraints:
•	Choose DIY if you require maximum control, need to self-host components,
or must integrate proprietary models. This approach demands strong
engineering resources and careful real-time systems design.
•	Choose a unified API if you want a balance of speed, flexibility, and
performance. This is often the best fit for teams building production
voice agents who want to avoid implementing streaming orchestration
themselves while retaining control over models and logic.
•	Choose a managed platform or enterprise suite if speed to deployment,
minimal coding, or enterprise procurement requirements dominate. These
approaches work well for standardized use cases or organizations that
prefer integrated vendor solutions.
Many teams mix approaches over time. Some prototype with managed
platforms and later transition to unified APIs or DIY stacks. Others embed
unified APIs within larger platforms or enterprise workflows. Deepgram is
designed to support this spectrum, allowing teams to adopt the abstraction
level that best matches their needs.

CHAPTER 2
System Design
and Architecture

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                                22

Voice UX Design     Principles                                                       The foundation is accurate turn-taking. A voice agent must reliably determine
                                                                                     when a user has finished speaking while tolerating natural pauses and
Voice user experience design sits at the intersection of linguistics, cognition,     hesitations. In production systems, this requires conversational speech
and real-time systems engineering. A voice agent does not merely transcribe          recognition that models timing and intent, not just words.
speech and return answers. It must manage timing, tone, and conversational           Deepgram’s conversational speech models are designed around this principle.
expectations so that interaction feels cooperative rather than transactional.        Rather than treating end-of-speech as a fixed silence threshold, they infer
Across academic research and production deployments, one conclusion is               turn completion from conversational context, allowing the system to respond
consistent: the quality of a voice agent is determined less by what it says          quickly without cutting users off. This precision enables agents to maintain
than by when and how it says it. Micro-timing, interruption handling, and            human-like pacing even under noisy or ambiguous conditions.
perceptual cues shape whether users trust the system or abandon it.                  When downstream reasoning or data access introduces delay, reactive
Deepgram’s approach to voice UX reflects this reality. We view voice                 design calls for explicit acknowledgment. Short, low-commitment cues signal
interaction as a real-time control problem, not a text interface with audio          attentiveness without breaking conversational flow.
attached. From that perspective, effective voice UX emerges from three
interdependent design layers: reactive, predictive, and adaptive behavior.
These layers govern how an agent responds in the moment, anticipates intent,
and adjusts tone over time.

Reactive Design: Establishing Conversational Rhythm
Human conversation follows a surprisingly strict rhythm. Turn gaps that are too
short feel interruptive; gaps that are too long feel inattentive. Reactive design
focuses on reproducing this rhythm in software.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                               23

Conceptually, the behavior looks like this:                                        The core pattern is speculative preparation with safe cancellation:

if user_turn_complete:                                                             if early_intent_inferred:
prepare_to_respond()                                                                begin_drafting_response()
if response_is_delayed:                                                            if user_continues_or_changes_direction:
acknowledge_progress()                                                              discard_draft()
if user_resumes_speaking:                                                          if turn_is_confirmed_complete:
immediately_yield_control()                                                         finalize_and_speak()

The goal is reassurance through restraint. Silence creates uncertainty, while       This overlap shortens response time without increasing error rates, provided
brief acknowledgment maintains trust.                                               the system can cancel cleanly when predictions are wrong.
Reactive design establishes the baseline rhythm of interaction. Without it,         Predictive design also shapes how speed is perceived. Users judge
predictive and adaptive behaviors cannot compensate for broken pacing.              responsiveness not by absolute latency, but by feedback continuity. Subtle
                                                                                    backchannel cues, brief affirmations, or tonal acknowledgment during
Predictive Design: Reducing Perceived Latency                                       processing can make identical systems feel significantly faster.
Once basic rhythm is stable, voice agents can move beyond reaction to               Deepgram’s opinion is clear here: latency is as much a UX problem as an
anticipation. Predictive design allows the system to infer intent before a user     infrastructure problem. Optimizing models alone is insufficient if orchestration
finishes speaking and begin preparing a response in parallel.                       does not allow early signals to flow through the system.
Research on incremental dialogue processing shows that overlapping                  Adaptive Design: Tone, Persona, and Context Awareness
listening and reasoning can dramatically reduce perceived latency.
Deepgram’s streaming-first architecture enables this behavior by emitting early     Static voice personas break down quickly in real-world interaction. Effective
conversational signals that allow downstream systems to act speculatively.          agents adjust tone, pacing, and phrasing based on context while maintaining
                                                                                    a consistent identity.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                                                                                      24

Adaptive design draws on two signal classes:                                      The guiding principle is contextual sensitivity, not emotional mimicry.
1. Input-side context, such as hesitation, interruptions, repeated questions,     The agent should sound calm when users are rushed, reassuring when
   or unstable recognition                                                        they hesitate, and concise when confidence is high.
2. Output-side expressiveness, including prosody, pacing, and emphasis            Conversational Framing and Meta-Communication
Deepgram’s speech models expose timing and stability signals that can be          Humans constantly talk about the conversation itself. These meta-
used to infer conversational friction. For example, rapidly changing partial      communicative cues manage expectations and keep dialogue cooperative.
transcripts or delayed stabilization often correlate with user uncertainty or     In voice UX, meta-communication reframes latency or uncertainty as progress
frustration. These signals can guide downstream response shaping without          rather than failure. Compare silence to a phrase like “I’m checking that now.”
explicit sentiment classification.                                                The latter maintains engagement by explaining what the system is doing.
On the output side, modern expressive synthesis allows tone modulation
without brittle markup. Deepgram’s Aura-2 voices are designed to produce          Meta-communication operates across layers:
consistent, professional speech while adapting pacing and emphasis                Layer             Responsibility                         Example
naturally from text and conversational context. Developers influence tone         Policy            Decide when to acknowledge delay       “Acknowledge if reasoning exceeds
primarily through response construction and persona choice, rather than                                                                    one second”
micromanaging synthesis parameters.                                               Orchestration     Detect slow operations                 Trigger acknowledgment
Vida’s healthcare voice agents process tens of thousands of calls daily
for appointment scheduling and medication adherence, where empathetic             Timing            Ensure cues respect turn ownership     Never interrupt user speech
tone directly correlates with task completion. Their architecture prioritizes     Synthesis         Convey reflective tone                 Slight pause, measured delivery
alphanumeric accuracy for dates and medication names without SSML                 The intent of meta-communication is transparency. When done well, it builds
markup, demonstrating that entity rendering precision is a UX requirement,        trust by making the system’s internal state legible to the user.
not a feature.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                          25

Repair and Recovery                                                            When recovery is transparent and cooperative, users perceive the agent
No voice agent avoids errors. Reliability depends on how gracefully            as attentive rather than flawed.
the system recovers.                                                           Multimodal Reinforcement and Cognitive Load
Effective repair follows a consistent pattern:                                 Voice interaction often coexists with visual or tactile feedback. Coordinating
•	Acknowledge uncertainty                                                      these channels reduces cognitive load by reinforcing system state through
•	Narrow ambiguity                                                             multiple signals.
•	Confirm resolution                                                           Auditory acknowledgments can be paired with visual indicators such as
Conceptually:                                                                  progress animations or status lights, all synchronized to conversational timing.
                                                                               The critical requirement is temporal alignment. When cues drift out of sync,
if confidence_is_low:                                                          trust erodes.
ask_for_clarification()                                                        As multimodal interfaces mature, the best experiences will feel unified
if user_corrects_agent:                                                        rather than layered, with users perceiving responsiveness rather than
prioritize_user_input()                                                        individual channels.
confirm_updated_understanding()

Interruptions during agent speech are especially important signals.
A system that immediately yields control reinforces that the user remains
the primary speaker.
Deepgram’s event-driven speech infrastructure is designed to support this
behavior, allowing playback cancellation and rapid listening resumption without
losing conversational state.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE 26

Perspective and Path Forward                                                         Real-Time Audio Pipeline
Voice UX is shifting from scripted interaction toward real-time collaboration.       Every voice interaction begins with audio capture, and architectural choices
Anticipatory processing, adaptive prosody, and event-driven orchestration            here directly affect responsiveness. Audio should be streamed in small,
are redefining how agents listen and respond.                                        consistent frames rather than buffered in large chunks.
Deepgram’s position is that voice UX quality emerges from optimizing the             Frame sizes in the 20–50 millisecond range strike a balance between reactivity
entire conversational loop, not isolated components. Low-latency speech              and network efficiency. Smaller frames increase responsiveness but raise
models, expressive synthesis, and fine-grained timing signals enable agents          overhead; larger frames reduce overhead but introduce audible lag.
that feel cooperative rather than mechanical.                                        Encoding formats should match the environment. Telephony typically uses
As these systems evolve, tone and timing will adapt fluidly to live context          8 kHz mono µ-law or A-law PCM, while browsers and mobile devices
rather than fixed personas. Measuring and improving these behaviors in               commonly support 16 or 48 kHz PCM. On the output side, synthesized
production is the next challenge, which we address in the following section.         speech should be streamed incrementally and buffered just enough to prevent
                                                                                     playback gaps. A short jitter buffer around 100 milliseconds is usually sufficient
Interaction and UX Architecture                                                      to smooth minor network variation without adding perceptible delay.
If voice UX principles define how an agent should feel, interaction architecture     Deepgram’s SDKs handle audio chunking, format negotiation, and stream
defines how that feeling is produced in real time. This section focuses on the       continuity automatically, allowing developers to focus on interaction logic
systems beneath the conversation: audio pipelines, event flow, interruption          rather than transport mechanics. This abstraction matters because timing
handling, and state signaling. A well-architected voice agent does not               errors at the audio layer propagate upward into turn-taking and UX failures
guess what is happening. It reacts deterministically to real-time signals
and coordinates perception, reasoning, and output under latency and
concurrency constraints.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                            27

Event-Driven Turn Management
Turn-taking is the backbone of conversational UX. Humans rely on implicit
timing cues; systems require explicit events. A production voice agent should    TurnOngoing
never poll for state. It should react to a stream of conversational events.
Key transitions such as speech start, speech end, interruption, and resume
must be handled as asynchronous signals. These events drive both backend
behavior and user-facing feedback. For example, detecting speech start               AwaitingEnd
should immediately cancel any active playback, while detecting turn              Start        Eager
completion should trigger reasoning or acknowledgment.                           Initial  OfTurn        EndOfTurn
Flux simplifies this layer by collapsing traditional ASR and VAD stacks              Speaking
into a single conversational model that emits deterministic turn events:             Turn
                                                                                     Resumed
•	StartOfTurn: user begins speaking, cancel playback
•	EagerEndOfTurn: medium confidence turn ending, begin                               Processing
speculative reasoning
•	TurnResumed: user continues, cancel speculative work                           Ready        End
                                                                                     OfTurn
•	EndOfTurn: high confidence completion, finalize response
Thresholds such as eager_eot_threshold and eot_threshold allow teams
to tune the speed–stability trade-off, and Flux is designed to keep transcripts
highly consistent between eager and final turn boundaries. Speculative
reasoning rarely diverges from the final text.                                   Figure 2.1: Flux Turn Management State Machine
                                                                                 Flux emits deterministic turn events, enabling the orchestration layer
                                                                                 to react to speech boundaries without polling or redundant VAD.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE 28

When integrating Flux into frameworks like LiveKit, Pipecat, or Vapi,                events such as AgentAudioDone provide a clean boundary for recovery
downstream VAD and turn logic should be disabled. Redundant                          and next actions.
detection introduces desynchronization, leading to premature responses               The core principle is control. TTS must be interruptible, cancellable, and
or mid-utterance replies. Flux should be the single source of truth for              replaceable at any moment. Voice agents that cannot stop themselves on
conversational boundaries.                                                           demand will never feel conversational.
Deepgram’s Voice Agent API builds on these primitives by exposing
higher-level lifecycle events such as UserStartedSpeaking, AgentThinking,            State Signaling and UX Feedback
AgentStartedSpeaking, and AgentAudioDone. The underlying turn logic                  Conversational UX depends on shared understanding of system state.
remains Flux-driven, but orchestration complexity is abstracted away, allowing       Rather than inferring state from timing heuristics, production systems
teams to work at the interaction level rather than the signal-processing level.      should emit explicit lifecycle signals.
Interruption and Playback Control                                                    Deepgram’s Voice Agent API exposes structured events representing
                                                                                     conversation state directly. These signals allow interfaces, analytics, and
Interruption handling, or barge-in, must be supported at both the audio and          monitoring systems to remain synchronized without duplicating logic.
orchestration layers. Users expect to interrupt naturally, and systems that fail     Treating state signaling as part of orchestration rather than presentation
here feel rigid and uncooperative.                                                   produces a single source of truth across devices, simplifying debugging
Input and output pipelines must run concurrently. When new speech is                 and ensuring feedback aligns with actual system behavior.
detected during playback, output should stop immediately and state should
transition back to listening. Playback cancellation must be explicit so buffers      Multi-Modal and Multi-Device Adaptation
and downstream components reset cleanly.                                             Voice agents increasingly operate across browsers, mobile apps, contact-
In Deepgram’s Voice Agent API, barge-in is handled automatically. User speech        center consoles, kiosks, and embedded devices. Conversation logic should
immediately cancels synthesis and playback, and the system re-enters a               remain platform-agnostic while presentation adapts locally.
listening state. For custom implementations, inbound audio energy or speech          The orchestration layer should emit structured state and content, while
detection flags should directly trigger playback termination. Confirmation           clients decide how to render it. A display-equipped device may visualize

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                                 29

AgentThinking, while a voice-only interface inserts a brief acknowledgment            treats speech boundaries, interruptions, and reasoning delays as first-class
triggered by the same event.                                                          events rather than edge cases.
This separation allows consistent behavior across environments even                   By combining event-driven architecture with the UX principles described
as interfaces evolve.                                                                 earlier, teams can build voice agents that remain fluid under real-world
                                                                                      conditions. The result is steadier rhythm, better recovery, and interactions that
Reliability, Failover, and Session Recovery                                           feel attentive because the system never loses track of the conversation.
Voice interactions are long-lived and streaming-based, making transient               Reasoning and Orchestration     Layer
failures unavoidable. Reliability architecture ensures that conversations
degrade gracefully rather than collapse.                                              Real-time voice agents succeed or fail in the layer that sits between perception
Streaming connections should implement reconnection logic with exponential            and speech: the reasoning and orchestration layer. This is where transcripts
backoff. When reconnection is possible, prior conversational context should be        become decisions, decisions become actions, and actions return to the
restored through injected state rather than restarting cold. When recovery fails,     conversation as coherent, timely responses. Unlike text-based systems, this
the system should communicate clearly rather than leaving silence.                    layer must operate under tight latency constraints, tolerate interruption, and
Backend components should monitor audio flow and message cadence.                     maintain conversational continuity across asynchronous events.
If input or output stalls, the system should treat it as a failure and initiate       In a production voice agent, reasoning coordinates thought, action, and
recovery. Where possible, fallback responses or alternate synthesis paths             response within a continuous conversational loop.
should preserve conversational continuity.                                            From Conversation to Decision
The goal is not perfect uptime but resilient interaction. Even under failure,         Effective voice agents deliberately separate interpretation from execution.
the agent should remain state-aware, transparent, and responsive.
                                                                                      The model’s role is to understand intent and decide what should happen.
Synthesis: Building Resilient Interaction                                             Deterministic systems handle how it happens. Business rules, validation,
Interaction architecture is where voice UX becomes real. A production agent           permissions, and side effects belong in code. Open-ended interpretation,
                                                                                      ambiguity resolution, and language generation belong in the model.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                                30

Most modern architectures therefore follow a Think → Act pattern:        At a conceptual level, the flow looks like this:
•	Think: Interpret the user’s intent and decide whether a response
requires action.
•	Act: Execute that action deterministically and return results to        #     Pseudocode illustrating Think → Act orchestration
the conversation.        on_user_end_of_turn(transcript):
    decision                                                                          = llm.think(
Deepgram’s Voice Agent API formalizes this separation by combining                   input=transcript,
streaming transcription, contextual history, and structured function        )        context=conversation_state
calling inside a real-time orchestration loop. The result is a system
where language models express intent, but execution remains controlled,        if decision.type == “function_call”:
auditable, and interruptible.        emit_state(“AgentThinking”)
                                                                                     result =           execute_function(
                                                                                     name=decision.name,
Function Calling as the Action Interface                                             args=decision.arguments
Function calling is the primary mechanism that allows a voice agent to act in    )
the real world. Rather than generating free-form text instructions, the model    update_context(decision,         result)
    speak(
emits structured requests that the orchestrator executes against external            llm.respond(
systems such as databases, APIs, or device controls.                                 context=conversation_state
                                                                                     )
This design turns the voice agent into an interactive system rather than a       )
conversational endpoint. The model decides which action to take and with        else:
what parameters. The orchestrator decides when, whether, and how that        speak(decision.text)
action is executed.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                            31

This pattern highlights several opinionated principles:                         This interruption-first design prevents stale responses, reinforces user control,
•	The model never executes side effects directly                                and preserves conversational trust. Long-running or asynchronous actions
•	Every action has a clear request and response boundary                        should always be cancelable or safely ignored if they become irrelevant.
•	Results are reintegrated into conversational context before speech            Managing Latency and Perceived Responsiveness
•	The system remains explainable and auditable                                  Tool invocation introduces unavoidable delay. Each function call requires at
                                                                                least two reasoning steps: one to request the action and one to incorporate
Interruption-Aware Reasoning                                                    the result. In voice interaction, unmanaged silence during this gap quickly
Voice agents must remain responsive even while actions are in flight.           degrades user trust.
If a user interrupts mid-task, the system should immediately prioritize         The orchestration layer should therefore manage perception as actively
listening over completion.                                                      as execution:
Architecturally, this means treating user speech as a higher-priority signal     •	If reasoning or execution exceeds a short threshold, inject a brief
than pending actions:                                                            acknowledgment.
                                                                                 •	Treat progress cues as part of conversational flow, not error handling.
on_user_started_speaking():                                                      •	Resume normal speech immediately when results arrive.
cancel_active_action()                                                          Because function calls are discrete messages, they are not inherently
stop_tts_playback()
emit_state(“Listening”)                                                         streamable. Execution should occur atomically, while the conversational layer
                                                                                maintains responsiveness through short, well-timed cues.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                              32

Reliability Under Real-Time Conditions                                             Voice agents should remember what matters, not everything that was said.
Voice agents stress reasoning systems more than text benchmarks suggest.           Retrieval and Grounded Reasoning
Long sessions, overlapping turns, noisy input, and repeated tool use increase      For knowledge-intensive domains, retrieval-augmented reasoning grounds
prompt complexity and error risk over time.                                        responses in verified data. In voice systems, retrieval belongs in the
Production systems should explicitly evaluate:                                     orchestration layer, not embedded directly in model prompts.
•	Correctness of function selection and arguments                                  When retrieval is needed:
•	Stability under interruption and cancellation                                    •	Fetch small, high-relevance snippets
•	Time to first spoken response after user turn completion                         •	Keep retrieval latency low
•	Consistency across long, multi-turn conversations                                •	Cache frequent queries
                                                                                   •	Inject results into the next reasoning step
Determinism matters more in voice than in chat. Lower decoding temperature         Deepgram’s Voice Agent API integrates cleanly with external retrieval systems
for transactional flows. Track state explicitly in code rather than relying on     through structured function calls, allowing agents to reason over live enterprise
probabilistic memory. Log every decision boundary to support debugging,            data without sacrificing real-time responsiveness.
replay, and audit.
Memory and Context Management                                                      Building a Coherent Reasoning Loop
Conversational coherence depends on disciplined context management.                The reasoning and orchestration layer defines how a voice agent thinks and
Short-term memory should retain recent turns and relevant function results.        acts in real time. It governs how intent becomes execution, how actions remain
As sessions grow, older content should be summarized or pruned to preserve         interruptible, and how conversational state stays coherent under latency and
context limits without losing intent. Function call history can be retained        uncertainty. When this layer is well designed, the agent feels responsive,
explicitly, allowing the agent to reference prior outcomes naturally.              deliberate, and in control.
Long-term memory requires external storage. Persist only what is necessary,
such as preferences or identifiers, and re-inject selectively at session start.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE 33

However, all of this reasoning ultimately operates within a delivery environment Building a production-grade phone agent requires more than connecting
that imposes its own constraints. For many production deployments, that speech models to a phone number. It requires a runtime that can bridge
environment is telephony. legacy telephony systems with modern, event-driven voice orchestration
Phone networks introduce additional complexity: constrained audio formats, while preserving natural conversational flow.
strict timing expectations, call setup and teardown semantics, regional routing,
and reliability requirements that differ fundamentally from browser or device-
based voice interactions. These constraints shape how audio is streamed, how
interruptions are detected, and how orchestration must behave at the edges
of the system.
In the next section, we examine telephony architecture for voice agents.
We explore how real-time voice systems integrate with PSTN and SIP
infrastructure, how call state and media streams interact with conversational
loops, and what architectural patterns are required to deliver natural, low-
latency voice agents over the phone at scale.
Telephony     Runtime     Architecture
Telephony remains one of the most demanding environments for real-
time voice agents. Inbound customer support, outbound automation,
and compliance-sensitive workflows still rely heavily on PSTN and SIP
infrastructure. Unlike browser or device-based voice, telephony introduces
strict constraints around audio format, latency, session control, and call
lifecycle management.

    CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                              34

    Bridging PSTN to Real-Time Voice Systems                                           From that point forward, the call behaves as a continuous streaming session:
    A typical telephony flow begins when a caller dials a number managed by a          The telephony provider acts as a media bridge, converting PSTN audio
    provider such as Twilio. The provider terminates the PSTN call and establishes     into packetized frames and routing synthesized speech back into the call.
    a bidirectional media stream, commonly via WebSocket, between the live call        Each session is identified by a unique call or stream identifier, which
    and a voice-agent runtime.                                                         must be preserved on all inbound and outbound media to avoid
                                                                                       cross-call contamination.
                                                                                       Deepgram’s Voice Agent API is designed to sit directly behind this gateway,
                                                                                       receiving and emitting audio streams while coordinating transcription,
        Caller                                                                         reasoning, and synthesis as a single real-time loop.
      PSTN/SIP                                                                         Audio Format and Latency Constraints
 Bidirectional Audio                                                                   Telephony audio operates at 8 kHz, mono, using μ-law or A-law PCM. This
                                                                                       limited bandwidth places a hard ceiling on acoustic fidelity and slightly
  Telephony Gateway                                                                    increases recognition difficulty compared to broadband sources.
     E.g. Twilio                                                                       The most important optimization is format alignment. Avoid transcoding
                                                                                       wherever possible. Deepgram’s speech models accept μ-law PCM natively,
      WebSocket                                                                        and its TTS can emit μ-law audio directly consumable by telephony gateways.
Bidirectional Stream                                                                   Eliminating format conversion removes unnecessary latency and reduces
                                                                                       failure modes.
 Voice Agent Runtime                                                                   Even with optimal alignment, PSTN interactions typically add
STT + Reasoning + TTS                                                                  100–200 milliseconds of round-trip delay. The best mitigation strategy
                                                                                       is regional proximity:

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                          35

•	Match telephony media regions with speech infrastructure regions             Recognition, reasoning, and synthesis operate independently but are
•	Co-locate orchestration middleware with both                                 synchronized through events. Signals such as “user stopped speaking,” “agent
•	Minimize inter-region hops between gateway, agent runtime, and LLM           started speaking,” and “audio playback completed” anchor conversational timing
                                                                               and allow orchestration logic to manage fillers, interruptions, and state transitions.
Telephony UX lives or dies on perceived responsiveness. Every avoidable        Deepgram’s Voice Agent API surfaces these lifecycle signals explicitly, allowing
millisecond matters.                                                           telephony runtimes to remain reactive rather than polling-based.
Asynchronous Streaming and Event Coordination                                  Barge-In, Interruption, and Playback Control
Phone-based agents must send and receive audio concurrently. Blocking          Telephony users interrupt frequently. A phone agent that cannot stop speaking
pipelines introduce dead air, clipped speech, or missed interruptions.         immediately when the caller interjects feels broken.
A robust telephony runtime uses non-blocking, event-driven loops for media     Barge-in must be enforced at two levels:
ingress and egress:                                                           •	Media: Stop or mute outbound audio the moment inbound speech resumes
                                                                              •	Logic: Cancel or invalidate any pending reasoning or tool execution
async def receive_media(ws, inbound_queue):                                    In integrated runtimes, interruption is automatic. In custom telephony stacks,
async  for frame     in ws:
await  inbound_queue.put(frame)                                                inbound audio energy or speech detection should immediately preempt
async def send_media(ws, outbound_queue):                                      playback and return the system to a listening state. Playback confirmation
while  True:                                                                   events are essential to ensure buffers are reset cleanly before the next
       frame =     await outbound_queue.get()                                  response begins.
       await ws.send(frame)

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                                36

DTMF and Call Control                                                                More advanced scenarios keep the AI present as an assistant while a human
Although speech-first interaction is preferred, telephony environments still         joins. These require strict separation of inbound and outbound streams to
produce keypad input. DTMF tones should be detected explicitly and handled           prevent cross-talk. The AI should never inject speech into the caller’s channel
outside the speech pipeline so they do not pollute transcripts.                      unless explicitly authorized.
Use DTMF sparingly and deterministically. Numeric shortcuts such as “Press           Agent-assist architectures benefit from the same real-time transcription and
0 for an operator” should route cleanly into call-control logic while preserving     orchestration capabilities, but the conversational contract changes. The AI
conversational continuity for speech interactions.                                   listens continuously and advises silently rather than speaking.
Call termination, transfer, and escalation must also be handled explicitly. When     Scaling and Concurrency
a call ends or is redirected, the associated media stream should be closed           Telephony workloads scale horizontally. Each call maps to an independent,
immediately. During transfers, inform the caller verbally, mute audio during the     long-lived streaming session.
transition, and avoid overlapping speech that can cause clipping or echo.
Voximplant’s native connector eliminates custom media infrastructure                 Scaling challenges typically arise in:
requirements for production voice agents across PSTN, SIP, and WebRTC                •	WebSocket concurrency limits
channels. This architecture validates that abstracting telephony complexity at       •	Orchestrator throughput
the platform layer accelerates deployment without sacrificing real-time control.     •	Downstream LLM rate limits
Escalation and Multi-Party Scenarios                                                 Use async runtimes and load balancers that support connection persistence.
In enterprise settings, AI agents frequently hand off to humans. The                 Implement graceful connection draining and backpressure during traffic
simplest pattern is a clean transfer: stop the AI stream and redirect the call       spikes. For critical flows, define fallback behaviors when upstream services
to a new endpoint.                                                                   degrade so callers never experience unexplained silence.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE 37

Monitoring and Quality Measurement
Telephony UX is judged almost entirely by timing and clarity. Measure:
•	End-of-turn to first audio response latency
•	Barge-in success rate
•	Frequency of clipped or interrupted responses
•	Call abandonment during silence
Event-level instrumentation provides the most actionable insight. Tracking
user stop, agent start, and audio completion events across large call volumes
reveals where conversational rhythm breaks down and where optimization
yields the highest return.

Bringing It All Together
Telephony architecture is where legacy voice infrastructure meets modern
real-time AI systems. Success depends on disciplined media handling, explicit
event coordination, and interruption-first design.
When engineered correctly, the underlying complexity disappears. The caller
experiences not a stitched-together system, but a responsive, conversational
agent that behaves naturally despite the constraints of PSTN. That illusion is
the benchmark of a production-ready telephony voice agent.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                             38

Multilingual   Strategies     and     Localization                                that responds in Spanish, then seamlessly switches to French if the user
                                                                                  changes languages mid-conversation.
As voice agents expand globally, multilingual support becomes a system-level      Language-specialized conversational streams: Some helpdesk or customer
concern rather than a feature add-on. Language choice affects every layer of      support systems require users to choose their language upfront. Once
the stack, including speech recognition, reasoning, synthesis, orchestration,     selected (e.g., Japanese), the voice agent uses a Japanese-specialized model
and UX. Successful multilingual agents balance accuracy, latency, cultural        for all understanding and response generation in that session.
alignment, and operational simplicity.
The core challenge is preserving conversational continuity and persona while      Unified multilingual streams prioritize continuity. They avoid disruptive mid-
adapting to linguistic and regional variation in real time.                       conversation transitions, simplify orchestration, and handle moderate code-
                                                                                  switching naturally. Language-specialized streams can optimize accuracy or
Language Strategy and Conversational Architecture                                 cost in long-running interactions, but introduce additional complexity around
                                                                                  transition, state management, and UX consistency.
Multilingual voice agents typically follow one of two conversation-level          Deepgram’s platform supports both approaches, allowing teams to choose
strategies:                                                                       based on product requirements rather than model constraints. In practice, real-
•	Unified multilingual conversational streams, where a single real-time           time voice agents benefit most from minimizing disruption. Continuity usually
stream supports multiple languages dynamically                                    matters more than marginal accuracy gains unless regulatory, domain-specific,
•	Language-specialized conversational streams, where the system                   or cost considerations dictate otherwise.
      converges on a dominant language and optimizes for it over time             Klubi’s AI voice agents handle 30,000+ monthly interactions in Brazilian
Examples:                                                                         Portuguese across noisy mobile environments, maintaining 90%+ end-to-
                                                                                  end conversation handling. Their deployment validates that domain-specific
Unified multilingual conversational streams: These are powered by                 terminology accuracy and environmental robustness matter more than raw
a multilingual model that can understand and generate replies in many             WER in production voice-led sales workflows.
languages in the same session. For example, a customer support bot

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE 39

Language Awareness and Adaptive Routing                                           Voice and Persona Consistency Across Languages
Language awareness must emerge early in the interaction, but it should            A multilingual agent should feel like the same character in every language.
remain incremental rather than decisive. In real-time voice systems, language     Inconsistent tone, pacing, or expressiveness breaks trust faster than minor
detection functions as a probabilistic signal that informs orchestration, not     recognition errors.
a hard routing gate that resets conversational state.                             Persona continuity is best achieved by:
Streaming multilingual recognition allows agents to adapt dynamically as         •	Selecting voices with similar tonal characteristics across languages
language stabilizes, without requiring explicit selection or disruptive handoffs.
Early signals can guide response phrasing, acknowledgment style, or              •	Maintaining consistent pacing and turn-taking behavior
escalation logic while preserving turn-taking and conversational rhythm.         •	Treating voice selection as a UX and brand decision, not a technical one
In more complex deployments, language confidence may still influence              Modern speech synthesis systems increasingly support expressive,
downstream behavior, such as:                                                     enterprise-grade voices across many languages. Where native voices are
•	Restricting inference to a known language set                                   unavailable, composable orchestration allows teams to integrate external
•	Gradually specializing speech or reasoning behavior                             synthesis providers while preserving real-time interruption handling and
                                                                                  session control.
•	Triggering human handoff or fallback workflows                                  Language switching mid-conversation should update voice and synthesis
The key requirement is that language-aware behavior enhances                      behavior dynamically without resetting context. The user should experience
responsiveness without breaking timing, interruption handling, or                 adaptation, not reconfiguration.
persona continuity.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE                                                  40

Prompt and Context Localization                                                        Testing, Quality, and Fallback Behavior
Localization is not translation.                                                       Multilingual quality cannot be evaluated by transcription accuracy alone.
Prompts, personas, and system messages should be authored directly in the              Native speakers should assess pronunciation, phrasing, pacing, and cultural
target language. Relying on real-time translation introduces tone drift, syntactic     appropriateness. Each language may require different tuning for response
artifacts, and cultural misalignment that compound over long interactions.             length, acknowledgment patterns, or synthesis speed.
Effective localization requires:                                                       When an unsupported language is encountered, agents should
                                                                                       fail gracefully:
•	Language-native persona definitions                                                  •	A brief explanation in the detected language, when possible
•	Regionally appropriate politeness and formality norms                                •	Optional escalation to a human operator
•	Localized acknowledgments, clarifications, and error handling                        •	Clear acknowledgment rather than silence or confusion
Knowledge grounding must also be localized. If enterprise data exists in one           Graceful degradation preserves trust even when full support
language and the user speaks another, retrieved content should be translated           is unavailable.
and adapted before synthesis to avoid disruptive code-mixing.
Localization is a UX responsibility. Agents feel fluent when they follow linguistic
norms rather than simply translating vocabulary.

CHAPTER 2: SYSTEM DESIGN AND ARCHITECTURE 41

Summary
Multilingual voice agents succeed when language support is designed into
the architecture rather than layered on later. Effective systems prioritize
conversational continuity, persona consistency, and localization over rigid
language pipelines.
Deepgram’s platform supports this approach through real-time multilingual
speech recognition, expressive synthesis, and a composable orchestration
layer that adapts across languages without sacrificing responsiveness.

CHAPTER 3
Deployment
and Runtime

CHAPTER 3: DEPLOYMENT AND RUNTIME                                                    43

Deployment and     Runtime                                      Architecture     Hosting Models     and  Regional
Designing a high-performing voice agent does not end with model quality          Placement
or UX design. Once deployed, success depends on infrastructure: where            Voice agents must run close to users, support different levels of operational
the system runs, how it scales under load, and how it behaves when things        control, and operate reliably across environments. Deepgram supports these
go wrong. Real-time voice systems place stricter demands on infrastructure
than typical web services because latency, interruptions, and downtime are       needs through multiple deployment models, including a fully managed Cloud
experienced directly through conversation.                                       API, single-tenant Dedicated clusters, EU-hosted endpoints for regional data
                                                                                 residency, and self-hosted deployments for private cloud, bare-metal, or
This chapter focuses on performance, availability, and runtime behavior.         restricted environments.
Regulatory, privacy, and governance considerations are addressed separately
in the Compliance chapter.                                                       The Cloud API provides the fastest path to production, with automatic scaling
                                                                                 and global availability managed by Deepgram. Dedicated deployments give
                                                                                 enterprises isolation, custom configuration, and predictable performance. Our
                                                                                 EU-hosted endpoint provides deterministic regional data residency, ensuring
                                                                                 inference and audio processing occur within a defined geographic boundary.
                                                                                 In environments with strict connectivity or security constraints, self-hosted
                                                                                 speech models can run locally while orchestration logic remains under
                                                                                 customer control.
                                                                                 Endpoint proximity is critical for conversational responsiveness. Routing users
                                                                                 to the nearest available speech endpoint can reduce round-trip latency by
                                                                                 hundreds of milliseconds. Telephony gateways, orchestrators, and speech
                                                                                 infrastructure should be co-located in the same region whenever possible to
                                                                                 minimize inter-service hops and preserve conversational timing.

CHAPTER 3: DEPLOYMENT AND RUNTIME                                                    44

Scaling and Concurrency                                                          Resilience    and Graceful     Degradation
Each active voice session maintains long-lived streaming connections for         Real-world reliability is defined not by the absence of failure, but by how
audio input, transcription, and synthesis. While a single session consumes       the system behaves when components degrade. Voice agents should never
modest resources, large deployments must support thousands of concurrent         fail silently.
conversations without degradation.                                               If reasoning or retrieval fails, the orchestrator should acknowledge the issue
Deepgram’s managed speech infrastructure automatically handles                   verbally and recover or escalate. If synthesis fails, a fallback voice or canned
concurrency and scaling for transcription and synthesis workloads. Customer-     audio response should be used. If transcription confidence drops, the agent
managed orchestration and reasoning layers should be designed with similar       should prompt for clarification rather than proceeding with uncertain input.
elasticity, using asynchronous runtimes and stateless gateways to manage         When automated recovery fails, the system should escalate to a human
large numbers of open connections efficiently.                                   operator rather than trapping users in conversational dead ends.
Production systems commonly distribute sessions across a pool of compute         Infrastructure changes should also be non-disruptive. Deploy updates
behind a load balancer, ensuring that no single node becomes a bottleneck.       gradually, drain existing sessions before recycling instances, and allow active
External reasoning components such as LLM APIs may impose rate limits or         conversations to complete cleanly. These practices preserve trust even during
cost constraints, so many deployments tier model usage, reserving larger         maintenance or partial outages.
models for complex turns and using lighter models for routine exchanges.

CHAPTER 3: DEPLOYMENT AND RUNTIME        45

Observability and     Runtime     Visibility        Edge     and     Offline     Deployments
Operational insight is essential for both debugging and optimization. Every        Some environments cannot rely on persistent cloud connectivity.
session should emit structured events capturing transcript segments, timing,       Vehicles, kiosks, and industrial systems may require local inference to
interruptions, and major system transitions. These signals allow teams to        guarantee availability.
correlate infrastructure behavior directly with user experience.        Deepgram supports these scenarios through self-hosted speech deployments
For self-hosted deployments, including those running on AWS SageMaker,        that run STT and TTS models locally while preserving the same streaming
private cloud, or bare-metal infrastructure, Deepgram exposes detailed        interfaces used in cloud environments. These systems often trade model
event-level telemetry for speech activity, which can be integrated directly        breadth for predictability, using constrained vocabularies or lighter models to
into standard observability stacks such as Datadog or CloudWatch. Tracking        maintain responsiveness on limited hardware. While less flexible than cloud
metrics like end-to-end response latency, interruption success rates, and        deployments, edge architectures ensure continuity when network access is
session stability enables teams to identify regressions and continuously refine    unreliable or unavailable.
conversational performance.
These same event streams later serve as inputs to audit and governance
workflows discussed in the Compliance chapter.

CHAPTER 3: DEPLOYMENT AND RUNTIME                                                      46

Security as     a     Runtime     Baseline                                         Summary
All real-time voice systems must operate over secure channels. Encrypted           Deployment is where voice UX becomes operational reality. The runtime
transport, short-lived authentication tokens, and strict network isolation are     architecture must balance latency, scale, and resilience without sacrificing
baseline requirements.                                                             availability or responsiveness. With thoughtful regional placement, elastic
Deepgram enforces these controls across its Cloud, Dedicated, and EU-              scaling, and graceful recovery strategies, teams can deploy voice agents that
hosted deployments, while customer-managed components must implement               remain trustworthy and performant in production, regardless of scale
equivalent safeguards. Security establishes the foundation for safe operation.     or environment.
How these controls extend into retention, access governance, and auditability
is addressed in the next chapter.

CHAPTER 4
Operational
Excellence

CHAPTER 4: OPERATIONAL EXCELLENCE                                                        48

Reliability,     Testing, and     Evaluation                                         The goal of reliability testing is therefore not to validate a single
                                                                                     correctresponse, but to measure outcome distributions and improve
Reliability for voice agents is defined by whether the system behaves naturally      their consistency.
under real-world conversational conditions, not by uptime alone. Voice agents        Probabilistic evaluation treats conversational behavior statistically. Teams run
fail in experiential ways: replies that start too early, pauses that stretch too     many sessions under controlled variation such as accents, noise, or speaking
long, or responses that technically answer but miss intent. Ensuring reliability     cadence and measure how often the agent behaves acceptably. This approach
requires validating not just correctness, but conversational behavior.               reflects real usage and allows systems to be tuned for conversational
Effective testing combines two complementary dimensions. Quantitative                smoothness rather than brittle correctness.
evaluation measures timing, flow, and responsiveness at the event level.
Qualitative evaluation assesses meaning, intent alignment, and task                  VAQI: Measuring Conversational Flow
success. Together, these approaches predict how an agent will feel to
users in production.                                                                 The Voice Agent Quality Index (VAQI) provides a concise way to quantify
                                                                                     conversational responsiveness using three timing behaviors:
Deepgram’s Voice Agent API exposes detailed event telemetry that enables            •	Interruptions (I): how often the agent speaks before the user finishes
precise timing analysis. For large-scale simulation and behavioral evaluation,
teams often pair this telemetry with tools from Coval, which specializes in         •	Missed responses (M): how often the agent fails to respond within a
probabilistic testing and multi-turn agent evaluation.                               defined window after a turn ends
                                                                                    •	Latency (L): elapsed time from UserStoppedSpeaking to
From Deterministic QA to Probabilistic Reliability                                   AgentStartedSpeaking
Traditional QA assumes that identical inputs yield identical outputs. Voice          These metrics are derived directly from event timestamps, making them well
agents violate this assumption by design. Speech recognition, language               suited for automated testing. Improvements in VAQI correlate strongly with
models, and real-time orchestration all introduce variability.                       perceived experience. For example, teams often see measurable gains after
                                                                                     tuning end-of-turn thresholds or optimizing orchestration latency.

    CHAPTER 4: OPERATIONAL EXCELLENCE                                                      49

    Retell AI consistently achieves ~800ms response times with interruption            •	Fault injection: Introduce controlled failures such as delayed reasoning
    handling in production voice agents, demonstrating that sub-second                 or dropped synthesis to confirm graceful recovery.
    responsiveness is achievable at scale when perception, reasoning, and              •	Turn-level diagnostics: Visualize UserStoppedSpeaking to
    synthesis are tightly orchestrated. This validates VAQI latency metrics as         AgentStartedSpeaking intervals and overlay interruption events to
    measurable predictors of conversational quality.                                   pinpoint orchestration bottlenecks.
    In large-scale benchmarks conducted with Coval, Deepgram’s conversational          Well-run teams maintain a fixed library of representative test calls and
    speech models demonstrated faster response onset while maintaining                 enforce tolerance bands, such as maximum acceptable VAQI deltas or
    transcription accuracy under production-like conditions, reinforcing the           missed-response rates, as part of every release cycle.
    importance of timing as a first-class reliability metric.
    Designing Effective Evaluation Programs                                            Qualitative Evaluation and Semantic Accuracy
                                                                                       Timing metrics describe how an agent behaves, but not whether it says
    A comprehensive reliability program blends multiple testing methods, each          the right thing. Qualitative evaluation measures intent alignment, semantic
    revealing different failure modes:                                                 correctness, and tone. Coval supports this layer through a mix of automated
    •	Probabilistic regression: Run many sessions under varied conditions and          checks and human-in-the-loop review.
    compare metric distributions across versions to detect drift.                      Common practices include scenario-based simulations, dialogue-level
    •	Replay testing: Reprocess recorded audio through new builds to isolate           assertions such as required fields in responses, and human review of tone
    timing regressions while holding input constant.                                   or empathy. These methods surface issues that quantitative metrics alone
    •	Load and stress testing: Simulate concurrent sessions and track tail latency     cannot capture, particularly in regulated or customer-facing domains.
rather than averages, since worst-case delays dominate user perception.

CHAPTER 4: OPERATIONAL EXCELLENCE        50

Validating Reliability Before Production
Reliability must be proven before exposure to real users. Testing environments
should mirror production configurations, including telephony codecs,
streaming pipelines, and orchestration logic. New builds should be validated
against baseline metrics and exercised under failure conditions such as
transient network loss or delayed downstream services.
A release should advance only after key indicators such as VAQI, missed-
response rate, and instruction compliance meet predefined thresholds.
Once validated, these same metrics can be monitored continuously in
production to detect drift and guide ongoing optimization.
Reliability begins with evaluation, but it is sustained through measurement.
The next section extends these principles into production observability
and continuous monitoring, ensuring that voice agents remain consistent
as they scale.

CHAPTER 4: OPERATIONAL EXCELLENCE                                                         51

Observability     and Monitoring                                                      In production, these events function as live signals rather than evaluation
                                                                                      artifacts. Tracking the intervals between them allows teams to monitor
Reliability testing validates a voice agent before release. Observability ensures     conversational timing and flow continuously. Aggregated across sessions,
that conversational health holds in production as traffic scales, models              these measurements reveal shifts in responsiveness or turn handling that
evolve, and real-world conditions vary. In real-time voice systems, latency,          warrant investigation.
interruptions, and failures are immediately audible to users, which makes early       A production observability pipeline typically includes:
detection essential.
Observability is concerned with detection and response. Its purpose is to             •	Event instrumentation that emits timestamps and metadata for every user
surface live degradation quickly so teams can investigate, mitigate, or route         and agent turn
traffic appropriately while conversations are in progress.                            •	Metric derivation that computes per-stage latency for speech recognition,
                                                                                      reasoning, and synthesis, as well as end-to-end turn timing
Effective observability turns conversational behavior into operational signals. It    •	Storage and visualization using systems such as Datadog, Grafana, or
exposes emerging issues before users report them and provides the feedback            CloudWatch
loop required to maintain stable performance over time.                               •	Alerting based on sustained deviations, such as rising tail latency or
From Testing Metrics to Live Signals                                                  interruption failures
Many of the same event boundaries used during testing continue to matter in           When tuned correctly, this pipeline functions as an early warning system for
production. These include turn boundaries, reasoning states, and playback             conversational degradation.
transitions emitted by the Voice Agent API, such as UserStoppedSpeaking,
AgentThinking, and AgentStartedSpeaking.

CHAPTER 4: OPERATIONAL EXCELLENCE                                                    52

Monitoring Conversational Behavior                                               Dashboards, Alerts, and SLOs
Infrastructure health alone does not capture the quality of live voice           Dashboards consolidate telemetry into a live operational view.
interactions. Observability must also track how conversations unfold in          Common views include active session volume, latency percentiles,
practice so teams can detect abnormal patterns as they emerge.                   interruption success rates, and error counts. Trend analysis often
Key behavioral signals include:                                                  reveals issues before users experience widespread impact.
•	Barge-in handling, measured by whether the agent stops speaking                Service Level Objectives should express acceptable operational
promptly when the user resumes                                                   bounds for conversational systems, such as:
•	Silence or stall detection, where expected responses fail to arrive within     •	Response latency remaining below a defined percentile threshold
defined time windows                                                             •	Interruption handling success staying within tolerance bands
•	Error distribution across speech recognition, reasoning, and synthesis         •	Error rates remaining below predefined limits
components                                                                       Alerts tied to these objectives exist to trigger operational
•	Session dynamics such as unusually long turns, repeated prompts, or            response. They signal when investigation, mitigation, or traffic
looping behavior                                                                 control actions are required, rather than serving as judgments of
These signals surface deviations from expected interaction patterns that         conversational correctness.
may indicate upstream failures, orchestration regressions, or dependency
issues. Correlating them with latency and error metrics helps teams localize     Logging and Traceability
problems quickly.                                                                Metrics reveal trends, while logs support incident investigation.
                                                                                 Each conversation should carry a unique session identifier that links
                                                                                 transcripts, events, and errors across systems.

CHAPTER 4: OPERATIONAL EXCELLENCE                                                          53

Structured logging enables reconstruction of problematic interactions when             Closing the Loop with Evaluation
diagnosing failures. Logs commonly capture system events such as retries,              Observability supplies real-world signals that inform what should be
timeouts, and function calls, as well as conversational events such as speech          investigated, mitigated, or prioritized for further testing. It does not replace
boundaries and interruptions.                                                          evaluation or testing programs. Instead, it provides continuous input that
Transcript storage used for debugging must follow strict privacy controls.             guides where deeper analysis is required.
Sensitive data should be redacted, logs encrypted at rest, and access                  By feeding production signals back into testing workflows, teams can refine
governed by role-based permissions, as described in the Compliance chapter.            scenarios, adjust thresholds, and focus evaluation efforts on the failure modes
Synthetic and Real-User Monitoring                                                     that matter most in practice.
Production observability benefits from combining synthetic probes with real-           Operational Discipline
user telemetry.                                                                        Observability supports resilience only when paired with operational rigor.
Synthetic monitoring runs scripted sessions on a schedule to validate                  Teams should regularly validate alerting pipelines, rehearse incident response,
baseline system behavior. These probes often reuse representative                      and evolve dashboards as systems change. Deployments should be versioned
scenarios developed during pre-release testing and help catch known                    and metrics tracked alongside build identifiers to preserve traceability.
failure modes early.                                                                   Testing establishes readiness before launch. Observability maintains
Real-user monitoring aggregates signals from live traffic. It captures variability     conversational health during live operation.
introduced by user behavior, network conditions, and external dependencies
that synthetic tests cannot fully simulate.
Together, these approaches provide both predictability and coverage.
Synthetic monitoring confirms expected behavior, while real-user telemetry
surfaces emergent issues.

CHAPTER 5
Compliance
and Governance

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                   55

Compliance     and     Data Control                                                Regional Deployment    and
Operating voice agents responsibly requires protecting user data across            Data Residency
its entire lifecycle, from capture and processing to storage and deletion.         The execution environment of a voice agent determines which regulatory
Compliance functions as an architectural property of the system and must be        frameworks apply. Jurisdictions such as the EU and UK impose strict
designed deliberately.                                                             requirements on where audio and transcripts may be processed and stored.
Many of the mechanisms referenced in this chapter, such as regional isolation,     Regional alignment ensures that audio and transcript data remains subject
secure transport, tokenized access, and event logging, appear earlier as           to the appropriate jurisdictional controls. Managed speech infrastructure
runtime capabilities. In this section, those same mechanisms are treated as        should support explicit regional routing and avoid cross-region processing.
governance controls that define how data is protected, retained, and audited
over time.                                                                         Vida processes hundreds of millions of TTS characters monthly for
Voice agents process sensitive data including live audio, transcripts, and         healthcare voice agents while maintaining HIPAA compliance, achieving
user-specific information. Privacy and security therefore must be enforced         50% cost savings through unified STT+TTS from a single provider. This
deliberately at every layer of the stack. A compliant deployment is defined        architecture demonstrates that compliance and cost optimization reinforce
by how data flows through the system, how long it persists, and how access         each other when vendor consolidation reduces both data exposure and
is controlled.                                                                     integration complexity.

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                                                                                   56

Highly regulated environments often require additional isolation.           Secure Transmission     and                                    Authentication
Single-tenant or region-specific deployments provide stronger
data segregation, clearer audit boundaries, and more predictable            Protecting data in motion and enforcing strict access controls form the
governance. Deepgram supports this model through Dedicated                  foundation of compliance. All real-time audio and transcript traffic should
clusters and EU-hosted deployments.                                         be encrypted using TLS, including secure WebSocket connections. Internal
When external services such as language models or downstream APIs           service-to-service communication should also use encrypted channels.
are involved, their residency guarantees must be evaluated as part          Authentication should rely on short-lived credentials rather than static
of the overall compliance architecture. In environments requiring full      API keys. Deepgram uses token-based authentication with ephemeral
control, self-hosting components within a controlled infrastructure         credentials that expire quickly, limiting exposure if intercepted.
provides the most deterministic guarantees.                                 Long-running sessions should refresh tokens automatically without
The core principle remains consistent. Systems should be designed           extending credential validity windows.
so data remains within the regions where it is legally or contractually     Client applications should avoid embedding long-lived credentials. Backend
required to reside.                                                         services should issue scoped, time-limited tokens following the principle of
                                                                            least privilege across browser, mobile, and device environments. The specific
                                                                            implementation of these controls varies by deployment model and is treated as
                                                                            an operational concern.

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                      57

Data Retention, Redaction,                                                            User Authentication, Consent,
and Minimization                                                                      and Disclosure
Effective compliance places strong emphasis on data minimization.                     When agents handle user-specific data or perform sensitive actions, users
Clear data-retention policies should limit storage to what is strictly necessary,     must be authenticated before proceeding. In telephony environments, this
with deletion or anonymization applied once data has served its purpose. Voice        may involve caller ID verification, PINs, or step-up authentication flows. If
transcripts frequently contain personally identifiable information. Deepgram’s        authentication fails, the agent should restrict disclosures or escalate to a
speech-to-text APIs support model-based PII redaction, allowing sensitive             human operator.
entities to be masked at inference time.                                              Consent and disclosure requirements apply across many jurisdictions. Users
Many organizations choose to avoid storing audio altogether. Deepgram does            may need to be informed that calls are recorded or that they are interacting
not retain audio by default, and storage is opt-in only for specific programs.        with an AI system. Telephony frameworks can deliver standardized disclosures
Other deployments maintain short-lived buffers for quality assurance and              automatically, and agents should identify themselves as AI when asked.
delete recordings automatically. These minimization practices are essential for       Clear disclosure practices reduce regulatory risk and reinforce user trust.
meeting GDPR, HIPAA, and PCI requirements.
When transcripts or logs are stored, they should be treated as confidential
assets. Data should be encrypted at rest, protected by role-based
access controls, restricted through IAM policies, and monitored through
comprehensive access auditing. Storage systems should be private by default.

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                     58

Logging, Auditability,     and     Governance                                        Putting Compliance     into     Practice
Compliance requires verifiable records of sensitive system behavior.                 Compliance for voice agents is achieved through layered controls:
Audit logs should be maintained for actions such as financial transactions,         •	Keep data within the appropriate region
consent capture, and content filtering. These logs should include timestamps,
session identifiers, and relevant metadata, and should be designed to               •	Secure data in transit and at rest
prevent tampering.                                                                  •	Minimize and redact stored information
Audit logs typically reuse the same event streams captured for operational          •	Authenticate users and capture consent
observability, with stricter retention, access controls, and immutability           •	Log sensitive actions for accountability
guarantees applied. This alignment ensures consistency between operational           Deepgram’s platform supports these principles through regional endpoints,
monitoring and compliance reporting.                                                 tokenized authentication, built-in PII redaction, and deployment options such
Access to audit data should be tightly restricted, encrypted at rest, and stored     as Dedicated and EU-hosted runtimes. These capabilities align with common
using immutable or versioned storage where appropriate. Organizations should         enterprise compliance frameworks including SOC 2 Type II, HIPAA, PCI,
maintain documented incident-response and business-continuity plans and              GDPR, and CCPA.
validate them regularly.                                                             Compliance ultimately reflects a design philosophy. Systems built with
Security and compliance operate as continuous processes that evolve                  privacy by default, disciplined data handling, and consistent governance
alongside the system.                                                                controls can operate at enterprise scale while maintaining trust, safety,
                                                                                     and regulatory alignment.

CHAPTER 5: COMPLIANCE AND GOVERNANCE 59

Content Safety and Guardrails
Voice agents operate in open-ended, real-time conversations,
which makes them uniquely exposed to unsafe, sensitive, or out-of-
scope inputs. Unlike traditional software, failures in voice systems
are immediately perceptible and cannot be silently corrected. Once
something is spoken, it cannot be taken back.
Content safety is therefore not an add-on. It is a core systems
responsibility that protects users, organizations, and operators by
enforcing clear behavioral boundaries at runtime.
Effective guardrails operate across three layers: input moderation,
reasoning control, and output filtering. These technical controls
are reinforced by governance processes that track, review, and
continuously refine safety behavior in production.

    CHAPTER 5: COMPLIANCE AND GOVERNANCE    60








    Flagged    Policy
              Response


        Violated Rules                                       Refusal/
User Input    Layer 1:                                       Redirect    Text-to- Spoken
  Audio/        Input                                                     Speech Response
  Speech     Moderation    Layer 2:               Unsafe                 Synthesis
        Clean              Reasoning              Content    Suppress/
                            Control     Layer 3:              Rewrite
        Compliant                       Output
                                        Filtering
                                                             Validated



    Figure 5.1: Three-Layer Guardrails Architecture — Input moderation,
    reasoning control, and output filtering work together to enforce behavioral
    boundaries at runtime.

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                      61

Input Moderation: Controlling What the Model Sees                                     Guardrails should be validated before deployment. Structured regression tests
The first line of defense is filtering user input before it reaches the reasoning     that probe adversarial phrasing, edge cases, and tone ensure that unsafe
layer. Input moderation reduces the likelihood that the model processes               inputs never propagate into production conversations.
content that is abusive, unsafe, or outside its intended domain.                      Reasoning Control: Constraining Model Behavior
Use moderation or classification systems to detect categories such as hate            Even with moderated input, language models require explicit behavioral
speech, explicit content, self-harm, or criminal intent. When input is flagged,       boundaries. These constraints live in system prompts and policy instructions
route the conversation into a policy-compliant handling path rather than              and should be treated as part of the agent’s safety configuration.
passing it directly to the language model.
Common patterns include:                                                              Effective reasoning controls include:
•	Abusive language: respond with a calm boundary, such as “I can help                 •	Refusal rules for violent, illegal, or disallowed requests.
if we keep the conversation respectful.”                                              •	Tone constraints that enforce calm, respectful responses
•	Self-harm signals: provide supportive language and escalate to                      under provocation.
appropriate resources.                                                                •	Instruction protection rules that prevent disclosure of system
•	Illegal or dangerous requests: refuse clearly and redirect without                  or developer prompts.
elaboration.                                                                          Prompts should be versioned, tested, and reviewed like code. High-risk
Deepgram’s speech recognition can accurately transcribe profanity or mask it          applications benefit from approval workflows for prompt changes, ensuring
when required, allowing moderation systems to operate reliably on text output.        that updates do not introduce unintended behavior.
Teams typically pair this with text-based moderation models or classifiers to         Many production systems now adopt layered guardrail architectures, where
cover policy categories across languages and contexts.                                multiple lightweight safety checks evaluate intent, policy compliance, or
                                                                                      hallucination risk in parallel with generation. These supervisory checks
                                                                                      can operate continuously without adding noticeable latency, preserving

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                      62

conversational flow while improving control. Frameworks such as Decagon’s            Voice-Specific Safety Risks
layered real-time guardrails demonstrate how this approach scales in                 Voice introduces safety considerations that do not exist in text-only systems.
production voice environments.                                                       Tone, pacing, and delivery shape how users perceive intent and trustworthiness.
Output Filtering: Controlling What Is Spoken                                         Key voice-specific risks include:
The final and most critical safeguard verifies model output before it is              •	Tone and empathy mismatches that escalate frustration or appear
converted to speech. Because spoken responses cannot be retracted, only               dismissive.
validated text should ever reach the synthesis stage.                                 •	Hallucinated confirmations, where the agent implies an action succeeded
Run each response through a post-generation filter to detect disallowed               before it actually did.
content, sensitive data, or unauthorized disclosures. If violations are detected,     •	Pronunciation errors in TTS that unintentionally resemble offensive language
suppress or rewrite the response before synthesis.                                   Mitigating these risks requires both technical controls and review processes.
Typical safeguards include:                                                          Monitoring user interruptions, sentiment shifts, and post-call feedback often
•	Redacting numeric patterns that resemble payment or identity data.                 surfaces issues that automated filters miss.
•	Masking explicit or unsafe terms.
•	Blocking responses that reference restricted internal data or system state.
This final verification step is essential in voice systems. Even a single unsafe
utterance can undermine trust or create regulatory exposure.

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                      63

Safety Governance and                                                                 When sessions exceed defined risk thresholds, such as repeated violations or
Continuous     Improvement                                                            distress signals, agents should escalate automatically to human operators.
                                                                                      In voice systems, safety is about guiding conversations within clear,
Safety does not end at runtime. Governance processes ensure                           responsible boundaries. Well-designed guardrails protect users while
that guardrails remain effective as models, prompts, and user behavior evolve.        preserving natural dialogue, ensuring agents remain helpful, trustworthy,
Reuse existing observability pipelines to capture moderation events, refusals,        and appropriate as conditions change.
and escalations, tagging them by policy category and outcome. This keeps              Operational Realities:
safety telemetry integrated with operational metrics rather than siloed in            Pitfalls and Success     Factors
separate systems.
Maintain audit logs for every safety intervention and review them regularly to        Building a voice agent that works is only the starting point. Sustained success
identify recurring triggers or emerging patterns. In regulated environments, this     depends on how the system is introduced, adopted, and measured inside an
is often supported by human-in-the-loop review processes.                             organization. Teams that succeed treat voice AI as an operational capability
Some organizations extend governance further with post-conversation                   that evolves over time, not a one-time deployment.
analysis that evaluates completed interactions for policy compliance, tone, and
escalation accuracy. Continuous QA systems, such as Decagon’s Watchtower-             Start with Focused Wins
style monitoring, help close the loop by feeding insights back into prompt            A common failure mode is overreach. Voice agents perform best when they
design, moderation rules, and detection thresholds.                                   begin with a narrow, high-volume workflow that is repetitive and clearly
Guardrails must evolve over time. New forms of prompt injection, indirect             scoped. Tasks like password resets, order status checks, or appointment
requests, and policy evasion appear regularly. Moderation logic and escalation        confirmations are ideal starting points.
criteria should be updated accordingly.                                               Klubi started with a single repeatable workflow—outbound qualification calls in
                                                                                      Brazilian Portuguese—before expanding to post-sales support.

CHAPTER 5: COMPLIANCE AND GOVERNANCE                                                      64

This narrow scope allowed them to tune domain vocabulary and noisy                    Align Humans and Manage Change
environment handling while replacing ~40 human SDRs with continuous AI                Voice agents change how people work, and adoption depends on trust.
operation handling 90%+ of conversations end-to-end.
Constrained use cases allow teams to tune vocabulary, behavior, and                   For employees, position the agent as a tool that removes repetitive work so
integrations without the noise of edge cases. They also deliver visible               humans can focus on complex or high-value interactions. Involve frontline staff
ROI quickly, building confidence and momentum. Most successful voice                  early. Their input improves agent behavior and creates ownership rather than
deployments started with a single domain-specific pilot before expanding into         resistance. Provide simple feedback loops so human agents can flag issues,
broader coverage.                                                                     suggest improvements, or review transferred calls.
Start small, prove reliability, then widen the scope deliberately.                    For customers, transparency matters. Clearly identify the agent as AI and give
                                                                                      it a consistent voice and identity. When users know what they are interacting
Integrate, Then Iterate                                                               with, expectations align and satisfaction improves.
Production voice agents sit at the intersection of telephony, authentication,         Design for Hybrid Operation
backend systems, and analytics. Underestimating integration effort is a               The most durable deployments combine AI and humans. The agent handles
common cause of delay.                                                                what it can, and humans take over when needed.
Plan for multiple tuning cycles. Prompts will evolve. Turn-taking thresholds          Handoffs should preserve context. Passing transcripts or summaries prevents
will need adjustment. Domain vocabulary will improve with real data. Treat the
initial rollout as a pilot, not a finished product. Launch to a limited audience,     users from repeating themselves and reduces frustration. AI can also support
observe real interactions, and refine continuously before scaling.                    human agents by summarizing prior interactions or suggesting next steps,
                                                                                      improving efficiency without removing human judgment.
Stability is achieved through iterative refinement based on real usage, rather        Hybrid systems work because they acknowledge limits and design for
than upfront completeness.                                                            them explicitly.

CHAPTER 5: COMPLIANCE AND GOVERNANCE 65

Measure Incremental ROI                                                         Sustain Momentum
Return on investment builds progressively. Measure coverage, such as the        Most failures are organizational, not technical. Teams that succeed adopt a
percentage of calls handled end to end, alongside efficiency metrics like       crawl, walk, run mindset: start narrow, involve people, measure impact, and
reduced handling time or deflection rate.                                       iterate continuously.
Even partial automation creates value. If an agent completes intake before      Celebrate incremental wins. Treat improvement as ongoing work, not a final
transferring to a human, it still reduces workload and improves throughput.     milestone. Trust in voice AI is earned through consistent, reliable interaction
Track improvements over time and use them to guide expansion.                   over time, one practical improvement at a time.
Progress compounds when each stage is measured and validated.

Optimize for Human Outcomes
Voice automation succeeds when it improves outcomes for people. Highlight
the impact on employees and customers: fewer repetitive tasks, shorter wait
times, and more consistent experiences.
For example, automating hundreds of routine calls per day translates
directly into hours returned to human agents for higher-value work. Share
these results internally to reinforce that the goal is service quality and
empowerment, not replacement.

CHAPTER 6
Applied
Architectures

CHAPTER 6: APPLIED ARCHITECTURES                                                    67

Reference Architectures     (Topologies)                                        This pattern represents the simplest viable architecture for a natural,
                                                                                real-time voice agent: a single, persistent streaming loop that handles
Designing a real-time voice agent is an architectural problem, not a wiring     perception, reasoning, and speech synthesis end to end.
exercise. How audio, reasoning, and synthesis are composed determines           Topology
conversational timing, state coherence, and reliability. Deepgram’s platform
supports multiple deployment topologies, from fully managed streaming loops
to deeply customized, multi-service runtimes.
The following reference architectures illustrate proven patterns across that
spectrum. Each reflects a production-grade implementation and highlights
trade-offs between simplicity, extensibility, and operational control.

Tier 1 – Single-Agent Foundations                                                                  WebSocket
Baseline Voice Agent (End-to-End Streaming Loop)                                    Audio    Bidirectional Stream        Deepgram
                                                                                User      Browser        Voice Agent
Reference Implementation: GitHub                                                    STT + LLM + TTS

CHAPTER 6: APPLIED ARCHITECTURES                                                     68

A lightweight browser client captures microphone audio and opens a secure        When to use it
WebSocket connection to the Deepgram Voice Agent API. Audio is streamed          This pattern is well suited for prototypes, internal tools, and early production
continuously. The agent runtime performs speech recognition, routes              deployments where speed, simplicity, and conversational responsiveness
transcripts to an integrated LLM, and streams synthesized speech back using      matter more than deep system integration.
Aura-2. Playback begins immediately as audio arrives, creating a full-duplex
conversational loop.                                                             Function-Calling / Tool-Use Agent
Because the entire interaction runs over one persistent WebSocket, there is      Reference Implementation: GitHub
no separate backend orchestrator. Conversational state, timing, interruption     This pattern extends a real-time voice agent with external actions and data
handling, and turn management are owned by the managed agent runtime.            access through structured function calls.
The client remains focused on transport, authentication, and playback, using
short-lived JWTs for stateless session control.
This topology prioritizes architectural compression: fewer moving parts, fewer
failure modes, and minimal latency. All conversational intelligence lives in the
agent runtime, while the client acts as a thin edge.

CHAPTER 6: APPLIED ARCHITECTURES    69

Topology









             WebSocket               Function Calls
Audio      Bidirectional    Deepgram    & Results    Backend              Queries
    Client    Stream        Voice Agent        Service                    & Data External APIs/
User     Browser/App        STT + Reasoning + TTS    Function Handlers Datastores

CHAPTER 6: APPLIED ARCHITECTURES 70

Deepgram’s Voice Agent API continues to manage the conversational loop,             When to use it
including streaming speech recognition, turn-taking, reasoning, and TTS.            This topology is ideal when an agent must interact with live systems or perform
When an interaction requires action, the agent emits a structured function call     transactions without breaking the voice session.
rather than free-form text. These events are handled by a backend service
(Flask in this reference implementation), which executes trusted logic and          Tier 2 – Specialized and Localized Agents
returns results to the agent for immediate verbalization.
The backend exposes a small, explicit set of functions such as customer             Domain-Specific Voice Agent (Medical Assistant)
lookup, order status, or scheduling. Each function maps directly to                 Reference Implementation: GitHub
a deterministic handler. The demo uses mock but realistic datasets                  This pattern shows how a general-purpose voice agent can be adapted for
stored as timestamped JSON files to enable repeatable testing without               regulated, domain-specific workflows such as clinical documentation. It
external dependencies.                                                              extends the baseline Voice Agent API topology with domain-optimized speech
This architecture separates concerns cleanly:                                       models and structured reasoning to handle specialized vocabulary, privacy
•	The agent runtime owns dialogue, timing, and state.                               constraints, and downstream data systems.
•	Function definitions constrain what the model is allowed to do.
•	Backend handlers execute side effects and data access.

    CHAPTER 6: APPLIED ARCHITECTURES    71

    Topology










                          WebSocket
                        Bidirectional                                 Clinical Notes
      User        Audio    Stream        Deepgram Voice Agent API    & Patient Context     EMR / Data Store
Clinician/Patient        Browser        Nova 3 Medical + Reasoning + TTS (Optional)        Clinical Records

CHAPTER 6: APPLIED ARCHITECTURES 72

Audio is streamed directly from the browser into the Voice Agent API, where        Topology
Nova-3 Medical provides accurate transcription of clinical terminology and
abbreviations. The resulting text is passed to a reasoning layer that structures
the content into summaries or draft clinical notes suitable for review or export.        User
Optional TTS can be used for confirmations or summaries, though the primary        Language Learner
output is structured text rather than conversational reply.
The key architectural characteristic is domain specialization without                      Audio
orchestration change. The real-time speech loop remains intact, while domain
intelligence is introduced through model choice, prompting, and downstream                 Browser
integrations. The same pattern applies to other regulated domains such as
finance or legal by substituting the speech model and knowledge layer.
When to use                                                                            WebSocket
                                                                                   Real-time Stream
Healthcare or regulated workflows that require high transcription accuracy and    Session & API Proxy
structured outputs, without rebuilding the real-time speech pipeline.              Flask + SocketIO
Language Coach (Multilingual and Localization Pattern)                              Voice Agent API
Reference Implementation: GitHub                                                      Connection

                                                                               Deepgram Voice Agent API
    Nova 3 Multilingual + Aura-2 + LLM

CHAPTER 6: APPLIED ARCHITECTURES                                                     73

This pattern demonstrates linguistic specialization: a multilingual, code-       Tier 3 – Integrated and Distributed Systems
switching voice agent that supports real-time conversation, pronunciation        Telephony Voice Agent (PSTN / SIP Frontend)
feedback, and adaptive responses across languages within a single session.
A browser client streams audio through a thin backend to the Voice Agent         Reference Implementation: Documentation and GitHub
API. Nova-3 Multilingual handles real-time transcription across languages        This pattern connects Deepgram’s Voice Agent API to traditional phone
within one continuous session, enabling natural code-switching without           networks via Twilio Media Streams, enabling real-time, natural conversations
reinitialization. Speech output is generated via Aura-2, with voices updated     over PSTN or SIP.
dynamically as language context changes to maintain persona consistency.
The reasoning layer focuses on corrective feedback and guided conversation
rather than task execution. Because multilingual STT, dynamic TTS switching,
and localized prompting all operate inside the same streaming loop, the
agent preserves timing and conversational flow even as languages change
mid-session.
This architecture directly operationalizes the multilingual strategies described
earlier: unified transcription, adaptive synthesis, and language-aware
prompting coordinated in real time.
When to use
Language learning, global assistants, or cross-market applications that require
seamless multilingual interaction within a single conversation.

CHAPTER 6: APPLIED ARCHITECTURES    74

Topology









          Phone Call                               WebSocket
          8kHz µ-law    Telephony  Twilio Media    Real-time    Async      Voice Agent API  Deepgram Voice
              PSTN/SIP                Stream        Stream      Orchestrator  STT + TTS     Agent API
Caller        Phone Network          WebSocket        Python/
                                      Bridge        Coordinator        Nova 3 + Reasoning
              Server        + Aura-2

CHAPTER 6: APPLIED ARCHITECTURES                                            75

Twilio bridges 8 kHz μ-law audio from the phone network into            When to use
a bidirectional WebSocket stream. The Voice Agent API handles           Inbound or outbound phone agents, IVR modernization, customer support
transcription, reasoning, and synthesis, returning Aura-2 audio         automation, or agent-assist systems that must operate over standard
that Twilio injects directly back into the live call. A small async     telephone infrastructure.
server coordinates inbound audio, outbound playback, and
interruption handling.                                                  Multi-Agent Orchestration (Specialized Agents with Context Handoff)
Key capabilities are built into the topology:                           Reference Implementation: GitHub
•	Low-latency turn-taking with barge-in support                         This pattern scales a single voice agent into a coordinated system
•	DTMF handling for IVR-style interactions                              of specialized sub-agents, each responsible for a distinct phase of a
•	Session-level call control and clean teardown                         conversation. A central orchestrator maintains the live audio stream while
•	Secure, token-based authentication for live streams                   rotating agents behind the scenes.
This architecture modernizes legacy IVR and call-center systems
without requiring custom telephony stacks. It preserves PSTN
compatibility while enabling real-time AI interaction and observability
through streamed transcripts.

    CHAPTER 6: APPLIED ARCHITECTURES    76

    Topology





        Phase 1      Qualifier                                                 Session
        Agent
                                                                      Summarize
                                                                      & Handoff

                     Bidirectional                               2
  Twilio Media Stream    Audio    Call Orchestration    Phase    Advisor       Session     Deepgram Voice Agent API
(Persistent WebSocket)              Manages Phases                Agent                    (Creates session per agent)
Summarize
& Handoff

                                                        Phase    3         Closer      Session
                                                                           Agent

CHAPTER 6: APPLIED ARCHITECTURES                                                       77

A persistent Twilio WebSocket carries audio for the entire call. The               When to use
orchestrator keeps this connection open while creating short-lived Voice Agent     Multi-step interactions such as sales qualification, onboarding, triage,
sessions for each sub-agent. Each agent runs with a focused prompt, limited        or claims processing, where different conversational stages benefit from
toolset, and clear role, then hands off control when its task is complete.         distinct prompts, logic, or success criteria.
Between phases, the orchestrator summarizes the prior exchange and injects         Tier 4 – Low-Level and Edge Implementations
that summary as context for the next agent. This prevents prompt bloat,
isolates failures, and keeps reasoning targeted. Audio streaming continues         Native SDK / Embedded Voice Agent (Rust)
uninterrupted across agent transitions, so the caller experiences a single,        Reference Implementation: GitHub
continuous conversation.
This architecture enables:                                                         This pattern demonstrates a fully custom voice agent built directly on
                                                                                   Deepgram’s WebSocket APIs, without the managed Voice Agent runtime.
•	Explicit phase separation and cleaner reasoning                                  Implemented in Rust, it prioritizes low latency, deterministic control,
•	Controlled context growth through summarization                                  and tight integration with local audio hardware.
•	Easier debugging and evaluation per agent role
•	Flexible composition of complex workflows

    CHAPTER 6: APPLIED ARCHITECTURES    78

    Topology






                       Rust Agent Application

    Capture        CPAL     Audio Stream   WebSocket  Synthesized         Playback
    Microphone     Audio                   Client       Speech  Rodio  (Auto-mute mic)
        Capture                            (Async I/O)          Audio        Speaker
                                                              Playback


    Bidirectional Deepgram WebSocket APIs
    WebSocket Nova-3 (STT) + LLM
+ Aura-2 (TTS)

CHAPTER 6: APPLIED ARCHITECTURES 79

The agent streams microphone audio to Deepgram for real-time transcription          Synthesis: The Architecture Continuum
and reasoning, then plays synthesized speech locally with precise timing.           These reference architectures form a practical continuum:
Audio input and output are handled asynchronously, with automatic
microphone muting during playback to prevent feedback and support natural           Tier     Focus                     Example Patterns           When to Use
turn-taking.
Configuration is explicit and lightweight:                                          1        Unified simplicity        Baseline Agent,            Prototypes and managed
                                                                                                                       Function Calling           agents
•	Listen: Nova-3 (streaming STT)                                                    2        Specialization            Medical Assistant,         Domain or multilingual
•	Think: compact reasoning model                                                                                       Language Coach             systems
•	Speak: Aura-2 voice                                                               3        Integration               Telephony, Multi-Agent     Enterprise workflows
•	Audio: linear PCM with device-level control                                                                          Orchestration
This architecture exposes the full speech pipeline while avoiding unnecessary       4        Performance & control     Native SDK / Edge          On-prem and embedded
abstractions. It is well suited to environments where latency budgets are tight,                                       Agent                      environments
dependencies must be minimal, or cloud-managed runtimes are not viable.
When to use                                                                         Most real-world deployments evolve across tiers. Teams often begin with
                                                                                    a managed, end-to-end agent and progressively introduce custom
Edge devices, kiosks, embedded systems, IVR gateways, or on-prem                    orchestration, telephony, or edge execution as requirements grow.
deployments that require maximum control over audio I/O, threading,                 Deepgram’s APIs and runtime model support this progression without
and runtime behavior.                                                               forcing architectural resets, allowing systems to scale in complexity
                                                                                    while preserving real-time conversational performance.

CHAPTER 6: APPLIED ARCHITECTURES 80

Ecosystem Patterns (Integrations)
The previous section focused on reference architectures owned end to end by
the builder. This section shows how those same architectural principles appear
in ecosystem integrations, where Deepgram provides the real-time speech
layer inside partner-managed orchestration, transport, or enterprise platforms.
Each pattern below represents a distinct integration topology and clarifies how
responsibility is divided between Deepgram and the surrounding system.
VAPI Orchestrated Agent (Managed Platform Topology)
Reference: Vapi documentation

CHAPTER 6: APPLIED ARCHITECTURES    81

Topology








VAPI Platform (Managed Orchestration)    Deepgram SST
                                      Speech Recognition
    Transcription
Caller  Phone Call  Telephony Audio  Workflow Engine
    Logic & Integrations      Synthesis

                                         Deepgram TTS
                                       Speech Synthesis

CHAPTER 6: APPLIED ARCHITECTURES                                                          82

This pattern represents a fully managed orchestration model. VAPI owns        Topology
telephony, dialog flow, state management, and integrations. Deepgram
supplies streaming speech recognition and synthesis as pluggable
components within that workflow.
Audio from the caller is streamed to Deepgram for real-time transcription.                User
VAPI’s workflow engine interprets the text, executes logic or API calls, and then    Capture
invokes Deepgram’s TTS to synthesize the response. Speech is returned to the
caller through the same telephony channel.                                     WebRTC / WebSocket
VAPI's platform demonstrates the managed orchestration model where               Media Transport
telephony, dialog flow, and state management are abstracted, allowing teams
to improve speech accuracy and latency by swapping STT/TTS components                 Audio In    Pipeline Events
without redesigning orchestration. This topology accelerates deployment for
teams prioritizing speed over deep system integration.                       Pipecat Graph Framework
When to use it                                                                        Deepgram STT Node
Teams that want rapid deployment using low-code or no-code tooling,
with minimal infrastructure ownership. This topology allows organizations
to improve speech accuracy and latency by swapping in Deepgram without                LLM Node
redesigning orchestration.

Pipecat Graph Agent (Open Orchestration Topology)                                     Deepgram TTS Node
Reference: Pipecat documentation

CHAPTER 6: APPLIED ARCHITECTURES 83

This pattern uses Pipecat’s open, graph-based orchestration framework.        Topology
Media transport, transcription, reasoning, and synthesis are expressed as
discrete nodes connected in a real-time pipeline. Deepgram appears as the
STT and TTS nodes within that graph.
Developers control the full execution path: partial transcripts, interruption     User
handling, LLM selection, and output routing. Deepgram provides the     Bidirectional Audio Stream
low-latency speech layer, while Pipecat manages media transport and
event coordination.                                                           LiveKit Room
When to use it                                                             SFU & Media Router
Teams that want full transparency and customization of the voice pipeline,            Incoming Audio
including experimentation, research, or advanced orchestration. Ideal for
builders who want modularity without implementing media infrastructure    LiveKit Agent Runtime
from scratch.        Synthesized Audio                                        Deepgram STT
LiveKit Audio Room Agent (Transport Topology)                                 Transcription
Reference: LiveKit documentation
                                                                          Logic Server Response
                                                                               Generation

                                                                                Deepgram
                                                                          TTS Speech Synthesis

CHAPTER 6: APPLIED ARCHITECTURES 84

This pattern centers on LiveKit as the real-time media transport layer.
Conversations occur inside persistent audio rooms, with the AI agent
participating as a peer. Deepgram processes incoming audio for transcription
and generates synthesized speech that is published back into the room.
LiveKit handles participant management, routing, and scalability. Deepgram
provides speech recognition and synthesis. Application logic runs alongside
the agent to determine responses or assist human participants.
When to use it
Multi-party or interactive environments such as meetings, agent-assist, virtual
rooms, or voice-enabled applications where WebRTC transport and low-
latency media routing are already required.
Enterprise Conversational Platforms
(Integrated CX Topology – Kore.ai Example)
Reference: Kore.ai documentation

    CHAPTER 6: APPLIED ARCHITECTURES    85

    Topology









        Kore.ai Platform

Bidirectional    Voice Gateway   Audio              Logic Server   Response  Deepgram
Audio Stream        Stream     Deepgram STT Transcription        Text
    User       Enterprise Voice      Transcription    Response              TTS Speech
                    Channel                          Generation              Synthesis




    Synthesized Audio

CHAPTER 6: APPLIED ARCHITECTURES 86

Enterprise CX platforms like Kore.ai provide full conversational ecosystems     Summary
spanning design tools, analytics, compliance, and CRM integration. In this      Across these ecosystem patterns, Deepgram consistently operates as the
topology, the platform owns orchestration and governance, while Deepgram        real-time speech layer, independent of where orchestration or transport lives.
supplies the speech layer.                                                      Whether embedded in a managed platform, an open graph framework, a
Audio is streamed from the voice gateway to Deepgram for transcription.         WebRTC transport, or an enterprise CX suite, Deepgram provides low-latency
Kore.ai’s NLU and workflow engine determines the response and invokes           transcription and synthesis while adapting cleanly to different architectural
Deepgram’s TTS for synthesis. The reply is delivered through the same           control points.
enterprise voice channel.                                                       These integrations show how Deepgram’s APIs fit naturally at multiple layers
When to use it                                                                  of the voice stack, enabling teams to improve speech performance without
Large organizations already standardized on an enterprise conversational        constraining how the rest of the system is designed.
platform that want to upgrade speech quality and latency without re-architecting
workflows, compliance, or analytics systems.

CHAPTER 7
The Future
of Voice AI

CHAPTER 7: THE FUTURE OF VOICE AI                                                                                                                                  88

The Next Architectural     Shift                                                      Neuroplex is designed around this principle. Internally, it operates on dense
                                                                                      semantic and acoustic representations rather than symbolic transcripts. Input
Voice agents today are built on a modular pipeline: speech-to-text, text-             audio is mapped to output audio through an internal understanding layer,
based reasoning, then text-to-speech. This architecture has scaled well, but it       enabling the system to reason over prosody, emphasis, and timing in ways that
introduces structural inefficiencies. Audio is repeatedly compressed into text        text pipelines cannot.
and expanded back into speech, discarding expressive signals such as tone,            This approach enables several structural advantages:
pacing, and emotion along the way.
Deepgram’s Neuroplex research explores the next architectural shift: speech-          •	Lower latency: Fewer handoffs allow the system to begin formulating
to-speech (S2S) systems that listen, reason, and respond directly in audio.           responses while still listening, supporting overlap and natural turn-taking.
Instead of treating text as the primary interface between perception and              •	Contextual robustness: Meaning is refined dynamically rather than
generation, Neuroplex operates on continuous representations of speech,               committed early to a fixed transcript.
preserving meaning beyond words alone.                                                •	More natural interaction: Interruptions, backchannels (“mm-hmm”),
In a traditional pipeline, the phrase “I guess so” produces the same transcript       and partial utterances are modeled as learned behavior rather than
regardless of whether it is spoken hesitantly, sarcastically, or enthusiastically.    hard-coded rules.
A speech-native architecture retains those distinctions through the reasoning         Early S2S systems have demonstrated promise, but many struggle in
step, allowing responses to reflect emotional and conversational context rather       production. Common issues include opaque behavior, limited steerability,
than just lexical meaning.                                                            policy violations, and difficulty debugging failures. Neuroplex addresses these
                                                                                      constraints by combining end-to-end continuity with modular control.

CHAPTER 7: THE FUTURE OF VOICE AI                                                             89

                                                                                         Neuroplex Architecture Overview
                                                                                          •	Neuroplex is end-to-end trainable but modular by design.
                                                                                         It preserves speech continuity while exposing control points required
                                                                                         for production systems.
"Hello" 15,000 times         "Hello" 15,000 times                                        Core architectural elements include:
in Current Architectures     in Neuroplex Architectures                                   •	Adapter-based composition
                                                                                         Speech encoders, reasoning models, and speech decoders are connected
                                                                                         via learned adapters. These adapters translate internal representations
                                                                                         without emitting intermediate text, preserving acoustic and semantic
                                                                                         features across modules.
                                                                                          •	Continuous latent flow
                                                                                         Conversations exist as dense vector streams that carry prosody, emphasis,
                                                                                         and emotional tone across turns.
Figure 1: Different acoustic realizations of the same word occupy distinct regions in     •	Inspectable internals
Neuroplex's latent space, preserving nuance that text collapses into a single token.     Each module can emit debug artifacts, enabling developers to inspect
                                                                                         latent states, reasoning signals, or alignment decisions (capabilities largely
                                                                                         absent from black-box S2S models).

CHAPTER 7: THE FUTURE OF VOICE AI 90

•	Steerable generation
Despite operating end-to-end, Neuroplex supports structured guidance
for tone, intent, and policy compliance through conditioning interfaces
rather than brittle prompt hacks.
•	System-level optimization
The training objective targets end-to-end conversational quality rather
than isolated metrics like WER or MOS, aligning perception and generation
as a single system.










Figure 2: Neuroplex architecture showing the modular pipeline from input audio to response
audio. The system consists of specialized components (Feature Extractor, ASR, LLM,
Text2Codes, Codes2Audio) connected by learned adapters (ASR2LLM, LLM2T2C). Debug
tokens can be extracted at multiple stages for model inspection.

CHAPTER 7: THE FUTURE OF VOICE AI                                                              91

Challenge in Current S2S Systems     Neuroplex Design Response        Implications for Builders
                                     Prior context is abstracted; only the active turn    As S2S architectures mature, the developer experience for voice agents will shift
Latency grows with context size      runs at full resolution        in several ways:
                                     Full-scale reasoning models remain in the loop       •	Audio-to-audio abstractions
Weak instruction following           via adapters                                          Developers may no longer manage transcripts as the primary interface.
                                                                                           Audio streams enter the system and audio streams return, while control
Unpredictable speech output          Acoustic decoding is conditioned and controllable     logic focuses on knowledge, actions, and constraints rather than plumbing.
Opaque failures                      Internal states and transitions are inspectable      •	Reduced orchestration complexity
                                                                                           Language switching, barge-in handling, and turn detection can be learned
High compute cost                    Specialized components handle distinct                behaviors rather than explicit logic, reducing integration surface area and
                                     workloads                                             failure modes.
                                                                                          •	Richer persona control
Neuroplex is a speech-native framework that balances fluidity with control,                Acoustic style vectors enable consistent tone and affect, such as
enabling continuous listening, thinking, and speaking without sacrificing                  maintaining calm authority or empathetic reassurance, without embedding
enterprise-grade reliability.                                                              fragile instructions in prompts.
                                                                                          •	New evaluation methods
                                                                                           Perceptual listening tests and conversational quality metrics will complement
                                                                                           logs and transcripts as primary evaluation tools.

CHAPTER 7: THE FUTURE OF VOICE AI 92

•	Evolving deployment models
S2S systems are compute-intensive and will initially favor cloud or
specialized accelerators. Traditional ASR will remain appropriate
for lightweight tasks, while interactive agents benefit most from
speech-native reasoning.
•	Converging skill sets
Teams previously split across ASR, TTS, and dialogue design will
increasingly work within unified speech model workflows that span
acoustic and semantic optimization.
Neuroplex reflects a broader transition in voice AI: moving beyond text
as the organizing abstraction for conversation. Rather than removing
developer control, it redefines it by aligning system design more closely
with how humans listen, interpret, and respond in real dialogue.
The long-term goal is clear: approach the Audio Turing Test, where
machine and human conversation become indistinguishable.
Neuroplex is Deepgram’s architectural blueprint for that future.
Learn more: Read the full Neuroplex technical whitepaper for
detailed architecture, benchmarks, and research findings.

CHAPTER 8
Getting Started

CHAPTER 8: GETTING STARTED                                                          94

Recap:  A  Practical     Framework                                              •	Applied architectures: Real-world deployments span managed agents,
for Voice  Agents                                                               function-calling systems, telephony integrations, multi-agent orchestration,
                                                                                and edge runtimes.
This guide has focused on how modern voice agents are designed, deployed,       •	The future: Speech-native architectures like Neuroplex point toward
and operated in real production environments. The final step is turning that    end-to-end voice intelligence, where listening, reasoning, and speaking
understanding into a working system.                                            converge into a single loop.
Voice agents are becoming a core interface for customer support, internal       The central takeaway: real-time voice agents are now buildable without
automation, and real-time assistance because speech is fast, natural, and       custom infrastructure. Platforms like Deepgram abstract the hardest problems
increasingly reliable at scale.                                                 in streaming speech, allowing teams to start small and evolve toward more
                                                                                advanced architectures as requirements grow.
Throughout this guide, we established a clear framework:                        Deepgram’s role is intentionally infrastructural. We provide fast, accurate
•	Foundations: A voice agent operates as a continuous loop of listening,        perception, natural synthesis, and a unified runtime through the Voice Agent
understanding, reasoning, and speaking. High-quality perception                 API, with deployment options ranging from cloud to dedicated and on-prem.
(streaming STT), fast reasoning, and low-latency synthesis must work            You bring the logic, workflows, and experience design.
together to feel conversational.
•	System design: Natural interaction depends on turn-taking, interruption
handling, multi-turn context, tool use, telephony integration, and
multilingual support.
•	Operational excellence: Production agents require reliability testing,
observability, data controls, and safety guardrails to remain performant
and trustworthy over time.

CHAPTER 8: GETTING STARTED                                                                                                                                     95

Choosing     Your     Build     Path                                                For Enterprise Evaluators
Different teams start from different places. The path forward depends               Voice agents should integrate into existing CX and analytics ecosystems, not
on your goals, constraints, and appetite for control.                               replace them. Deepgram works across telephony, WebRTC, open orchestration
                                                                                    frameworks, and enterprise conversational platforms, allowing teams to
For Developers                                                                      modernize voice interactions without re-architecting upstream systems.
Start with a minimal, working loop. Sign up for a free account to create an API     Most organizations begin with a proof of concept, then scale after validating
key, then try the Voice Agent Playground to test a live agent in your browser.      performance, cost, and governance requirements. Contact us to plan your
When ready to build, follow the Voice Agent API quickstart to stream audio          enterprise POC.
and hear responses in real time. Explore reference implementations such             Your Open     Build     Path
as the baseline agent, function-calling demos, or multi-agent prototypes to
understand how perception, reasoning, and synthesis interact under streaming        No matter how you choose to start, you are not locked into a single vendor,
conditions. Begin with a single task, then layer in tools, memory, or telephony     abstraction level, or architecture. Deepgram’s ecosystem is designed for
once the fundamentals feel intuitive.                                               modularity and evolution. Teams often begin with a managed platform to
                                                                                    validate experience and latency, then migrate to the Voice Agent API for
For Architects and Product Leaders                                                  deeper customization, or build directly on STT and TTS for maximum control.
Identify a focused workflow where voice delivers immediate value, such as           Across these paths, Deepgram serves as the consistent real-time speech
scheduling, intake, or support deflection. Use the architectural patterns in        layer. You can integrate with VAPI for rapid prototyping, Pipecat for open
this guide to define system boundaries, latency targets, and success metrics.       orchestration graphs, LiveKit for real-time audio transport, or enterprise
Early attention to compliance, routing, and scale prevents rework later. Pilot      CX platforms for production workflows. The architecture is yours to design.
narrowly, validate outcomes, then expand deliberately. Contact our team to          Deepgram provides the streaming speech intelligence that makes it reliable,
discuss your deployment strategy or explore pricing options.                        low latency, and production-ready.

CHAPTER 8: GETTING STARTED                                                                  96

Take the     First     Steps                                                            The guide may end here, but the system you build does not. Start with one
                                                                                        workflow. Iterate deliberately. Evolve the architecture as requirements grow.
Start small and make it tangible. The fastest way to build intuition is to interact     Join the Deepgram community for ongoing support, technical discussions,
with a live system:                                                                     and to connect with other builders.
Try it now:                                                                             Happy building. We’re excited to see what you build as you shape the future
    • Voice Agent Playground – Test a complete voice agent in your browser              of voice AI with Deepgram.
    • Flux Playground – Experience conversational turn-taking
    • Aura-2 Playground – Hear expressive text-to-speech synthesis
Once you’ve experienced the system live, spin up a sample application, adapt
it  to your domain, add a single tool or function call, and expand from there.
When you are ready to go deeper, request a design review or deployment
consultation. Whether you are validating a prototype, planning a telephony
rollout, or evaluating Dedicated or region-specific deployments, Deepgram
provides the documentation, architectural guidance, and infrastructure to
support each stage.
Voice AI has reached a point where natural, low-latency conversation is no
longer speculative. The remaining work is architectural and experiential:
shaping timing, behavior, and trust in real environments. You now have the
frameworks to do that well.

CHAPTER 9

Appendices

CHAPTER 9: APPENDICES                                                                   98

The appendices provide supporting reference material: a glossary of key terms,      Deepgram Voice Agent API
API endpoints and parameters for common Deepgram features, and diagnostic           A unified WebSocket API that manages the real-time conversational loop,
guidance to help identify the architectural layer responsible for common voice      including streaming STT, integrated LLM reasoning, and streaming TTS
agent failures.                                                                     playback, with support for function calls. It exposes event signals and accepts
Glossary     of     Key     Terms                                                   runtime configuration updates during a session. Serves as both the speech
                                                                                    layer and orchestration runtime, eliminating the need for custom real-time
ASR (Automatic Speech Recognition)                                                  coordination logic. View API Reference
Technology that converts spoken audio into text, also referred to as STT            Barge-in
(Speech-to-Text). Deepgram ASR models include Nova-3 for multilingual               The ability for a user to interrupt the agent while it is speaking, requiring
transcription and Flux for conversational speech with rapid turn detection.         immediate suppression or stopping of TTS output to maintain natural
CSR (Conversational Speech Recognition)                                             turn-taking.
A dialogue-optimized form of ASR that supports partial results, barge-in            Cascade Architecture
detection, and accurate end-of-turn identification during natural conversation.     The traditional voice agent architecture that converts
Deepgram’s Flux is the primary implementation of CSR in the platform.               speech→text→reasoning→text→speech sequentially. Contrasts with
LLM (Large Language Model)                                                          speech-to-speech (S2S) systems like Neuroplex that operate on continuous
A Transformer-based model that performs reasoning in a voice agent,                 audio representations.
interpreting transcribed speech and determining the next conversational             Latency (Response Latency)
action or response.                                                                 The elapsed time between the end of a user’s utterance and the start of the
TTS (Text-to-Speech)                                                                agent’s spoken reply, spanning ASR, reasoning, and TTS stages.
Technology that synthesizes spoken audio from text. Deepgram’s Aura-2
provides real-time speech generation with multiple voice styles and languages.

CHAPTER 9: APPENDICES                                                                                                                                        99

VAQI (Voice Agent Quality Index)                                                 Neuroplex
A composite metric proposed by Deepgram to evaluate conversational               Deepgram’s research architecture for speech-to-speech intelligence, connecting
smoothness, incorporating latency, interruption handling, and                    ASR, LLM, and TTS through a shared latent representation to preserve acoustic
missed-response rates.                                                           nuance and conversational expressiveness.
WebSocket                                                                        Dedicated Deployment
A protocol for full-duplex communication over a single TCP connection,           A single-tenant instance of Deepgram’s platform deployed in a customer-
enabling bidirectional audio streaming between clients and voice agent           controlled environment to meet security, compliance, or regional
services in real time.                                                           governance requirements.
Function Call (LLM Function Calling)                                             DTMF (Dual-Tone Multi-Frequency)
A mechanism by which an LLM emits structured JSON to request an external         Keypad tones generated when users press phone keys. Voice agents should
action, such as a database lookup, before continuing the conversation with       detect and handle DTMF separately from speech to avoid transcript pollution.
updated context.                                                                 EagerEndOfTurn / TurnResumed
Full-Duplex                                                                      EagerEndOfTurn is a medium-confidence signal from Flux that the user may
Simultaneous bidirectional communication allowing the voice agent to receive     be finished speaking, enabling speculative reasoning. TurnResumed indicates
user audio while playing agent speech. Required for natural barge-in and         the user continued speaking after an eager end, triggering cancellation of
interruption handling.                                                           speculative work.
IVR (Interactive Voice Response)                                                 Event-Driven Architecture
Traditional menu-driven phone systems using prerecorded prompts and DTMF         An architectural pattern where system components react to asynchronous
input. Modern voice agents replace or modernize IVR systems with natural         events (e.g., speech start, turn end, interruption) rather than polling state.
language interaction.                                                            Essential for responsive voice agent behavior.

CHAPTER 9: APPENDICES                                                                      100

Redaction (PII Redaction)                                                              Streaming vs Batch
The masking or removal of sensitive information from transcripts,                      Streaming processes audio incrementally and emits results in real time. Batch
such as payment data or personal identifiers, to support privacy and                   processes complete audio after recording ends. Voice agents depend on
regulatory compliance.                                                                 streaming operation, as batch processing introduces unacceptable latency for
Partial vs Final Transcript                                                            conversational UX.
Partial transcripts are interim ASR outputs produced while the user is still           Speech-to-Speech (S2S)
speaking. Final transcripts are confirmed at the end of an utterance. Also             An emerging architecture that processes audio directly without text
referred to as “interim” and “final” results in some speech recognition systems.       intermediaries, preserving prosody and emotional context. Deepgram’s
Partial results enable earlier reasoning and lower perceived latency.                  Neuroplex represents this next-generation approach.
PSTN (Public Switched Telephone Network)                                               Utterance
The traditional circuit-switched telephone network. Voice agents integrate with        A continuous segment of speech from one speaker, ending when the speaker
PSTN through telephony gateways to handle standard phone calls at 8 kHz                yields the conversational turn.
audio quality.                                                                         NLU (Natural Language Understanding)
Turn (Conversation Turn)                                                               Traditionally refers to intent and entity extraction. In modern voice agents, LLM-
A single exchange in a dialogue, typically consisting of a user utterance followed     based reasoning often replaces standalone NLU, though hybrid systems may still
by an agent response, coordinated through speech-boundary events.                      incorporate both.
STT vs ASR                                                                             Orchestration
Both refer to speech-to-text conversion. ASR is the broader technical term, while      The coordination layer that manages timing, state, and data flow between
STT describes the functional capability.                                               speech recognition, reasoning, and synthesis components in real time. Critical
                                                                                       for maintaining conversational rhythm and handling interruptions.
                                                                                       This glossary is intended as a reference for terminology used throughout
                                                                                       this guide.

CHAPTER 9: APPENDICES                                                               101

Quick Reference:     Deepgram                                                   Conversational STT optimized for fast, reliable end-of-turn detection
APIs and     SDKs                                                               and natural pauses.
                                                                                Try it: Flux Playground
This section summarizes the Deepgram APIs and features most commonly            Typical use: Voice agents with barge-in, natural turn-taking, and fast
used when building real-time voice agents.                                      response loops.
Realtime Speech-to-Text (STT)                                                   When to use Flux: Use Flux (`/v2/listen`) for real-time voice agents that require
                                                                                conversational turn-taking. Use regular streaming STT (`/v1/listen`) for non-
Realtime Streaming STT (Non-Flux)                                               conversational use cases like live transcription, analytics, or when implementing
Endpoint: `/v1/listen`                                                          custom turn detection.
Low-latency streaming STT over WebSocket or SDKs. Emits interim and final       Common params:
transcripts with optional word timing and diarization.                          model=flux, language, encoding, sample_rate, eot_threshold, eager_eot_
                                                                                threshold, eot_timeout_ms
Typical use: Live transcription, telephony, analytics, agent observability.     Flux Events:
Common params:                                                                 •	StartOfTurn - user begins speaking for the first time in the turn
model=nova-3, language, encoding, sample_rate, punctuate, diarize,
smart_format                                                                   •	Update - periodic transcript updates
Conversational STT – Flux                                                      •	EagerEndOfTurn — medium-confidence end (speculative)
Endpoint: `/v2/listen`                                                         •	TurnResumed — user continued after eager end
                                                                               •	EndOfTurn — high-confidence end of user speech

CHAPTER 9: APPENDICES                                                       102

Text-to-Speech (TTS)                                                   Key Event Types (Examples)
Text-to-Speech API                                                      •	Welcome – session initialized
Endpoint: `/v1/speak`                                                   •	SettingsApplied – configuration active
Generates audio from text using Aura voices. Supports streaming and     •	UserStartedSpeaking – speech detected
non-streaming output.                                                   •	ConversationText – user or agent text
Try it: Aura-2 Playground                                               •	AgentThinking – LLM processing
                                                                        •	AgentStartedSpeaking / AgentAudioDone – agent audio lifecycle
Common params:                                                          •	FunctionCallRequest / FunctionCallResponse – tool execution
model=<model-voice>, encoding=<audio-encoding>, sample_rate=<Hz>        •	AgentWarning / AgentError – runtime issues
Voice Selection:                                                       Runtime Updates
•	TTS: voice=<voice_id>
•	Voice Agent: agent.speak.voice=<voice_id>                            Supports mid-call updates to models, prompts, voices, and tools via
                                                                       configuration events (no reconnect required).
Voice Agent API                                                        SDKs and Auth
Unified Voice Agent API                                                Deepgram SDKs
Endpoint: `/v1/agent/converse`                                         Languages: Python, Node.js, .NET, Go, others
Single WebSocket API combining STT + LLM reasoning + TTS. Manages
turn-taking, events, prompts, and function calls.                      Simplify streaming, WebSocket handling, auth, reconnects, audio I/O,
Try it: Voice Agent Playground                                         and event parsing.

CHAPTER 9: APPENDICES 103

Temporary Auth Tokens                                             Flow:
Short-lived JWTs created via project/key endpoints.               FunctionCallRequest → your app executes tool → FunctionCallResponse →
                                                                  agent continues with result
Recommended for: Browser and streaming clients instead            Common     Failure     Modes in Real-Time
of long-lived API keys.
Benefits: Scoped permissions and limited TTLs.                    Voice Agents
Compliance and Language Features                                  Even well-architected voice agents can exhibit issues once deployed in
                                                                  real-world conditions. Because voice agents operate as tightly coupled,
Redaction & Profanity Filtering                                   real-time systems, problems often emerge at the boundaries between
Transcript-level masking at the API layer.                        perception, reasoning, synthesis, and transport. This section outlines the
                                                                  most common failure modes and, more importantly, where in the system
Examples:                                                         they typically originate.
redact=pii, profanity_filter=true                                 The goal is not to provide exhaustive fixes, but to help teams quickly narrow
Multilingual Support                                              the scope of investigation.
•	Explicit language selection (language=en)                       Slow or Awkward Responses
•	Automatic detection (detect_language=true)                      Usually originates in:
•	Multilingual models (e.g., Nova-3 Multilingual)                 End-of-speech detection, reasoning latency, or client-side audio playback.
Function Calling (Voice Agent API)                                What to inspect:
                                                                  Turn-boundary signals, the timing between final user speech and agent
Structured event-based mechanism for invoking external tools.     response, and whether audio playback begins as soon as synthesis is available.

CHAPTER 9: APPENDICES                                                              104

Perceived latency is often introduced outside the speech                       Agent Talks Over the User or Misses Interruptions
models themselves.                                                             Usually originates in:
Agent Fails to Respond / Dead Air                                              Audio transport or interruption detection.
Usually originates in:                                                         What to inspect:
Turn detection failure, orchestration bugs, or downstream service timeout.     Whether audio is flowing continuously during agent playback and whether
                                                                               the system supports true full-duplex streaming. Reliable barge-in depends on
What to inspect:                                                               uninterrupted microphone input and fast speech-start detection.
Whether EndOfTurn events are being delivered, LLM response timeouts,
synthesis initialization, and event handler errors. Check for unhandled        Agent Responds Too Early / Premature Interruption
exceptions or blocking operations that prevent the agent from entering         Usually originates in:
the response phase.                                                            Aggressive end-of-turn thresholds or speech boundary tuning.
Inaccurate Transcription of Domain-Specific Language                           What to inspect:
Usually originates in:                                                         EOT threshold configuration (eot_threshold, eager_eot_threshold), whether
Model selection or vocabulary coverage.                                        partial transcripts or early turn signals trigger responses prematurely, and VAD
                                                                               sensitivity settings. Systems optimized for speed may sacrifice accuracy in
What to inspect:                                                               detecting natural pauses.
Whether the ASR model is appropriate for the domain and whether
specialized terminology is being surfaced to the speech system.                Choppy, Distorted, or Unnatural Audio
Generic models may struggle with clinical, financial, or product-specific      Usually originates in:
language without adaptation.                                                   Playback buffering, encoding mismatches, or network instability.

CHAPTER 9: APPENDICES 105

What to inspect:                                                                Repetitive or Incoherent Responses Over Time
Consistency between audio formats across the pipeline and whether playback      Usually originates in:
strategies introduce unnecessary buffering. Many perceived synthesis issues     Context growth or prompt design.
are actually transport or client-side artifacts.
                                                                                What to inspect:
Echo or Audio Feedback Loops                                                    How conversational history is accumulated, summarized, or truncated. Long-
Usually originates in:                                                          running sessions often degrade when older context overwhelms the model’s
Audio routing configuration or lack of echo cancellation.                       working memory or is repeated unintentionally.
What to inspect:                                                                Authentication or Connection Failures
Whether agent output is being fed back into the input stream, full-duplex       Usually originates in:
configuration, and hardware echo cancellation settings. In telephony            Token lifecycle management or endpoint configuration.
scenarios, verify that the media gateway properly isolates inbound and
outbound audio channels. Agent hearing itself can trigger response loops        What to inspect:
or distorted transcription.                                                     Whether credentials are valid, properly scoped, and refreshed as needed, and
                                                                                whether the correct regional or feature-enabled endpoints are being used.
Tools or Function Calls Are Not Triggered
Usually originates in:                                                          WebSocket Disconnections or Connection Instability
Tool visibility or instruction framing.                                         Usually originates in:
What to inspect:                                                                Network reliability, keepalive configuration, or session recovery logic.
Whether functions are clearly defined, discoverable to the reasoning model,
and aligned with the agent’s role. If tools are underspecified or poorly scoped,
the model may default to answering directly rather than invoking them.

CHAPTER 9: APPENDICES                                                                    106

What to inspect:                                                                     Closing Note
Connection timeout settings, reconnection backoff logic, whether state is            Most real-time voice issues fall into one of five layers: audio capture,
properly restored after reconnect, and network proxy or firewall configurations.     transcription, reasoning, synthesis, or playback. Diagnosing problems
Long-lived streaming sessions require explicit keepalive mechanisms and              effectively requires identifying which layer is responsible before attempting
graceful reconnection handling to maintain conversational continuity.                to tune parameters or swap components.
Missing or Confused Speakers in Multi-Party Scenarios                                For implementation details, configuration options, and code-level fixes,
Usually originates in:                                                               refer to Deepgram’s official documentation and reference implementations.
Audio routing or channel configuration.                                              This appendix is intended to help you reason about failures architecturally,
                                                                                     not replace production debugging workflows.
What to inspect:
Whether speakers are mixed correctly upstream and whether the architecture
supports the intended number of participants. Many real-time agents assume
a single human speaker per session.

Loss of Context or “Forgetting” Mid-Conversation
Usually originates in:
State persistence or memory strategy.
What to inspect:
How prior turns are retained and injected into reasoning. Long or complex
interactions often require explicit summarization or structured memory rather
than raw transcript accumulation.

deepgram.com
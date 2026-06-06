Today we released an interactive demo of our new Fin Voice product, powered by our Apex Flash model: https://fin.ai/voice

The architecture we are using here is very interesting here.
Fin Voice 2 is an unusual combination of s2s models (OpenAI gpt-realtime) and a custom model (Fin Apex Flash) in a production application.

We actually think this might be the future of Voice architectures.

I have to explain that claim:
The simplest way to add voice to a RAG system is what’s called ‘full cascade’.
This is where you simply put a speech-to-text model at the input end of your existing text RAG system, and a text-to-speech model for output.

We actually think that rendering the output using text-to-speech is pragmatic today - and probably for a while - and so we do that (so called ‘half cascade’), because our customers need fine control over how speech is rendered, tone of voice, accent etc, and there are a lot of great providers of that.

However, the input path is more interesting.

Speech from a human user is really complicated.

To give a great interface, you want to be able to interpret contextual ambiguity, errors, corrections, etc.
For example, if the user says ‘3,4,5, actually sorry that’s 4,6’ you have to interpret that - people make little updates like this all the time in voice, that they edit before the press 'enter' on their keyboard in text.

So you want a powerful model that’s equipped with context in order to understand this. So we bet early on gpt-realtime here.
That is an expensive model to run, but the results at input were excellent. And we think that the future here is a sophisticated LLM, so felt good about that.

However, to handle the RAG and answer generation parts, we really wanted a model that’s great at RAG.

But it was costly to have gpt-realtime, and then a heavy general frontier model behind it. And even worse, the latency cost of chaining models together like that really hurts the UX.

We’re delighted that we managed to solve this with a new custom model, Apex Flash - a dramatically more efficient version of our leading Apex model.
This dramatically improved the performance at core RAG, and overall performance of Fin Voice, improving both latency and RAG quality way beyond our previous architecture.

In general we’ve found that building custom models like this can compete with more general frontier models that are 1-2 OOM larger in size and cost.

We’re seeing this play out across our whole surface area.
I think this is a huge and under-appreciated dynamic in the world.

Of course, its easy to say all this.
So the team also did a lot of work to produce an actual live interactive demo of Fin Voice 2 so you can actually play with it and test it for yourself.
We put together an interface so you can see some of its internals in real time - it shows when it’s doing a RAG lookup, tool call, etc. There’s also a persistent datastore (per conversation) so you can e.g. cancel your booking and then check it’s been cancelled.

If you take the demo and kind of push the edge cases - ask it confusing questions etc I bet it’ll be much more robust than you’d expect.
I’m not saying you can’t break it if you try to - just that this tech is now really ready for production use cases, including messy calls with confusing user input.

It’s kind of exciting.
There’s an absolutely huge overhang here in terms of where this technology can be applied.
Any time I'm on hold for a human now, I wish they had some version of Fin Voice with API access hooked up.

Anyway, if you are interested in pushing the demo, check out:
https://fin.ai/voice
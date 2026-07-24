import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://syrinx.asyncdot.com',
  integrations: [
    starlight({
      title: 'Syrinx',
      description:
        'A TypeScript-native voice engine: transport edge (browser + telephony), a swappable STT/LLM/TTS + native-realtime pipeline, and a hibernatable runtime that runs on Node and Cloudflare Workers.',
      customCss: ['./src/styles/docs-theme.css'],
      plugins: [
        starlightLlmsTxt({
          projectName: 'Syrinx',
          description:
            'Syrinx is a TypeScript voice engine/SDK. It owns the transport edge (resumable WebSocket audio, Twilio/Telnyx/SmartPBX telephony) and hands the agent runtime a clean mono-PCM16 stream, wiring a swappable STT/LLM/TTS cascade OR a native-realtime (S2S) front. Providers are thin adapters over shared streaming lifecycle modules (stt-core, tts-core, realtime). Runs on Node and Cloudflare Workers (one hibernatable Durable Object per conversation).',
          details:
            'Packages are published under @kuralle-syrinx/*. Three architectures: cascade (STT->LLM->TTS), native realtime (S2S), and half-cascade. Telephony codecs (mu-law/PCMA/G.722), DTMF-send, and call transfer are unit-verified only — not yet certified against a live carrier.',
        }),
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/kuralle/syrinx',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/kuralle/syrinx/edit/main/apps/docs/',
      },
      sidebar: [
        {
          label: 'Getting Started',
          items: [{ slug: 'introduction' }, { slug: 'getting-started/quickstart' }],
        },
        {
          label: 'Guides',
          items: [
            { slug: 'guides/building-a-voice-agent' },
            { slug: 'guides/deploy-on-cloudflare' },
          ],
        },
        {
          label: 'Providers',
          items: [{ slug: 'providers/overview' }],
        },
        {
          label: 'Telephony',
          items: [{ slug: 'telephony/overview' }],
        },
        {
          label: 'Reference',
          items: [
            { slug: 'reference/architecture' },
            { slug: 'reference/stt-reconfigure' },
            { slug: 'reference/packets' },
          ],
        },
      ],
    }),
  ],
});

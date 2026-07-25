// SPDX-License-Identifier: MIT
//
// Shared shape for a provider's generated-project footprint: what it depends
// on, what env keys it needs, and how to emit its plugin construction code.
// `envRef` is supplied by the caller so the SAME provider entry emits either
// `process.env["KEY"]` (node runtime) or `env.KEY` (Cloudflare Workers).

export interface EnvKeySpec {
  readonly key: string;
  readonly required: boolean;
  readonly note?: string;
}

/** An STT or TTS provider's plugin — the cascade's discrete stages. */
export interface StageProvider {
  readonly packageName: string;
  readonly packageVersion: string;
  /** Import path, when it differs from packageName (e.g. a "/stt" or "/tts" subpath). */
  readonly importFrom?: string;
  readonly className: string;
  readonly envKeys: readonly EnvKeySpec[];
  /** True when the plugin constructor takes an optional SocketFactory (ws-based providers). */
  readonly usesSocketFactory: boolean;
  /** True for an STT plugin that can own endpointing itself (`endpointingCapability.owner === "provider_stt"`). */
  readonly ownsEndpointing: boolean;
  /** TS source for each field of the plugin's config object literal (no trailing commas). */
  readonly configFields: (envRef: (key: string) => string) => readonly string[];
}

export interface ReasonerProviderEmission {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly extraPackages: Readonly<Record<string, string>>;
  readonly envKeys: readonly EnvKeySpec[];
  readonly importLines: (envRef: (key: string) => string) => readonly string[];
  /** Lines emitted before the session/pipeline is built (e.g. constructing a model client). */
  readonly preludeLines: (envRef: (key: string) => string) => readonly string[];
  /** The `Reasoner`-producing expression, e.g. `fromStreamText({ ... })`. */
  readonly reasonerExpr: string;
}

export interface RealtimeProviderEmission {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly envKeys: readonly EnvKeySpec[];
  readonly importLines: readonly string[];
  /** `socketFactoryIdent` is runtime-dependent ("createNodeWsSocket" | "createWorkersSocket"), supplied by the caller. */
  readonly adapterExpr: (envRef: (key: string) => string, socketFactoryIdent: string) => string;
}

export interface SidecarPluginEmission {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly className: string;
  readonly slot: "vad" | "eos";
  readonly envKeys: readonly EnvKeySpec[];
  readonly configFields: (envRef: (key: string) => string) => readonly string[];
}

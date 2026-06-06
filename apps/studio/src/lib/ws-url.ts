export const HOSTED_WS_URL = "wss://syrinx-voice-server-workers.mithushancj.workers.dev/ws";
export const DEFAULT_LOCAL_WS_URL = "ws://127.0.0.1:4173/ws";

export type WsTarget = "local" | "hosted" | "custom";

export function resolveInitialWsUrl(): { target: WsTarget; url: string } {
  const params = new URLSearchParams(window.location.search);
  const queryOverride = params.get("ws")?.trim();
  if (queryOverride) {
    return { target: "custom", url: queryOverride };
  }
  return { target: "local", url: DEFAULT_LOCAL_WS_URL };
}

export function wsUrlForTarget(target: WsTarget, localUrl: string): string {
  if (target === "hosted") return HOSTED_WS_URL;
  if (target === "local") return localUrl.trim() || DEFAULT_LOCAL_WS_URL;
  return localUrl.trim() || DEFAULT_LOCAL_WS_URL;
}

export function connectionLabel(status: "offline" | "connecting" | "connected" | "error"): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    default:
      return "Offline";
  }
}

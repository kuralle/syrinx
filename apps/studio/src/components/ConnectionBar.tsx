import {
  DEFAULT_LOCAL_WS_URL,
  connectionLabel,
  wsUrlForTarget,
  type WsTarget,
} from "@/lib/ws-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ConnectionStatus = "offline" | "connecting" | "connected" | "error";

interface ConnectionBarProps {
  readonly target: WsTarget;
  readonly localUrl: string;
  readonly customUrl: string;
  readonly status: ConnectionStatus;
  readonly sessionId?: string | null;
  readonly errorMessage?: string;
  readonly onTargetChange: (target: WsTarget) => void;
  readonly onLocalUrlChange: (url: string) => void;
  readonly onCustomUrlChange: (url: string) => void;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onClearTranscript: () => void;
  readonly onPlaySample: () => void;
}

export function ConnectionBar({
  target,
  localUrl,
  customUrl,
  status,
  sessionId,
  errorMessage,
  onTargetChange,
  onLocalUrlChange,
  onCustomUrlChange,
  onConnect,
  onDisconnect,
  onClearTranscript,
  onPlaySample,
}: ConnectionBarProps) {
  const resolvedUrl = target === "custom" ? customUrl : wsUrlForTarget(target, localUrl);
  const connected = status === "connected";
  const badgeVariant =
    status === "connected" ? "success" : status === "connecting" ? "warning" : status === "error" ? "destructive" : "default";

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Syrinx Studio</CardTitle>
          <CardDescription>
            WebSocket voice session — always-on mic, server-side VAD and endpointing.
          </CardDescription>
        </div>
        <Badge variant={badgeVariant}>
          <span className="inline-block h-2 w-2 rounded-full bg-current opacity-80" />
          {connectionLabel(status)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)_auto]">
        <div className="space-y-2">
          <Label htmlFor="ws-target">Backend</Label>
          <Select
            value={target}
            onValueChange={(value) => onTargetChange(value as WsTarget)}
            disabled={connected}
          >
            <SelectTrigger id="ws-target">
              <SelectValue placeholder="Select backend" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">Local</SelectItem>
              <SelectItem value="hosted">Hosted (Cloudflare)</SelectItem>
              <SelectItem value="custom">Custom URL</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="ws-url">
            {target === "local" ? "Local WebSocket URL" : target === "hosted" ? "Hosted endpoint" : "Custom WebSocket URL"}
          </Label>
          {target === "local" ? (
            <Input
              id="ws-url"
              value={localUrl}
              onChange={(event) => onLocalUrlChange(event.target.value)}
              spellCheck={false}
            />
          ) : target === "hosted" ? (
            // Editable: typing a hosted URL switches the target to custom so the value persists.
            <Input
              id="ws-url"
              value={resolvedUrl}
              onChange={(event) => {
                onCustomUrlChange(event.target.value);
                onTargetChange("custom");
              }}
              spellCheck={false}
            />
          ) : (
            <Input
              id="ws-url"
              value={customUrl}
              onChange={(event) => onCustomUrlChange(event.target.value)}
              spellCheck={false}
              placeholder={DEFAULT_LOCAL_WS_URL}
            />
          )}
          <p className="text-xs text-muted-foreground">
            Override with <code className="rounded bg-muted px-1">?ws=</code> query param. Active URL: {resolvedUrl}
          </p>
          {sessionId ? (
            <p className="text-xs text-muted-foreground">Session: {sessionId}</p>
          ) : null}
          {errorMessage ? <p className="text-xs text-destructive">{errorMessage}</p> : null}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          {connected ? (
            <Button variant="destructive" onClick={onDisconnect}>
              Disconnect
            </Button>
          ) : (
            <Button onClick={onConnect} disabled={status === "connecting" || !resolvedUrl.trim()}>
              Connect
            </Button>
          )}
          <Button variant="outline" onClick={onPlaySample} disabled={status === "connecting"}>
            Play sample
          </Button>
          <Button variant="outline" onClick={onClearTranscript}>
            Clear transcript
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

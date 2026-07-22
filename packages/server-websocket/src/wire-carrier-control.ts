// SPDX-License-Identifier: MIT
//
// Bus wiring for dtmf.send + call.transfer → pure constructor + injectable dispatch.
// Mechanism unit-tested; live carrier HTTP unverified.

import { Route, type CallTransferPacket, type DtmfSendPacket, type VoiceAgentSession } from "@kuralle-syrinx/core";
import {
  buildTelnyxSendDtmf,
  buildTelnyxTransfer,
  buildTwilioSendDigits,
  buildTwilioTransfer,
  dispatchTelnyxCommand,
  dispatchTwilioCommand,
  resolveTransferSummary,
  type FetchLike,
  type TelnyxRestCredentials,
  type TwilioRestCredentials,
  type WarmTransferSummarizer,
} from "./carrier-commands.js";

export interface TwilioCarrierControlOptions {
  readonly carrier: "twilio";
  /** Call SID for the active media stream (injected; may resolve lazily). */
  getCallSid: () => string | undefined;
  readonly credentials?: TwilioRestCredentials;
  readonly fetchImpl?: FetchLike;
  readonly redirectUrl?: string;
  readonly warmSummarizer?: WarmTransferSummarizer;
}

export interface TelnyxCarrierControlOptions {
  readonly carrier: "telnyx";
  getCallControlId: () => string | undefined;
  readonly credentials?: TelnyxRestCredentials;
  readonly fetchImpl?: FetchLike;
  readonly webhookUrl?: string;
  readonly warmSummarizer?: WarmTransferSummarizer;
}

export type CarrierControlOptions = TwilioCarrierControlOptions | TelnyxCarrierControlOptions;

/**
 * Subscribe to `dtmf.send` and `call.transfer` on the session bus.
 * When credentials are absent, still builds the command and emits a metric so
 * unit tests can assert the constructor path without live HTTP.
 */
export function wireCarrierControl(
  session: VoiceAgentSession,
  disposers: Array<() => void>,
  options: CarrierControlOptions,
): void {
  disposers.push(
    session.bus.on("dtmf.send", (pkt) => {
      void handleDtmfSend(session, pkt as DtmfSendPacket, options);
    }),
    session.bus.on("call.transfer", (pkt) => {
      void handleCallTransfer(session, pkt as CallTransferPacket, options);
    }),
  );
}

async function handleDtmfSend(
  session: VoiceAgentSession,
  pkt: DtmfSendPacket,
  options: CarrierControlOptions,
): Promise<void> {
  try {
    if (options.carrier === "twilio") {
      const callSid = options.getCallSid();
      if (!callSid) {
        emitMetric(session, pkt.contextId, "carrier.dtmf_send.missing_call_handle", "twilio");
        return;
      }
      const command = buildTwilioSendDigits(callSid, pkt);
      emitMetric(session, pkt.contextId, "carrier.dtmf_send.built", JSON.stringify({ carrier: "twilio", digits: command.form.SendDigits }));
      if (!options.credentials) {
        emitMetric(session, pkt.contextId, "carrier.dtmf_send.no_credentials", "twilio");
        return;
      }
      const res = await dispatchTwilioCommand(options.credentials, command, options.fetchImpl);
      emitMetric(session, pkt.contextId, "carrier.dtmf_send.dispatched", String(res.status));
      return;
    }

    const callControlId = options.getCallControlId();
    if (!callControlId) {
      emitMetric(session, pkt.contextId, "carrier.dtmf_send.missing_call_handle", "telnyx");
      return;
    }
    const command = buildTelnyxSendDtmf(callControlId, pkt);
    emitMetric(session, pkt.contextId, "carrier.dtmf_send.built", JSON.stringify({ carrier: "telnyx", digits: command.json.digits }));
    if (!options.credentials) {
      emitMetric(session, pkt.contextId, "carrier.dtmf_send.no_credentials", "telnyx");
      return;
    }
    const res = await dispatchTelnyxCommand(options.credentials, command, options.fetchImpl);
    emitMetric(session, pkt.contextId, "carrier.dtmf_send.dispatched", String(res.status));
  } catch (err) {
    emitMetric(session, pkt.contextId, "carrier.dtmf_send.error", err instanceof Error ? err.message : String(err));
  }
}

async function handleCallTransfer(
  session: VoiceAgentSession,
  pkt: CallTransferPacket,
  options: CarrierControlOptions,
): Promise<void> {
  try {
    const summary = await resolveTransferSummary(pkt, options.warmSummarizer);
    const resolved = summary !== undefined ? { ...pkt, summary } : pkt;

    if (options.carrier === "twilio") {
      const callSid = options.getCallSid();
      if (!callSid) {
        emitMetric(session, pkt.contextId, "carrier.transfer.missing_call_handle", "twilio");
        return;
      }
      const command = buildTwilioTransfer(callSid, resolved, {
        redirectUrl: options.redirectUrl,
      });
      emitMetric(
        session,
        pkt.contextId,
        "carrier.transfer.built",
        JSON.stringify({
          carrier: "twilio",
          mode: command.mode,
          target: resolved.target,
          summary: command.summary ?? null,
        }),
      );
      if (!options.credentials) {
        emitMetric(session, pkt.contextId, "carrier.transfer.no_credentials", "twilio");
        return;
      }
      const res = await dispatchTwilioCommand(options.credentials, command, options.fetchImpl);
      emitMetric(session, pkt.contextId, "carrier.transfer.dispatched", String(res.status));
      return;
    }

    const callControlId = options.getCallControlId();
    if (!callControlId) {
      emitMetric(session, pkt.contextId, "carrier.transfer.missing_call_handle", "telnyx");
      return;
    }
    const command = buildTelnyxTransfer(callControlId, resolved, {
      webhookUrl: options.webhookUrl,
    });
    emitMetric(
      session,
      pkt.contextId,
      "carrier.transfer.built",
      JSON.stringify({
        carrier: "telnyx",
        mode: command.mode,
        target: command.json.to,
        summary: command.summary ?? null,
      }),
    );
    if (!options.credentials) {
      emitMetric(session, pkt.contextId, "carrier.transfer.no_credentials", "telnyx");
      return;
    }
    const res = await dispatchTelnyxCommand(options.credentials, command, options.fetchImpl);
    emitMetric(session, pkt.contextId, "carrier.transfer.dispatched", String(res.status));
  } catch (err) {
    emitMetric(session, pkt.contextId, "carrier.transfer.error", err instanceof Error ? err.message : String(err));
  }
}

function emitMetric(session: VoiceAgentSession, contextId: string, name: string, value: string): void {
  session.bus.push(Route.Background, {
    kind: "metric.conversation",
    contextId,
    timestampMs: Date.now(),
    name,
    value,
  });
}

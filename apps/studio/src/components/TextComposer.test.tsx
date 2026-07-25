import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TextComposer } from "./TextComposer";

const noop = () => undefined;

describe("TextComposer", () => {
  it("sends on Enter and clears the composer", () => {
    const onSend = vi.fn();
    render(
      <TextComposer mode="text" connected micActive={false} onModeChange={noop} onSend={onSend} />,
    );

    const input = screen.getByTestId("text-composer-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "book me a table" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("book me a table");
    expect(input.value).toBe("");
  });

  it("does not send a blank turn", () => {
    const onSend = vi.fn();
    render(
      <TextComposer mode="text" connected micActive={false} onModeChange={noop} onSend={onSend} />,
    );

    const input = screen.getByTestId("text-composer-input");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId("text-composer-send")).toBeDisabled();
  });

  it("is disabled while disconnected, and says so instead of failing silently", () => {
    const onSend = vi.fn();
    render(
      <TextComposer
        mode="text"
        connected={false}
        micActive={false}
        onModeChange={noop}
        onSend={onSend}
      />,
    );

    const input = screen.getByTestId("text-composer-input");
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute("placeholder", expect.stringMatching(/connect to send/i));
    expect(screen.getByTestId("text-composer-send")).toBeDisabled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("states what text mode does not test, in plain language", () => {
    render(
      <TextComposer mode="text" connected micActive={false} onModeChange={noop} onSend={noop} />,
    );

    const trade = screen.getByTestId("text-mode-trade");
    expect(trade).toHaveTextContent(/nothing transcribes you/i);
    expect(trade).toHaveTextContent(/when you finished talking/i);
    expect(trade).toHaveTextContent(/untested/i);
    // Verified live: a typed turn IS spoken. The card must not claim otherwise —
    // a developer told the reply is silent will not think to listen to it.
    expect(trade).toHaveTextContent(/reply is still spoken/i);
    expect(trade.textContent ?? "").not.toMatch(/nothing speaks the reply/i);
    // Never packet names in the UI.
    expect(trade.textContent ?? "").not.toMatch(/turn_complete|text_received|stt_output|eos\./);
  });

  it("shows whether the microphone is actually open", () => {
    const { rerender } = render(
      <TextComposer mode="voice" connected micActive onModeChange={noop} onSend={noop} />,
    );
    expect(screen.getByTestId("mic-status")).toHaveTextContent(/microphone on/i);

    rerender(
      <TextComposer mode="text" connected micActive={false} onModeChange={noop} onSend={noop} />,
    );
    expect(screen.getByTestId("mic-status")).toHaveTextContent(/microphone off/i);
  });

  it("offers no composer in voice mode, and explains what text mode buys", () => {
    render(<TextComposer mode="voice" connected micActive onModeChange={noop} onSend={noop} />);

    expect(screen.queryByTestId("text-composer-input")).not.toBeInTheDocument();
    expect(screen.getByTestId("voice-mode-note")).toHaveTextContent(/switch to\s+text/i);
  });

  it("reports the mode it is in through the toggle", () => {
    const onModeChange = vi.fn();
    render(
      <TextComposer mode="voice" connected micActive onModeChange={onModeChange} onSend={noop} />,
    );

    expect(screen.getByTestId("mode-voice")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mode-text")).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByTestId("mode-text"));
    expect(onModeChange).toHaveBeenCalledWith("text");
  });
});

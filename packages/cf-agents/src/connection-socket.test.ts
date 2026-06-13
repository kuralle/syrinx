// SPDX-License-Identifier: MIT

import { describe, it, expect, vi } from "vitest";
import { connectionManagedSocket, type VoiceConnection } from "./connection-socket.js";

function fakeConnection(readyState = 1): VoiceConnection & { sent: Array<string | ArrayBuffer | ArrayBufferView>; closed: boolean } {
  const sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  let closed = false;
  return {
    id: "c1",
    get readyState() {
      return closed ? 3 : readyState;
    },
    send(data) {
      sent.push(data);
    },
    close() {
      closed = true;
    },
    sent,
    get closed() {
      return closed;
    },
  };
}

describe("connectionManagedSocket", () => {
  it("forwards send() to the connection and reflects readyState via isOpen", () => {
    const conn = fakeConnection();
    const { socket } = connectionManagedSocket(conn);
    expect(socket.isOpen).toBe(true);
    socket.send("hello");
    socket.send(new Uint8Array([1, 2, 3]));
    expect(conn.sent).toEqual(["hello", new Uint8Array([1, 2, 3])]);
  });

  it("isOpen is false when the connection is not OPEN", () => {
    const conn = fakeConnection(0);
    const { socket } = connectionManagedSocket(conn);
    expect(socket.isOpen).toBe(false);
  });

  it("dispose() closes the underlying connection", () => {
    const conn = fakeConnection();
    const { socket } = connectionManagedSocket(conn);
    socket.dispose();
    expect(conn.closed).toBe(true);
    expect(socket.isOpen).toBe(false);
  });

  it("controller.message pumps string frames as text and ArrayBuffer as binary", () => {
    const { socket, controller } = connectionManagedSocket(fakeConnection());
    const received: Array<{ data: unknown; isBinary: boolean }> = [];
    socket.onMessage((data, isBinary) => received.push({ data, isBinary }));

    controller.message("a-json-frame");
    const buf = new Uint8Array([9, 8, 7]).buffer;
    controller.message(buf);

    expect(received).toHaveLength(2);
    expect(received[0]).toEqual({ data: "a-json-frame", isBinary: false });
    expect(received[1]?.isBinary).toBe(true);
    expect(received[1]?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(received[1]?.data as Uint8Array)).toEqual([9, 8, 7]);
  });

  it("controller.close and controller.error fan out to registered handlers", () => {
    const { socket, controller } = connectionManagedSocket(fakeConnection());
    const onClose = vi.fn();
    const onError = vi.fn();
    socket.onClose(onClose);
    socket.onError(onError);

    controller.close(1011, "boom");
    controller.error(new Error("network"));

    expect(onClose).toHaveBeenCalledWith(1011, "boom");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "network" }));
  });

  it("dispose() fires the close handlers (so edge teardown runs) and closes the connection", () => {
    const conn = fakeConnection();
    const { socket } = connectionManagedSocket(conn);
    const onClose = vi.fn();
    socket.onClose(onClose);

    socket.dispose();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(conn.closed).toBe(true);
    expect(socket.isOpen).toBe(false);
  });

  it("fires close at most once across dispose() and controller.close()", () => {
    const { socket, controller } = connectionManagedSocket(fakeConnection());
    const onClose = vi.fn();
    socket.onClose(onClose);

    socket.dispose();
    controller.close(1000, "later");
    controller.close(1000, "again");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("onOpen fires on the next microtask when already open", async () => {
    const { socket } = connectionManagedSocket(fakeConnection());
    const onOpen = vi.fn();
    socket.onOpen(onOpen);
    expect(onOpen).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

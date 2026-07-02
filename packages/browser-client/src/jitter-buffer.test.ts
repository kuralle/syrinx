// SPDX-License-Identifier: MIT
// WT-03: Client jitter buffer tests

import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioJitterBuffer } from "./audio.js";

// Mock AudioContext for testing
class MockAudioContext {
  public currentTime = 0;
  public destination = {};
  private nextBufferId = 1;

  createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(channels, length, sampleRate, this.nextBufferId++);
  }

  createBufferSource(): MockAudioBufferSource {
    return new MockAudioBufferSource();
  }
}

class MockAudioBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
    public _id: number
  ) {}

  get duration(): number {
    return this.length / this.sampleRate;
  }

  copyToChannel(_data: Float32Array, _channel: number): void {
    // Mock implementation
  }
}

class MockAudioBufferSource {
  public buffer: MockAudioBuffer | null = null;
  public onended: (() => void) | null = null;
  private connected = false;
  private started = false;
  private startTime = 0;

  connect(_destination: unknown): void {
    this.connected = true;
  }

  start(when = 0): void {
    this.started = true;
    this.startTime = when;
    
    // Simulate completion after buffer duration
    if (this.buffer && this.onended) {
      setTimeout(() => {
        this.onended?.();
      }, this.buffer.duration * 1000);
    }
  }

  stop(): void {
    this.started = false;
  }
}

describe("AudioJitterBuffer", () => {
  let mockContext: MockAudioContext;
  let jitterBuffer: AudioJitterBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    mockContext = new MockAudioContext();
    jitterBuffer = new AudioJitterBuffer(mockContext as any, { 
      sampleRateHz: 16000,
      targetBufferMs: 100 
    });
  });

  it("enqueues and schedules audio frames with target buffer delay", () => {
    const pcm16Data = new Int16Array(320); // 20ms at 16kHz
    pcm16Data.fill(1000);

    mockContext.currentTime = 1.0;
    jitterBuffer.enqueue(pcm16Data.buffer, "test-context");

    // Should schedule audio ~100ms + frame duration in the future
    expect(jitterBuffer.bufferedDurationMs).toBeCloseTo(120, -1);
  });

  it("schedules multiple frames contiguously", () => {
    const frameData = new Int16Array(320); // 20ms at 16kHz
    frameData.fill(1000);

    mockContext.currentTime = 1.0;
    
    // Enqueue 3 frames
    jitterBuffer.enqueue(frameData.buffer, "test-context");
    jitterBuffer.enqueue(frameData.buffer, "test-context");
    jitterBuffer.enqueue(frameData.buffer, "test-context");

    // Should buffer ~160ms total (100ms initial + 3*20ms)
    expect(jitterBuffer.bufferedDurationMs).toBeCloseTo(160, -1);
  });

  it("tracks active context IDs", () => {
    const frameData = new Int16Array(320);
    frameData.fill(1000);

    jitterBuffer.enqueue(frameData.buffer, "context-1");
    jitterBuffer.enqueue(frameData.buffer, "context-2");

    expect(jitterBuffer.activeContextIds).toContain("context-1");
    expect(jitterBuffer.activeContextIds).toContain("context-2");
    expect(jitterBuffer.activeContextIds).toHaveLength(2);
  });

  it("reports played-out ms clamped to the scheduled window (heard clock)", () => {
    const frameData = new Int16Array(320); // 20ms at 16kHz
    frameData.fill(1000);
    mockContext.currentTime = 1.0;
    jitterBuffer.enqueue(frameData.buffer, "ctx"); // scheduled at 1.1, ends 1.12

    // Before the frame starts playing → nothing heard yet.
    expect(jitterBuffer.playedOutMs("ctx")).toBe(0);
    expect(jitterBuffer.isPlayoutComplete("ctx")).toBe(false);

    // Halfway through the 20ms frame → ~10ms heard.
    mockContext.currentTime = 1.11;
    expect(jitterBuffer.playedOutMs("ctx")).toBeCloseTo(10, 0);

    // Past the end → clamped to the full 20ms, and complete.
    mockContext.currentTime = 1.2;
    expect(jitterBuffer.playedOutMs("ctx")).toBeCloseTo(20, 0);
    expect(jitterBuffer.isPlayoutComplete("ctx")).toBe(true);

    // Unknown context reports 0.
    expect(jitterBuffer.playedOutMs("nope")).toBe(0);
  });

  it("clears specific context frames on context-specific clear", () => {
    const frameData = new Int16Array(320);
    frameData.fill(1000);

    jitterBuffer.enqueue(frameData.buffer, "context-1");
    jitterBuffer.enqueue(frameData.buffer, "context-2");
    jitterBuffer.enqueue(frameData.buffer, "context-1");

    expect(jitterBuffer.activeContextIds).toHaveLength(2);

    jitterBuffer.clear("context-1");

    expect(jitterBuffer.activeContextIds).toContain("context-2");
    expect(jitterBuffer.activeContextIds).not.toContain("context-1");
    expect(jitterBuffer.activeContextIds).toHaveLength(1);
  });

  it("resets schedule baseline after context-specific clear", () => {
    const frameData = new Int16Array(320);
    frameData.fill(1000);

    mockContext.currentTime = 1.0;
    for (let i = 0; i < 50; i += 1) {
      jitterBuffer.enqueue(frameData.buffer, "assistant");
    }
    expect(jitterBuffer.bufferedDurationMs).toBeGreaterThan(1000);

    jitterBuffer.clear("assistant");
    expect(jitterBuffer.bufferedDurationMs).toBe(0);

    mockContext.currentTime = 1.05;
    jitterBuffer.enqueue(frameData.buffer, "user-barge");
    expect(jitterBuffer.bufferedDurationMs).toBeCloseTo(120, -1);
  });

  it("zeros buffered duration when the cleared context was the only one scheduled", () => {
    const frameData = new Int16Array(320);
    frameData.fill(1000);

    mockContext.currentTime = 2.0;
    jitterBuffer.enqueue(frameData.buffer, "solo-context");
    jitterBuffer.enqueue(frameData.buffer, "solo-context");
    expect(jitterBuffer.bufferedDurationMs).toBeGreaterThan(0);

    jitterBuffer.clear("solo-context");
    expect(jitterBuffer.activeContextIds).toHaveLength(0);
    expect(jitterBuffer.bufferedDurationMs).toBe(0);

    mockContext.currentTime = 8.0;
    jitterBuffer.enqueue(frameData.buffer, "next-context");
    expect(jitterBuffer.bufferedDurationMs).toBeCloseTo(120, -1);
  });

  it("clears all frames on global clear", () => {
    const frameData = new Int16Array(320);
    frameData.fill(1000);

    jitterBuffer.enqueue(frameData.buffer, "context-1");
    jitterBuffer.enqueue(frameData.buffer, "context-2");

    expect(jitterBuffer.activeContextIds).toHaveLength(2);

    jitterBuffer.clear();

    expect(jitterBuffer.activeContextIds).toHaveLength(0);
    expect(jitterBuffer.bufferedDurationMs).toBe(0);
  });

  it("establishes new baseline when buffer is empty", () => {
    const frameData = new Int16Array(320);
    frameData.fill(1000);

    mockContext.currentTime = 1.0;
    jitterBuffer.enqueue(frameData.buffer, "context-1");

    const initialBuffer = jitterBuffer.bufferedDurationMs;

    // Clear and advance time
    jitterBuffer.clear();
    mockContext.currentTime = 2.0;

    jitterBuffer.enqueue(frameData.buffer, "context-2");

    // Should establish new baseline at current time + target buffer
    expect(jitterBuffer.bufferedDurationMs).toBeCloseTo(initialBuffer, -1);
  });

  it("handles PCM16 to Float32 conversion correctly", () => {
    // Test with known values
    const pcm16Data = new Int16Array([0, 16383, -16384, 32767, -32768]);
    const expectedFloat32 = [0, 0.5, -0.5, 1.0, -1.0];

    let capturedFloat32: Float32Array | null = null;
    
    // Mock copyToChannel to capture the converted data
    MockAudioBuffer.prototype.copyToChannel = function(data: Float32Array, _channel: number) {
      capturedFloat32 = new Float32Array(data);
    };

    jitterBuffer.enqueue(pcm16Data.buffer);

    expect(capturedFloat32).not.toBeNull();
    expect(capturedFloat32![0]).toBeCloseTo(expectedFloat32[0]!, 5);
    expect(capturedFloat32![1]).toBeCloseTo(expectedFloat32[1]!, 3);
    expect(capturedFloat32![2]).toBeCloseTo(expectedFloat32[2]!, 3);
    expect(capturedFloat32![3]).toBeCloseTo(expectedFloat32[3]!, 3);
    expect(capturedFloat32![4]).toBeCloseTo(expectedFloat32[4]!, 3);
  });

  it("handles empty or invalid audio data gracefully", () => {
    const emptyData = new ArrayBuffer(0);
    
    expect(() => {
      jitterBuffer.enqueue(emptyData, "test-context");
    }).not.toThrow();

    expect(jitterBuffer.activeContextIds).toHaveLength(0);
  });

  it("advances scheduled time correctly for consecutive frames", () => {
    const frame1 = new Int16Array(160).fill(1000); // 10ms at 16kHz
    const frame2 = new Int16Array(320).fill(1000); // 20ms at 16kHz

    mockContext.currentTime = 0;
    
    jitterBuffer.enqueue(frame1.buffer, "context-1");
    const buffer1 = jitterBuffer.bufferedDurationMs;
    
    jitterBuffer.enqueue(frame2.buffer, "context-1");
    const buffer2 = jitterBuffer.bufferedDurationMs;

    // Second frame should add its duration to the buffer
    expect(buffer2 - buffer1).toBeCloseTo(20, -1);
  });
});
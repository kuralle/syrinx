import { useEffect, useRef } from "react";

interface AudioVisualizerProps {
  readonly micAnalyser?: AnalyserNode | null;
  readonly playbackLevel?: number;
  readonly active?: boolean;
}

export function AudioVisualizer({ micAnalyser, playbackLevel = 0, active = false }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playbackRef = useRef(playbackLevel);

  useEffect(() => {
    playbackRef.current = playbackLevel;
  }, [playbackLevel]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frame = 0;
    const data = new Uint8Array(micAnalyser?.frequencyBinCount ?? 64);

    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      const width = canvas.clientWidth * window.devicePixelRatio;
      const height = canvas.clientHeight * window.devicePixelRatio;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "oklch(0.995 0.001 106)";
      ctx.fillRect(0, 0, width, height);

      let micLevel = 0;
      if (micAnalyser && active) {
        micAnalyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum += data[i]!;
        micLevel = sum / (data.length * 255);
      }

      const level = Math.min(1, Math.max(micLevel, playbackRef.current * 4));
      const barCount = 24;
      const gap = 3;
      const barWidth = (width - gap * (barCount - 1)) / barCount;

      for (let i = 0; i < barCount; i += 1) {
        const phase = (i / barCount) * Math.PI;
        const wave = 0.35 + 0.65 * Math.sin(phase + performance.now() / 180);
        const barHeight = Math.max(4, height * level * wave);
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;
        ctx.fillStyle = active ? "oklch(0.45 0.12 150)" : "oklch(0.72 0.01 106)";
        ctx.fillRect(x, y, barWidth, barHeight);
      }

      ctx.strokeStyle = "oklch(0.86 0.012 106)";
      ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
    };

    draw();
    return () => cancelAnimationFrame(frame);
  }, [active, micAnalyser]);

  return (
    <canvas
      ref={canvasRef}
      className="h-16 w-full rounded-md border bg-card"
      aria-label="Audio visualizer"
    />
  );
}

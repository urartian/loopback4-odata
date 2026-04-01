import { ScenarioSummary } from '../types';

export type MemorySnapshot = {
  heapUsed: number;
  rss: number;
};

export function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function snapshotMemory(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
  };
}

export function toMb(bytes: number): number {
  return bytes / (1024 * 1024);
}

export async function forceGcIfAvailable(): Promise<void> {
  const gc = global.gc;
  if (typeof gc !== 'function') return;
  gc();
  await new Promise((resolve) => setTimeout(resolve, 25));
  gc();
}

export function formatSummary(summary: ScenarioSummary): string {
  const lines = [
    `${summary.name} - ${summary.description}`,
    `  ${summary.operationLabel}: ${summary.operations}`,
    `  total: ${summary.totalMs.toFixed(1)} ms`,
    `  min/avg/max: ${summary.minMs.toFixed(1)} / ${summary.avgMs.toFixed(1)} / ${summary.maxMs.toFixed(1)} ms`,
    `  p50/p95: ${summary.p50Ms.toFixed(1)} / ${summary.p95Ms.toFixed(1)} ms`,
    `  throughput: ${summary.opsPerSecond.toFixed(2)} ${summary.operationLabel}/s`,
    `  memory delta (heap/rss): ${summary.heapUsedDeltaMb.toFixed(2)} / ${summary.rssDeltaMb.toFixed(2)} MiB`,
  ];
  return lines.join('\n');
}

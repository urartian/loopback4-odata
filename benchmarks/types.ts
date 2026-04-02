import { Client } from '@loopback/testlab';
import { TestApplication } from '../src/__tests__/fixtures/odata-app.fixture';

export interface BenchOptions {
  iterations: number;
  warmup: number;
  concurrency: number;
  datasetScale: number;
  tokenOpsPerIteration: number;
  database: 'memory' | 'postgres';
  payloadBytes: number;
}

export interface BenchmarkEnvironment {
  options: BenchOptions;
  app?: TestApplication;
  client?: Client;
  state?: Record<string, unknown>;
}

export interface BenchScenario {
  name: string;
  description: string;
  operationLabel?: string;
  countOperations?(options: BenchOptions): number;
  setup(options: BenchOptions): Promise<BenchmarkEnvironment>;
  run(env: BenchmarkEnvironment): Promise<void>;
  cleanup?(env: BenchmarkEnvironment): Promise<void>;
}

export interface ScenarioSummary {
  name: string;
  description: string;
  operations: number;
  operationLabel: string;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  opsPerSecond: number;
  heapUsedDeltaMb: number;
  rssDeltaMb: number;
}

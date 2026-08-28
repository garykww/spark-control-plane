export type NodeType = 'dgx-spark' | 'gpu-host';
export type Connection = 'local' | 'ssh';

export interface LlmPort {
  port: number;
  label: string;
}

export interface NodeConfig {
  id: string;
  name: string;
  type: NodeType;
  connection: Connection;
  host: string;
  sshUser: string;
  sshPort: number;
  sshKeyPath: string | null;
  llmPorts: LlmPort[];
  macAddress: string | null;
  enabled: boolean;
  order: number;
  createdAt: string;
  hasPassword: boolean;
}

export interface ThrottleReason {
  key: string;
  label: string;
  severity: 'info' | 'warning' | 'serious';
}

export interface GpuEngines {
  encoder: number | null;
  decoder: number | null;
  jpeg: number | null;
  ofa: number | null;
}

export interface Gpu {
  index: number;
  name: string;
  driver: string | null;
  utilization: number | null;
  memoryUtilization: number | null;
  memoryTotal: number | null;
  memoryUsed: number | null;
  memoryPercent: number | null;
  temperature: number | null;
  /* Degrees left before the driver starts cutting clocks. */
  temperatureHeadroom: number | null;
  powerDraw: number | null;
  powerLimit: number | null;
  clockSm: number | null;
  clockSmMax: number | null;
  clockSmPercent: number | null;
  clockMemory: number | null;
  pstate: string | null;
  fanSpeed: number | null;
  /* null when the driver does not report clock-event reasons at all. */
  throttleReasons: ThrottleReason[] | null;
  engines: GpuEngines;
  enginesActive: boolean;
  isUnified: boolean;
}

export interface GpuProcess {
  pid: number;
  name: string;
  command: string;
  memory: number | null;
}

export interface Mount {
  device: string;
  mount: string;
  total: number;
  used: number;
  available: number;
  percent: number;
}

export interface Interface {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxRate: number;
  txRate: number;
}

export interface ThermalZone {
  label: string;
  celsius: number;
}

export interface LlmStatus {
  id: string;
  label: string;
  port: number;
  online: boolean;
  backend: string | null;
  models: string[];
  error: string | null;
  latencyMs: number | null;
  decodeRate: number;
  prefillRate: number;
  running: number | null;
  queued: number | null;
  kvCacheUsage: number | null;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
  createdAt: string;
}

export type ContainerAction = 'start' | 'stop' | 'restart';

export interface SparkSpec {
  platform: string;
  soc: string;
  gpu: string;
  cpu: string;
  cpuCores: number;
  memoryBytes: number;
  memoryType: string;
  memoryBandwidthGBs: number;
  aiPerformance: string;
  networking: string;
  powerWatts: number;
}

export interface NodeSnapshot {
  nodeId: string;
  name: string;
  type: NodeType;
  online: boolean;
  stale?: boolean;
  error: string | null;
  collectedAt: number;
  spec: SparkSpec | null;
  host?: { hostname: string; kernel: string; arch: string; model: string };
  uptimeSeconds?: number;
  load?: { load1: number; load5: number; load15: number };
  cpu?: {
    model: string;
    cores: number;
    /* null until a second sample exists to diff against. */
    percent: number | null;
    cores_percent: number[];
    runnable: number;
  };
  memory?: {
    total: number;
    used: number;
    available: number;
    cached: number;
    buffers: number;
    swapTotal: number;
    swapUsed: number;
    percent: number;
  };
  gpus: Gpu[];
  gpuProcesses: GpuProcess[];
  containers: Container[];
  /* False when Docker is absent or unreachable; dockerError says which. */
  dockerAvailable: boolean;
  dockerError: string | null;
  thermal: ThermalZone[];
  storage: Mount[];
  network: Interface[];
  llm: LlmStatus[];
}

export interface Snapshot {
  at: number;
  demoMode: boolean;
  pollIntervalMs: number;
  nodes: NodeSnapshot[];
}

export interface History {
  timestamps: number[];
  gpuUtilization: number[];
  gpuMemoryPercent: number[];
  gpuTemperature: number[];
  gpuPower: number[];
  cpuPercent: number[];
  memoryPercent: number[];
  networkRx: number[];
  networkTx: number[];
  llmDecodeRate: number[];
}

export type HistoryMap = Record<string, History>;

export interface TestResult {
  connection: { ok: boolean; detail: string | null };
  gpu: { ok: boolean; detail: string | null };
  llm: { port: number; ok: boolean; detail: string | null }[];
}

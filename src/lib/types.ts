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
  /* Physical SM count from the CUDA driver API; null when the probe failed. */
  smCount: number | null;
  isUnified: boolean;
}

export interface GpuProcess {
  pid: number;
  name: string;
  command: string;
  memory: number | null;
  /* Share of SM time, from nvidia-smi pmon; null when it does not report one. */
  sm: number | null;
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

export type HfRepoType = 'model' | 'dataset' | 'space';
export type HfJobStatus =
  | 'starting'
  | 'running'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'orphaned';

export interface HfRepo {
  id: string;
  repoId: string;
  repoType: HfRepoType;
  /* null when hf reported a size it could not express in bytes. */
  sizeBytes: number | null;
  sizeText: string;
  lastAccessed: string;
  lastModified: string;
  refs: string[];
}

export interface HfJob {
  id: string;
  repoId: string;
  repoType: HfRepoType;
  revision: string | null;
  status: HfJobStatus;
  totalBytes: number | null;
  downloadedBytes: number;
  /* null when the total could not be determined - show bytes, not a fake bar. */
  percent: number | null;
  message: string | null;
  startedAt: number | null;
}

export interface HfState {
  available: boolean;
  error: string | null;
  bin: string | null;
  version: string | null;
  /* null means hf is installed but nobody is logged in. */
  user: string | null;
  cacheDir: string | null;
  repos: HfRepo[];
  totalBytes: number;
  jobs: HfJob[];
  reclaimable: {
    incompleteFiles: number;
    incompleteBytes: number;
    pruneBytes: number | null;
    pruneRevisions: number;
  };
  scannedAt: number | null;
}

export interface HfDeletePreview {
  repoId: string;
  repoType: HfRepoType;
  repos: number;
  revisions: number;
  sizeText: string;
  sizeBytes: number | null;
}

export type RunPhase = 'download' | 'image' | 'launch' | 'wait' | 'ready';

export type RunStatus =
  | 'starting'
  | 'downloading'
  | 'pulling'
  | 'launching'
  | 'waiting'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'orphaned';

/* A whole serving configuration - weights, image and every flag - rather than a
 * template with blanks. Served once per connection; it never changes at runtime. */
export type RecipeRuntime = 'vllm' | 'service';

export interface Recipe {
  id: string;
  /* 'vllm' has weights, serving flags and a KV cache to size; 'service' is a
   * container that brings its own entrypoint and declares a flat figure. */
  runtime: RecipeRuntime;
  name: string;
  summary: string;
  modelRepoId: string | null;
  draftRepoId: string | null;
  imageRef: string;
  buildsImage: boolean;
  port: number;
  containerName: string;
  /* Read back out of the recipe's own flags; null when it left the choice to
   * vLLM by not setting --max-model-len / --max-num-seqs. */
  contextLength: number | null;
  concurrency: number | null;
  weightsBytes: number;
  args: string[];
  notes: string[];
}

export interface PlanIssue {
  code: string;
  message: string;
}

/* Recomputed on every poll against that poll's own figures, so what the panel
 * shows and what the server will allow can never disagree. */
export interface RecipePlan {
  recipeId: string;
  fits: boolean;
  memory: {
    unified: boolean;
    weightsBytes: number;
    /* Non-torch allocations, peak activation and CUDA graph capture. */
    overheadBytes: number;
    /* The term that moves with the tuning below. */
    kvBytes: number;
    kvTokens: number;
    requiredBytes: number;
    /* What vLLM will actually ask for: its utilisation fraction of total. */
    claimBytes: number | null;
    availableBytes: number | null;
    totalBytes: number | null;
  };
  /* What this plan was priced at, and the room to move. Null for a service
   * recipe: there is nothing to tune, so the panel shows no sliders. */
  tuning: {
    contextLength: number;
    maxRequests: number;
    gpuMemoryUtilization: number | null;
    /* The smallest fraction that still covers the settings above. */
    minUtilization: number | null;
    /* False once the user has pinned a fraction of their own. */
    automatic: boolean;
    contextOptions: number[];
    requestOptions: number[];
  } | null;
  disk: {
    downloadBytes: number;
    availableBytes: number | null;
    mount: string | null;
  };
  repos: { repoId: string; repoType: HfRepoType; cached: boolean }[];
  /* null when the node's image list has not been read yet. */
  imagePresent: boolean | null;
  blockers: PlanIssue[];
  warnings: PlanIssue[];
}

export interface Run {
  id: string;
  recipeId: string;
  recipeName: string;
  modelRepoId: string;
  containerName: string;
  port: number | null;
  apiKey: string | null;
  phase: RunPhase | null;
  status: RunStatus;
  totalBytes: number | null;
  downloadedBytes: number;
  /* Only the download phase has a denominator; every other phase reports null. */
  percent: number | null;
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface PlannerState {
  runs: Run[];
  plans: RecipePlan[];
}

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
  /* Local image tags, so the planner knows what still has to be pulled. */
  dockerImages: string[];
  /* False when Docker is absent or unreachable; dockerError says which. */
  dockerAvailable: boolean;
  dockerError: string | null;
  hf: HfState;
  planner: PlannerState;
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

/*
 * A control-plane secret. The value is write-only: the server reports whether
 * one is stored and the last four characters of it, never the secret itself.
 */
export interface VaultEntry {
  name: string;
  label: string;
  summary: string;
  /* What a valid value looks like, shown under the field. */
  hint: string;
  placeholder: string;
  set: boolean;
  preview: string | null;
  updatedAt: string | null;
}

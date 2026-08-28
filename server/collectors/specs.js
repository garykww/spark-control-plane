/*
 * Published specifications for the DGX Spark (GB10). These are constants rather
 * than probed values: several of them (memory bandwidth, FP4 throughput) are not
 * exposed by any driver interface, and the rest are fixed for the platform.
 *
 * Nodes registered as type "gpu-host" show detected hardware instead.
 */
export const DGX_SPARK_SPEC = {
  platform: 'NVIDIA DGX Spark',
  soc: 'GB10 Grace Blackwell Superchip',
  gpu: 'Blackwell, 5th-gen Tensor Cores',
  cpu: '20-core Arm (10x Cortex-X925 + 10x Cortex-A725)',
  cpuCores: 20,
  memoryBytes: 128 * 1024 ** 3,
  memoryType: 'LPDDR5X unified',
  memoryBandwidthGBs: 273,
  aiPerformance: '1 PFLOP FP4 (sparse)',
  networking: 'ConnectX-7 200GbE + 10GbE RJ45 + Wi-Fi 7',
  powerWatts: 240,
};

/*
 * Bandwidth is not measurable from userspace, so the UI shows a utilisation
 * estimate derived from the memory controller's reported activity when the
 * driver exposes it, and hides the panel otherwise.
 */
export function specForNode(node) {
  return node.type === 'dgx-spark' ? DGX_SPARK_SPEC : null;
}

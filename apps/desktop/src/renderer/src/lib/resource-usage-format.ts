import { formatBytes } from '@caxri/utils';

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * Process readings arrive as `memoryMb` (`ps` RSS or Electron working set). Printing that verbatim (`2402.8 MB`) never
 * rolls over into GB, so every surface that shows one (the status bar chip, Process Explorer, the resource alert) goes
 * through the shared binary-unit `formatBytes` here instead of a one-off.
 */
export function formatMemoryMb(memoryMb: number): string {
    return formatBytes(Math.round(memoryMb * BYTES_PER_MEBIBYTE));
}

/**
 * `ps`-style CPU, where a busy multi-process tree exceeds 100%. One decimal while small enough for it to matter, whole
 * percent once it does not.
 */
export function formatCpuPercent(cpuPercent: number): string {
    return cpuPercent < 10 ? `${cpuPercent.toFixed(1)}%` : `${Math.round(cpuPercent)}%`;
}

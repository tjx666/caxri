import { formatBytes } from '@caxri/utils';

const BYTES_PER_MEBIBYTE = 1024 * 1024;

/**
 * The status bar's process-tree memory chip used to print `terminal.resources`' `memoryMb` verbatim (`2402.8 MB`),
 * which never rolls over into GB and does not round to a width the chip's fixed slot expects. Routing it through the
 * shared `formatBytes` — already used by the update-download chip — keeps one binary-unit formatter for the whole
 * Renderer instead of a second one-off here.
 */
export function terminalMemoryLabel(memoryMb: number): string {
    return formatBytes(Math.round(memoryMb * BYTES_PER_MEBIBYTE));
}

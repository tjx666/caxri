import { execFile } from 'node:child_process';
import { cpus, loadavg } from 'node:os';
import process from 'node:process';
import { promisify } from 'node:util';

import type { WebContents } from 'electron';
import { app, BrowserWindow } from 'electron';

/**
 * Content-free facts Main can read about a hung Renderer without its cooperation. They exist because the call stack is
 * unavailable for native work (#3389): two production hangs of 8s and 11s both logged `stackOutcome: timeout` and no
 * `renderer.jank` record, which means no Long Animation Frame ever completed. These fields tell apart the causes that
 * leaves open:
 *
 * - A Renderer burning a core (`rendererCpuPercent` near 100) is stuck in native layout, style, or GC work.
 * - A Renderer near 0% CPU is blocked waiting (GPU, IPC, a lock) or was not scheduled; a `loadAverage1m` far above
 *   `cpuCount` points at the second.
 * - A GPU process at high CPU with an idle Renderer points at compositor starvation.
 * - A hidden, minimized, or unfocused window points at OS-level throttling rather than the page.
 *
 * Every value is a number or boolean; nothing here can carry source, Terminal output, or paths.
 */
export interface RendererHangEvidence {
    /**
     * Logical cores, to read `loadAverage1m` against.
     */
    cpuCount: number;
    /**
     * Average CPU of the GPU process since the sampler was marked; 100 is one fully used core.
     */
    gpuCpuPercent?: number;
    loadAverage1m: number;
    /**
     * Average CPU of Main since the sampler was marked.
     */
    mainCpuPercent?: number;
    /**
     * Average CPU of the Renderer process since the sampler was marked, which is a little before the hang was detected.
     * Measured from `ps` cumulative CPU time: Electron's `getAppMetrics` percentage read 6% for a Renderer spinning in
     * a JavaScript loop on macOS, so it cannot tell busy from blocked.
     */
    rendererCpuPercent?: number;
    /**
     * First letter of the Renderer's `ps` state when the hang was detected: `R` running, `S` sleeping, `U` stuck in an
     * uninterruptible wait (a page fault or disk I/O), `T` stopped.
     */
    rendererProcessState?: string;
    rendererWorkingSetMb?: number;
    windowFocused?: boolean;
    windowMinimized?: boolean;
    windowVisible?: boolean;
}

const execFileAsync = promisify(execFile);

export interface RendererHangEvidenceSampler {
    /**
     * Records each process's cumulative CPU time, the start of the measurement window. Never rejects.
     */
    mark(): void;
    /**
     * Never rejects; a field it cannot measure is omitted.
     */
    read(): Promise<RendererHangEvidence>;
}

interface ProcessSnapshot {
    atMs: number;
    cpuSeconds: number;
    state: string;
}

interface ProcessIds {
    gpu?: number;
    main: number;
    renderer?: number;
}

export interface RendererHangEvidenceDependencies {
    cpuCount?: () => number;
    getLoadAverage1m?: () => number;
    getProcessIds?: (webContents: WebContents) => ProcessIds;
    getWindow?: (
        webContents: WebContents,
    ) => Pick<BrowserWindow, 'isFocused' | 'isMinimized' | 'isVisible'> | null;
    now?: () => number;
    /**
     * Cumulative CPU time and state per pid; a pid that has exited is absent.
     */
    readProcesses?: (pids: number[]) => Promise<Map<number, Omit<ProcessSnapshot, 'atMs'>>>;
    /**
     * Working set of the Renderer in megabytes.
     */
    getRendererWorkingSetMb?: (pid: number) => number | undefined;
}

export function createRendererHangEvidenceSampler(
    webContents: WebContents,
    dependencies: RendererHangEvidenceDependencies = {},
): RendererHangEvidenceSampler {
    const getProcessIds = dependencies.getProcessIds ?? defaultProcessIds;
    const getWindow =
        dependencies.getWindow ?? ((contents) => BrowserWindow.fromWebContents(contents));
    const getCpuCount = dependencies.cpuCount ?? (() => cpus().length);
    const getLoadAverage1m = dependencies.getLoadAverage1m ?? (() => loadavg()[0] ?? 0);
    const readProcesses = dependencies.readProcesses ?? readProcessesWithPs;
    const getWorkingSetMb = dependencies.getRendererWorkingSetMb ?? defaultWorkingSetMb;
    const now = dependencies.now ?? Date.now;
    let baseline = Promise.resolve(new Map<number, ProcessSnapshot>());

    async function snapshot(pids: number[]): Promise<Map<number, ProcessSnapshot>> {
        const atMs = now();
        try {
            const processes = await readProcesses(pids);
            return new Map([...processes].map(([pid, value]) => [pid, { atMs, ...value }]));
        } catch {
            return new Map();
        }
    }

    function targets(): ProcessIds | undefined {
        if (webContents.isDestroyed()) return undefined;
        try {
            return getProcessIds(webContents);
        } catch {
            return undefined;
        }
    }

    return {
        mark() {
            const ids = targets();
            if (ids) baseline = snapshot(definedPids(ids));
        },
        async read() {
            const ids = targets();
            const window = webContents.isDestroyed() ? null : getWindow(webContents);
            const evidence: RendererHangEvidence = {
                cpuCount: getCpuCount(),
                loadAverage1m: roundTo(getLoadAverage1m(), 1),
                ...(window && {
                    windowFocused: window.isFocused(),
                    windowMinimized: window.isMinimized(),
                    windowVisible: window.isVisible(),
                }),
            };
            if (!ids) return evidence;
            const [before, after] = [await baseline, await snapshot(definedPids(ids))];
            const percent = (pid: number | undefined): number | undefined => {
                const start = pid === undefined ? undefined : before.get(pid);
                const end = pid === undefined ? undefined : after.get(pid);
                if (!start || !end || end.atMs <= start.atMs) return undefined;
                const busy = (end.cpuSeconds - start.cpuSeconds) / ((end.atMs - start.atMs) / 1000);
                return roundTo(busy * 100, 0);
            };
            const renderer = percent(ids.renderer);
            const gpu = percent(ids.gpu);
            const main = percent(ids.main);
            const state = ids.renderer === undefined ? undefined : after.get(ids.renderer)?.state;
            const workingSetMb =
                ids.renderer === undefined
                    ? undefined
                    : safely(() => getWorkingSetMb(ids.renderer!));
            return {
                ...evidence,
                ...(renderer !== undefined && { rendererCpuPercent: renderer }),
                ...(state && { rendererProcessState: state }),
                ...(workingSetMb !== undefined && { rendererWorkingSetMb: workingSetMb }),
                ...(gpu !== undefined && { gpuCpuPercent: gpu }),
                ...(main !== undefined && { mainCpuPercent: main }),
            };
        },
    };
}

function safely<T>(read: () => T): T | undefined {
    try {
        return read();
    } catch {
        return undefined;
    }
}

function definedPids(ids: ProcessIds): number[] {
    return [ids.renderer, ids.gpu, ids.main].filter((pid): pid is number => pid !== undefined);
}

function defaultProcessIds(webContents: WebContents): ProcessIds {
    const gpu = app.getAppMetrics().find((metric) => metric.type === 'GPU');
    return {
        main: process.pid,
        renderer: webContents.getOSProcessId(),
        ...(gpu && { gpu: gpu.pid }),
    };
}

function defaultWorkingSetMb(pid: number): number | undefined {
    const metric = app.getAppMetrics().find((candidate) => candidate.pid === pid);
    return metric && roundTo(metric.memory.workingSetSize / 1024, 0);
}

/**
 * Reads cumulative CPU time and state with one `ps` call. Unavailable on Windows, where it resolves empty.
 */
async function readProcessesWithPs(
    pids: number[],
): Promise<Map<number, Omit<ProcessSnapshot, 'atMs'>>> {
    const result = new Map<number, Omit<ProcessSnapshot, 'atMs'>>();
    if (process.platform === 'win32' || pids.length === 0) return result;
    const { stdout } = await execFileAsync(
        'ps',
        ['-o', 'pid=,state=,time=', '-p', pids.join(',')],
        {
            timeout: 2_000,
        },
    );
    for (const line of stdout.split('\n')) {
        const [pid, state, time] = line.trim().split(/\s+/u, 3);
        const cpuSeconds = parsePsCpuTime(time);
        if (pid && state && cpuSeconds !== undefined)
            result.set(Number(pid), { cpuSeconds, state: state.slice(0, 1) });
    }
    return result;
}

/**
 * Parses `ps` cumulative CPU time, `[[dd-]hh:]mm:ss[.cc]`.
 */
export function parsePsCpuTime(time: string | undefined): number | undefined {
    const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+(?:\.\d+)?)$/u.exec(time ?? '');
    if (!match) return undefined;
    const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match;
    return Number(days) * 86_400 + Number(hours) * 3_600 + Number(minutes) * 60 + Number(seconds);
}

function roundTo(value: number, digits: number): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

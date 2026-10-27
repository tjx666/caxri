import { execFileAsync } from '@caxri/system';

const PROCESS_QUERY_TIMEOUT_MS = 2_000;
const PROCESS_QUERY_MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/**
 * How long a finished machine-wide read answers later probes. Under half the one-second probe interval, so each watched
 * Terminal still sees a table at most this old on every probe, while watches whose timers drift apart within one
 * interval still share one read.
 */
const PROCESS_LIST_REUSE_MS = 400;

/**
 * Reads the whole machine's process table (PID, parent, process group, terminal foreground group, command). Process
 * identity only: the output is never logged, persisted, or sent to the Renderer.
 */
export async function readMachineProcessList(): Promise<string> {
    const result = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='], {
        encoding: 'utf8',
        maxBuffer: PROCESS_QUERY_MAX_BUFFER_BYTES,
        timeout: PROCESS_QUERY_TIMEOUT_MS,
    });
    return result.stdout;
}

interface ProcessListRead {
    output: Promise<string>;
    /**
     * When the read finished; unset while it is in flight.
     */
    settledAt?: number;
}

interface SharedProcessListOptions {
    now?: () => number;
    read?: () => Promise<string>;
    reuseMs?: number;
}

/**
 * One machine-wide `/bin/ps` table shared by every foreground-Agent probe. Each read costs tens of milliseconds of CPU
 * on a machine with about a thousand processes, and every manually started Agent's exit watch probes once a second, so
 * without sharing N watched Terminals paid for N reads a second (#2748). Concurrent callers join the read in flight,
 * and a read that finished within {@link PROCESS_LIST_REUSE_MS} answers without spawning; a failed read is never
 * reused.
 */
export class SharedProcessList {
    private current?: ProcessListRead;
    private readonly now: () => number;
    private readonly readTable: () => Promise<string>;
    private readonly reuseMs: number;

    constructor(options: SharedProcessListOptions = {}) {
        this.now = options.now ?? (() => performance.now());
        this.readTable = options.read ?? readMachineProcessList;
        this.reuseMs = options.reuseMs ?? PROCESS_LIST_REUSE_MS;
    }

    private async settle(entry: ProcessListRead): Promise<string> {
        try {
            const output = await this.readTable();
            entry.settledAt = this.now();
            return output;
        } catch (error) {
            if (this.current === entry) this.current = undefined;
            throw error;
        }
    }

    read(): Promise<string> {
        const current = this.current;
        if (
            current &&
            (current.settledAt === undefined || this.now() - current.settledAt < this.reuseMs)
        )
            return current.output;
        const entry: ProcessListRead = { output: Promise.resolve('') };
        this.current = entry;
        entry.output = this.settle(entry);
        return entry.output;
    }
}

/**
 * The Server's shared table for foreground-Agent detection.
 */
export const foregroundProcessList = new SharedProcessList();

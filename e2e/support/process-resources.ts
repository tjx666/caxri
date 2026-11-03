import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './electron-app.ts';

interface ProcessRecord {
    command: string;
    /**
     * Cumulative user plus system CPU time, in seconds.
     */
    cpuSeconds: number;
    pid: number;
    ppid: number;
    rssKiB: number;
}

/**
 * Parses `ps` `time=` output (`[[DD-]HH:]MM:SS.ss`) into seconds.
 */
function parseCpuTime(value: string): number {
    const [days, clock] = value.includes('-') ? value.split('-') : ['0', value];
    return (
        Number(days) * 86_400 +
        clock.split(':').reduce((total, part) => total * 60 + Number(part), 0)
    );
}

async function listProcesses(): Promise<ProcessRecord[]> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,time=,command=']);
    return stdout
        .split('\n')
        .filter(Boolean)
        .map((line): ProcessRecord => {
            const [pid, ppid, rssKiB, time, ...command] = line.trim().split(/\s+/u);
            if (!pid || !ppid || !rssKiB || !time || command.length === 0)
                throw new Error(`Unexpected process resource record: ${line}`);
            return {
                command: command.join(' '),
                cpuSeconds: parseCpuTime(time),
                pid: Number(pid),
                ppid: Number(ppid),
                rssKiB: Number(rssKiB),
            };
        });
}

/**
 * Server Core and the helper processes it owns whose script matches `helper`. Agent processes it launches are never
 * included, so an Agent's own memory does not count against Caxri.
 */
function serverOwners(
    processes: readonly ProcessRecord[],
    serverCorePid: number,
    helper: RegExp,
): ProcessRecord[] {
    const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
    const isServerDescendant = (entry: ProcessRecord): boolean => {
        const visited = new Set<number>();
        let current: ProcessRecord | undefined = entry;
        while (current && !visited.has(current.pid)) {
            if (current.ppid === serverCorePid) return true;
            visited.add(current.pid);
            current = byPid.get(current.ppid);
        }
        return false;
    };
    const owners = processes.filter(
        (entry) =>
            entry.pid === serverCorePid ||
            (isServerDescendant(entry) && helper.test(entry.command)),
    );
    if (owners.every((entry) => entry.pid !== serverCorePid))
        throw new Error('Server Core process disappeared before resource measurement');
    return owners;
}

const kibToMb = (kib: number): number => Math.round((kib / 1024) * 10) / 10;

/**
 * Measures every general Server owner that replaced the legacy Host + Runtime pair. Extension Host remains excluded
 * because it was already independent in A0; Terminal Host is included once A3b splits it from Server Core. This keeps
 * the same memory and descriptor budget meaningful across deliberate process-topology changes.
 */
export async function measureServerOwnerResources(serverCorePid: number): Promise<{
    memoryMb: number;
    openDescriptors: number;
}> {
    const owners = serverOwners(
        await listProcesses(),
        serverCorePid,
        /(?:^|\/)terminal-host\.js(?:\s|$)/u,
    );
    const descriptorCounts = await Promise.all(
        owners.map(async ({ pid }) => {
            const { stdout: openFiles } = await execFileAsync('lsof', ['-p', String(pid)]);
            return openFiles.split('\n').filter(Boolean).length - 1;
        }),
    );
    return {
        memoryMb: owners.reduce((total, entry) => total + entry.rssKiB, 0) / 1024,
        openDescriptors: descriptorCounts.reduce((total, count) => total + count, 0),
    };
}

/**
 * Resident memory of the whole app, in MB: every Electron process (Main, Renderers, GPU, utilities) from
 * `app.getAppMetrics()`, plus Server Core, Terminal Host, and Extension Host. Agent processes are excluded.
 */
export async function measureAppMemory(
    app: E2EApp,
    serverCorePid: number,
): Promise<{ electronMb: number; serverMb: number; totalMb: number }> {
    const electronKiB = await app.evaluate(({ app: electron }) =>
        electron.getAppMetrics().reduce((total, metric) => total + metric.memory.workingSetSize, 0),
    );
    const serverKiB = serverOwners(
        await listProcesses(),
        serverCorePid,
        /(?:^|\/)(?:terminal|extension)-host\.js(?:\s|$)/u,
    ).reduce((total, entry) => total + entry.rssKiB, 0);
    return {
        electronMb: kibToMb(electronKiB),
        serverMb: kibToMb(serverKiB),
        totalMb: kibToMb(electronKiB + serverKiB),
    };
}

/**
 * One process role in an idle sample, keyed by Electron's `app.getAppMetrics()` type (`electron:Tab` is the Renderer)
 * or by Server owner (`server-core`, `terminal-host`, `extension-host`).
 */
export interface IdleRoleSample {
    /**
     * Share of one CPU core used over the sample window, in percent (100 = one core fully busy).
     */
    cpuPercent: number;
    /**
     * Physical footprint, the "Memory" column of Activity Monitor, in MB.
     */
    footprintMb: number;
    /**
     * Resident set size in MB. Counts pages shared between Electron processes once per process, so the sum over roles
     * overstates what the app costs; prefer `footprintMb` for totals.
     */
    rssMb: number;
    processes: number;
}

const FOOTPRINT_UNITS: Record<string, number> = { B: 1 / 1_048_576, K: 1 / 1024, M: 1, G: 1024 };

/**
 * Physical footprint per PID from one `top` sample. `ps` has no footprint column, and `top`'s `mem` is the value
 * Activity Monitor shows.
 */
async function footprintsMb(pids: readonly number[]): Promise<Map<number, number>> {
    const { stdout } = await execFileAsync('top', [
        '-l',
        '1',
        '-stats',
        'pid,mem',
        ...pids.flatMap((pid) => ['-pid', String(pid)]),
    ]);
    const footprints = new Map<number, number>();
    for (const line of stdout.split('\n')) {
        const match = /^(\d+)\s+([\d.]+)([BKMG])/u.exec(line.trim());
        if (match) footprints.set(Number(match[1]), Number(match[2]) * FOOTPRINT_UNITS[match[3]]);
    }
    return footprints;
}

/**
 * Samples CPU and memory of every Caxri process over `sampleMs` while the app is left alone: Electron processes from
 * `app.getAppMetrics()` plus Server Core, Terminal Host, and Extension Host. Agent processes are excluded. A process
 * that starts or exits during the window is left out, so a sample is only meaningful when the app is idle.
 */
export async function sampleIdleResources(
    app: E2EApp,
    serverCorePid: number,
    sampleMs: number,
): Promise<{
    roles: Record<string, IdleRoleSample>;
    total: { cpuPercent: number; footprintMb: number };
}> {
    const electron = await app.evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map(({ pid, type }) => ({ pid, type })),
    );
    const before = await listProcesses();
    const roleByPid = new Map<number, string>(
        electron.map(({ pid, type }) => [pid, `electron:${type}`]),
    );
    for (const owner of serverOwners(
        before,
        serverCorePid,
        /(?:^|\/)(?:terminal|extension)-host\.js(?:\s|$)/u,
    )) {
        const helper = /(terminal|extension)-host\.js/u.exec(owner.command)?.[1];
        roleByPid.set(owner.pid, helper ? `${helper}-host` : 'server-core');
    }
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
    const after = new Map((await listProcesses()).map((entry) => [entry.pid, entry]));
    const beforeByPid = new Map(before.map((entry) => [entry.pid, entry]));
    const stable = roleByPid
        .keys()
        .filter((pid) => after.has(pid) && beforeByPid.has(pid))
        .toArray();
    const footprints = await footprintsMb(stable);
    const roles: Record<string, IdleRoleSample> = {};
    for (const pid of stable) {
        const role = roleByPid.get(pid)!;
        const sample = (roles[role] ??= { cpuPercent: 0, footprintMb: 0, rssMb: 0, processes: 0 });
        sample.cpuPercent +=
            ((after.get(pid)!.cpuSeconds - beforeByPid.get(pid)!.cpuSeconds) / (sampleMs / 1000)) *
            100;
        sample.footprintMb += footprints.get(pid) ?? 0;
        sample.rssMb += after.get(pid)!.rssKiB / 1024;
        sample.processes += 1;
    }
    const round = (value: number): number => Math.round(value * 10) / 10;
    for (const sample of Object.values(roles)) {
        sample.cpuPercent = round(sample.cpuPercent);
        sample.footprintMb = round(sample.footprintMb);
        sample.rssMb = round(sample.rssMb);
    }
    const samples = Object.values(roles);
    return {
        roles,
        total: {
            cpuPercent: round(samples.reduce((sum, sample) => sum + sample.cpuPercent, 0)),
            footprintMb: round(samples.reduce((sum, sample) => sum + sample.footprintMb, 0)),
        },
    };
}

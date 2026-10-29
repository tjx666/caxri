import { execFileAsync } from '@caxri/system';

import type { E2EApp } from './electron-app.ts';

interface ProcessRecord {
    command: string;
    pid: number;
    ppid: number;
    rssKiB: number;
}

async function listProcesses(): Promise<ProcessRecord[]> {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,rss=,command=']);
    return stdout
        .split('\n')
        .filter(Boolean)
        .map((line): ProcessRecord => {
            const [pid, ppid, rssKiB, ...command] = line.trim().split(/\s+/u);
            if (!pid || !ppid || !rssKiB || command.length === 0)
                throw new Error(`Unexpected process resource record: ${line}`);
            return {
                command: command.join(' '),
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

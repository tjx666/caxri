import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

const execFileAsync = promisify(execFile);

/**
 * `ps` prints `lstart` as `Tue Oct 20 16:09:54 2026`; with `LC_ALL=C` the layout is the same on macOS and Linux.
 */
const PROCESS_ROW = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/u;

/**
 * One row of the host process table.
 */
export interface ProcessTableEntry {
    pid: number;
    pgid: number;
    /**
     * The process start time as `ps` printed it (second resolution).
     */
    startedAt: string;
}

export type ReadProcessTable = () => Promise<ProcessTableEntry[]>;

/**
 * Durable record of the provider process groups the running Server Core owns; see `agentChatProcessGroups`.
 */
export interface ProviderGroupLedger {
    record(group: { pgid: number; terminalId: string; leaderStartedAt: string }): void;
    /**
     * With `leaderStartedAt`, removes the record only while it still carries that start time, so the startup sweep
     * never deletes the record of a group a newer Chat registered under the same ID meanwhile.
     */
    forget(pgid: number, leaderStartedAt?: string): void;
    list(): Array<{ pgid: number; terminalId: string; leaderStartedAt: string }>;
}

/**
 * What a spawned provider needs to register its process group: the Chat it serves and where to record the group.
 */
export interface ProviderGroupRegistration {
    terminalId: string;
    ledger: Pick<ProviderGroupLedger, 'forget' | 'record'>;
}

async function runPs(arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('ps', arguments_, {
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
}

/**
 * The host process table (pid, process group, start time) from `ps`, available on macOS and Linux. Throws when `ps` is
 * missing or fails; callers treat that as "identity cannot be verified" and signal nothing.
 */
const readProcessTable: ReadProcessTable = async () => {
    const stdout = await runPs(['-axo', 'pid=,pgid=,lstart=']);
    return stdout.split('\n').flatMap((line) => {
        const match = PROCESS_ROW.exec(line);
        return match
            ? [{ pid: Number(match[1]), pgid: Number(match[2]), startedAt: match[3] }]
            : [];
    });
};

/**
 * The start time `ps` reports for `pid`, or undefined when it is gone or `ps` fails.
 */
async function readProcessStart(pid: number): Promise<string | undefined> {
    try {
        const stdout = await runPs(['-o', 'lstart=', '-p', String(pid)]);
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Records a freshly spawned provider's process group. Resolves once the record is written or skipped; never rejects,
 * because a failed record only costs the reaping of a SIGKILLed Server Core's leftovers.
 */
export async function registerProviderGroup(
    registration: ProviderGroupRegistration,
    pgid: number,
): Promise<void> {
    try {
        const leaderStartedAt = await readProcessStart(pgid);
        if (leaderStartedAt)
            registration.ledger.record({
                pgid,
                terminalId: registration.terminalId,
                leaderStartedAt,
            });
    } catch {
        // Best effort, see above.
    }
}

/**
 * Why a recorded group was or was not stopped: `reaped` signaled live members that provably belong to it; `gone` had no
 * live member left; `reused` is a different process group that merely carries the recorded ID.
 */
type StaleGroupOutcome = 'gone' | 'reaped' | 'reused';

/**
 * Decides whether process group `pgid`, recorded with its leader's start time, still holds its original members. A
 * POSIX kernel keeps a group ID reserved while any member lives, so the ID can only be handed to a new group after the
 * old one emptied, and that new group's leader has pid == pgid. A leader with a different start time therefore means
 * the ID was reused. With the leader gone and members alive, the group is the original one, and any member that began
 * before the recorded leader would contradict that, so it is refused too.
 */
function classifyGroup(
    table: readonly ProcessTableEntry[],
    group: { pgid: number; leaderStartedAt: string },
): StaleGroupOutcome {
    const members = table.filter((entry) => entry.pgid === group.pgid);
    if (members.length === 0) return 'gone';
    const leader = members.find((entry) => entry.pid === group.pgid);
    if (leader) return leader.startedAt === group.leaderStartedAt ? 'reaped' : 'reused';
    const recorded = Date.parse(group.leaderStartedAt);
    if (Number.isNaN(recorded)) return 'reused';
    const isEarlier = members.some((entry) => {
        const startedAt = Date.parse(entry.startedAt);
        return Number.isNaN(startedAt) || startedAt < recorded;
    });
    return isEarlier ? 'reused' : 'reaped';
}

/**
 * Stops the provider process groups a previous Server Core lifetime left behind (it was SIGKILLed, crashed, or lost
 * power before its normal reaping ran). Every recorded group is checked against the live process table before anything
 * is signaled, so a process group ID that the OS handed to an unrelated process after the original group ended is never
 * signaled (see {@link classifyGroup}). Each record is removed afterwards, signaled or not. Never throws: when the
 * process table cannot be read, nothing is signaled and the records stay for the next start.
 */
export async function reapStaleProviderGroups(options: {
    ledger: () => ProviderGroupLedger;
    logger: StructuredLogger;
    reapGroup: (pgid: number) => Promise<void>;
    readTable?: ReadProcessTable;
}): Promise<void> {
    if (process.platform === 'win32') return;
    const startedAt = Date.now();
    try {
        const ledger = options.ledger();
        const groups = ledger.list();
        if (groups.length === 0) return;
        const table = await (options.readTable ?? readProcessTable)();
        const counts: Record<StaleGroupOutcome, number> = { gone: 0, reaped: 0, reused: 0 };
        // Groups are independent, so they are stopped together; each record is forgotten only after its own stop.
        await Promise.all(
            groups.map(async (group) => {
                // Never the group of this very process, whatever the record claims.
                const outcome = group.pgid <= 1 ? 'reused' : classifyGroup(table, group);
                counts[outcome] += 1;
                if (outcome === 'reaped') await options.reapGroup(group.pgid);
                ledger.forget(group.pgid, group.leaderStartedAt);
            }),
        );
        options.logger.write('info', logEventCatalog.agentChat.staleGroupsReaped, {
            fields: { recorded: groups.length, ...counts, durationMs: Date.now() - startedAt },
        });
    } catch {
        // The records stay and the next start retries.
    }
}

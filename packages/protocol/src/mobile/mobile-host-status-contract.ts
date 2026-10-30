import { z } from 'zod';

import { agentProviderSchema } from '../agent/agents.js';
import { identifierSchema } from '../domain/identifiers.js';
import { terminalKindSchema } from '../domain/terminal-record.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * A reply must fit one sealed gateway frame (64 KiB of plaintext); the Session list is the only part that grows with
 * use, so it is cut to this budget with room left for the envelope.
 */
export const MOBILE_HOST_STATUS_MAX_BYTES = 48 * 1_024;
const MOBILE_HOST_STATUS_MAX_SESSIONS = 40;
export const MOBILE_HOST_STATUS_MAX_TERMINALS_PER_SESSION = 8;
/**
 * The phone sorts the busiest processes by CPU or by memory without another round trip, so the reply carries the top
 * entries of both orders (their union, at most twice this many).
 */
export const MOBILE_HOST_STATUS_TOP_PROCESSES = 10;
export const MOBILE_HOST_STATUS_TITLE_MAX_LENGTH = 120;
const PROCESS_NAME_MAX_LENGTH = 120;
const CLIP_MARKER = '…';

const usageShape = {
    /**
     * Summed `ps` `%cpu`, the reading Desktop's Process Explorer shows, so a busy multi-process tree can exceed 100.
     */
    cpuPercent: z.number().nonnegative(),
    memoryMb: z.number().nonnegative(),
};

const mobileHostSystemSchema = z.strictObject({
    /**
     * Whole-machine busy share, 0–100 across all cores. Absent on the first read after Server Core starts, which has no
     * previous counter sample to compare with.
     */
    cpuPercent: z.number().min(0).max(100).optional(),
    cpuCount: z.number().int().positive(),
    /**
     * 1, 5, and 15 minute load averages; zeros where the platform reports none (Windows).
     */
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
    memoryTotalMb: z.number().nonnegative(),
    memoryUsedMb: z.number().nonnegative(),
    swapUsedMb: z.number().nonnegative().optional(),
    uptimeSeconds: z.number().nonnegative(),
});

/**
 * Caxri's own long-lived processes. Desktop is not listed: Server Core can outlive it and does not track its PID.
 */
const mobileHostServiceRoleSchema = z.enum(['serverCore', 'terminalHost', 'extensionHost']);

const mobileHostServiceSchema = z.strictObject({
    role: mobileHostServiceRoleSchema,
    pid: z.number().int().positive(),
    ...usageShape,
});

const mobileHostTerminalLoadSchema = z.strictObject({
    terminalId: identifierSchema,
    kind: terminalKindSchema,
    provider: agentProviderSchema.optional(),
    title: z.string().max(MOBILE_HOST_STATUS_TITLE_MAX_LENGTH + 1),
    ...usageShape,
    /**
     * The PTY root plus every descendant.
     */
    processCount: z.number().int().nonnegative(),
});

const mobileHostSessionLoadSchema = z.strictObject({
    sessionId: identifierSchema,
    title: z.string().max(MOBILE_HOST_STATUS_TITLE_MAX_LENGTH + 1),
    ...usageShape,
    processCount: z.number().int().nonnegative(),
    terminals: z
        .array(mobileHostTerminalLoadSchema)
        .max(MOBILE_HOST_STATUS_MAX_TERMINALS_PER_SESSION),
    /**
     * Every running Terminal of the Session, including any left out of `terminals`.
     */
    terminalTotal: z.number().int().nonnegative(),
});

const mobileHostProcessSchema = z.strictObject({
    pid: z.number().int().positive(),
    /**
     * The executable name (interpreter plus script for `node`, `bun`, …). Never the command line, whose arguments can
     * carry credentials.
     */
    name: z
        .string()
        .min(1)
        .max(PROCESS_NAME_MAX_LENGTH + 1),
    ...usageShape,
});

const mobileHostProcessesSchema = z.strictObject({
    services: z.array(mobileHostServiceSchema).max(8),
    /**
     * Sessions with at least one running Terminal, busiest first.
     */
    sessions: z.array(mobileHostSessionLoadSchema).max(MOBILE_HOST_STATUS_MAX_SESSIONS),
    /**
     * Every Session with a running Terminal, including any that did not fit this reply.
     */
    sessionTotal: z.number().int().nonnegative(),
    topProcesses: z.array(mobileHostProcessSchema).max(MOBILE_HOST_STATUS_TOP_PROCESSES * 2),
    /**
     * Every process on the machine.
     */
    processCount: z.number().int().nonnegative(),
});

export const mobileHostStatusSchema = z.strictObject({
    sampledAt: z.number(),
    system: mobileHostSystemSchema,
    /**
     * Absent when the process table could not be read; the system figures still stand on their own.
     */
    processes: mobileHostProcessesSchema.optional(),
});

export type MobileHostSystem = z.infer<typeof mobileHostSystemSchema>;
export type MobileHostService = z.infer<typeof mobileHostServiceSchema>;
export type MobileHostServiceRole = z.infer<typeof mobileHostServiceRoleSchema>;
export type MobileHostTerminalLoad = z.infer<typeof mobileHostTerminalLoadSchema>;
export type MobileHostSessionLoad = z.infer<typeof mobileHostSessionLoadSchema>;
export type MobileHostProcess = z.infer<typeof mobileHostProcessSchema>;
export type MobileHostStatus = z.infer<typeof mobileHostStatusSchema>;

/**
 * One Session's load before it is shortened for the phone: every running Terminal, untrimmed titles.
 */
export interface HostSessionLoadSample extends Omit<
    MobileHostSessionLoad,
    'terminals' | 'terminalTotal'
> {
    terminals: MobileHostTerminalLoad[];
}

/**
 * Everything Server Core sampled, unbounded; {@link projectHostStatusForMobile} cuts it to one frame.
 */
export interface HostStatusSample {
    sampledAt: number;
    system: MobileHostSystem;
    processes?: {
        services: MobileHostService[];
        sessions: HostSessionLoadSample[];
        /**
         * Every process on the machine, already reduced to its display name.
         */
        all: MobileHostProcess[];
    };
}

const clip = (text: string, limit: number): string =>
    text.length <= limit ? text : `${text.slice(0, limit)}${CLIP_MARKER}`;

const byteLength = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * A sorted copy. The phone's Hermes runtime lacks ES2023 `toSorted`, so this sorts a fresh copy in place.
 */
const sortedCopy = <T>(items: readonly T[], compare: (left: T, right: T) => number): T[] =>
    // eslint-disable-next-line unicorn/no-array-sort -- Sorts the fresh copy; see above.
    [...items].sort(compare);

const busiestFirst = <T extends { cpuPercent: number; memoryMb: number }>(
    left: T,
    right: T,
): number => right.cpuPercent - left.cpuPercent || right.memoryMb - left.memoryMb;

function topProcesses(all: readonly MobileHostProcess[]): MobileHostProcess[] {
    const byCpu = sortedCopy(all, busiestFirst).slice(0, MOBILE_HOST_STATUS_TOP_PROCESSES);
    const byMemory = sortedCopy(
        all,
        (left, right) => right.memoryMb - left.memoryMb || right.cpuPercent - left.cpuPercent,
    ).slice(0, MOBILE_HOST_STATUS_TOP_PROCESSES);
    const seen = new Set<number>();
    return [...byCpu, ...byMemory].flatMap((process) => {
        if (seen.has(process.pid)) return [];
        seen.add(process.pid);
        return [{ ...process, name: clip(process.name, PROCESS_NAME_MAX_LENGTH) }];
    });
}

function projectSession(session: HostSessionLoadSample): MobileHostSessionLoad {
    return {
        sessionId: session.sessionId,
        title: clip(session.title, MOBILE_HOST_STATUS_TITLE_MAX_LENGTH),
        cpuPercent: session.cpuPercent,
        memoryMb: session.memoryMb,
        processCount: session.processCount,
        terminals: sortedCopy(session.terminals, busiestFirst)
            .slice(0, MOBILE_HOST_STATUS_MAX_TERMINALS_PER_SESSION)
            .map((terminal) => ({
                ...terminal,
                title: clip(terminal.title, MOBILE_HOST_STATUS_TITLE_MAX_LENGTH),
            })),
        terminalTotal: session.terminals.length,
    };
}

/**
 * The computer status a phone can carry in one frame: Sessions busiest first, so the quiet ones are the first dropped
 * when the budget runs out; `sessionTotal` tells the phone how many exist.
 */
export function projectHostStatusForMobile(sample: HostStatusSample): MobileHostStatus {
    if (!sample.processes) return { sampledAt: sample.sampledAt, system: sample.system };
    const sessions = sortedCopy(sample.processes.sessions, busiestFirst);
    const base = {
        sampledAt: sample.sampledAt,
        system: sample.system,
        processes: {
            services: sample.processes.services,
            sessions: [] as MobileHostSessionLoad[],
            sessionTotal: sessions.length,
            topProcesses: topProcesses(sample.processes.all),
            processCount: sample.processes.all.length,
        },
    };
    let budget = MOBILE_HOST_STATUS_MAX_BYTES - byteLength(base);
    for (const session of sessions) {
        if (base.processes.sessions.length >= MOBILE_HOST_STATUS_MAX_SESSIONS) break;
        const projected = projectSession(session);
        const cost = byteLength(projected) + 1;
        if (cost > budget) break;
        budget -= cost;
        base.processes.sessions.push(projected);
    }
    return base;
}

/**
 * The paired Mac's live load. Control devices only: it names Sessions from every Project, beyond a narrower grant.
 */
export const mobileHostStatusMethods = {
    'mobile.host.status': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}).default({}),
        result: mobileHostStatusSchema,
    },
} as const satisfies Record<string, MethodSpec>;

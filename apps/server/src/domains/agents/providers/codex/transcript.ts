import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentEnvironment } from '../../contract';
import type { AgentTranscriptLocation } from '../../transcript-security';
import { resolveCodexHome } from './paths';

/**
 * One day of local Codex activity is a few hundred rollouts; a folder past this budget fails closed.
 */
const MAX_CODEX_SESSION_DAY_ENTRIES = 4_096;
/**
 * Codex thread ids are UUIDv7, so the first 48 bits carry the thread's creation time in milliseconds.
 */
const UUID_V7_PATTERN = /^([\da-f]{8})-([\da-f]{4})-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i;
const ROLLOUT_NAME_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[\da-f-]{36}\.jsonl$/i;

export function codexSessionsRoot(environment: AgentEnvironment): string {
    return join(resolveCodexHome(environment), 'sessions');
}

function uuidV7Timestamp(value: string): number | undefined {
    const match = UUID_V7_PATTERN.exec(value);
    if (!match) return;
    return Number.parseInt(`${match[1]}${match[2]}`, 16);
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

async function findRolloutName(directory: string, suffix: string): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    let scanned = 0;
    try {
        handle = await opendir(directory);
        for await (const entry of handle) {
            scanned += 1;
            if (scanned > MAX_CODEX_SESSION_DAY_ENTRIES) return;
            const name = entry.name.toLowerCase();
            if (entry.isFile() && name.endsWith(suffix) && ROLLOUT_NAME_PATTERN.test(name))
                return entry.name;
        }
    } catch {
        // A missing day folder is the normal case for two of the three candidate days.
    } finally {
        try {
            await handle?.close();
        } catch {
            // Async directory iteration already closes an exhausted handle.
        }
    }
    return undefined;
}

/**
 * Codex writes each thread to `sessions/YYYY/MM/DD/rollout-<wall clock>-<thread id>.jsonl`. The wall clock and the day
 * folder use the machine's local time and are sampled separately from the UUIDv7 thread id (about 3% of local rollouts
 * land one second apart), so the path cannot be derived purely. The thread id's own timestamp picks the day folder,
 * which is then listed for the file carrying that id; the neighbouring days absorb midnight and timezone drift. Only
 * directory entries are read here, never transcript contents.
 */
export async function locateCodexTranscript(
    context: { agentSessionId: string },
    environment: AgentEnvironment,
): Promise<AgentTranscriptLocation | undefined> {
    const createdAt = uuidV7Timestamp(context.agentSessionId);
    if (createdAt === undefined) return;
    const sessionsRoot = codexSessionsRoot(environment);
    const suffix = `-${context.agentSessionId.toLowerCase()}.jsonl`;
    const candidates = await Promise.all(
        [0, -1, 1].map(async (dayOffset) => {
            const day = new Date(createdAt);
            day.setDate(day.getDate() + dayOffset);
            const year = String(day.getFullYear());
            const month = pad(day.getMonth() + 1);
            const root = join(sessionsRoot, year, month, pad(day.getDate()));
            const name = await findRolloutName(root, suffix);
            return name
                ? {
                      anchorRoot: sessionsRoot,
                      baseRoot: join(sessionsRoot, year, month),
                      path: join(root, name),
                      root,
                  }
                : undefined;
        }),
    );
    return candidates.find((candidate) => candidate !== undefined);
}

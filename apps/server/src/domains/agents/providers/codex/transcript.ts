import { opendir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentEnvironment } from '../../contract';
import type { AgentTranscriptLocation } from '../../transcript-security';
import { resolveCodexHome, resolveCodexStateDirectories } from './paths';
import { CODEX_ROLLOUT_NAME_PATTERN, readCodexCurrentRolloutId } from './rollouts';

/**
 * One day of local Codex activity is a few hundred rollouts; a folder past this budget fails closed.
 */
const MAX_CODEX_SESSION_DAY_ENTRIES = 4_096;
/**
 * Codex thread ids are UUIDv7, so the first 48 bits carry the thread's creation time in milliseconds.
 */
const UUID_V7_PATTERN = /^([\da-f]{8})-([\da-f]{4})-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i;

function codexSessionsRoot(environment: AgentEnvironment): string {
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

async function findRolloutName(
    directory: string,
    suffix: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    let scanned = 0;
    try {
        signal?.throwIfAborted();
        handle = await opendir(directory);
        for await (const entry of handle) {
            signal?.throwIfAborted();
            scanned += 1;
            if (scanned > MAX_CODEX_SESSION_DAY_ENTRIES) return;
            const name = entry.name.toLowerCase();
            if (entry.isFile() && name.endsWith(suffix) && CODEX_ROLLOUT_NAME_PATTERN.test(name))
                return entry.name;
        }
    } catch {
        signal?.throwIfAborted();
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
 * Codex writes each thread to `sessions/YYYY/MM/DD/rollout-<wall clock>-<thread id>.jsonl` (see
 * {@link CODEX_ROLLOUT_NAME_PATTERN} for the reverted-thread form). The wall clock and the day folder use the machine's
 * local time and are sampled separately from the UUIDv7 thread id (about 3% of local rollouts land one second apart),
 * so the path cannot be derived purely. The thread id's own timestamp picks the day folder, which is then listed for
 * the file carrying that id; the neighbouring days absorb midnight and timezone drift. Only directory entries are read
 * here, never transcript contents.
 */
export async function locateCodexTranscript(
    context: { agentSessionId: string },
    environment: AgentEnvironment,
    signal?: AbortSignal,
): Promise<AgentTranscriptLocation | undefined> {
    signal?.throwIfAborted();
    if (uuidV7Timestamp(context.agentSessionId) === undefined) return;
    /**
     * A reverted thread continues in `rollout-<wall clock>-<thread id>_<rollout id>.jsonl`, written on the revert's day
     * rather than the thread's, so the rollout ID's own timestamp picks the day folder. The abandoned original rollout
     * stays on disk and must not be read as the live transcript.
     */
    const rolloutId = await readCodexCurrentRolloutId(
        context.agentSessionId,
        resolveCodexStateDirectories(environment),
    );
    signal?.throwIfAborted();
    const createdAt = uuidV7Timestamp(rolloutId ?? context.agentSessionId);
    if (createdAt === undefined) return;
    const sessionsRoot = codexSessionsRoot(environment);
    const suffix = rolloutId
        ? `-${context.agentSessionId.toLowerCase()}_${rolloutId.toLowerCase()}.jsonl`
        : `-${context.agentSessionId.toLowerCase()}.jsonl`;
    /**
     * Cancellation must retain the caller's scan slot until all directory handles have settled.
     */
    const candidates = await Promise.allSettled(
        [0, -1, 1].map(async (dayOffset) => {
            const day = new Date(createdAt);
            day.setDate(day.getDate() + dayOffset);
            const year = String(day.getFullYear());
            const month = pad(day.getMonth() + 1);
            const root = join(sessionsRoot, year, month, pad(day.getDate()));
            const name = await findRolloutName(root, suffix, signal);
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
    signal?.throwIfAborted();
    for (const candidate of candidates) {
        if (candidate.status === 'fulfilled' && candidate.value !== undefined)
            return candidate.value;
    }
    return undefined;
}

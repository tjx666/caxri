import { realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import type { AgentSnapshotContext, LocalAgentState } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';
import type { ProcessOpenFile } from '../../process-detection';
import { detectForegroundAgentOpenFiles } from '../../process-detection';
import { resolveCodexHome } from './paths';
import { CODEX_ROLLOUT_NAME_PATTERN, parseCodexRolloutName } from './rollouts';
import { readCodexState } from './thread-state';

const CODEX_THREAD_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i;
/**
 * `xxxxxxxx-xxxx`: the 48-bit big-endian millisecond timestamp a UUIDv7 carries in its first two groups, which sorts
 * lexicographically in creation order.
 */
const CODEX_THREAD_ID_TIMESTAMP_CHARACTERS = 13;
/**
 * How many of a Codex process's open threads may be inspected before the probe gives up. Only the foreground
 * conversation and threads it spawned can appear here, so a deeper set means the process is running background work
 * this probe cannot attribute, and spending one database query per candidate is the cost being bounded.
 */
const MAX_CODEX_OPEN_THREAD_CANDIDATES = 4;

function isWritableOpenFile(access: string): boolean {
    const normalized = access.trim().toLowerCase();
    return normalized === 'u' || normalized.includes('w');
}

/**
 * Every Codex thread held open for writing below the canonical Codex sessions root, newest first. A missing, malformed,
 * or foreign-root file contributes nothing, so an unreadable file set still yields no identity at all.
 *
 * More than one open rollout is the normal shape rather than an error: a `/new` inside a running Codex keeps the
 * conversation it just left open for minutes while it writes the replacement, and a background thread holds its own
 * rollout too. Refusing to decide there is what let a Terminal keep a conversation the user had already abandoned: the
 * binding never caught up, so restarting Caxri resumed the retired thread instead of the visible one. Ordering is the
 * thread id's own UUIDv7 timestamp (its first 48 bits, which {@link CODEX_THREAD_ID_PATTERN} already requires) rather
 * than the file name's local-time stamp, so a DST fall-back hour cannot reverse two threads.
 */
export function codexSessionIdsFromOpenFiles(
    files: readonly ProcessOpenFile[],
    sessionsRoot: string,
): string[] {
    if (!isAbsolute(sessionsRoot)) return [];
    const sessionIds = new Set<string>();
    for (const file of files) {
        if (!isWritableOpenFile(file.access)) continue;
        const suffix = relative(sessionsRoot, file.path);
        if (
            suffix === '' ||
            isAbsolute(suffix) ||
            suffix.startsWith(`..${sep}`) ||
            suffix.split(sep).length !== 4
        )
            continue;
        // A reverted thread's live rollout carries its rollout ID after the stable thread ID.
        const sessionId = parseCodexRolloutName(basename(file.path))?.threadId;
        if (!sessionId || !CODEX_THREAD_ID_PATTERN.test(sessionId)) continue;
        if (!isOpaqueAgentSessionId(sessionId)) continue;
        sessionIds.add(sessionId);
    }
    return [...sessionIds].toSorted((left, right) => {
        const byCreation = right
            .slice(0, CODEX_THREAD_ID_TIMESTAMP_CHARACTERS)
            .toLowerCase()
            .localeCompare(left.slice(0, CODEX_THREAD_ID_TIMESTAMP_CHARACTERS).toLowerCase());
        // Two threads created inside the same millisecond still need one stable order.
        return byCreation === 0 ? right.localeCompare(left) : byCreation;
    });
}

/**
 * Resolves identity from the rollout files the Codex process itself holds open.
 *
 * The three outcomes are distinct and the caller must not collapse them: a state means the process was identified,
 * `undefined` means the probe could not decide and heuristic discovery may still run, and `null` means the probe proved
 * this process owns no claimable thread: heuristic discovery must then stay out.
 */
export async function readCodexStateFromProcess(
    context: AgentSnapshotContext,
    environment: Parameters<typeof resolveCodexHome>[0],
    stateDirectories: string[],
): Promise<LocalAgentState | null | undefined> {
    if (
        context.agentSessionId ||
        context.shellPid === undefined ||
        context.processState !== 'running'
    )
        return undefined;
    let sessionsRoot: string;
    try {
        sessionsRoot = await realpath(join(resolveCodexHome(environment), 'sessions'));
    } catch {
        return undefined;
    }
    const openFiles = await detectForegroundAgentOpenFiles(context.shellPid, 'codex');
    if (openFiles.length === 0) return undefined;
    const candidateOpenFiles = openFiles.filter(
        (file) =>
            isWritableOpenFile(file.access) && CODEX_ROLLOUT_NAME_PATTERN.test(basename(file.path)),
    );
    /**
     * The probe listed this process's files and found no rollout among them. Codex only creates a thread once it
     * receives a first message, so this is proof of a thread-less Agent rather than a failed probe: `openFiles` is
     * empty when the probe itself is unusable, and that case returned above.
     *
     * Falling through to cwd discovery here is what let an idle Terminal adopt the next thread a sibling Session
     * started in the same directory: that query bounds candidates only by "created after this Terminal started", so a
     * Terminal waiting at an empty prompt claimed a thread created minutes later, and its automatic title then followed
     * the stolen binding.
     *
     * @see https://github.com/tjx666/caxri/issues/795
     */
    if (candidateOpenFiles.length === 0) return null;
    const canonicalFiles = (
        await Promise.all(
            candidateOpenFiles.map(async (file) => {
                try {
                    return { ...file, path: await realpath(file.path) };
                } catch {
                    return;
                }
            }),
        )
    ).filter((file): file is ProcessOpenFile => file !== undefined);
    const sessionIds = codexSessionIdsFromOpenFiles(canonicalFiles, sessionsRoot);
    if (sessionIds.length === 0) return undefined;
    /**
     * Newest first, because the thread this process started last is the one the user is talking to. An older sibling is
     * considered only when the newer one turns out to be a spawned subagent, whose rollout this process holds open just
     * as it does the conversation's.
     */
    const excluded = new Set(context.excludedAgentSessionIds);
    for (const sessionId of sessionIds.slice(0, MAX_CODEX_OPEN_THREAD_CANDIDATES)) {
        /**
         * The thread this process holds open is already bound to another Terminal. Heuristic discovery would then hand
         * this Terminal a different Session's thread, which is worse than reporting no identity at all.
         */
        if (excluded.has(sessionId)) return null;
        // eslint-disable-next-line no-await-in-loop -- each candidate is only reached once the newer one is disproved
        const state = await readCodexState(
            { ...context, agentSessionId: sessionId },
            stateDirectories,
        );
        /**
         * An unknown thread (`undefined`) is not a subagent proof, so it still answers: the provider store simply has
         * not flushed a conversation this process demonstrably owns, and the caller's own retry is the right recovery.
         */
        if (state?.sessionIsSubagent !== true) return state;
    }
    return null;
}

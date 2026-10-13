import { realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { AgentEnvironment } from '../../contract';
import type { AgentOpenFilesProbe, AgentOpenFilesProbeFailure } from '../../process-detection';
import { detectAgentOpenFiles } from '../../process-detection';
import { codexSessionIdsFromOpenFiles } from './index';
import { resolveCodexHome } from './paths';
import { CODEX_ROLLOUT_NAME_PATTERN } from './rollouts';

/**
 * `sessions_root_missing` means this machine has no Codex sessions directory to resolve open rollouts against.
 */
type OpenCodexSessionsProbeFailure = AgentOpenFilesProbeFailure | 'sessions_root_missing';

export type OpenCodexSessionsProbe =
    | { ok: true; sessionIds: ReadonlySet<string> }
    | { ok: false; reason: OpenCodexSessionsProbeFailure };

/**
 * Thread ids whose rollout any running Codex process on this machine holds open for writing. A Codex CLI keeps its
 * current rollout open for the whole conversation, including while idle at the prompt, so this answers "is this
 * conversation still open in another terminal" where the transcript mtime cannot: an idle conversation stops writing.
 *
 * A failure carries a closed reason so the caller can fall back to the mtime heuristic and log only that reason; no
 * path, file name, or content leaves this function.
 */
export async function probeOpenCodexSessionIds(
    environment: AgentEnvironment,
    readOpenFiles: () => Promise<AgentOpenFilesProbe> = () => detectAgentOpenFiles('codex'),
): Promise<OpenCodexSessionsProbe> {
    let sessionsRoot: string;
    try {
        sessionsRoot = await realpath(join(resolveCodexHome(environment), 'sessions'));
    } catch {
        return { ok: false, reason: 'sessions_root_missing' };
    }
    const probe = await readOpenFiles();
    if (!probe.ok) return probe;
    const rollouts = probe.files.filter((file) =>
        CODEX_ROLLOUT_NAME_PATTERN.test(basename(file.path)),
    );
    const canonical = await Promise.all(
        rollouts.map(async (file) => {
            try {
                return { ...file, path: await realpath(file.path) };
            } catch {
                return;
            }
        }),
    );
    return {
        ok: true,
        sessionIds: new Set(
            codexSessionIdsFromOpenFiles(
                canonical.filter((file) => file !== undefined),
                sessionsRoot,
            ),
        ),
    };
}

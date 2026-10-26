import { join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';

import type { AgentEnvironment } from '../../contract';

export function resolveClaudeConfigDirectory(environment: AgentEnvironment): string {
    // `||` is deliberate: an empty override is not a usable configuration root.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is invalid here
    return environment.variables.CLAUDE_CONFIG_DIR || join(environment.homeDirectory, '.claude');
}

export function claudeTranscriptBaseRoot(configDirectory: string): string {
    return join(configDirectory, 'projects');
}

export function claudeTranscriptRoot(configDirectory: string, cwd: string): string {
    return join(claudeTranscriptBaseRoot(configDirectory), cwd.replaceAll(/[^a-z0-9]/gi, '-'));
}

export function claudeTranscriptPath(
    configDirectory: string,
    cwd: string,
    sessionId: string,
): string {
    return join(claudeTranscriptRoot(configDirectory, cwd), `${sessionId}.jsonl`);
}

const MAX_SUBAGENT_META_BYTES = 64 * 1024;

/**
 * The parent `toolUseId` recorded in a Claude subagent's `agent-<id>.meta.json` sidecar. Reads a bounded regular file
 * without following a symlink; a missing, oversized, non-regular, or malformed sidecar yields `undefined`.
 */
export async function readClaudeSubagentToolUseId(metaPath: string): Promise<string | undefined> {
    try {
        const meta: unknown = JSON.parse(
            await readBoundedRegularFileText(metaPath, MAX_SUBAGENT_META_BYTES, {
                symlinks: 'nofollow',
            }),
        );
        if (typeof meta !== 'object' || meta === null) return undefined;
        const { toolUseId } = meta as { toolUseId?: unknown };
        return typeof toolUseId === 'string' ? toolUseId : undefined;
    } catch {
        return undefined;
    }
}

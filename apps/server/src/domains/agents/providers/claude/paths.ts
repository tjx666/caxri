import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { readBoundedRegularFileText } from '@caxri/system';

import type { AgentEnvironment } from '../../contract';

export function resolveClaudeConfigDirectory(environment: AgentEnvironment): string {
    // `||` is deliberate: an empty override is not a usable configuration root.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty string is invalid here
    return environment.variables.CLAUDE_CONFIG_DIR || join(environment.homeDirectory, '.claude');
}

/**
 * `~/.claude.json` keeps every Project Claude Code has opened, so it grows with use; this bound only stops a corrupt or
 * hostile file from being parsed whole.
 */
export const MAX_CLAUDE_GLOBAL_CONFIG_BYTES = 32 * 1024 * 1024;

/**
 * Mirrors Claude Code's global config lookup: a legacy `<config dir>/.config.json` wins when it exists; otherwise the
 * file is `.claude.json` beside `CLAUDE_CONFIG_DIR`'s contents, or in the home directory when that is unset.
 */
export async function resolveClaudeGlobalConfigPath(
    environment: AgentEnvironment,
): Promise<string> {
    const legacy = join(resolveClaudeConfigDirectory(environment), '.config.json');
    try {
        await access(legacy);
        return legacy;
    } catch {
        // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- an empty override is not a usable root
        const root = environment.variables.CLAUDE_CONFIG_DIR || environment.homeDirectory;
        const suffix = environment.variables.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
        return join(root, `.claude${suffix}.json`);
    }
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

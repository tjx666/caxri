import { join } from 'node:path';

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

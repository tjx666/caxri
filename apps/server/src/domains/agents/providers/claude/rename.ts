import { runExternalCommand } from '../../../executables';
import type { AgentProviderSessionRenameContext, AgentSessionRenameResult } from '../../contract';
import {
    agentCommandEnvironment,
    assertAgentRenameVersion,
    throwAgentRenameError,
} from '../../rename';
import { CAXRI_CLAUDE_ENTRYPOINT } from './entrypoint';

/**
 * Non-interactive `/rename` is the public write boundary. Repeating the same exact-session rename is idempotent on the
 * supported CLI line, while the parsed result remains authoritative if provider behavior changes.
 *
 * @see https://code.claude.com/docs/en/commands
 */
const CLAUDE_RENAME_MINIMUM_VERSION = '2.1.232';
const CLAUDE_RENAME_OUTPUT_BYTES = 64 * 1024;
/**
 * The Renderer shows a manual rename before this call returns, so the limit only guards a hung CLI holding the
 * Session's rename queue, which also carries automatic naming. A cold `claude --resume` routinely takes ~5s.
 */
const CLAUDE_RENAME_TIMEOUT_MS = 60_000;
const CLAUDE_RENAME_RESULT_PREFIX = 'Session renamed to:';

interface ClaudeRenameResponse {
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
    subtype?: unknown;
    type?: unknown;
}

function parseClaudeRenameResponse(
    stdout: string,
    expectedSessionId: string,
): AgentSessionRenameResult {
    let response: ClaudeRenameResponse;
    try {
        response = JSON.parse(stdout.trim()) as ClaudeRenameResponse;
    } catch {
        throw new Error('Claude returned invalid rename output');
    }
    if (
        response.type !== 'result' ||
        response.subtype !== 'success' ||
        response.is_error !== false ||
        response.session_id !== expectedSessionId ||
        typeof response.result !== 'string' ||
        !response.result.startsWith(CLAUDE_RENAME_RESULT_PREFIX)
    )
        throw new Error('Claude rejected the Session rename');
    const title = response.result.slice(CLAUDE_RENAME_RESULT_PREFIX.length).trim();
    if (!title) throw new Error('Claude returned an empty Session name');
    return { title };
}

export async function renameClaudeSession(
    context: AgentProviderSessionRenameContext,
): Promise<AgentSessionRenameResult> {
    assertAgentRenameVersion('claude', context.version, CLAUDE_RENAME_MINIMUM_VERSION);
    try {
        const { stdout } = await runExternalCommand(
            context.executable,
            [
                '--resume',
                context.agentSessionId,
                '--print',
                '--output-format',
                'json',
                `/rename ${context.title}`,
            ],
            {
                cwd: context.cwd,
                env: {
                    ...(await agentCommandEnvironment(context.environment)),
                    CLAUDE_CODE_ENTRYPOINT: CAXRI_CLAUDE_ENTRYPOINT,
                },
                maxBuffer: CLAUDE_RENAME_OUTPUT_BYTES,
                signal: context.signal,
                timeout: CLAUDE_RENAME_TIMEOUT_MS,
            },
        );
        return parseClaudeRenameResponse(stdout, context.agentSessionId);
    } catch (error) {
        throwAgentRenameError('claude', error, context.signal);
    }
}

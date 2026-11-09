import type { AgentProviderSessionRenameContext, AgentSessionRenameResult } from '../../contract';
import { assertAgentRenameVersion, throwAgentRenameError } from '../../rename';
import { callCodexAppServer } from './app-server-call';

/**
 * A one-shot app-server sees the active conversation as an unloaded thread; 0.110.0 made that rename path durable.
 *
 * @see https://github.com/openai/codex/pull/13282
 */
const CODEX_RENAME_MINIMUM_VERSION = '0.110.0';

export async function renameCodexSession(
    context: AgentProviderSessionRenameContext,
): Promise<AgentSessionRenameResult> {
    assertAgentRenameVersion('codex', context.version, CODEX_RENAME_MINIMUM_VERSION);
    try {
        await callCodexAppServer(
            {
                executable: context.executable,
                cwd: context.cwd,
                environment: context.environment,
                purpose: 'Session rename',
                ...(context.signal && { signal: context.signal }),
            },
            [
                {
                    method: 'thread/name/set',
                    params: { threadId: context.agentSessionId, name: context.title },
                },
            ],
        );
        return { title: context.title };
    } catch (error) {
        throwAgentRenameError('codex', error, context.signal);
    }
}

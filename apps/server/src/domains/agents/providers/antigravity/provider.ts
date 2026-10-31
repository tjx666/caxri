import { stat } from 'node:fs/promises';

import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

import type { AgentProviderDescriptor } from '../../contract';
import { isOpaqueAgentSessionId } from '../../contract';
import { antigravityHookAdapter } from './hooks';
import { antigravityConversationPath } from './paths';
import { readAntigravityState } from './state';

/**
 * Arguments that would let the user's launch settings pick another conversation or leave the interactive TUI, which
 * Caxri owns: identity comes from hooks and `--conversation`, and the PTY must stay interactive.
 */
const CONFLICTING_ARGUMENTS = new Set([
    '--',
    '--conversation',
    '--continue',
    '-c',
    '--print',
    '-p',
    '--prompt',
    '--prompt-interactive',
    '-i',
    '--output-format',
    '--input-format',
]);

export const antigravityProvider: AgentProviderDescriptor = {
    id: 'antigravity',
    hooks: antigravityHookAdapter,
    readState: readAntigravityState,
    resumeArguments: (sessionId) => [...agentProviderCatalog.antigravity.resumeArgs, sessionId],
    /**
     * Antigravity chooses its own conversation id and reports it to the lifecycle hooks, so a fresh launch has no
     * identity to allocate. Preparation only rejects arguments that would break Caxri's ownership, proves a resumed
     * conversation exists locally, and passes the initial prompt through `-i`, the only way to start `agy`
     * interactively with a prompt.
     */
    prepareLaunch: async ({ args, environment, initialPrompt, resumeAgentSessionId }) => {
        const launchArguments = expandLaunchArguments(args);
        if (
            launchArguments.some((argument) => CONFLICTING_ARGUMENTS.has(argument.split('=', 1)[0]))
        )
            throw new CaxriError(
                'VALIDATION',
                'Caxri manages Antigravity conversation identity and the interactive terminal',
            );
        if (resumeAgentSessionId) {
            let isExists = false;
            try {
                isExists =
                    isOpaqueAgentSessionId(resumeAgentSessionId) &&
                    (
                        await stat(antigravityConversationPath(environment, resumeAgentSessionId))
                    ).isFile();
            } catch {
                // Missing or inaccessible provider state cannot authorize a fresh conversation on restore.
            }
            if (!isExists)
                throw new CaxriError(
                    'UNAVAILABLE',
                    'The original Antigravity conversation is unavailable locally',
                    { reason: 'agent_session_unavailable' },
                );
        }
        return {
            ...(resumeAgentSessionId && { agentSessionId: resumeAgentSessionId }),
            args: [
                ...launchArguments,
                ...(resumeAgentSessionId
                    ? antigravityProvider.resumeArguments(resumeAgentSessionId)
                    : []),
                ...(initialPrompt ? ['-i', initialPrompt] : []),
            ],
        };
    },
};

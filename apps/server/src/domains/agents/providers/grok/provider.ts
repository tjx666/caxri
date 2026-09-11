import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { CaxriError } from '@caxri/protocol';

import type { AgentProviderDescriptor } from '../../contract';
import { grokDelegationAdapter } from './delegation';
import { grokHookAdapter, isGrokVersionSupported } from './hooks';
import { grokProjectRoot, locateGrokTranscript } from './paths';
import { readGrokState } from './state';

const sessionIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export const grokProvider: AgentProviderDescriptor = {
    id: 'grok',
    delegation: grokDelegationAdapter,
    locateTranscript: locateGrokTranscript,
    requiresLifecycleHooks: true,
    hooks: grokHookAdapter,
    /**
     * Hooks own identity and activity. The probe only adds the conversation title Grok Build keeps for the exact
     * hook-bound session, because directory recency cannot distinguish simultaneous same-directory sessions.
     */
    readState: readGrokState,
    resumeArguments: (sessionId) => ['--resume', sessionId],
    prepareLaunch: async ({
        args,
        assignedAgentSessionId,
        initialPrompt,
        cwd,
        environment,
        resumeAgentSessionId,
        version,
    }) => {
        if (!isGrokVersionSupported(version))
            throw new CaxriError(
                'UNAVAILABLE',
                'Grok Build 1.0.24 or later in major version 1 is required',
            );
        const conflicting = new Set([
            '--',
            '--session-id',
            '--resume',
            '-r',
            '--continue',
            '-c',
            '--fork',
            '--fork-session',
            '--leader-socket',
            '--no-leader',
            '--cwd',
            '--remote',
            '--acp',
            '--print',
            '-p',
        ]);
        if (args.some((argument) => conflicting.has(argument.split('=', 1)[0])))
            throw new CaxriError(
                'VALIDATION',
                'Caxri manages Grok Build Session identity and process ownership',
            );
        const sandboxValues = args.flatMap((argument, index) =>
            argument === '--sandbox'
                ? [args[index + 1]]
                : argument.startsWith('--sandbox=')
                  ? [argument.slice(10)]
                  : [],
        );
        if (sandboxValues.length === 0 || sandboxValues.some((value) => value !== 'workspace'))
            throw new CaxriError(
                'VALIDATION',
                'Grok Build requires the workspace sandbox to keep Agent processes inside the Terminal lifetime',
            );
        if (
            resumeAgentSessionId &&
            assignedAgentSessionId &&
            resumeAgentSessionId !== assignedAgentSessionId
        )
            throw new CaxriError('VALIDATION', 'Assigned and resumed Grok identities must match');
        const agentSessionId = resumeAgentSessionId ?? assignedAgentSessionId ?? randomUUID();
        if (!sessionIdPattern.test(agentSessionId))
            throw new CaxriError('VALIDATION', 'Grok Build Session identity must be a UUID');
        if (resumeAgentSessionId) {
            /**
             * Exact local existence avoids a remote lookup hanging or silently selecting another conversation.
             */
            const root = await grokProjectRoot(await realpath(cwd), environment);
            let isExists = false;
            try {
                isExists =
                    root !== undefined &&
                    (await stat(join(root, agentSessionId, 'summary.json'))).isFile();
            } catch {
                // Missing or inaccessible provider state cannot authorize a fresh conversation on restore.
            }
            if (!isExists)
                throw new CaxriError(
                    'UNAVAILABLE',
                    'The original Grok Build Session is unavailable locally',
                    { reason: 'agent_session_unavailable' },
                );
        }
        return {
            agentSessionId,
            args: [
                ...args,
                resumeAgentSessionId ? '--resume' : '--session-id',
                agentSessionId,
                ...(initialPrompt ? ['--', initialPrompt] : []),
            ],
        };
    },
};

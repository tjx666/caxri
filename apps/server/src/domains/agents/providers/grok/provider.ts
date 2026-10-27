import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { agentProviderCatalog, CaxriError } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

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
    hooks: grokHookAdapter,
    /**
     * Hooks own identity and activity. The probe only adds the conversation title Grok Build keeps for the exact
     * hook-bound session, because directory recency cannot distinguish simultaneous same-directory sessions.
     */
    readState: readGrokState,
    resumeArguments: (sessionId) => [...agentProviderCatalog.grok.resumeArgs, sessionId],
    /**
     * Caxri owns Session identity and process lifetime, not Grok's sandbox. `--sandbox` is optional user confinement:
     * omit it (Grok's default is `off`, unrestricted) or pass any documented mode, including `off`. Do not reintroduce
     * a workspace-only gate.
     */
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
        const launchArguments = expandLaunchArguments(args);
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
        if (launchArguments.some((argument) => conflicting.has(argument.split('=', 1)[0])))
            throw new CaxriError(
                'VALIDATION',
                'Caxri manages Grok Build Session identity and process ownership',
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
                ...launchArguments,
                resumeAgentSessionId ? '--resume' : '--session-id',
                agentSessionId,
                ...(initialPrompt ? ['--', initialPrompt] : []),
            ],
        };
    },
};

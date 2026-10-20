import { join } from 'node:path';

import { agentProviderCatalog } from '@caxri/protocol';

import type { AgentProviderDescriptor } from '../../contract';
import { projectDirectories } from '../../contract';
import { AGENT_TITLE_SYSTEM_INSTRUCTIONS } from '../../title-generation';
import { renameCodexSession } from './app-server-rename';
import { codexDelegationAdapter, codexPrimaryTurnFailure } from './delegation';
import { codexHookAdapter } from './hooks';
import { generateCodexLowCostText } from './low-cost-generation';
import { readCodexStateFromProcess } from './open-files';
import { resolveCodexHome, resolveCodexStateDirectories } from './paths';
import { readCodexState } from './thread-state';
import { createCodexThroughputScanner } from './throughput';
import { appendCodexTimelineRecord } from './timeline';
import { locateCodexTranscript } from './transcript';
import { readCodexTurnStatus } from './turn-state';

export const codexProvider: AgentProviderDescriptor = {
    delegation: codexDelegationAdapter,
    readTurnStatus: (context, environment) =>
        readCodexTurnStatus(context, resolveCodexStateDirectories(environment)),
    resolvePrimaryTurnFailure: codexPrimaryTurnFailure,
    generateTitle: (context) =>
        generateCodexLowCostText(
            context,
            AGENT_TITLE_SYSTEM_INSTRUCTIONS,
            'Automatic Session naming',
        ),
    actions: {
        roots: (context, environment) => [
            {
                directory: join(resolveCodexHome(environment), 'skills'),
                kind: 'skills',
                scope: 'legacy',
            },
            {
                directory: join(environment.homeDirectory, '.agents', 'skills'),
                kind: 'skills',
                scope: 'global',
            },
            ...projectDirectories(context).flatMap((directory) => [
                {
                    boundaryDirectory: context.projectRoot,
                    directory: join(directory, '.codex', 'skills'),
                    kind: 'skills' as const,
                    scope: 'legacy' as const,
                },
                {
                    boundaryDirectory: context.projectRoot,
                    directory: join(directory, '.agents', 'skills'),
                    kind: 'skills' as const,
                    scope: 'project' as const,
                },
            ]),
        ],
        skillInvocation: (name) => `$${name}`,
    },
    hooks: codexHookAdapter,
    id: 'codex',
    /**
     * Codex 0.154 skips implicit shared-daemon reuse for CLI config overrides. A local backend must inherit this
     * Terminal's hook identity and credentials; Caxri owns cross-Session messaging. This also disables auto recap.
     * https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/tui/src/lib.rs#L988-L998
     */
    managedLaunchArguments: ['-c', 'tui.auto_recap=false'],
    readState: async (context, environment) => {
        const stateDirectories = resolveCodexStateDirectories(environment);
        const processState = await readCodexStateFromProcess(
            context,
            environment,
            stateDirectories,
        );
        if (processState !== undefined || context.requireForegroundProcessIdentity)
            return processState ?? undefined;
        return readCodexState(context, stateDirectories);
    },
    renameSession: renameCodexSession,
    locateTranscript: (context, environment, signal) =>
        locateCodexTranscript(context, environment, signal),
    resumeArguments: (agentSessionId) => [...agentProviderCatalog.codex.resumeArgs, agentSessionId],
    timelineProjector: appendCodexTimelineRecord,
    createThroughputScanner: createCodexThroughputScanner,
};

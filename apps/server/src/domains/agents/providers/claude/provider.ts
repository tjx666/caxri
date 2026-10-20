import { join, resolve } from 'node:path';

import { agentProviderCatalog } from '@caxri/protocol';

import type { AgentProviderDescriptor } from '../../contract';
import { projectDirectories } from '../../contract';
import { AGENT_TITLE_SYSTEM_INSTRUCTIONS } from '../../title-generation';
import { claudeDelegationAdapter } from './delegation';
import { claudeHookAdapter } from './hooks';
import { generateClaudeLowCostText } from './low-cost-generation';
import { claudeMetadataCacheCounters } from './metadata-cache';
import {
    claudeTranscriptBaseRoot,
    claudeTranscriptPath,
    claudeTranscriptRoot,
    resolveClaudeConfigDirectory,
} from './paths';
import { renameClaudeSession } from './rename';
import { readClaudeState } from './state';
import { createClaudeThroughputScanner } from './throughput';
import { appendClaudeTimelineRecord } from './timeline';

export const claudeProvider: AgentProviderDescriptor = {
    delegation: claudeDelegationAdapter,
    generateTitle: (context) =>
        generateClaudeLowCostText(
            context,
            AGENT_TITLE_SYSTEM_INSTRUCTIONS,
            'Automatic Session naming',
        ),
    actions: {
        roots: (context, environment) => {
            const configuredDirectory = environment.variables.CLAUDE_CONFIG_DIR;
            const configDirectory = resolve(
                configuredDirectory === undefined || configuredDirectory === ''
                    ? join(environment.homeDirectory, '.claude')
                    : configuredDirectory,
            );
            return [
                { directory: join(configDirectory, 'commands'), kind: 'commands', scope: 'global' },
                { directory: join(configDirectory, 'skills'), kind: 'skills', scope: 'global' },
                ...projectDirectories(context).flatMap((directory) => [
                    {
                        boundaryDirectory: context.projectRoot,
                        directory: join(directory, '.claude', 'commands'),
                        kind: 'commands' as const,
                        scope: 'project' as const,
                    },
                    {
                        boundaryDirectory: context.projectRoot,
                        directory: join(directory, '.claude', 'skills'),
                        kind: 'skills' as const,
                        scope: 'project' as const,
                    },
                ]),
            ];
        },
        commandInvocation: (relativeName) => `/${relativeName.replaceAll('/', ':')}`,
        skillInvocation: (name) => `/${name}`,
    },
    hooks: claudeHookAdapter,
    id: 'claude',
    probeCacheCounters: claudeMetadataCacheCounters,
    readState: (context, environment) =>
        readClaudeState(context, resolveClaudeConfigDirectory(environment)),
    renameSession: renameClaudeSession,
    resumeArguments: (agentSessionId) => [
        ...agentProviderCatalog.claude.resumeArgs,
        agentSessionId,
    ],
    timelineProjector: appendClaudeTimelineRecord,
    createThroughputScanner: createClaudeThroughputScanner,
    transcriptBaseRoot: (environment) =>
        claudeTranscriptBaseRoot(resolveClaudeConfigDirectory(environment)),
    transcriptPath: ({ agentSessionId, cwd }, environment) =>
        claudeTranscriptPath(resolveClaudeConfigDirectory(environment), cwd, agentSessionId),
    transcriptRoot: ({ cwd }, environment) =>
        claudeTranscriptRoot(resolveClaudeConfigDirectory(environment), cwd),
};

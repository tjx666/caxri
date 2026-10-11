import type { AgentProvider, ServerOperationParameters } from '@caxri/protocol';
import { agentProviderIds, CaxriError } from '@caxri/protocol';

import { discoverExecutable } from '../agents';
import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';

type Parameters = ServerOperationParameters<'mobile.agent.availabilityInternal'>;

export function createMobileAgentAvailabilityHandler(options: {
    configuration: Pick<ConfigService, 'getSettings'>;
    database: CaxriDatabase;
    discover?: typeof discoverExecutable;
}) {
    return async ({ projectId, principal }: Parameters) => {
        if (
            principal.kind !== 'paired-device' ||
            !principal.projectIds.includes(projectId) ||
            options.database.listVisibleProjects().every((project) => project.id !== projectId)
        )
            throw new CaxriError('NOT_FOUND', 'Project not found');
        const settings = options.configuration.getSettings().value;
        const providers = await Promise.all(
            agentProviderIds.map(async (kind: AgentProvider) => {
                const requested = settings['agents.providers'][kind].launch.executable;
                const executable = await (options.discover ?? discoverExecutable)(kind, requested);
                return {
                    kind,
                    available: Boolean(executable),
                    ...(!executable && { reason: 'Agent CLI is unavailable' }),
                };
            }),
        );
        return {
            agents: [...providers, { kind: 'shell' as const, available: true }],
            openAgentsInChat: settings['session.openAgentsInChat'],
        };
    };
}

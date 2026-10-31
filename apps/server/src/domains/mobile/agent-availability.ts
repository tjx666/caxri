import type { AgentProvider, AppSettings, ServerOperationParameters } from '@caxri/protocol';
import { agentProviderIds, CaxriError } from '@caxri/protocol';

import type { AgentSignInProbe } from '../agents';
import { createAgentSignInProbe, discoverExecutable } from '../agents';
import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';

type Parameters = ServerOperationParameters<'mobile.agent.availabilityInternal'>;

/**
 * Resolves every Agent provider's configured executable the way a launch would, without launching anything or returning
 * a path. Shared by the phone's New Session picker and the desktop's Agent menus so both report the same "not
 * installed" answer.
 */
async function probeAgentAvailability(
    settings: Pick<AppSettings, 'agents.providers'>,
    discover: typeof discoverExecutable = discoverExecutable,
): Promise<Array<{ kind: AgentProvider; available: boolean }>> {
    return Promise.all(
        agentProviderIds.map(async (kind: AgentProvider) => {
            const requested = settings['agents.providers'][kind].launch.executable;
            return { kind, available: Boolean(await discover(kind, requested)) };
        }),
    );
}

/**
 * Desktop handler for `agentAvailability.get`: whether each CLI is installed and, for an installed one whose CLI can
 * say so, whether it still needs a sign-in. The menus ask only when they open, so neither check runs at startup.
 */
export function createAgentAvailabilityHandler(options: {
    configuration: Pick<ConfigService, 'getSettings'>;
    discover?: typeof discoverExecutable;
    signIn?: AgentSignInProbe;
}) {
    const discover = options.discover ?? discoverExecutable;
    const signIn = options.signIn ?? createAgentSignInProbe();
    return async () => {
        const settings = options.configuration.getSettings().value;
        const providers = await Promise.all(
            agentProviderIds.map(async (kind: AgentProvider) => {
                const executable = await discover(
                    kind,
                    settings['agents.providers'][kind].launch.executable,
                );
                if (!executable) return { kind, available: false };
                const status = await signIn.read(kind, executable);
                return {
                    kind,
                    available: true,
                    ...(status === 'signedOut' && { needsSignIn: true }),
                };
            }),
        );
        return { providers };
    };
}

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
        const providers = (await probeAgentAvailability(settings, options.discover)).map(
            (provider) => ({
                ...provider,
                ...(!provider.available && { reason: 'Agent CLI is unavailable' }),
            }),
        );
        return {
            agents: [...providers, { kind: 'shell' as const, available: true }],
            openAgentsInChat: settings['session.openAgentsInChat'],
        };
    };
}

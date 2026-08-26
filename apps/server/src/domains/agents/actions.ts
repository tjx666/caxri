import type { AppSettings } from '@caxri/protocol';
import { CaxriError, MAX_AGENT_ACTIONS, mergeAgentActions } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { discoverAgentActions } from './action-discovery';
import type { AgentEnvironment } from './contract';
import { agentProviders } from './providers';

/**
 * Lists actions only for the selected, running Agent Terminal. The database supplies the authorized Project root and
 * provider identity; Renderer input can never nominate an arbitrary filesystem path or provider configuration root.
 */
export async function listAgentActions(
    database: CaxriDatabase,
    environment: AgentEnvironment,
    settings: AppSettings,
    terminalId: string,
) {
    const terminal = database.getTerminal(terminalId);
    if (!terminal?.provider) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
    if (terminal.lastProcessState !== 'running')
        throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
    const session = database.getSession(terminal.sessionId);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
    const project = database.getProject(session.projectId);
    if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
    const descriptor = agentProviders[terminal.provider];
    const adapter = descriptor.actions;
    const discovered = adapter
        ? await discoverAgentActions(
              adapter,
              adapter.roots({ cwd: terminal.cwd, projectRoot: project.rootPath }, environment),
          )
        : { actions: [], partial: false };
    const actions = mergeAgentActions(
        terminal.provider,
        discovered.actions,
        settings['agents.providers'][terminal.provider].actions,
    );
    return {
        provider: terminal.provider,
        actions,
        discovery:
            discovered.partial || actions.length >= MAX_AGENT_ACTIONS
                ? ('partial' as const)
                : ('complete' as const),
    };
}

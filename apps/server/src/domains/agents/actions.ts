import type { AgentActionReadResult, AppSettings } from '@caxri/protocol';
import { CaxriError, MAX_AGENT_ACTIONS, mergeAgentActions } from '@caxri/protocol';

import type { ConfigService } from '../config';
import type { CaxriDatabase } from '../db';
import { discoverAgentActions, readActionFile } from './action-discovery';
import type { AgentEnvironment } from './contract';
import { agentProviders } from './providers';

/**
 * The Agent Terminal and the authorized Project root its actions are discovered under.
 */
function actionTerminal(database: CaxriDatabase, terminalId: string) {
    const terminal = database.getTerminal(terminalId);
    if (!terminal?.provider) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
    const session = database.getSession(terminal.sessionId);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
    const project = database.getProject(session.projectId);
    if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
    return { terminal, provider: terminal.provider, projectRoot: project.rootPath };
}

async function discoverTerminalActions(
    database: CaxriDatabase,
    environment: AgentEnvironment,
    terminalId: string,
    { requireRunning }: { requireRunning: boolean },
) {
    const { terminal, provider, projectRoot } = actionTerminal(database, terminalId);
    if (requireRunning && terminal.lastProcessState !== 'running')
        throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
    const adapter = agentProviders[provider].actions;
    const discovered = adapter
        ? await discoverAgentActions(
              adapter,
              adapter.roots({ cwd: terminal.cwd, projectRoot }, environment),
          )
        : { actions: [], files: new Map<string, string>(), partial: false };
    return { provider, discovered };
}

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
    const { provider, discovered } = await discoverTerminalActions(
        database,
        environment,
        terminalId,
        {
            requireRunning: true,
        },
    );
    const actions = mergeAgentActions(
        provider,
        discovered.actions,
        settings['agents.providers'][provider].actions,
    );
    return {
        provider,
        actions,
        discovery:
            discovered.partial || actions.length >= MAX_AGENT_ACTIONS
                ? ('partial' as const)
                : ('complete' as const),
    };
}

/**
 * A discovered skill or command file's Markdown, without its frontmatter, so a Chat can show what an invocation it sent
 * asks the Agent to do. Discovery runs again for the Terminal, so the Renderer names only an invocation, never a path;
 * the Agent need not still be running, since a transcript outlives its process.
 */
export async function readAgentAction(
    database: CaxriDatabase,
    environment: AgentEnvironment,
    terminalId: string,
    invocation: string,
): Promise<AgentActionReadResult> {
    const { discovered } = await discoverTerminalActions(database, environment, terminalId, {
        requireRunning: false,
    });
    const action = discovered.actions.find((candidate) => candidate.invocation === invocation);
    const file = discovered.files.get(invocation);
    if (!action || !file)
        throw new CaxriError('NOT_FOUND', 'No skill or command file has this name');
    return {
        invocation,
        kind: action.kind,
        ...(action.description && { description: action.description }),
        markdown: withoutFrontmatter(await readActionFile(file)),
    };
}

function withoutFrontmatter(source: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\n|$)/u.exec(source);
    return (match ? source.slice(match[0].length) : source).trim();
}

/**
 * Resolves the provider from the authoritative Terminal record before mutating Settings. This prevents a Renderer
 * request from writing one provider's action identity into another provider's history.
 */
export function recordRecentAgentAction(
    database: CaxriDatabase,
    config: ConfigService,
    terminalId: string,
    invocation: string,
) {
    const terminal = database.getTerminal(terminalId);
    if (!terminal?.provider) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
    return config.recordRecentAgentAction(terminal.provider, invocation);
}

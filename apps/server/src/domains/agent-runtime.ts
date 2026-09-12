import process from 'node:process';

import type { AgentProvider, ServerEvent } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentLifecycleSignal } from './agents';
import {
    AgentCoordinator,
    AgentHookManager,
    AgentService,
    createLocalAgentAdapters,
    defaultAgentEnvironment,
    discoverExecutable,
} from './agents';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DomainDependencies } from './domain-services';
import { SessionAutoNamingService } from './session-auto-naming';
import { SessionRenameService } from './session-rename';
import type { WatchHub } from './watch-hub';
import * as provenance from './workbench-provenance';
import type { WorkbenchRootService } from './workbench-roots';

interface CreateAgentRuntimeOptions {
    configuration: ConfigService;
    database: CaxriDatabase;
    dependencies: Pick<
        DomainDependencies,
        | 'agentAdapters'
        | 'agentEndpoints'
        | 'agentEnvironment'
        | 'agentHooksPath'
        | 'agentRefreshDelayMs'
        | 'hookExecutable'
    >;
    logger: StructuredLogger;
    /**
     * Observes every accepted lifecycle signal after the coordinator has applied it.
     */
    onLifecycleSignal?: (signal: AgentLifecycleSignal) => void;
    onLifecycleApplied?: (signal: AgentLifecycleSignal) => void;
    send: (event: ServerEvent) => void;
    userDataPath: string;
    watchHub: WatchHub;
    workbenchRoots: WorkbenchRootService;
}

/**
 * Composes the Agent provider, lifecycle-hook, and native rename services. Keeping their shared launch identity and
 * settings reconciliation here makes the domain root consume one cohesive Agent runtime.
 */
export async function createAgentRuntime(options: CreateAgentRuntimeOptions) {
    const {
        configuration,
        database,
        dependencies,
        logger,
        send,
        userDataPath,
        watchHub,
        workbenchRoots,
    } = options;
    const agentLaunchSettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].launch;
    const agentOutputRecoverySettings = (provider: AgentProvider) =>
        configuration.getSettings().value['agents.providers'][provider].recovery;
    const agentEnvironment = dependencies.agentEnvironment ?? defaultAgentEnvironment();
    const agents = new AgentService(
        logger,
        dependencies.agentAdapters ??
            createLocalAgentAdapters(agentEnvironment, agentLaunchSettings),
    );
    const namingState: { service?: SessionAutoNamingService } = {};
    const coordinator = new AgentCoordinator(database, agents, send, logger, {
        /**
         * A parent Stop can be deferred until background subagents finish; raw hook acceptance is not completion.
         */
        onLifecycleApplied: (signal) => {
            namingState.service?.observe(signal);
            options.onLifecycleApplied?.(signal);
        },
        refreshDelayMs: dependencies.agentRefreshDelayMs,
    });
    const sessionRenames = new SessionRenameService(database, agents, coordinator, send);
    const automaticNaming = new SessionAutoNamingService(
        database,
        agents,
        sessionRenames,
        agentEnvironment,
        (terminalId, launchId) => {
            const provider = database.getTerminal(terminalId)?.provider;
            return Boolean(
                provider &&
                configuration.getSettings().value['agents.providers'][provider].hooks.enabled &&
                coordinator.isCurrentTerminalLaunch(terminalId, launchId),
            );
        },
        logger,
        (sessionId, reason) =>
            send({ event: 'agent.automaticNamingUnavailable', payload: { sessionId, reason } }),
    );
    namingState.service = automaticNaming;
    const agentHooks = new AgentHookManager({
        discoverExecutable,
        environment: agentEnvironment,
        logger,
        onAuthorityLost: (provider) => coordinator.resetHookAuthority(provider),
        onLaunchEnded: (terminalId) => coordinator.endTerminalLaunch(terminalId),
        onLaunchStarted: (terminalId, launchId) =>
            coordinator.beginTerminalLaunch(terminalId, launchId),
        onSignal: async (signal) => {
            const decision = await provenance.handleAgentLifecycleSignal(
                coordinator,
                workbenchRoots,
                signal,
            );
            if (decision === 'accepted') {
                options.onLifecycleSignal?.(signal);
            }
            return decision;
        },
        hookExecutable: dependencies.hookExecutable ?? process.execPath,
        send,
        sharedPath: dependencies.agentHooksPath,
        userDataPath,
        watchHub,
    });
    await agentHooks.initialize(configuration.getSettings().value['agents.providers']);
    let settingsReconcile = Promise.resolve();
    const unsubscribeSettings = configuration.subscribeSettings((settings) => {
        /**
         * Preserve setting-update order so a slow probe cannot restore authority after disable.
         */
        settingsReconcile = (async () => {
            try {
                await settingsReconcile;
            } catch (error: unknown) {
                logger.write('warn', logEventCatalog.agent.integrationReconcileFailed, {
                    fields: { error: errorMessage(error, 'unknown') },
                });
            }
            await Promise.all([
                agentHooks.reconcile(settings['agents.providers']),
                dependencies.agentEndpoints?.reconcile(settings['agents.providers']),
            ]);
        })();
    });

    return {
        agentEnvironment,
        agentHooks,
        agentLaunchSettings,
        agentOutputRecoverySettings,
        agents,
        awaitSettingsReconcile: () => settingsReconcile,
        close: async () => {
            unsubscribeSettings();
            await automaticNaming.close();
            await settingsReconcile;
            await agentHooks.close();
        },
        coordinator,
        sessionRenames,
    };
}

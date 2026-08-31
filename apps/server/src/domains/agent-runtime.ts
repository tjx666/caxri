import process from 'node:process';

import type { AgentAutomaticNamingHealth, AgentProvider, ServerEvent } from '@caxri/protocol';
import { errorMessage } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import {
    AgentCoordinator,
    AgentHookManager,
    AgentService,
    createLocalAgentAdapters,
    defaultAgentEnvironment,
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
    send: (event: ServerEvent) => void;
    userDataPath: string;
    watchHub: WatchHub;
    workbenchRoots: WorkbenchRootService;
}

/**
 * Composes the Agent provider, lifecycle-hook, native rename, and automatic naming services. Keeping their shared
 * launch identity and settings reconciliation here makes the domain root consume one cohesive Agent runtime.
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
    const coordinator = new AgentCoordinator(database, agents, send, logger, {
        refreshDelayMs: dependencies.agentRefreshDelayMs,
    });
    const sessionRenames = new SessionRenameService(database, agents, coordinator, send);
    let hasAutoNamingConflict: (provider: AgentProvider) => boolean = () => false;
    const autoNamingHealthReporter: {
        report?: (provider: AgentProvider, health: AgentAutomaticNamingHealth) => void;
    } = {};
    const sessionAutoNaming = new SessionAutoNamingService(
        database,
        agents,
        sessionRenames,
        () => configuration.getSettings().value,
        send,
        logger,
        {
            hasForeignHookConflict: (provider) => hasAutoNamingConflict(provider),
            isCurrentLaunch: (terminalId, launchId) =>
                coordinator.isCurrentTerminalLaunch(terminalId, launchId),
            onHealthChanged: (provider, health) =>
                autoNamingHealthReporter.report?.(provider, health),
        },
    );
    const agentHooks = new AgentHookManager({
        environment: agentEnvironment,
        logger,
        onAuthorityLost: (provider) => coordinator.resetHookAuthority(provider),
        onLaunchEnded: (terminalId) => {
            sessionAutoNaming.forgetTerminal(terminalId);
            coordinator.endTerminalLaunch(terminalId);
        },
        onLaunchStarted: (terminalId, launchId) => {
            sessionAutoNaming.forgetTerminal(terminalId);
            coordinator.beginTerminalLaunch(terminalId, launchId);
        },
        onSignal: async (signal) => {
            const handled = await provenance.handleAgentLifecycleSignal(
                coordinator,
                workbenchRoots,
                signal,
            );
            if (handled) sessionAutoNaming.observe(signal);
            return handled;
        },
        hookExecutable: dependencies.hookExecutable ?? process.execPath,
        send,
        sharedPath: dependencies.agentHooksPath,
        userDataPath,
        watchHub,
    });
    hasAutoNamingConflict = (provider) => agentHooks.hasAutoNamingConflict(provider);
    autoNamingHealthReporter.report = (provider, health) =>
        agentHooks.setAutomaticNamingHealth(provider, health);
    await agentHooks.initialize(configuration.getSettings().value['agents.providers']);
    let settingsReconcile = Promise.resolve();
    const unsubscribeSettings = configuration.subscribeSettings((settings) => {
        sessionAutoNaming.reconcile(settings['agents.providers']);
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
            await settingsReconcile;
            await agentHooks.close();
        },
        coordinator,
        sessionAutoNaming,
        sessionRenames,
    };
}

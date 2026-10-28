import process from 'node:process';

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { AgentChatService } from './agent-chat';
import type {
    AgentEnvironment,
    AgentHookManager,
    AgentThroughputService,
    AgentTimelineService,
    AgentTranscriptWatcher,
    LongPasteService,
    SessionSearchIndex,
} from './agents';
import {
    agentSkillHealthReader,
    listAgentActions,
    readAgentAction,
    readAgentExcerpts,
    readAgentReplySummary,
    readAgentTranscript,
    recordRecentAgentAction,
} from './agents';
import type { BotHandoverService, BotInboxService, CaxriBotServiceOptions } from './bot';
import { CaxriBotService } from './bot';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import { DeliveryFocusRefresh } from './delivery-focus-refresh';
import type { DiagnosticsService } from './diagnostics';
import type { DomainDependencies, DomainHandlers } from './domain-services';
import type { ExternalStatusHub } from './external-status';
import type { FileService } from './files';
import type { GitService } from './git';
import { withGitRequestSignal } from './git';
import type { createIntrospectionServices } from './introspection';
import { createAgentAvailabilityHandler } from './mobile';
import {
    addProjectFolder,
    importProjectTransferFile,
    resolveOwnerProjectRoot,
    resolveProjectRoot,
    writeProjectTransfer,
} from './project';
import type { ProjectStatusService, VercelDeploymentStore } from './project-status';
import { SessionPullRequestService } from './project-status';
import type { PullRequestMergeNoticeOptions, PullRequestSettlementWiring } from './pull-request';
import {
    createPullRequestMergeNotice,
    PullRequestSettlement,
    refreshAfterMerge,
} from './pull-request';
import type { SessionContextService } from './session';
import {
    defaultSessionReferenceDirectory,
    SessionAgentHistoryService,
    SessionConversationReferenceService,
    SessionSearchService,
} from './session';
import { resolveTerminalFileLink } from './terminal';
import type { AgentUsageGuards } from './usage';
import { offlinePriceListFetch, UsageService } from './usage';

type ServiceHandlerMethods =
    | 'agent.excerpts'
    | 'agent.replySummary'
    | 'agent.delegation.access.bootstrap'
    | 'agentActions.list'
    | 'agentActions.read'
    | 'agentActions.recordRecent'
    | 'files.list'
    | 'files.resolveImports'
    | 'files.resolveKind'
    | 'files.browse'
    | 'files.locateDirectory'
    | 'files.create'
    | 'files.copy'
    | 'files.rename'
    | 'files.move'
    | 'files.operation.get'
    | 'files.operation.list'
    | 'files.operation.cancel'
    | 'files.operation.acknowledge'
    | 'files.authorizeTrash'
    | 'files.authorizeOpen'
    | 'files.trashOnHost'
    | 'files.read'
    | 'files.readAsset'
    | 'files.write'
    | 'files.search'
    | 'terminal.agentThroughput'
    | 'terminal.agentUsage'
    | 'terminal.agentTaskUsage'
    | 'terminal.agentTranscript'
    | 'terminal.commitLink.resolve'
    | 'terminal.reference.preview'
    | 'terminal.fileLink.resolve'
    | 'terminal.prepareLongPaste'
    | 'agentChat.saveLongPaste'
    | 'terminal.referenceContext'
    | 'project.create'
    | 'project.add'
    | 'project.setIcon'
    | 'project.setChatDefault'
    | 'git.summary'
    | 'git.overview'
    | 'git.branches'
    | 'git.switchBranch'
    | 'git.sync'
    | 'git.discard.preflight'
    | 'git.discard.apply'
    | 'git.mergePullRequest'
    | 'git.diffDocument'
    | 'git.pullRequestChanges'
    | 'git.pullRequestDiffDocument'
    | 'git.remoteHost'
    | 'git.commits'
    | 'git.commitDetails'
    | 'git.commitDiffDocument'
    | 'git.blame'
    | 'git.fileHead'
    | 'projectStatus.summary'
    | 'projectStatus.overview'
    | 'projectStatus.linearIssue'
    | 'session.pullRequests'
    | 'bot.ensure'
    | 'bot.snapshot'
    | 'bot.board'
    | 'bot.session.create'
    | 'bot.session.handOver'
    | 'bot.session.takeBack'
    | 'bot.managedSessions'
    | 'bot.conversations'
    | 'bot.status'
    | 'bot.stop'
    | 'bot.data'
    | 'bot.switchAgent'
    | 'bot.clearData'
    | 'bot.task.create'
    | 'bot.task.list'
    | 'bot.task.update'
    | 'bot.inbox.list'
    | 'bot.inbox.show'
    | 'bot.inbox.add'
    | 'bot.inbox.resolve'
    | 'bot.inbox.ack'
    | 'bot.inbox.reply'
    | 'bot.inbox.dismiss'
    | 'bot.inbox.merge'
    | 'mobile.botInbox.replyInternal'
    | 'session.refreshDeliveryOnFocus'
    | 'session.search'
    | 'session.importConversation'
    | 'session.agentHistory'
    | 'session.reopenConversation'
    | 'session.conversationReference'
    | 'settings.get'
    | 'settings.inspect'
    | 'settings.patch'
    | 'settings.delegation.import'
    | 'agentAvailability.get'
    | 'agentHooks.get'
    | 'agentSkills.get'
    | 'usage.limits'
    | 'usage.dismissPlanPace'
    | 'usage.report'
    | 'settings.update'
    | 'settings.trustDomain'
    | 'settings.trustFolder'
    | 'keybindings.get'
    | 'keybindings.update'
    | 'theme.get'
    | 'theme.update'
    | 'theme.importPath'
    | 'diagnostics.exportPath'
    | 'projectTransfer.exportPath'
    | 'projectTransfer.importPath'
    | 'diagnostics.snapshot'
    | 'logs.query';

/**
 * Handlers that only delegate to an already-constructed Server service, with no dependency on the composition root's
 * own closures. Handlers that need those closures (selection, parking, deletion, Terminal lifecycle) are registered by
 * their own slices instead.
 */
export function createServiceHandlers(services: {
    acknowledgeFileMutation: (sessionId: string, operationId: string) => Promise<void>;
    agentChat: PullRequestMergeNoticeOptions['agentChat'] &
        Pick<AgentChatService, 'readPlanLimits' | 'states'>;
    agentEnvironment: AgentEnvironment;
    agentHooks: AgentHookManager;
    /**
     * Shared with the Chat service, which reads it when a turn ends (`recordChatTurnMetrics`).
     */
    agentThroughput: Pick<AgentThroughputService, 'read'>;
    agentRuntime: {
        awaitSettingsReconcile: () => Promise<void>;
        usageGuards: Pick<AgentUsageGuards, 'observe'>;
        sessionSearchIndex: Pick<SessionSearchIndex, 'describe' | 'inspect' | 'search'>;
    };
    bot: Omit<
        CaxriBotServiceOptions,
        'database' | 'handovers' | 'inbox' | 'onLaunching' | 'pullRequests' | 'userDataPath'
    >;
    botHandovers: BotHandoverService;
    botInbox: BotInboxService;
    configuration: ConfigService;
    database: CaxriDatabase;
    emit: DomainDependencies['send'];
    diagnostics: DiagnosticsService;
    externalStatus: ExternalStatusHub;
    files: FileService;
    git: GitService;
    introspection: ReturnType<typeof createIntrospectionServices>;
    longPastes: LongPasteService;
    logger: StructuredLogger;
    /**
     * The same operation as the sidebar's Archive, used when a Session's pull request settles.
     */
    archiveSession(sessionId: string): unknown;
    projectStatus: ProjectStatusService;
    sessionContext: SessionContextService;
    settlementWiring: PullRequestSettlementWiring;
    terminals: PullRequestMergeNoticeOptions['terminals'];
    timeline: AgentTimelineService;
    transcripts: AgentTranscriptWatcher;
    userDataPath: string;
    vercel: VercelDeploymentStore;
}): Pick<DomainHandlers, ServiceHandlerMethods> {
    const {
        acknowledgeFileMutation,
        agentEnvironment,
        agentHooks,
        agentRuntime,
        agentThroughput,
        botHandovers,
        botInbox,
        configuration,
        database,
        emit,
        diagnostics,
        externalStatus,
        files,
        git,
        introspection,
        longPastes,
        logger,
        projectStatus,
        sessionContext,
        settlementWiring,
        timeline,
        transcripts,
        userDataPath,
        vercel,
    } = services;
    const sessionSearch = new SessionSearchService({
        database,
        index: agentRuntime.sessionSearchIndex,
        resolveProjectRoot: resolveOwnerProjectRoot,
        onSessionImported: () =>
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'session.create' } }),
    });
    const sessionAgentHistory = new SessionAgentHistoryService({
        database,
        index: agentRuntime.sessionSearchIndex,
        onTerminalCreated: () =>
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'terminal.create' } }),
    });
    const sessionConversationReferences = new SessionConversationReferenceService(
        defaultSessionReferenceDirectory(),
        database,
        logger,
        agentEnvironment,
    );
    const noticeMergedPullRequest = createPullRequestMergeNotice({
        agentChat: services.agentChat,
        database,
        isEnabled: () => configuration.getSettings().value['projectStatus.notifyAgentOnMerge'],
        isWithinAgentTurn: (sessionId, at) => settlementWiring.turnWindows.contains(sessionId, at),
        logger,
        terminals: services.terminals,
    });
    const pullRequestSettlement = new PullRequestSettlement({
        archive: (sessionId) => services.archiveSession(sessionId),
        database,
        hasBackgroundWork: (sessionId) => services.agentChat.states.hasRunningTasks(sessionId),
        isAutoArchiveEnabled: () =>
            configuration.getSettings().value['projectStatus.autoArchiveOnPullRequestSettled'],
        logger,
        notifyMerged: noticeMergedPullRequest,
        onArchived: (sessionId, pullRequestState) =>
            emit({ event: 'session.autoArchived', payload: { sessionId, pullRequestState } }),
    });
    settlementWiring.attach(pullRequestSettlement);
    const sessionPullRequests = new SessionPullRequestService(
        database,
        git,
        logger,
        externalStatus.run,
        {
            agentEnvironment,
            emit,
            github: externalStatus.github,
            onPullRequestChanged: (sessionId, previous, next) =>
                settlementWiring.observePullRequest(sessionId, previous, next),
            sessionContext: (session) => sessionContext.read(session),
            settings: () => configuration.getSettings().value,
            vercel,
        },
    );
    projectStatus.useSessionPullRequests((sessionId) => sessionPullRequests.resolve(sessionId));
    const bot = new CaxriBotService({
        ...services.bot,
        database,
        handovers: botHandovers,
        inbox: botInbox,
        logger,
        onLaunching: () => {
            botInbox.announceUnacknowledged();
            botHandovers.requeue();
        },
        pullRequests: () => sessionPullRequests.snapshot(),
        userDataPath,
    });
    const usage = new UsageService({
        database,
        readPlanLimits: (terminalId) => services.agentChat.readPlanLimits(terminalId),
        onLimit: (limit) => services.agentRuntime.usageGuards.observe(limit.provider, limit),
        environment: agentEnvironment,
        ...(process.env.CAXRI_E2E === '1' && { fetch: offlinePriceListFetch }),
        logger,
        runner: externalStatus.run,
        userDataPath,
    });
    const deliveryFocusRefresh = new DeliveryFocusRefresh({
        logger,
        projectStatus,
        sessionPullRequests,
    });
    return {
        'agent.excerpts': async ({ sessions }) => ({
            excerpts: await readAgentExcerpts(
                {
                    database,
                    timeline,
                    pendingRequest: (terminalId) =>
                        services.agentChat.states.pendingRequest(terminalId),
                },
                sessions,
            ),
        }),
        'agent.replySummary': ({ sessionId }) =>
            readAgentReplySummary(database, timeline, sessionId),
        'agent.delegation.access.bootstrap': async ({
            rootPath,
            callerProvider,
            registerProject,
        }) => {
            const result = database.ensureDelegationContext(
                await resolveOwnerProjectRoot(rootPath),
                callerProvider,
                registerProject,
            );
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.create' } });
            return result;
        },
        'agentActions.list': ({ terminalId }) =>
            listAgentActions(
                database,
                agentEnvironment,
                configuration.getSettings().value,
                terminalId,
            ),
        'agentActions.read': ({ invocation, terminalId }) =>
            readAgentAction(database, agentEnvironment, terminalId, invocation),
        'agentActions.recordRecent': ({ invocation, terminalId }) =>
            recordRecentAgentAction(database, configuration, terminalId, invocation),
        'files.list': ({ sessionId, directory }, signal) =>
            files.listDirectory(sessionId, directory, signal),
        'files.browse': (parameters) => files.browse(parameters),
        'files.locateDirectory': (parameters, signal) => files.locateDirectory(parameters, signal),
        'files.create': (parameters) => files.create(parameters),
        'files.copy': (parameters) => files.copy(parameters),
        'files.rename': (parameters) => files.rename(parameters),
        'files.move': (parameters) => files.move(parameters),
        'files.operation.get': async ({ operationId, sessionId }) =>
            (await files.getScopedMutationOperation(sessionId, operationId)) ?? null,
        'files.operation.list': ({ sessionId }) => files.listScopedMutationOperations(sessionId),
        'files.operation.cancel': ({ operationId, sessionId }) =>
            files.cancelScopedMutationOperation(sessionId, operationId),
        'files.operation.acknowledge': async ({ operationId, sessionId }) => {
            await acknowledgeFileMutation(sessionId, operationId);
            return null;
        },
        'files.authorizeTrash': (parameters) => files.authorizeTrash(parameters),
        'files.authorizeOpen': (parameters) => files.authorizeOpen(parameters),
        'files.trashOnHost': async (parameters) => {
            await files.trashOnHost(parameters);
            return null;
        },
        'files.resolveImports': (parameters) => files.resolveImports(parameters),
        'files.resolveKind': async (parameters) => (await files.authorizeOpen(parameters)).kind,
        'files.read': ({ sessionId, path }) => files.read(sessionId, path),
        'files.readAsset': ({ sessionId, path }, signal) =>
            files.readAsset(sessionId, path, signal),
        'files.write': ({ sessionId, path, content }) => files.write(sessionId, path, content),
        'session.search': (parameters, signal) => sessionSearch.search(parameters, signal),
        'session.importConversation': ({ provider, agentSessionId }) =>
            sessionSearch.importConversation(provider, agentSessionId),
        'session.agentHistory': ({ sessionId }, signal) =>
            sessionAgentHistory.list(sessionId, signal),
        'session.reopenConversation': ({ sessionId, provider, agentSessionId }) =>
            sessionAgentHistory.reopen(sessionId, provider, agentSessionId),
        'session.conversationReference': ({ sessionId }, signal) =>
            sessionConversationReferences.prepare(sessionId, signal),
        'files.search': (parameters, signal) => files.search(parameters, signal),
        'terminal.agentThroughput': ({ terminalId }) => agentThroughput.read(terminalId),
        'terminal.agentTranscript': async ({ terminalId, withContent }) => {
            if (withContent) await transcripts.watch(terminalId);
            return readAgentTranscript(database, terminalId, withContent, agentEnvironment);
        },
        'terminal.fileLink.resolve': (parameters) =>
            resolveTerminalFileLink(database, parameters, {
                searchProjectFileSuffixes: (sessionId, root, suffix, signal) =>
                    files.searchProjectFileSuffixes(sessionId, root, suffix, signal),
                trustedFolders: configuration.getSettings().value['security.trustedFolders'],
            }),
        'terminal.prepareLongPaste': (parameters, signal) => longPastes.prepare(parameters, signal),
        'agentChat.saveLongPaste': (parameters, signal) =>
            longPastes.saveForChat(parameters, signal),
        'terminal.referenceContext': ({ terminalId }) => {
            const terminal = database.getTerminal(terminalId);
            if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
            return git.referenceContext(terminal.sessionId);
        },
        'terminal.commitLink.resolve': ({ terminalId, reference }) => {
            const terminal = database.getTerminal(terminalId);
            if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
            return git.resolveCommitReference(terminal.sessionId, reference, terminal.cwd);
        },
        'terminal.reference.preview': ({ terminalId, reference }) => {
            const terminal = database.getTerminal(terminalId);
            if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
            return git.referencePreview(terminal.sessionId, terminal.cwd, reference);
        },
        'project.create': async ({ expectedRootIdentity, rootPath }) => {
            const project = database.createProject(
                await resolveProjectRoot(rootPath, expectedRootIdentity),
            );
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.create' } });
            return project;
        },
        'project.add': async ({ path }) => {
            const { id, title } = await addProjectFolder(database, emit, path);
            return { project: { id, title } };
        },
        'project.setIcon': ({ projectId, icon }) => {
            const project = database.setProjectIcon(projectId, icon);
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.setIcon' } });
            return project;
        },
        'project.setChatDefault': ({ projectId, provider, chatDefault }) => {
            const project = database.setProjectChatDefault(projectId, provider, chatDefault);
            emit({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'project.setChatDefault' },
            });
            return project;
        },
        'git.summary': ({ sessionId, refresh, requester }, signal) =>
            withGitRequestSignal(signal, () => git.summary(sessionId, refresh, requester)),
        'git.overview': ({ sessionId, refresh }) => git.overview(sessionId, refresh),
        'git.branches': (parameters) => git.branches(parameters),
        'git.switchBranch': (parameters) => git.switchBranch(parameters),
        'git.sync': (parameters, signal) =>
            withGitRequestSignal(signal, () => git.sync(parameters)),
        'git.discard.preflight': (parameters) => git.discardPreflight(parameters),
        'git.discard.apply': (parameters) => git.discardApply(parameters),
        'git.mergePullRequest': async (parameters) => {
            const result = await git.mergePullRequest(parameters);
            // Fire-and-forget: the notice logs its own outcome. It runs before the refresh starts so the notice's
            // once-per-pull-request record is written before the refresh can detect this same merge.
            void noticeMergedPullRequest(parameters.sessionId, result.url, { origin: 'caxri' });
            // Fire-and-forget: the refresh logs its own failure, and the merge already succeeded.
            void refreshAfterMerge(sessionPullRequests, parameters.sessionId, parameters.number);
            return result;
        },
        'git.diffDocument': ({ sessionId, repositoryId, path }) =>
            git.diffDocument(sessionId, repositoryId, path),
        'git.pullRequestChanges': (parameters, signal) =>
            withGitRequestSignal(signal, () => git.pullRequestChanges(parameters)),
        'git.pullRequestDiffDocument': (parameters) => git.pullRequestDiffDocument(parameters),
        'git.remoteHost': (parameters, signal) =>
            withGitRequestSignal(signal, () => git.remoteHost(parameters)),
        'git.commits': (parameters, signal) =>
            withGitRequestSignal(signal, () => git.commits(parameters)),
        'git.commitDetails': (parameters, signal) =>
            withGitRequestSignal(signal, () => git.commitDetails(parameters)),
        'git.commitDiffDocument': (parameters) => git.commitDiffDocument(parameters),
        'git.blame': (parameters) => git.blame(parameters),
        'git.fileHead': (parameters) => git.fileHead(parameters),
        'projectStatus.summary': ({ sessionId, refreshToken }) =>
            projectStatus.summary(sessionId, refreshToken),
        'projectStatus.overview': ({ sessionId }) => projectStatus.overview(sessionId),
        'projectStatus.linearIssue': ({ identifier, workspace }) =>
            projectStatus.linearIssue(identifier, workspace),
        'session.pullRequests': () => sessionPullRequests.snapshot(),
        'bot.ensure': () => bot.ensure(),
        'bot.snapshot': () => bot.snapshot(),
        'bot.status': () => bot.status(),
        'bot.stop': () => bot.stop(),
        'bot.data': () => bot.data(),
        'bot.switchAgent': ({ agent }) => bot.switchAgent(agent),
        'bot.clearData': (request) => bot.clearData(request),
        'bot.board': () => bot.board(),
        'bot.session.create': ({ projectId }) => bot.createSession(projectId),
        'bot.session.handOver': (request) => botHandovers.handOver(request),
        'bot.session.takeBack': ({ sessionId }) => botHandovers.takeBack(sessionId),
        'bot.managedSessions': () => botHandovers.managedSessions(),
        'bot.conversations': () => botHandovers.conversations(),
        'bot.task.create': (parameters) => bot.tasks.create(parameters),
        'bot.task.list': ({ includeClosed }) => ({
            tasks: bot.tasks.list({ includeClosed: includeClosed ?? false }),
        }),
        'bot.task.update': (parameters) => bot.tasks.update(parameters),
        'bot.inbox.list': ({ includeClosed }) => botInbox.list(includeClosed),
        'bot.inbox.show': ({ id }) => botInbox.show(id),
        'bot.inbox.add': (input) => botInbox.add(input),
        'bot.inbox.resolve': ({ id }) => botInbox.resolve(id),
        'bot.inbox.ack': ({ id, sequence }) => botInbox.acknowledge(id, sequence),
        'bot.inbox.reply': ({ id, body }) => botInbox.reply(id, body, 'desktop'),
        'bot.inbox.dismiss': ({ id }) => botInbox.dismiss(id),
        'bot.inbox.merge': ({ id, revision }) => botInbox.merge(id, revision),
        'mobile.botInbox.replyInternal': ({ id, body, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError(
                    'FORBIDDEN',
                    'Control access is required to reply to the Inbox',
                );
            const item = botInbox.reply(id, body, 'mobile');
            // `reply` appends the new reply last, so the last sequence is the one just stored.
            return { sequence: item.replies.at(-1)?.sequence ?? item.replies.length };
        },
        'session.refreshDeliveryOnFocus': ({ sessionId }) => {
            // Fire-and-forget: the refresh logs its own outcome and the change events converge the UI.
            void deliveryFocusRefresh.request(sessionId);
            return null;
        },
        'settings.get': () => configuration.getSettings(),
        'settings.inspect': () => configuration.inspectSettings(),
        'settings.patch': ({ changes, dryRun }) => configuration.patchSettings(changes, dryRun),
        'settings.delegation.import': ({ settings, dryRun }) =>
            configuration.importDelegationSettings(settings, dryRun),
        'agentAvailability.get': createAgentAvailabilityHandler({ configuration }),
        'agentHooks.get': () => agentHooks.getHealth(),
        'agentSkills.get': agentSkillHealthReader(database, agentEnvironment, userDataPath),
        'usage.limits': () => usage.readLimits(),
        'usage.dismissPlanPace': ({ provider }) => usage.dismissPlanPace(provider),
        'usage.report': (parameters) => usage.report(parameters),
        'terminal.agentUsage': ({ terminalId }) => usage.readTerminal(terminalId),
        'terminal.agentTaskUsage': ({ terminalId, taskId }) =>
            usage.readTerminalTask(terminalId, taskId),
        'settings.update': async ({ source }) => {
            await configuration.updateSettings(source);
            await agentRuntime.awaitSettingsReconcile();
            return configuration.getSettings();
        },
        'settings.trustDomain': async ({ domain }) => {
            await configuration.trustDomain(domain);
            return configuration.getSettings();
        },
        'settings.trustFolder': async ({ path }) => {
            await configuration.trustFolder(path);
            return configuration.getSettings();
        },
        'keybindings.get': () => configuration.getKeybindings(),
        'keybindings.update': async ({ source }) => {
            await configuration.updateKeybindings(source);
            return configuration.getKeybindings();
        },
        'theme.get': () => configuration.getTheme(),
        'theme.update': async ({ source }) => {
            await configuration.updateTheme(source);
            database.setAppState('activeThemeId', configuration.getTheme().value.id);
            return configuration.getTheme();
        },
        'theme.importPath': async ({ path }) => {
            const result = await configuration.importTheme(path);
            database.setAppState('activeThemeId', result.value.id);
            return result;
        },
        'diagnostics.exportPath': ({ destination }) => diagnostics.export(destination),
        'projectTransfer.exportPath': ({ destination }) =>
            writeProjectTransfer(database, destination),
        'projectTransfer.importPath': ({ path }) => importProjectTransferFile(database, path, emit),
        'diagnostics.snapshot': () => diagnostics.snapshot(),
        'logs.query': (parameters) => introspection.logs.query(parameters),
    };
}

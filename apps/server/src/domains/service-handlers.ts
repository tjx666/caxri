import process from 'node:process';

import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type {
    AgentEnvironment,
    AgentHookManager,
    AgentTimelineService,
    AgentTranscriptWatcher,
    LongPasteService,
} from './agents';
import {
    agentSkillHealthReader,
    AgentThroughputService,
    listAgentActions,
    readAgentAction,
    readAgentReplySummary,
    readAgentTranscript,
    recordRecentAgentAction,
    SessionContentSearch,
} from './agents';
import type {
    AgentCommanderServiceOptions,
    CommanderHandoverService,
    CommanderInboxService,
} from './commander';
import { AgentCommanderService } from './commander';
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
import { addProjectFolder, resolveOwnerProjectRoot, resolveProjectRoot } from './project';
import type { ProjectStatusService, VercelDeploymentStore } from './project-status';
import { SessionPullRequestService } from './project-status';
import type { PullRequestMergeNoticeOptions } from './pull-request-merge-notice';
import { createPullRequestMergeNotice } from './pull-request-merge-notice';
import { refreshAfterMerge } from './pull-request-merge-refresh';
import type { SessionContextService } from './session';
import { defaultSessionReferenceDirectory, SessionConversationReferenceService } from './session';
import { resolveTerminalFileLink } from './terminal';
import { offlinePriceListFetch, UsageService } from './usage';

type ServiceHandlerMethods =
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
    | 'commander.ensure'
    | 'commander.snapshot'
    | 'commander.board'
    | 'commander.session.create'
    | 'commander.session.handOver'
    | 'commander.session.takeBack'
    | 'commander.managedSessions'
    | 'commander.conversations'
    | 'commander.status'
    | 'commander.stop'
    | 'commander.data'
    | 'commander.switchAgent'
    | 'commander.clearData'
    | 'commander.task.create'
    | 'commander.task.list'
    | 'commander.task.update'
    | 'commander.inbox.list'
    | 'commander.inbox.show'
    | 'commander.inbox.add'
    | 'commander.inbox.resolve'
    | 'commander.inbox.ack'
    | 'commander.inbox.reply'
    | 'commander.inbox.dismiss'
    | 'commander.inbox.merge'
    | 'mobile.commanderInbox.replyInternal'
    | 'session.refreshDeliveryOnFocus'
    | 'session.searchContent'
    | 'session.conversationReference'
    | 'settings.get'
    | 'settings.inspect'
    | 'settings.patch'
    | 'settings.delegation.import'
    | 'agentHooks.get'
    | 'agentSkills.get'
    | 'usage.report'
    | 'settings.update'
    | 'settings.trustDomain'
    | 'settings.trustFolder'
    | 'keybindings.get'
    | 'keybindings.update'
    | 'theme.get'
    | 'theme.update'
    | 'theme.importPath'
    | 'config.paths'
    | 'diagnostics.exportPath'
    | 'diagnostics.snapshot'
    | 'logs.query';

/**
 * Handlers that only delegate to an already-constructed Server service, with no dependency on the composition root's
 * own closures. Kept out of `create-domain-services.ts` to stay under the file's physical-line budget.
 */
export function createServiceHandlers(services: {
    acknowledgeFileMutation: (sessionId: string, operationId: string) => Promise<void>;
    agentChat: PullRequestMergeNoticeOptions['agentChat'];
    agentEnvironment: AgentEnvironment;
    agentHooks: AgentHookManager;
    awaitAgentSettingsReconcile: () => Promise<void>;
    commander: Omit<
        AgentCommanderServiceOptions,
        'database' | 'handovers' | 'inbox' | 'onLaunching' | 'pullRequests' | 'userDataPath'
    >;
    commanderHandovers: CommanderHandoverService;
    commanderInbox: CommanderInboxService;
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
    projectStatus: ProjectStatusService;
    sessionContext: SessionContextService;
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
        awaitAgentSettingsReconcile,
        commanderHandovers,
        commanderInbox,
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
        timeline,
        transcripts,
        userDataPath,
        vercel,
    } = services;
    const sessionContentSearch = new SessionContentSearch(database, agentEnvironment);
    const sessionConversationReferences = new SessionConversationReferenceService(
        defaultSessionReferenceDirectory(),
        database,
        logger,
        agentEnvironment,
    );
    const agentThroughput = new AgentThroughputService(database, agentEnvironment);
    const sessionPullRequests = new SessionPullRequestService(
        database,
        git,
        logger,
        externalStatus.run,
        {
            agentEnvironment,
            emit,
            github: externalStatus.github,
            sessionContext: (session) => sessionContext.read(session),
            settings: () => configuration.getSettings().value,
            vercel,
        },
    );
    projectStatus.useSessionPullRequests((sessionId) => sessionPullRequests.resolve(sessionId));
    const commander = new AgentCommanderService({
        ...services.commander,
        database,
        handovers: commanderHandovers,
        inbox: commanderInbox,
        logger,
        onLaunching: () => {
            commanderInbox.announceUnacknowledged();
            commanderHandovers.requeue();
        },
        pullRequests: () => sessionPullRequests.snapshot(),
        userDataPath,
    });
    const noticeMergedPullRequest = createPullRequestMergeNotice({
        agentChat: services.agentChat,
        database,
        isEnabled: () => configuration.getSettings().value['projectStatus.notifyAgentOnMerge'],
        logger,
        terminals: services.terminals,
    });
    const usage = new UsageService({
        database,
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
        'session.searchContent': ({ query }, signal) => sessionContentSearch.search(query, signal),
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
            const { id, displayTitle } = await addProjectFolder(database, emit, path);
            return { project: { id, displayTitle } };
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
            // Fire-and-forget: the refresh logs its own failure, and the merge already succeeded.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void refreshAfterMerge(sessionPullRequests, parameters.sessionId, parameters.number);
            // Fire-and-forget for the same reason: the notice logs its own outcome.
            // eslint-disable-next-line no-void -- intentional floating-promise discard
            void noticeMergedPullRequest(parameters.sessionId, result.url);
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
        'commander.ensure': () => commander.ensure(),
        'commander.snapshot': () => commander.snapshot(),
        'commander.status': () => commander.status(),
        'commander.stop': () => commander.stop(),
        'commander.data': () => commander.data(),
        'commander.switchAgent': ({ agent }) => commander.switchAgent(agent),
        'commander.clearData': (request) => commander.clearData(request),
        'commander.board': () => commander.board(),
        'commander.session.create': ({ projectId }) => commander.createSession(projectId),
        'commander.session.handOver': (request) => commanderHandovers.handOver(request),
        'commander.session.takeBack': ({ sessionId }) => commanderHandovers.takeBack(sessionId),
        'commander.managedSessions': () => commanderHandovers.managedSessions(),
        'commander.conversations': () => commanderHandovers.conversations(),
        'commander.task.create': (parameters) => commander.tasks.create(parameters),
        'commander.task.list': ({ includeClosed }) => ({
            tasks: commander.tasks.list({ includeClosed: includeClosed ?? false }),
        }),
        'commander.task.update': (parameters) => commander.tasks.update(parameters),
        'commander.inbox.list': ({ includeClosed }) => commanderInbox.list(includeClosed),
        'commander.inbox.show': ({ id }) => commanderInbox.show(id),
        'commander.inbox.add': (input) => commanderInbox.add(input),
        'commander.inbox.resolve': ({ id }) => commanderInbox.resolve(id),
        'commander.inbox.ack': ({ id, sequence }) => commanderInbox.acknowledge(id, sequence),
        'commander.inbox.reply': ({ id, body }) => commanderInbox.reply(id, body, 'desktop'),
        'commander.inbox.dismiss': ({ id }) => commanderInbox.dismiss(id),
        'commander.inbox.merge': ({ id, revision }) => commanderInbox.merge(id, revision),
        'mobile.commanderInbox.replyInternal': ({ id, body, principal }) => {
            if (principal.kind !== 'paired-device' || principal.role !== 'control')
                throw new CaxriError(
                    'FORBIDDEN',
                    'Control access is required to reply to the Inbox',
                );
            const item = commanderInbox.reply(id, body, 'mobile');
            // `reply` appends the new reply last, so the last sequence is the one just stored.
            return { sequence: item.replies.at(-1)?.sequence ?? item.replies.length };
        },
        'session.refreshDeliveryOnFocus': ({ sessionId }) => {
            // Fire-and-forget: the refresh logs its own outcome and the change events converge the UI.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void deliveryFocusRefresh.request(sessionId);
            return null;
        },
        'settings.get': () => configuration.getSettings(),
        'settings.inspect': () => configuration.inspectSettings(),
        'settings.patch': ({ changes, dryRun }) => configuration.patchSettings(changes, dryRun),
        'settings.delegation.import': ({ settings, dryRun }) =>
            configuration.importDelegationSettings(settings, dryRun),
        'agentHooks.get': () => agentHooks.getHealth(),
        'agentSkills.get': agentSkillHealthReader(database, agentEnvironment, userDataPath),
        'usage.report': (parameters) => usage.report(parameters),
        'terminal.agentUsage': ({ terminalId }) => usage.readTerminal(terminalId),
        'settings.update': async ({ source }) => {
            await configuration.updateSettings(source);
            await awaitAgentSettingsReconcile();
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
        'config.paths': () => ({
            settings: configuration.settingsPath,
            keybindings: configuration.keybindingsPath,
            theme: configuration.themePath,
        }),
        'diagnostics.exportPath': ({ destination }) => diagnostics.export(destination),
        'diagnostics.snapshot': () => diagnostics.snapshot(),
        'logs.query': (parameters) => introspection.logs.query(parameters),
    };
}

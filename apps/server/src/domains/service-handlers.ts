import type { ServerOperation } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import { agentSkillHealthReader } from './agent-skills';
import type {
    AgentEnvironment,
    AgentHookManager,
    AgentTimelineService,
    AgentTranscriptWatcher,
    LongPasteService,
} from './agents';
import {
    listAgentActions,
    readAgentReplySummary,
    readAgentTranscript,
    recordRecentAgentAction,
    SessionContentSearch,
} from './agents';
import type { AgentCommanderServiceOptions } from './commander';
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
import { resolveOwnerProjectRoot, resolveProjectRoot } from './project-root-identity';
import type { ProjectStatusService, VercelDeploymentStore } from './project-status';
import type { PullRequestMergeNoticeOptions } from './pull-request-merge-notice';
import { createPullRequestMergeNotice } from './pull-request-merge-notice';
import { refreshAfterMerge } from './pull-request-merge-refresh';
import type { SessionContextService } from './session-context';
import { SessionPullRequestService } from './session-pull-requests';
import { resolveTerminalFileLink } from './terminal';

type ServiceHandlerMethods =
    | 'agent.message.send'
    | 'agent.message.reply'
    | 'agent.message.wait'
    | 'agent.message.check'
    | 'agent.message.receipt'
    | 'agent.message.policy.get'
    | 'agent.message.policy.set'
    | 'agent.message.held'
    | 'agent.message.held.get'
    | 'agent.message.approve'
    | 'agent.message.deny'
    | 'agent.replySummary'
    | 'agent.delegation.access.bootstrap'
    | 'agentActions.list'
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
    | 'files.read'
    | 'files.readAsset'
    | 'files.write'
    | 'files.search'
    | 'terminal.agentTranscript'
    | 'terminal.commitLink.resolve'
    | 'terminal.reference.preview'
    | 'terminal.fileLink.resolve'
    | 'terminal.prepareLongPaste'
    | 'terminal.referenceContext'
    | 'project.create'
    | 'project.setIcon'
    | 'git.summary'
    | 'git.overview'
    | 'git.branches'
    | 'git.switchBranch'
    | 'git.sync'
    | 'git.discard'
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
    | 'session.pullRequests'
    | 'commander.ensure'
    | 'commander.snapshot'
    | 'commander.board'
    | 'commander.session.create'
    | 'commander.status'
    | 'commander.stop'
    | 'session.refreshDeliveryOnFocus'
    | 'session.searchContent'
    | 'settings.get'
    | 'settings.inspect'
    | 'settings.patch'
    | 'settings.delegation.import'
    | 'agentHooks.get'
    | 'agentSkills.get'
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
    | 'logs.query'
    | 'pathBrowser.browse'
    | 'pathBrowser.close'
    | 'pathBrowser.navigate'
    | 'pathBrowser.open'
    | 'pathBrowser.start';

/**
 * Methods the Renderer may call but that only Electron Main can satisfy.
 */
export function mainOwned(method: ServerOperation): never {
    throw new CaxriError('CONFLICT', `${method} must be handled by Electron Main`);
}

/**
 * Every method the Server rejects outright because Electron Main answers it before the request reaches Core. Listed
 * here rather than as one handler line each in `create-domain-services.ts` to keep that file under its physical-line
 * budget.
 */
const MAIN_OWNED_METHODS = [
    'extensions.retry',
    'requests.cancel',
    'viewContainers.cancelRequest',
    'viewContainers.catalog',
    'viewContainers.executeCommand',
    'viewContainers.treeChildren',
    'viewContainers.viewOperation',
    'agent.context',
    'agent.list',
    'agent.grants',
    'agent.grant',
    'agent.revoke',
    'agent.delegation.access.create',
    'agent.delegation.access.list',
    'agent.delegation.access.revoke',
    'agent.message.send',
    'agent.message.reply',
    'agent.message.wait',
    'agent.message.check',
    'agent.message.receipt',
    'agent.message.policy.get',
    'agent.message.policy.set',
    'agent.message.held',
    'agent.message.held.get',
    'agent.message.approve',
    'agent.message.deny',
    'events.recover',
    'events.query',
    'host.status',
    'host.stop',
    'mobile.access.status',
    'mobile.access.enable',
    'mobile.access.disable',
    'mobile.pairing.create',
    'mobile.device.list',
    'mobile.dashboard',
    'mobile.agent.actions',
    'mobile.session.archived',
    'mobile.session.rename',
    'mobile.session.archive',
    'mobile.session.restore',
    'mobile.terminal.takeOver',
    'mobile.terminal.release',
    'mobile.terminal.input',
    'mobile.terminal.scroll',
    'mobile.agentChat.read',
    'mobile.agentChat.send',
    'mobile.agentChat.interrupt',
    'mobile.agentChat.respond',
    'mobile.agentChat.retry',
    'mobile.device.revoke',
    'mobile.device.revoke.apply',
    'desktop.status',
    'desktop.focus',
    'desktop.openPath',
    'desktop.openProject',
    'desktop.openFile',
    'external.open',
    'argv.get',
    'argv.update',
    'gpu.restartInSafeMode',
    'gpu.testInjectContextLoss',
    'contextMenu.show',
    'processExplorer.open',
    'agentCommander.open',
    'agentCommander.openFileLink',
    'agentCommander.openSettings',
    'agentCommander.revealSession',
    'agentCommander.stop',
    'dialog.selectDirectory',
    'editor.confirmDiscard',
    'diagnostics.export',
    'bugReport.captureScreenshot',
    'bugReport.saveScreenshot',
    'bugReport.send',
    'files.reveal',
    'files.openWithDefaultApp',
    'externalDocument.write',
    'externalDocument.reveal',
    'externalDocument.openWithDefaultApp',
    'externalDocument.openInTerminal',
    'project.openInEditor',
    'project.openRoot',
    'files.trash',
    'updates.getState',
    'updates.check',
    'updates.acknowledge',
    'updates.download',
    'updates.cancel',
    'updates.open',
    'shellCommand.install',
    'shellCommand.uninstall',
    'theme.import',
    'project.query',
    'session.query',
    'terminal.openFileLink',
    'terminal.query',
] as const satisfies readonly ServerOperation[];

export const mainOwnedHandlers = Object.fromEntries(
    MAIN_OWNED_METHODS.map((method) => [method, () => mainOwned(method)]),
) as Record<(typeof MAIN_OWNED_METHODS)[number], () => never>;

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
    commander: Omit<AgentCommanderServiceOptions, 'database' | 'pullRequests' | 'userDataPath'>;
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
        logger,
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
    const deliveryFocusRefresh = new DeliveryFocusRefresh({
        logger,
        projectStatus,
        sessionPullRequests,
    });
    return {
        'agent.message.send': () => mainOwned('agent.message.send'),
        'agent.message.reply': () => mainOwned('agent.message.reply'),
        'agent.message.wait': () => mainOwned('agent.message.wait'),
        'agent.message.check': () => mainOwned('agent.message.check'),
        'agent.message.receipt': () => mainOwned('agent.message.receipt'),
        'agent.message.policy.get': () => mainOwned('agent.message.policy.get'),
        'agent.message.policy.set': () => mainOwned('agent.message.policy.set'),
        'agent.message.held': () => mainOwned('agent.message.held'),
        'agent.message.held.get': () => mainOwned('agent.message.held.get'),
        'agent.message.approve': () => mainOwned('agent.message.approve'),
        'agent.message.deny': () => mainOwned('agent.message.deny'),
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
        'files.resolveImports': (parameters) => files.resolveImports(parameters),
        'files.resolveKind': async (parameters) => (await files.authorizeOpen(parameters)).kind,
        'files.read': ({ sessionId, path }) => files.read(sessionId, path),
        'files.readAsset': ({ sessionId, path }, signal) =>
            files.readAsset(sessionId, path, signal),
        'files.write': ({ sessionId, path, content }) => files.write(sessionId, path, content),
        'session.searchContent': ({ query }, signal) => sessionContentSearch.search(query, signal),
        'files.search': (parameters, signal) => files.search(parameters, signal),
        'pathBrowser.start': () => mainOwned('pathBrowser.start'),
        'pathBrowser.browse': () => mainOwned('pathBrowser.browse'),
        'pathBrowser.navigate': () => mainOwned('pathBrowser.navigate'),
        'pathBrowser.open': () => mainOwned('pathBrowser.open'),
        'pathBrowser.close': () => mainOwned('pathBrowser.close'),
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
        'project.setIcon': ({ projectId, icon }) => {
            const project = database.setProjectIcon(projectId, icon);
            emit({ event: 'state.changed', payload: { kind: 'full', reason: 'project.setIcon' } });
            return project;
        },
        'git.summary': ({ sessionId, refresh, requester }, signal) =>
            withGitRequestSignal(signal, () => git.summary(sessionId, refresh, requester)),
        'git.overview': ({ sessionId, refresh }) => git.overview(sessionId, refresh),
        'git.branches': (parameters) => git.branches(parameters),
        'git.switchBranch': (parameters) => git.switchBranch(parameters),
        'git.sync': (parameters, signal) =>
            withGitRequestSignal(signal, () => git.sync(parameters)),
        'git.discard': () => mainOwned('git.discard'),
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
        'session.pullRequests': () => sessionPullRequests.snapshot(),
        'commander.ensure': () => commander.ensure(),
        'commander.snapshot': () => commander.snapshot(),
        'commander.status': () => commander.status(),
        'commander.stop': () => commander.stop(),
        'commander.board': () => commander.board(),
        'commander.session.create': ({ projectId }) => commander.createSession(projectId),
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

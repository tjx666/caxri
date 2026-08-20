import { agentSkillHealthReader } from './agent-skills';
import type { AgentEnvironment, AgentHookManager } from './agents';
import { readAgentTranscript } from './agents';
import type { ConfigService } from './config';
import type { CaxriDatabase } from './db';
import type { DiagnosticsService } from './diagnostics';
import type { RuntimeHandlers } from './dispatch';
import type { FileService } from './files';
import type { GitService } from './git';
import type { createIntrospectionServices } from './introspection';
import type { ProjectStatusService } from './project-status';

type ServiceHandlerMethods =
    | 'files.list'
    | 'files.browse'
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
    | 'files.write'
    | 'files.search'
    | 'terminal.agentTranscript'
    | 'git.summary'
    | 'git.overview'
    | 'git.branches'
    | 'git.switchBranch'
    | 'git.sync'
    | 'git.discard'
    | 'git.diffDocument'
    | 'git.pullRequestChanges'
    | 'git.pullRequestDiffDocument'
    | 'git.commits'
    | 'git.commitDetails'
    | 'git.commitDiffDocument'
    | 'git.blame'
    | 'git.fileHead'
    | 'projectStatus.summary'
    | 'projectStatus.overview'
    | 'settings.get'
    | 'settings.inspect'
    | 'settings.patch'
    | 'agentHooks.get'
    | 'agentSkills.get'
    | 'settings.update'
    | 'settings.trustDomain'
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
 * Handlers that only delegate to an already-constructed Runtime service, with no dependency on the composition root's
 * own closures. Kept out of `bootstrap.ts` to stay under the file's physical-line budget.
 */
export function createServiceHandlers(services: {
    acknowledgeFileMutation: (operationId: string) => Promise<void>;
    agentEnvironment: AgentEnvironment;
    agentHooks: AgentHookManager;
    awaitAgentSettingsReconcile: () => Promise<void>;
    configuration: ConfigService;
    database: CaxriDatabase;
    diagnostics: DiagnosticsService;
    files: FileService;
    git: GitService;
    introspection: ReturnType<typeof createIntrospectionServices>;
    projectStatus: ProjectStatusService;
    userDataPath: string;
}): Pick<RuntimeHandlers, ServiceHandlerMethods> {
    const {
        acknowledgeFileMutation,
        agentEnvironment,
        agentHooks,
        awaitAgentSettingsReconcile,
        configuration,
        database,
        diagnostics,
        files,
        git,
        introspection,
        projectStatus,
        userDataPath,
    } = services;
    return {
        'files.list': ({ sessionId, directory }) => files.list(sessionId, directory),
        'files.browse': (parameters) => files.browse(parameters),
        'files.create': (parameters) => files.create(parameters),
        'files.copy': (parameters) => files.copy(parameters),
        'files.rename': (parameters) => files.rename(parameters),
        'files.move': (parameters) => files.move(parameters),
        'files.operation.get': async ({ operationId }) =>
            (await files.getMutationOperation(operationId)) ?? null,
        'files.operation.list': () => files.listMutationOperations(),
        'files.operation.cancel': ({ operationId }) => files.cancelMutationOperation(operationId),
        'files.operation.acknowledge': async ({ operationId }) => {
            await acknowledgeFileMutation(operationId);
            return null;
        },
        'files.authorizeTrash': (parameters) => files.authorizeTrash(parameters),
        'files.authorizeOpen': (parameters) => files.authorizeOpen(parameters),
        'files.read': ({ sessionId, path }) => files.read(sessionId, path),
        'files.write': ({ sessionId, path, content }) => files.write(sessionId, path, content),
        'files.search': (parameters) => files.search(parameters),
        'terminal.agentTranscript': ({ terminalId, withContent }) =>
            readAgentTranscript(database, terminalId, withContent, agentEnvironment),
        'git.summary': ({ sessionId, refresh }) => git.summary(sessionId, refresh),
        'git.overview': ({ sessionId }) => git.overview(sessionId),
        'git.branches': (parameters) => git.branches(parameters),
        'git.switchBranch': (parameters) => git.switchBranch(parameters),
        'git.sync': (parameters) => git.sync(parameters),
        'git.discard': (parameters) => git.discard(parameters),
        'git.diffDocument': ({ sessionId, repositoryId, path }) =>
            git.diffDocument(sessionId, repositoryId, path),
        'git.pullRequestChanges': (parameters) => git.pullRequestChanges(parameters),
        'git.pullRequestDiffDocument': (parameters) => git.pullRequestDiffDocument(parameters),
        'git.commits': (parameters) => git.commits(parameters),
        'git.commitDetails': (parameters) => git.commitDetails(parameters),
        'git.commitDiffDocument': (parameters) => git.commitDiffDocument(parameters),
        'git.blame': (parameters) => git.blame(parameters),
        'git.fileHead': (parameters) => git.fileHead(parameters),
        'projectStatus.summary': ({ sessionId, refreshToken }) =>
            projectStatus.summary(sessionId, refreshToken),
        'projectStatus.overview': ({ sessionId }) => projectStatus.overview(sessionId),
        'settings.get': () => configuration.getSettings(),
        'settings.inspect': () => configuration.inspectSettings(),
        'settings.patch': ({ changes, dryRun }) => configuration.patchSettings(changes, dryRun),
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
            const theme = await configuration.importTheme(path);
            database.setAppState('activeThemeId', theme.id);
            return theme;
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

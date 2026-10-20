import type { MainRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

type DesktopMethod = MainRequest['method'];

/**
 * Which Workbench environments may call a Main-owned method.
 *
 * - `any`: the method acts on this app (dialogs, menus, updates, URLs) or only on the calling window's own Server.
 * - `local-only`: the method reads or writes this machine's disk or OS on behalf of a path, or drives a window bound to
 *   the local Server. An SSH Host window must never reach it, because a remote path that happens to exist locally would
 *   be acted on in the wrong place.
 * - `remote-override`: both environments call it, and the SSH Host window's handler takes a remote-safe branch (for
 *   example creating a Project from a folder the remote Server listed, with no local folder grant).
 * - `ssh-only`: only an SSH Host window has the state these methods act on.
 */
type EnvironmentMethodScope = 'any' | 'local-only' | 'remote-override' | 'ssh-only';

/**
 * Exhaustive per-method decision; adding a Main-owned method fails compilation until it is classified here. See
 * docs/adr/0014-ssh-remote-server.md.
 */
const environmentMethodScopes = {
    'agentChat.confirmRevertFiles': 'any',
    'agentChat.openPathReference': 'local-only',
    'agentCommander.open': 'local-only',
    'agentCommander.stop': 'local-only',
    'agentCommander.revealSession': 'local-only',
    'agentCommander.openSettings': 'local-only',
    'agentCommander.openFileLink': 'local-only',
    'agentCommander.clearData': 'local-only',
    /**
     * Benchmark runs on the local Server; an SSH Host window has no Benchmark window of its own.
     */
    'benchmark.open': 'local-only',
    /**
     * The share card goes to this Mac's clipboard or disk, which an SSH Host window has no access to.
     */
    'benchmark.shareImage.copy': 'local-only',
    'benchmark.shareImage.save': 'local-only',
    'bugReport.captureScreenshot': 'local-only',
    'bugReport.saveScreenshot': 'local-only',
    /**
     * The screenshot reaches the Agent through this Mac's clipboard, which a remote Agent CLI cannot read.
     */
    'bugReport.send': 'local-only',
    'mobile.device.revoke': 'any',
    'session.authorizeWorkbenchRoot': 'remote-override',
    'session.continueInWorktree': 'remote-override',
    /**
     * An SSH Host window's path browser identifies directories through its own Server and has no free mode, so it never
     * lists this Mac's disk.
     */
    'pathBrowser.start': 'remote-override',
    'pathBrowser.browse': 'remote-override',
    'pathBrowser.navigate': 'remote-override',
    'pathBrowser.open': 'remote-override',
    'pathBrowser.close': 'remote-override',
    'argv.get': 'any',
    'argv.update': 'any',
    'gpu.restartInSafeMode': 'any',
    'gpu.testInjectContextLoss': 'any',
    'shellCommand.install': 'local-only',
    'shellCommand.uninstall': 'local-only',
    'environment.get': 'any',
    'sshHost.hosts.list': 'any',
    'sshHost.connect': 'any',
    'sshHost.reconnect': 'ssh-only',
    'sshHost.retryNow': 'ssh-only',
    'sshHost.cancel': 'ssh-only',
    /**
     * Reveals this Mac's own SSH config, which the Connect to SSH Host picker reads in every window.
     */
    'sshHost.sshConfig.reveal': 'any',
    'sshHost.stopServer': 'ssh-only',
    'sshHost.askpass.reply': 'ssh-only',
    'contextMenu.show': 'any',
    'externalDocument.write': 'local-only',
    'externalDocument.read': 'local-only',
    'externalDocument.watch': 'local-only',
    'externalDocument.readAsset': 'local-only',
    'externalDocument.openLinked': 'local-only',
    'externalDocument.reveal': 'local-only',
    'externalDocument.openWithDefaultApp': 'local-only',
    'externalDocument.openInTerminal': 'local-only',
    'editor.confirmDiscard': 'any',
    'editor.unsavedReply': 'any',
    'links.favicon': 'any',
    'agentProviderStatus.read': 'any',
    'links.preview': 'any',
    'external.open': 'any',
    'processExplorer.open': 'local-only',
    'dialog.selectDirectory': 'local-only',
    /**
     * The panel lists this Mac's disk, whose paths mean nothing to an Agent on the SSH Host; that window's `+` keeps
     * the file-only picker for its images instead.
     */
    'dialog.selectPaths': 'local-only',
    /**
     * Server Core writes the archive to the chosen path, which would be a path on the SSH Host.
     */
    'diagnostics.export': 'local-only',
    'updates.getState': 'any',
    'updates.check': 'any',
    'updates.acknowledge': 'any',
    'updates.download': 'any',
    'updates.cancel': 'any',
    'updates.open': 'any',
    'project.create': 'remote-override',
    'project.cancelCreate': 'remote-override',
    'project.delete': 'any',
    'session.delete': 'any',
    'session.deleteMany': 'any',
    'terminal.openFileLink': 'remote-override',
    /**
     * Electron's Trash API moves a local path, so an SSH Host window asks its Server to move the entry into the remote
     * host's own Trash instead.
     */
    'files.trash': 'remote-override',
    'git.discard': 'any',
    /**
     * Server Core imports a path the native picker chose on this Mac.
     */
    'theme.import': 'local-only',
    /**
     * Reads the calling window's own fullscreen state, so its title bar restores the right chrome after a reload.
     */
    'window.fullScreen.get': 'any',
    'window.reportViewing': 'any',
} as const satisfies Record<DesktopMethod, EnvironmentMethodScope>;

export type EnvironmentKind = 'local' | 'ssh';

export function isMethodAvailable(method: DesktopMethod, environment: EnvironmentKind): boolean {
    const scope: EnvironmentMethodScope = environmentMethodScopes[method];
    if (environment === 'local') return scope !== 'ssh-only';
    return scope !== 'local-only';
}

/**
 * Wraps a Main method handler so a request the environment may not make fails before any handler code runs.
 */
export function guardEnvironmentMethods(
    environment: EnvironmentKind,
    handler: (request: MainRequest) => Promise<unknown>,
): (request: MainRequest) => Promise<unknown> {
    return (request) => {
        if (!isMethodAvailable(request.method, environment))
            return Promise.reject(
                new CaxriError(
                    'UNAVAILABLE',
                    environment === 'ssh'
                        ? `${request.method} acts on this computer and is unavailable in an SSH Host window`
                        : `${request.method} is only available in an SSH Host window`,
                ),
            );
        return handler(request);
    };
}

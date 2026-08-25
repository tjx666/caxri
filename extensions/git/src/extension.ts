import type {
    CancellationToken,
    ExtensionContext,
    SourceControlChange,
    SourceControlMode,
    SourceControlProvider,
} from 'caxri';
import caxri, { EventEmitter } from 'caxri';

function assertNotCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested)
        throw Object.assign(new Error('Source Control request was cancelled'), {
            code: 'CANCELLED',
        });
}

class GitProvider implements SourceControlProvider {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<SourceControlChange>();
    readonly onDidChange = this.changed.event;

    summary(refresh: number, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.git.summary(refresh, token);
    }

    sync(repoId: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.git.sync(repoId, token);
    }

    discard(
        repo: Parameters<SourceControlProvider['discard']>[0],
        scope: Parameters<SourceControlProvider['discard']>[1],
        token: CancellationToken,
    ) {
        assertNotCancelled(token);
        return caxri.workspace.git.discard(repo, scope, token);
    }

    pullRequestChanges(repoId: string, refresh: number, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.git.pullRequestChanges(repoId, refresh, token);
    }

    commits(options: Parameters<SourceControlProvider['commits']>[0], token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.git.commits(options, token);
    }

    commitDetails(
        options: Parameters<SourceControlProvider['commitDetails']>[0],
        token: CancellationToken,
    ) {
        assertNotCancelled(token);
        return caxri.workspace.git.commitDetails(options, token);
    }

    remoteHost(repoId: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.git.remoteHost(repoId, token);
    }

    refresh(): void {
        this.changed.fire({ kind: 'refresh' });
    }

    setMode(mode: SourceControlMode): void {
        this.changed.fire({ kind: 'mode', mode });
    }

    dispose(): void {
        this.changed.dispose();
    }
}

export function activate(context: ExtensionContext): void {
    const provider = new GitProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerSourceControlProvider('caxri.git.sourceControl', provider),
        caxri.commands.registerCommand('caxri.git.workingTree', () => provider.setMode('working')),
        caxri.commands.registerCommand('caxri.git.lastCommit', () => provider.setMode('commit')),
        caxri.commands.registerCommand('caxri.git.pullRequest', () =>
            provider.setMode('pull-request'),
        ),
        caxri.commands.registerCommand('caxri.git.refresh', () => provider.refresh()),
        caxri.workspace.onDidChangeActiveContext(() => provider.refresh()),
        caxri.workspace.onDidChangeGit(() => provider.refresh()),
    );
}

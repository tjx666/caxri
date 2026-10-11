import type { ExtensionContext } from 'caxri';
import caxri, { CancellationTokenSource } from 'caxri';

import { GitProvider } from './git-provider';
import { workingTreeBadge } from './working-tree-badge';

function registerProviderCommand(provider: GitProvider, commandId: string) {
    return caxri.commands.registerCommand(commandId, async (...arguments_: readonly unknown[]) => {
        const cancellation = new CancellationTokenSource();
        try {
            // The action result feeds the Source Control view's own refresh, not the command dispatcher.
            await provider.executeCommand(commandId, arguments_, cancellation.token);
        } finally {
            cancellation.dispose();
        }
    });
}

export function activate(context: ExtensionContext): void {
    const provider = new GitProvider();
    const currentScopeId = (): string | undefined => caxri.workspace.getCurrentContext()?.scopeId;
    context.subscriptions.push(
        provider,
        caxri.views.registerSourceControlProvider('caxri.git.sourceControl', provider),
        caxri.views.registerViewBadgeProvider('caxri.git.sourceControl', {
            onDidChangeBadge: (listener) => caxri.workspace.onDidChangeGit(() => listener()),
            provideBadge: async (_request, token) =>
                workingTreeBadge(await caxri.workspace.git.summary(0, token)),
        }),
        caxri.commands.registerCommand('caxri.git.workingTree', () =>
            provider.setMode('working', currentScopeId()),
        ),
        caxri.commands.registerCommand('caxri.git.lastCommit', () =>
            provider.setMode('commit', currentScopeId()),
        ),
        caxri.commands.registerCommand('caxri.git.pullRequest', () =>
            provider.setMode('pull-request', currentScopeId()),
        ),
        caxri.commands.registerCommand('caxri.git.refresh', () =>
            provider.forceRefresh(currentScopeId()),
        ),
        caxri.commands.registerCommand('caxri.git.openCommit', async (repoId, sha) => {
            const scopeId = currentScopeId();
            if (!scopeId || typeof repoId !== 'string' || typeof sha !== 'string')
                throw Object.assign(new Error('Git commit target is unavailable'), {
                    code: 'PROJECT_SCOPE_DENIED',
                });
            const cancellation = new CancellationTokenSource();
            try {
                await provider.openCommit(scopeId, repoId, sha, cancellation.token);
            } finally {
                cancellation.dispose();
            }
        }),
        ...[
            'caxri.git.sync',
            'caxri.git.discardAll',
            'caxri.git.discard',
            'caxri.git.openChanges',
            'caxri.git.history',
        ].map((commandId) => registerProviderCommand(provider, commandId)),
        caxri.workspace.onDidChangeActiveContext(({ scopeId }) => provider.refresh(scopeId)),
        caxri.workspace.onDidChangeGit(({ scopeId }) => provider.refresh(scopeId)),
    );
}

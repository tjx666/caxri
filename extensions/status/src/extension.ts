import type {
    CancellationToken,
    CaxriApi,
    CommandResult,
    ExtensionContext,
    TreeDataProvider,
    TreeItem,
} from 'caxri';
import caxri, { EventEmitter } from 'caxri';

import { statusBadge } from './status-badge';
import type { StatusNode } from './status-item';
import type { MergePullRequestArguments } from './status-merge';
import {
    currentBranchMerge,
    isMergePullRequestArguments,
    MERGE_CURRENT_PULL_REQUEST_COMMAND,
    MERGE_PULL_REQUEST_COMMAND,
    mergedMessage,
} from './status-merge';
import { buildStatusRootNodes } from './status-tree';

export class ProjectStatusProvider implements TreeDataProvider<StatusNode> {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<StatusNode | readonly StatusNode[] | undefined>();
    // eslint-disable-next-line unicorn/prefer-event-target -- Extension API subscriptions use the public Event contract.
    private readonly badgeChanged = new EventEmitter<void>();
    private readonly forceRequests = new Set<string>();
    private refreshToken?: string;
    readonly onDidChangeTreeData = this.changed.event;
    readonly onDidChangeBadge = this.badgeChanged.event;

    constructor(
        private readonly workspace: Pick<
            CaxriApi['workspace'],
            'getProjectStatus'
        > = caxri.workspace,
    ) {}

    async getChildren(
        element: StatusNode | undefined,
        token: CancellationToken,
    ): Promise<readonly StatusNode[]> {
        if (element) return element.children ?? [];
        const refreshToken = this.refreshToken;
        if (refreshToken) this.forceRequests.add(refreshToken);
        try {
            const summary = await this.workspace.getProjectStatus(
                refreshToken ? { refreshToken } : undefined,
            );
            if (token.isCancellationRequested) return [];
            return buildStatusRootNodes(summary);
        } finally {
            if (refreshToken) this.forceRequests.delete(refreshToken);
            if (this.refreshToken === refreshToken) this.refreshToken = undefined;
        }
    }

    getTreeItem(element: StatusNode): TreeItem {
        return element.item;
    }

    async provideBadge() {
        return statusBadge(await this.workspace.getProjectStatus());
    }

    refresh(shouldForce = false): void {
        if (shouldForce) this.refreshToken = crypto.randomUUID();
        this.changed.fire(undefined);
    }

    projectStatusChanged(): void {
        this.badgeChanged.fire();
        /**
         * Runtime echoes the completed forced request before its API reply reaches this provider.
         */
        if (this.refreshToken || this.forceRequests.size > 0) return;
        this.changed.fire(undefined);
    }

    dispose(): void {
        this.badgeChanged.dispose();
        this.changed.dispose();
    }
}

/**
 * Merges the pull request and refreshes the panel either way. Resolves with the success toast text, which names the
 * method Server Core chose; the inline action's declared `feedback` supplies the failure prefix and Open on GitHub.
 */
export async function mergePullRequest(
    provider: Pick<ProjectStatusProvider, 'refresh'>,
    target: MergePullRequestArguments,
    git: Pick<CaxriApi['workspace']['git'], 'mergePullRequest'> = caxri.workspace.git,
): Promise<CommandResult> {
    try {
        const { method } = await git.mergePullRequest(target.repositoryId, {
            number: target.number,
            headSha: target.headSha,
        });
        return { message: mergedMessage(method, target.number) };
    } finally {
        // Refresh on failure too: a rejected merge usually means the row was stale (a new push, a new conflict), and
        // the forced read shows why instead of offering the same doomed button again.
        provider.refresh(true);
    }
}

export function activate(context: ExtensionContext): void {
    const provider = new ProjectStatusProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerTreeDataProvider('caxri.project-status.overview', provider),
        caxri.views.registerViewBadgeProvider('caxri.project-status.overview', provider),
        caxri.commands.registerCommand('caxri.project-status.refresh', () =>
            provider.refresh(true),
        ),
        caxri.commands.registerCommand(MERGE_PULL_REQUEST_COMMAND, async (target: unknown) => {
            if (!isMergePullRequestArguments(target))
                throw new Error('Merge Pull Request needs a pull request from the Status panel');
            return mergePullRequest(provider, target);
        }),
        caxri.commands.registerCommand(MERGE_CURRENT_PULL_REQUEST_COMMAND, async () => {
            const decision = currentBranchMerge(
                (await caxri.workspace.getProjectStatus()).repositories,
            );
            if (decision.kind === 'refuse') throw new Error(decision.message);
            return mergePullRequest(provider, decision.arguments);
        }),
        /**
         * Deliberately no `onDidChangeActiveContext` subscription. The Workbench already rebuilds this View per active
         * Session and re-reads its root on remount, so refreshing here only retired the Host handles the remount was
         * about to request again, a second round trip whose sole visible effect was making a Session switch look like a
         * Project Status refetch. Git and Project Status changes, plus the manual refresh command, remain the ways this
         * tree is invalidated.
         */
        caxri.workspace.onDidChangeGit(({ scopeId }) => {
            if (scopeId === caxri.workspace.getCurrentContext()?.scopeId)
                provider.projectStatusChanged();
        }),
        caxri.workspace.onDidChangeProjectStatus(() => provider.projectStatusChanged()),
    );
}

import type {
    CancellationToken,
    CaxriApi,
    ExtensionContext,
    TreeDataProvider,
    TreeItem,
} from 'caxri';
import caxri, { EventEmitter } from 'caxri';

import { statusBadge } from './status-badge';
import type { StatusNode } from './status-tree';
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

export function activate(context: ExtensionContext): void {
    const provider = new ProjectStatusProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerTreeDataProvider('caxri.project-status.overview', provider),
        caxri.views.registerViewBadgeProvider('caxri.project-status.overview', provider),
        caxri.commands.registerCommand('caxri.project-status.refresh', () =>
            provider.refresh(true),
        ),
        caxri.workspace.onDidChangeActiveContext(() => provider.refresh()),
        caxri.workspace.onDidChangeProjectStatus(() => provider.projectStatusChanged()),
    );
}

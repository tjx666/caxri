import type { CancellationToken, ExtensionContext, TreeDataProvider } from 'caxri';
import caxri, { EventEmitter, ThemeIcon, TreeItem } from 'caxri';

import type { StatusNode } from './status-tree';
import { buildRepoNode } from './status-tree';

class ProjectStatusProvider implements TreeDataProvider<StatusNode> {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<StatusNode | readonly StatusNode[] | undefined>();
    readonly onDidChangeTreeData = this.changed.event;

    async getChildren(
        element: StatusNode | undefined,
        token: CancellationToken,
    ): Promise<readonly StatusNode[]> {
        if (element) return element.children ?? [];
        const summary = await caxri.workspace.getProjectStatus();
        if (token.isCancellationRequested) return [];
        if (summary.error) {
            const item = new TreeItem(summary.error);
            item.iconPath = new ThemeIcon('warning');
            return [{ item }];
        }
        return summary.repositories.map(buildRepoNode);
    }

    getTreeItem(element: StatusNode): TreeItem {
        return element.item;
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    dispose(): void {
        this.changed.dispose();
    }
}

export function activate(context: ExtensionContext): void {
    const provider = new ProjectStatusProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerTreeDataProvider('caxri.project-status.overview', provider),
        caxri.commands.registerCommand('caxri.project-status.refresh', () => provider.refresh()),
        caxri.workspace.onDidChangeActiveContext(() => provider.refresh()),
    );
}

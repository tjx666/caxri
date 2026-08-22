import process from 'node:process';

import type { CancellationToken, ExtensionContext, TreeDataProvider } from 'caxri';
import caxri, { EventEmitter, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'caxri';

interface FixtureNode {
    kind: 'branch' | 'command' | 'leaf' | 'throw' | 'timeout' | 'overflow';
    label: string;
    depth?: number;
}

function cancellableDelay(milliseconds: number, token: CancellationToken): Promise<void> {
    if (token.isCancellationRequested) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        const subscription = token.onCancellationRequested(() => {
            clearTimeout(timer);
            subscription.dispose();
            resolve();
        });
    });
}

class FixtureProvider implements TreeDataProvider<FixtureNode> {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<FixtureNode | readonly FixtureNode[] | undefined>();
    private commandActivationCount = 0;
    private commandRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    readonly onDidChangeTreeData = this.changed.event;

    async getChildren(
        element: FixtureNode | undefined,
        token: CancellationToken,
    ): Promise<readonly FixtureNode[]> {
        if (!element) {
            await cancellableDelay(180, token);
            return token.isCancellationRequested
                ? []
                : [
                      { kind: 'branch', label: 'Lazy children' },
                      { kind: 'branch', label: 'Deep tree', depth: 0 },
                      { kind: 'throw', label: 'Provider error' },
                      { kind: 'timeout', label: 'Provider timeout' },
                      { kind: 'overflow', label: 'Payload limit' },
                      {
                          kind: 'command',
                          label: `Command activations: ${this.commandActivationCount}`,
                      },
                      ...Array.from({ length: 400 }, (_, index) => ({
                          kind: 'leaf' as const,
                          label: `Virtual row ${index}`,
                      })),
                  ];
        }
        if (element.kind === 'throw') throw new Error('Fixture provider failure');
        if (element.kind === 'timeout') {
            await cancellableDelay(30_000, token);
            return [];
        }
        if (element.kind === 'overflow') {
            return Array.from({ length: 1_001 }, (_, index) => ({
                kind: 'leaf' as const,
                label: `Overflow ${index}`,
            }));
        }
        if (element.label === 'Lazy children') {
            await cancellableDelay(180, token);
            return token.isCancellationRequested
                ? []
                : [
                      { kind: 'leaf', label: 'Alpha' },
                      { kind: 'leaf', label: 'Beta' },
                  ];
        }
        const depth = element.depth ?? 0;
        if (depth >= 250) return [{ kind: 'leaf', label: 'Deep leaf' }];
        return Array.from({ length: 8 }, (_, index) => ({
            kind: index === 0 ? ('branch' as const) : ('leaf' as const),
            label: `Level ${depth + 1} item ${index + 1}`,
            depth: depth + 1,
        }));
    }

    getTreeItem(element: FixtureNode): TreeItem {
        const isCollapsible = ['branch', 'throw', 'timeout', 'overflow'].includes(element.kind);
        const item = new TreeItem(
            element.label,
            isCollapsible ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None,
        );
        item.id = `${element.kind}:${element.depth ?? 0}:${element.label}`;
        item.iconPath = new ThemeIcon(isCollapsible ? 'folder' : 'symbol-string');
        item.accessibilityInformation = { label: element.label };
        if (element.kind === 'command') {
            item.command = {
                command: 'caxri.fixture.recordCommand',
                title: 'Record fixture command activation',
            };
        }
        return item;
    }

    recordCommandActivation(): void {
        this.commandActivationCount += 1;
        clearTimeout(this.commandRefreshTimer);
        this.commandRefreshTimer = setTimeout(() => this.changed.fire(undefined), 100);
    }

    refresh(): void {
        this.changed.fire(undefined);
    }

    dispose(): void {
        clearTimeout(this.commandRefreshTimer);
        this.changed.dispose();
    }
}

export function activate(context: ExtensionContext): void {
    const provider = new FixtureProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerTreeDataProvider('caxri.fixture.tree', provider),
        caxri.commands.registerCommand('caxri.fixture.refresh', () => provider.refresh()),
        caxri.commands.registerCommand('caxri.fixture.recordCommand', () =>
            provider.recordCommandActivation(),
        ),
        caxri.commands.registerCommand('caxri.fixture.crashHost', () => {
            // eslint-disable-next-line unicorn/no-process-exit -- This fixture command intentionally terminates the Extension Host for recovery coverage.
            process.exit(86);
        }),
    );
}

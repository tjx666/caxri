import type {
    CancellationToken,
    ExtensionContext,
    ResourceExplorerChange,
    ResourceExplorerProvider,
    WorkspaceFileChange,
} from 'caxri';
import caxri, { EventEmitter } from 'caxri';

function assertNotCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested)
        throw Object.assign(new Error('Resource Explorer request was cancelled'), {
            code: 'CANCELLED',
        });
}

class FilesProvider implements ResourceExplorerProvider {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<ResourceExplorerChange>();
    readonly onDidChange = this.changed.event;

    list(directory: string | undefined, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.list(directory, token);
    }

    search(options: Parameters<ResourceExplorerProvider['search']>[0], token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.search(options, token);
    }

    create(options: Parameters<ResourceExplorerProvider['create']>[0], token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.create(options, token);
    }

    copy(path: string, directory: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.copy(path, directory, token);
    }

    rename(options: Parameters<ResourceExplorerProvider['rename']>[0], token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.rename(options, token);
    }

    move(options: Parameters<ResourceExplorerProvider['move']>[0], token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.move(options, token);
    }

    getOperation(operationId: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.getOperation(operationId, token);
    }

    listOperations(token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.listOperations(token);
    }

    cancelOperation(operationId: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.cancelOperation(operationId, token);
    }

    acknowledgeOperation(operationId: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.acknowledgeOperation(operationId, token);
    }

    trash(
        path: string,
        options: Parameters<ResourceExplorerProvider['trash']>[1],
        token: CancellationToken,
    ) {
        assertNotCancelled(token);
        return caxri.workspace.fs.trash(path, options, token);
    }

    reveal(path: string, token: CancellationToken) {
        assertNotCancelled(token);
        return caxri.workspace.fs.reveal(path, token);
    }

    refresh(): void {
        this.changed.fire({ kind: 'content' });
    }

    requestCreate(itemKind: 'file' | 'directory'): void {
        this.changed.fire({ kind: 'create', itemKind });
    }

    workspaceChanged(change: WorkspaceFileChange): void {
        this.changed.fire(change);
    }

    showSearch(): void {
        this.changed.fire({ kind: 'search' });
    }

    collapse(): void {
        this.changed.fire({ kind: 'collapse' });
    }

    dispose(): void {
        this.changed.dispose();
    }
}

export function activate(context: ExtensionContext): void {
    const provider = new FilesProvider();
    context.subscriptions.push(
        provider,
        caxri.views.registerResourceExplorerProvider('caxri.files.explorer', provider),
        caxri.commands.registerCommand('secondarySidebar.searchFiles', () => provider.showSearch()),
        caxri.commands.registerCommand('caxri.files.newFile', () => provider.requestCreate('file')),
        caxri.commands.registerCommand('caxri.files.newFolder', () =>
            provider.requestCreate('directory'),
        ),
        caxri.commands.registerCommand('caxri.files.collapseFolders', () => provider.collapse()),
        caxri.commands.registerCommand('caxri.files.refresh', () => provider.refresh()),
        caxri.workspace.onDidChangeActiveContext(() => provider.refresh()),
        caxri.workspace.onDidChangeFiles((change) => provider.workspaceChanged(change)),
    );
}

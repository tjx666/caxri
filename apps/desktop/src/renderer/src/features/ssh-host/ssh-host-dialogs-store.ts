import { createStore } from '../../lib/store';

interface SshHostDialogsState {
    isConnectOpen: boolean;
    /**
     * The destination the Connect picker is connecting; present while Main resolves it.
     */
    connectingDestination?: string;
    /**
     * Settles the open folder picker; present exactly while it is open.
     */
    resolveFolder?: (path: string | undefined) => void;
    /**
     * The SSH Host whose folders the open picker lists.
     */
    folderEnvironmentId?: string;
    /**
     * Settles the open Add Project machine chooser with the chosen machine (`environmentId` absent for this Mac), or
     * `undefined` for a cancel; present exactly while it is open.
     */
    resolveMachine?: (choice: { environmentId?: string } | undefined) => void;
}

export const useSshHostDialogsStore = createStore<SshHostDialogsState>('ssh-host-dialogs', () => ({
    isConnectOpen: false,
}));

/**
 * Closing the picker also drops a pending connect from it: Main still connects the SSH Host it was asked for, but the
 * picker no longer waits on it, so reopening it starts idle.
 */
export function setConnectSshHostOpen(isOpen: boolean): void {
    useSshHostDialogsStore.setState({ isConnectOpen: isOpen, connectingDestination: undefined });
}

/**
 * Asks the user for a folder on the SSH Host and resolves with its absolute path, or `undefined` when they cancel. It
 * stands in for the native folder picker, which can only see this Mac's disk. A second request answers a still-open one
 * with `undefined` first, so no caller waits on a promise that can never settle.
 */
export function pickSshHostFolder(environmentId: string): Promise<string | undefined> {
    return new Promise((resolve) => {
        useSshHostDialogsStore.getState().resolveFolder?.(undefined);
        useSshHostDialogsStore.setState({
            folderEnvironmentId: environmentId,
            resolveFolder: resolve,
        });
    });
}

/**
 * Closes the folder picker with the chosen folder, or with `undefined` for a cancel; a no-op once already answered.
 */
export function settleSshHostFolder(path: string | undefined): void {
    const { resolveFolder } = useSshHostDialogsStore.getState();
    if (!resolveFolder) return;
    useSshHostDialogsStore.setState({ folderEnvironmentId: undefined, resolveFolder: undefined });
    resolveFolder(path);
}

/**
 * Asks which machine a new Project goes on and resolves with it, or `undefined` when the user cancels. A second request
 * answers a still-open one with `undefined` first.
 */
export function pickProjectMachine(): Promise<{ environmentId?: string } | undefined> {
    return new Promise((resolve) => {
        useSshHostDialogsStore.getState().resolveMachine?.(undefined);
        useSshHostDialogsStore.setState({ resolveMachine: resolve });
    });
}

/**
 * Closes the machine chooser with the chosen machine, or with `undefined` for a cancel; a no-op once already answered.
 */
export function settleProjectMachine(choice: { environmentId?: string } | undefined): void {
    const { resolveMachine } = useSshHostDialogsStore.getState();
    if (!resolveMachine) return;
    useSshHostDialogsStore.setState({ resolveMachine: undefined });
    resolveMachine(choice);
}

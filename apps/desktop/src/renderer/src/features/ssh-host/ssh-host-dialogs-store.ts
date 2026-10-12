import { createStore } from '../../lib/store';

interface SshHostDialogsState {
    isConnectOpen: boolean;
    /**
     * Settles the open folder picker; present exactly while it is open.
     */
    resolveFolder?: (path: string | undefined) => void;
}

export const useSshHostDialogsStore = createStore<SshHostDialogsState>('ssh-host-dialogs', () => ({
    isConnectOpen: false,
}));

export function setConnectSshHostOpen(isOpen: boolean): void {
    useSshHostDialogsStore.setState({ isConnectOpen: isOpen });
}

/**
 * Asks the user for a folder on the SSH Host and resolves with its absolute path, or `undefined` when they cancel. It
 * stands in for the native folder picker, which can only see this Mac's disk. A second request answers a still-open one
 * with `undefined` first, so no caller waits on a promise that can never settle.
 */
export function pickSshHostFolder(): Promise<string | undefined> {
    return new Promise((resolve) => {
        useSshHostDialogsStore.getState().resolveFolder?.(undefined);
        useSshHostDialogsStore.setState({ resolveFolder: resolve });
    });
}

/**
 * Closes the folder picker with the chosen folder, or with `undefined` for a cancel; a no-op once already answered.
 */
export function settleSshHostFolder(path: string | undefined): void {
    const { resolveFolder } = useSshHostDialogsStore.getState();
    if (!resolveFolder) return;
    useSshHostDialogsStore.setState({ resolveFolder: undefined });
    resolveFolder(path);
}

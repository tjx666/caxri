import { CaxriError } from '@caxri/protocol';

import type { RootIdentity } from './path-browser-identity';
import { directoryIdentity, validateDirectory } from './path-browser-identity';
import type { DesktopServerConnection } from './server-connection';

/**
 * Where the path browser identifies the Project directories it lists. A local Workbench reads this Mac's disk; an SSH
 * Host window's Project lives on the remote machine, so its identities come from that Server and it has no free mode.
 */
export interface PathBrowserDirectories {
    /**
     * False in an SSH Host window: free mode and `~` would list this Mac's disk, not the SSH Host's.
     */
    readonly canBrowseFree: boolean;
    /**
     * The Project root's identity, canonical like the paths Server Core returns for its entries.
     */
    root(sessionId: string, path: string): Promise<RootIdentity>;
    /**
     * A directory inside the Project. `shouldFollowWorkspaceLinks` keeps a workspace link's own path as the identity
     * path, as Server Core does for entries reached through one.
     */
    directory(
        sessionId: string,
        path: string,
        shouldFollowWorkspaceLinks?: boolean,
    ): Promise<RootIdentity>;
    /**
     * Fails when a listed directory was replaced since it was identified.
     */
    validate(directory: RootIdentity): Promise<void>;
}

export const localPathBrowserDirectories: PathBrowserDirectories = {
    canBrowseFree: true,
    root: (_sessionId, path) => directoryIdentity(path),
    directory: (_sessionId, path, shouldFollowWorkspaceLinks) =>
        directoryIdentity(path, shouldFollowWorkspaceLinks),
    validate: validateDirectory,
};

/**
 * Identifies directories through Server Core's `files.authorizeOpen`, which resolves the path against the Session's
 * Project root on the SSH Host. Revalidation is left to Server Core too: every `files.browse` it answers authorizes its
 * directory again, so a second round trip per keystroke would add latency without adding a check.
 */
export function remotePathBrowserDirectories(
    getServer: () => DesktopServerConnection,
): PathBrowserDirectories {
    async function authorize(sessionId: string, path: string) {
        const entry = await getServer().request('files.authorizeOpen', { sessionId, path });
        if (entry.kind !== 'directory')
            throw new CaxriError('PATH_DENIED', 'Browse location is not a directory');
        return entry;
    }
    return {
        canBrowseFree: false,
        root: async (sessionId, path) => (await authorize(sessionId, path)).root,
        directory: async (sessionId, path) => {
            const entry = await authorize(sessionId, path);
            return { path: entry.path, device: entry.device, inode: entry.inode };
        },
        validate: () => Promise.resolve(),
    };
}

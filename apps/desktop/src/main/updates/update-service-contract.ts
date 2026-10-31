import type { UpdateState } from '@caxri/protocol';

import type { SourceMapFlavor } from '../source-map-flavor';

export type UpdateFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * How a verified installer installs; see `installMode` and `resetsData` on the `ready` state.
 */
export interface PreparedInstall {
    installMode: 'manual' | 'restart';
    resetsData?: true;
}

/**
 * Supplies a fixed release in place of the GitHub request for one declared Acceptance case. It never exposes a download
 * URL, so a service built with it can announce an update but can never download or install one.
 */
export interface AcceptanceUpdateDiscovery {
    discover(): Promise<{ fileName: string; version: string }>;
}

export interface UpdateServiceOptions {
    /**
     * Present only when `createAcceptanceUpdateFixture` admitted (or visibly rejected) an Acceptance request. It
     * replaces the network discovery and lets an unpackaged Acceptance build check for updates without ever enabling
     * the real release service.
     */
    acceptanceDiscovery?: AcceptanceUpdateDiscovery;
    /**
     * Asks before restarting into an update whose `ready` state sets `resetsData`, offering to export Projects and
     * Sessions first. Resolves `true` only when the user chose to install anyway; absent, such an update never installs
     * in place.
     */
    confirmDataReset?(version: string): Promise<boolean>;
    currentVersion: string;
    downloadDirectory: string;
    /**
     * The packaged-build gate for real release checks.
     */
    enabled: boolean;
    fetch?: UpdateFetch;
    /**
     * Replaces the installed bundle with the staged one once Main exits, reopening Caxri when `relaunch` is set. Only
     * called for a `ready` state whose `installMode` is `restart`, and for one that resets data only after
     * {@link UpdateServiceOptions.confirmDataReset} accepted that exact version.
     */
    launchInstall?(input: { relaunch: boolean; version: string }): Promise<void>;
    now?: () => number;
    onState?(state: UpdateState): void;
    openPath(path: string): Promise<string>;
    /**
     * Unpacks a verified installer for the in-place install and reports which install it allows. Absent (tests,
     * Acceptance), every update installs manually from the DMG.
     */
    prepareInstall?(input: { dmgPath: string; version: string }): Promise<PreparedInstall>;
    /**
     * Runs the quit flow that ends with {@link UpdateServiceOptions.launchInstall}; resolves only when the user
     * cancelled, because a confirmed restart exits Main. `remote` marks a restart a paired phone already confirmed.
     */
    restartToUpdate?(options?: { remote?: boolean }): Promise<void>;
    /**
     * Keeps an installed no-map build on its explicit release channel. Builds without a marker default to `include`.
     */
    sourceMapFlavor?: SourceMapFlavor;
}

import type { ServerEvent } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';
import type { GitHubRepoSlug } from '@caxri/utils';
import { parseGitHubRemote } from '@caxri/utils';

import { parseGitRemoteHost } from './remote-host';
import { deriveRepoKey } from './repo-key';
import { sharedGitRequest } from './request-signal';

/**
 * What a repository root's `origin` remote says, resolved once per root and kept until {@link revalidate}: the
 * commit-avatar privacy gate (`git.remoteHost`) must never re-spawn Git on every commit row render, the repository key
 * (`project.repositoryKeys`) is read for every Project on every machine, and the sidebar's pull-request sweep
 * (`githubRepository`) asks for every visible Session about every 30 seconds. Production logged ~3,900 `remote get-url`
 * spawns in 90 minutes from that sweep alone, with 146 Sessions and no lookup due. A remote changing mid-session is
 * rare, so the Git metadata watcher calls {@link revalidate} when `.git/config` moves instead of anything polling. Reads
 * local Git config only (`remote get-url`), never the network.
 */
export class OriginRemoteFacts {
    /**
     * The trimmed `origin` URL per root, `''` when the root has none or it could not be read.
     */
    private readonly remoteByRoot = new Map<string, string>();
    private readonly requests = new SingleFlight<string, string>();

    /**
     * @param originRemote Prints a root's `origin` URL, or an empty string when it has none.
     * @param emit Receives `state.changed` after {@link revalidate} moved any repository key, so Clients re-read them.
     */
    constructor(
        private readonly originRemote: (rootPath: string) => Promise<string>,
        private readonly emit?: (event: ServerEvent) => void,
    ) {}

    private async readRemote(rootPath: string): Promise<string> {
        try {
            return (await this.originRemote(rootPath)).trim();
        } catch {
            // No readable `origin`: nothing to derive.
            return '';
        }
    }

    private async remote(rootPath: string): Promise<string> {
        const cached = this.remoteByRoot.get(rootPath);
        if (cached !== undefined) return cached;
        return sharedGitRequest(() =>
            this.requests.run(rootPath, async () => {
                const remote = await this.readRemote(rootPath);
                this.remoteByRoot.set(rootPath, remote);
                return remote;
            }),
        );
    }

    /**
     * The `origin` host, or `null` when there is none or it cannot be parsed.
     */
    async host(rootPath: string): Promise<string | null> {
        return parseGitRemoteHost(await this.remote(rootPath));
    }

    /**
     * The machine-independent repository key (see {@link deriveRepoKey}), or `null` when there is none.
     */
    async repositoryKey(rootPath: string): Promise<string | null> {
        return deriveRepoKey(await this.remote(rootPath));
    }

    /**
     * The GitHub owner and repository `origin` points at, or `undefined` when it is not a GitHub remote.
     */
    async githubRepository(rootPath: string): Promise<GitHubRepoSlug | undefined> {
        const remote = await this.remote(rootPath);
        return remote ? parseGitHubRemote(remote) : undefined;
    }

    /**
     * Re-reads `origin` for every cached root and replaces the cached URL.
     *
     * Emits `state.changed` when any root's repository key changed.
     */
    async revalidate(): Promise<void> {
        const changes = await Promise.all(
            this.remoteByRoot.keys().map(async (rootPath) => {
                const remote = await sharedGitRequest(() => this.readRemote(rootPath));
                const previous = this.remoteByRoot.get(rootPath);
                // `clear()` may have run while the read was in flight; do not resurrect the root.
                if (previous === undefined) return false;
                this.remoteByRoot.set(rootPath, remote);
                return deriveRepoKey(previous) !== deriveRepoKey(remote);
            }),
        );
        if (changes.includes(true))
            this.emit?.({
                event: 'state.changed',
                payload: { kind: 'full', reason: 'project.repositoryKeys' },
            });
    }

    clear(): void {
        this.remoteByRoot.clear();
    }
}

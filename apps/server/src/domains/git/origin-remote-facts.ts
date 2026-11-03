import { SingleFlight } from '@caxri/system';

import { parseGitRemoteHost } from './remote-host';
import { deriveRepoKey } from './repo-key';
import { sharedGitRequest } from './request-signal';

/**
 * What a repository root's `origin` remote says, resolved once per root and kept for the Server's lifetime: the
 * commit-avatar privacy gate (`git.remoteHost`) must never re-spawn Git on every commit row render, and the repository
 * key (`project.repositoryKeys`) is read for every Project on every machine. A remote changing mid-session is rare
 * enough that a Server restart picking it up is an acceptable trade-off. Reads local Git config only (`remote
 * get-url`), never the network.
 */
export class OriginRemoteFacts {
    private readonly hostByRoot = new Map<string, string | null>();
    private readonly hostRequests = new SingleFlight<string, string | null>();
    private readonly keyByRoot = new Map<string, string | null>();
    private readonly keyRequests = new SingleFlight<string, string | null>();

    /**
     * @param originRemote Prints a root's `origin` URL, or an empty string when it has none.
     */
    constructor(private readonly originRemote: (rootPath: string) => Promise<string>) {}

    private async cached(
        rootPath: string,
        byRoot: Map<string, string | null>,
        requests: SingleFlight<string, string | null>,
        derive: (remote: string) => string | null,
    ): Promise<string | null> {
        const cached = byRoot.get(rootPath);
        if (cached !== undefined) return cached;
        return sharedGitRequest(() =>
            requests.run(rootPath, async () => {
                let remote = '';
                try {
                    remote = await this.originRemote(rootPath);
                } catch {
                    // No readable `origin`: nothing to derive.
                }
                const value = derive(remote);
                byRoot.set(rootPath, value);
                return value;
            }),
        );
    }

    /**
     * The `origin` host, or `null` when there is none or it cannot be parsed.
     */
    host(rootPath: string): Promise<string | null> {
        return this.cached(rootPath, this.hostByRoot, this.hostRequests, parseGitRemoteHost);
    }

    /**
     * The machine-independent repository key (see {@link deriveRepoKey}), or `null` when there is none.
     */
    repositoryKey(rootPath: string): Promise<string | null> {
        return this.cached(rootPath, this.keyByRoot, this.keyRequests, deriveRepoKey);
    }

    clear(): void {
        this.hostByRoot.clear();
        this.keyByRoot.clear();
    }
}

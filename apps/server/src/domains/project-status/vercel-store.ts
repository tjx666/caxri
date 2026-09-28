import { homedir } from 'node:os';

import type { ProjectStatusState } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import type { ExternalStatusRunner } from '../external-status';
import type { VercelLink } from './external';
import { vcListArguments } from './external';
import { parseVercelList } from './parse';
import { findVercelLink, mapProjectStatusDeployment } from './vercel';

/**
 * Production moves only when something is merged and rebuilt, so a minute-old answer is still the right one to draw a
 * badge from. The cost being spread is one `vc api` call per repository, shared by every Session pointing at it.
 */
const PRODUCTION_TTL_MS = 60_000;
/**
 * A repository Vercel has never heard of answers the same way every time, and proving it costs a team list plus one
 * deployment query per team. Re-asking on every sweep would make a repository that simply is not deployed the most
 * expensive one in the sidebar, so absence is remembered far longer than presence.
 */
const UNLINKED_TTL_MS = 30 * 60_000;
const MAX_ENTRIES = 256;

export interface VercelProductionDeployment {
    /**
     * The GitHub commit this build was produced from, when Vercel recorded one. A direct CLI upload carries no Git
     * provenance, and a deployment nothing can be matched against is the same as none for the Session badge.
     */
    commitSha?: string;
    state: ProjectStatusState;
}

interface StoredProduction {
    fetchedAt: number;
    value?: VercelProductionDeployment;
}

export interface VercelDeploymentStoreOptions {
    now?: () => number;
    productionTtlMs?: number;
    unlinkedTtlMs?: number;
}

/**
 * The Server's single reader of Vercel's current production deployment, and the owner of the `owner/repo` → Vercel
 * project map that resolving one requires.
 *
 * Both the Status panel's deployment tree and the PrimarySidebar's per-Session delivery badge need to know what
 * production is serving. The panel asks for one repository at a time, the sidebar asks for every active Session at
 * once, and without a shared store the same repository would be queried once per Session on every sweep.
 */
export class VercelDeploymentStore {
    private readonly productions = new Map<string, StoredProduction>();
    /**
     * Shared with the Status panel's `loadVercelDeployments` so the expensive project discovery is paid once per
     * process rather than once per reader.
     */
    readonly links = new Map<string, VercelLink>();

    constructor(
        private readonly run: ExternalStatusRunner,
        private readonly options: VercelDeploymentStoreOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private cached(key: string): StoredProduction | undefined {
        const stored = this.productions.get(key);
        if (!stored) return undefined;
        const ttl = stored.value
            ? (this.options.productionTtlMs ?? PRODUCTION_TTL_MS)
            : (this.options.unlinkedTtlMs ?? UNLINKED_TTL_MS);
        return this.now() - stored.fetchedAt < ttl ? stored : undefined;
    }

    private async load(
        owner: string,
        repo: string,
    ): Promise<VercelProductionDeployment | undefined> {
        const dependencies = {
            links: this.links,
            onParseFailure: () => {},
            run: (arguments_: readonly string[], cwd: string) => this.run('vc', arguments_, cwd),
        };
        const link = await findVercelLink(dependencies, owner, repo);
        if (!link) return undefined;
        const output = await dependencies.run(
            vcListArguments(link.team, { githubOrg: owner, githubRepo: repo }, 'production'),
            homedir(),
        );
        const mapped = mapProjectStatusDeployment(
            parseVercelList(output)[0] ?? {},
            'production',
            link,
        );
        if (!mapped) return undefined;
        return { commitSha: mapped.commit?.sha, state: mapped.state };
    }

    /**
     * The deployment currently serving production for a GitHub repository, or `undefined` when the repository has no
     * Vercel project, no production build yet, or the provider could not be reached. Every outcome is cached; a caller
     * renders "no deployment" for all of them, so none of them is worth a second query this minute.
     */
    async production(owner: string, repo: string): Promise<VercelProductionDeployment | undefined> {
        const key = `${owner}/${repo}`.toLowerCase();
        const cached = this.cached(key);
        if (cached) return cached.value;
        let value: VercelProductionDeployment | undefined;
        try {
            value = await this.load(owner, repo);
        } catch {
            /**
             * A failed `vc` call is remembered as "no deployment" for the production TTL rather than retried on the
             * next sweep: the badge it feeds is additive, so a minute without it costs nothing, while a provider outage
             * would otherwise turn every sweep into a burst of failing subprocesses.
             */
            value = undefined;
        }
        rememberBounded(this.productions, key, { fetchedAt: this.now(), value }, MAX_ENTRIES);
        return value;
    }

    clear(): void {
        this.productions.clear();
        this.links.clear();
    }
}

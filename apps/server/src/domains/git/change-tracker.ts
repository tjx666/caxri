import { resolve, sep } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';

/**
 * Debounce window that folds a burst of generation bumps (rapid Agent writes, a rebase touching many refs) into one
 * `git.changed` invalidation event.
 */
const CHANGE_EMIT_DELAY_MS = 150;

interface TrackedSession {
    repositoryKeys: readonly string[];
    /**
     * Canonical repository roots this Session's latest summary projected, deepest-first.
     */
    roots: string[];
    sessionRoot: string;
}

interface GitChangeTrackerOptions {
    delayMs?: number;
    emit?: (event: ServerEvent) => void;
    repositoryId: (rootPath: string) => string;
}

/**
 * Owns the Session ↔ repository-identity mapping behind `git.changed`. Summaries register which canonical roots a
 * Session projects; generation bumps schedule one coalesced invalidation event naming every Session that projects an
 * affected repository (including sibling Sessions of other Workbench Projects), so no consumer waits out a stale-time
 * window for correctness. Payloads carry opaque ids only; no `.git` or working-tree path ever crosses this boundary.
 */
export class GitChangeTracker {
    private closed = false;
    private readonly pendingRoots = new Set<string>();
    private pendingScope: 'status' | 'topology' = 'status';
    private readonly sessions = new Map<string, TrackedSession>();
    private timer?: NodeJS.Timeout;

    constructor(private readonly options: GitChangeTrackerOptions) {}

    private scheduleFlush(): void {
        if (this.closed || this.pendingRoots.size === 0 || this.timer) return;
        this.timer = setTimeout(() => this.flush(), this.options.delayMs ?? CHANGE_EMIT_DELAY_MS);
        this.timer.unref();
    }

    private flush(): void {
        this.timer = undefined;
        if (this.closed || this.pendingRoots.size === 0) return;
        const roots = new Set(this.pendingRoots);
        const scope = this.pendingScope;
        this.pendingRoots.clear();
        this.pendingScope = 'status';
        const sessionIds: string[] = [];
        for (const [sessionId, session] of this.sessions)
            if (session.roots.some((root) => roots.has(root))) sessionIds.push(sessionId);
        if (sessionIds.length === 0) return;
        this.options.emit?.({
            event: 'git.changed',
            payload: {
                repositoryIds: roots
                    .values()
                    .take(256)
                    .map((root) => this.options.repositoryId(root))
                    .toArray(),
                scope,
                sessionIds: sessionIds.slice(0, 1_024),
            },
        });
    }

    registerSession(
        sessionId: string,
        sessionRoot: string,
        repoKeys: readonly string[],
        roots: readonly string[],
    ): void {
        this.sessions.set(sessionId, {
            repositoryKeys: [...repoKeys],
            roots: [...roots].toSorted((left, right) => right.length - left.length),
            sessionRoot,
        });
    }

    evictSessions(sessionIds: readonly string[]): void {
        for (const sessionId of sessionIds) this.sessions.delete(sessionId);
    }

    /**
     * Roots still referenced by at least one live Session; used to release watchers/snapshots.
     */
    referencedRoots(): ReadonlySet<string> {
        const roots = new Set<string>();
        for (const session of this.sessions.values())
            for (const root of session.roots) roots.add(root);
        return roots;
    }

    referencedRepositoryKeys(): ReadonlySet<string> {
        const keys = new Set<string>();
        for (const session of this.sessions.values())
            for (const key of session.repositoryKeys) keys.add(key);
        return keys;
    }

    /**
     * Maps Session-relative changed paths to the deepest known repository root of that Session, so a write inside a
     * nested repository bumps only that repository.
     */
    mapChangesToRoots(sessionId: string, changePaths: readonly string[]): string[] {
        const session = this.sessions.get(sessionId);
        if (!session) return [];
        const roots = new Set<string>();
        for (const changePath of changePaths) {
            const absolute = resolve(session.sessionRoot, changePath);
            const owner = session.roots.find(
                (root) => absolute === root || absolute.startsWith(`${root}${sep}`),
            );
            if (owner) roots.add(owner);
        }
        return [...roots];
    }

    scheduleStatusChanged(roots: readonly string[]): void {
        for (const root of roots) this.pendingRoots.add(root);
        this.scheduleFlush();
    }

    scheduleTopologyChanged(repoKey: string): void {
        this.pendingScope = 'topology';
        for (const session of this.sessions.values())
            if (session.repositoryKeys.includes(repoKey))
                for (const root of session.roots) this.pendingRoots.add(root);
        this.scheduleFlush();
    }

    close(): void {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pendingRoots.clear();
        this.sessions.clear();
    }
}

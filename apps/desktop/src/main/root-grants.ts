import { CaxriError } from '@caxri/protocol';

/**
 * The filesystem object a native folder selection named, captured by Main at pick time. `device` and `inode` are
 * decimal strings of the `bigint` stat fields, matching `project.create`'s `expectedRootIdentity`.
 */
export interface ProjectRootGrantIdentity {
    path: string;
    device: string;
    inode: string;
}

interface RootGrant {
    expiresAt: number;
    identity: ProjectRootGrantIdentity | undefined;
}

export class ProjectRootGrants {
    private readonly roots = new Map<string, RootGrant>();
    /**
     * Monotonic per-root counter, bumped by every `grant()`/`revoke()` and by `use()` right before it awaits
     * `create()`. `use()` reads this counter to tell, once `create()` settles, whether anything else changed this
     * root's authorization while it was in flight. The `roots` map alone cannot answer that: `use()` deletes its own
     * reservation up front, so an absent entry is ambiguous between "still reserved by me" and "revoked by someone else
     * while I was awaiting". This map never shrinks, but its key set is bounded by the roots a user has ever selected
     * in this process lifetime, the same low cardinality `roots` already assumes.
     */
    private readonly generations = new Map<string, number>();

    constructor(private readonly timeToLiveMs = 60_000) {}

    private bumpGeneration(rootPath: string): number {
        const next = (this.generations.get(rootPath) ?? 0) + 1;
        this.generations.set(rootPath, next);
        return next;
    }

    /**
     * `identity` is the object the user actually selected. `use()` hands it to the creator so Main, never the Renderer,
     * decides which filesystem object Server Core must still find at the path.
     */
    grant(rootPath: string, identity?: ProjectRootGrantIdentity): void {
        this.roots.set(rootPath, { expiresAt: Date.now() + this.timeToLiveMs, identity });
        this.bumpGeneration(rootPath);
    }

    revoke(rootPath: string): void {
        this.roots.delete(rootPath);
        this.bumpGeneration(rootPath);
    }

    /**
     * Reserves the single-use grant while creating, then restores its original deadline only when creation fails.
     * Restoring the original `expiresAt` (instead of minting a fresh `timeToLiveMs`-out grant, as a naive retry would)
     * matters because `create()` can fail repeatedly: resetting the clock on every failure would let authorization
     * outlive the deadline the user actually agreed to. The restore is itself conditional on `generations` being
     * unchanged, so a `revoke()` or a new `grant()` that lands while `create()` is in flight always wins over this
     * reservation's stale deadline.
     */
    async use<T>(
        rootPath: string,
        create: (identity: ProjectRootGrantIdentity | undefined) => Promise<T>,
    ): Promise<T> {
        const reserved = this.roots.get(rootPath);
        if (reserved === undefined)
            throw new CaxriError('PATH_DENIED', 'Project root was not selected by the user');
        this.roots.delete(rootPath);
        if (reserved.expiresAt <= Date.now())
            throw new CaxriError('PATH_DENIED', 'Project root selection expired');
        const generation = this.bumpGeneration(rootPath);
        try {
            return await create(reserved.identity);
        } catch (error) {
            if (this.generations.get(rootPath) === generation) this.roots.set(rootPath, reserved);
            throw error;
        }
    }
}

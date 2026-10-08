import type { GitDetachedHead, GitFileStatus } from '@caxri/protocol';
import { DETACHED_BRANCH } from '@caxri/protocol';

/**
 * Names a detached HEAD from `git for-each-ref --points-at HEAD --format=%(refname)` output. A tag is the most
 * deliberate name a pinned commit can have, so it wins over a remote branch whose tip merely happens to be there.
 * Symbolic `<remote>/HEAD` aliases are skipped because they only restate the remote's default branch.
 */
export function detachedHeadReference(refnames: string): string | undefined {
    const references = refnames
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const tag = references.find((reference) => reference.startsWith('refs/tags/'));
    if (tag) return tag.slice('refs/tags/'.length);
    const remote = references.find(
        (reference) => reference.startsWith('refs/remotes/') && !reference.endsWith('/HEAD'),
    );
    return remote?.slice('refs/remotes/'.length);
}

/**
 * A bare `(detached)` or a short SHA tells the reader nothing about which commit is checked out: submodules sit there
 * permanently. Two cheap reads, paid only by detached repositories, name it the way a person would: the tag or remote
 * branch at that commit, and its subject.
 */
export async function loadDetachedHead(
    status: Pick<RepoStatus, 'branch' | 'head'>,
    git: (arguments_: string[], options: { allowFailure: true }) => Promise<string>,
): Promise<GitDetachedHead | undefined> {
    if (status.branch !== DETACHED_BRANCH || !status.head) return undefined;
    const [subjectOutput, referencesOutput] = await Promise.all([
        git(['log', '-1', '--format=%s', 'HEAD'], { allowFailure: true }),
        git(
            [
                'for-each-ref',
                '--points-at',
                'HEAD',
                '--format=%(refname)',
                'refs/tags',
                'refs/remotes',
            ],
            { allowFailure: true },
        ),
    ]);
    const subject = subjectOutput.trim().slice(0, 1_024);
    if (!subject) return undefined;
    const reference = detachedHeadReference(referencesOutput)?.slice(0, 1_024);
    return { subject, ...(reference && { reference }) };
}

export type StatusOutcome = 'fresh' | 'joined' | 'coalesced';

export interface RepoStatus {
    branch: string;
    head?: string;
    /**
     * The tracked remote branch (`origin/main`); absent when the branch has never been published or HEAD is detached.
     */
    upstream?: string;
    /**
     * What a detached HEAD points at, in terms a reader recognizes: an exact tag, otherwise the commit subject.
     */
    detachedHead?: GitDetachedHead;
    ahead: number;
    behind: number;
    additions: number;
    deletions: number;
    changedFileCount: number;
    truncated: boolean;
    files: GitFileStatus[];
}

function statusKind(code: string): GitFileStatus['kind'] {
    if (code === 'AA' || code === 'DD' || code.includes('U')) return 'conflicted';
    if (code.includes('R')) return 'renamed';
    if (code.includes('D')) return 'deleted';
    if (code.includes('A')) return 'added';
    return 'modified';
}

function parseStatusRecord(
    record: string,
    originalPath?: string,
):
    | {
          code: string;
          path: string;
          originalPath?: string;
          kind?: GitFileStatus['kind'];
      }
    | undefined {
    if (record.startsWith('? ')) return { code: '??', path: record.slice(2), kind: 'untracked' };
    const ordinary = /^1 (\S{2})(?: \S+){6} (.+)$/.exec(record);
    if (ordinary) return { code: ordinary[1], path: ordinary[2] };
    const renamed = /^2 (\S{2})(?: \S+){7} (.+)$/.exec(record);
    if (renamed) return { code: renamed[1], path: renamed[2], originalPath, kind: 'renamed' };
    const conflicted = /^u (\S{2})(?: \S+){8} (.+)$/.exec(record);
    if (conflicted) return { code: conflicted[1], path: conflicted[2], kind: 'conflicted' };
    return undefined;
}

export function parseGitStatus(
    output: string,
): Omit<RepoStatus, 'additions' | 'deletions' | 'changedFileCount' | 'truncated' | 'detachedHead'> {
    const records = output.split('\0').filter(Boolean);
    const files: GitFileStatus[] = [];
    let branch = 'detached';
    let head: string | undefined;
    let upstream: string | undefined;
    let ahead = 0;
    let behind = 0;
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.startsWith('# branch.head ')) {
            branch = record.slice('# branch.head '.length);
            continue;
        }
        if (record.startsWith('# branch.oid ')) {
            const oid = record.slice('# branch.oid '.length);
            head = oid === '(initial)' ? undefined : oid;
            continue;
        }
        if (record.startsWith('# branch.upstream ')) {
            upstream = record.slice('# branch.upstream '.length);
            continue;
        }
        if (record.startsWith('# branch.ab ')) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
            ahead = Number(match?.[1] ?? 0);
            behind = Number(match?.[2] ?? 0);
            continue;
        }
        const parsed = parseStatusRecord(
            record,
            record.startsWith('2 ') ? records[index + 1] : undefined,
        );
        if (!parsed) continue;
        const code = parsed.code.replaceAll('.', ' ');
        files.push({
            path: parsed.path,
            originalPath: parsed.originalPath,
            index: code[0],
            workingTree: code[1],
            kind: parsed.kind ?? (code === '??' ? 'untracked' : statusKind(code)),
        });
        if (record.startsWith('2 ')) index += 1;
    }
    return { branch, head, ...(upstream && { upstream }), ahead, behind, files };
}

interface ProducedSnapshot<Status> {
    generation: number;
    status: Status;
}

interface SnapshotEntry<Status> {
    generation: number;
    promise: Promise<ProducedSnapshot<Status>>;
    settled: boolean;
}

/**
 * Generation-keyed working-tree status snapshots, one entry per canonical worktree root. Exactly one producer runs per
 * `(rootPath, generation)`; concurrent consumers join it and later consumers of the same generation reuse the settled
 * snapshot without spawning Git. A generation bump (file write, Git metadata change, explicit refresh) makes the next
 * consumer produce a fresh snapshot, and a production that finishes after its generation was superseded can never
 * overwrite the newer snapshot: its consumers transparently re-produce at the newest generation (per-repository
 * trailing coalescing).
 */
export class RepoStatusStore<Status> {
    private readonly generations = new Map<string, number>();
    private readonly snapshots = new Map<string, SnapshotEntry<Status>>();

    private async produce(
        entry: SnapshotEntry<Status>,
        rootPath: string,
        load: () => Promise<Status>,
    ): Promise<ProducedSnapshot<Status>> {
        try {
            const status = await load();
            const currentGeneration = this.generation(rootPath);
            if (currentGeneration === entry.generation)
                return { generation: entry.generation, status };
            /**
             * Superseded mid-production: re-run once at the newest generation instead of handing consumers a snapshot
             * that predates the change that superseded it. Advancing `entry.generation` first lets consumers arriving
             * at the new generation join this trailing production, so a burst of bumps coalesces into at most one extra
             * load.
             */
            entry.generation = currentGeneration;
            return await this.produce(entry, rootPath, load);
        } catch (error) {
            /**
             * A failed production must not pin the store entry, or every later consumer of this generation would replay
             * the cached rejection instead of retrying.
             */
            if (this.snapshots.get(rootPath) === entry) this.snapshots.delete(rootPath);
            throw error;
        }
    }

    generation(rootPath: string): number {
        return this.generations.get(rootPath) ?? 0;
    }

    /**
     * Advances the status generation for one repository root and returns the new value.
     */
    bump(rootPath: string): number {
        const next = this.generation(rootPath) + 1;
        this.generations.set(rootPath, next);
        return next;
    }

    /**
     * Releases snapshots owned by roots that no longer exist or lost authorization.
     */
    evict(rootPath: string): void {
        this.generations.delete(rootPath);
        this.snapshots.delete(rootPath);
    }

    clear(): void {
        this.generations.clear();
        this.snapshots.clear();
    }

    /**
     * Drops every root outside `referenced` in one lifecycle sweep.
     */
    retainOnly(referenced: ReadonlySet<string>): void {
        for (const root of this.generations.keys())
            if (!referenced.has(root)) this.generations.delete(root);
        for (const root of this.snapshots.keys())
            if (!referenced.has(root)) this.snapshots.delete(root);
    }

    /**
     * Returns the snapshot for the current generation of `rootPath`, producing it with `load` if needed. `outcome`
     * reports whether this call produced (`fresh`), joined an in-flight production (`joined`), or reused a settled
     * same-generation snapshot (`coalesced`).
     */
    async status(
        rootPath: string,
        load: () => Promise<Status>,
    ): Promise<{ generation: number; outcome: StatusOutcome; status: Status }> {
        const generation = this.generation(rootPath);
        const existing = this.snapshots.get(rootPath);
        if (existing?.generation === generation) {
            const outcome: StatusOutcome = existing.settled ? 'coalesced' : 'joined';
            const snapshot = await existing.promise;
            // The joined production may itself have been superseded and re-produced; report the
            // generation it actually settled at.
            return { generation: snapshot.generation, outcome, status: snapshot.status };
        }
        const entry = { generation, settled: false } as SnapshotEntry<Status>;
        entry.promise = this.produce(entry, rootPath, load);
        this.snapshots.set(rootPath, entry);
        try {
            const snapshot = await entry.promise;
            return { generation: snapshot.generation, outcome: 'fresh', status: snapshot.status };
        } finally {
            entry.settled = true;
        }
    }
}

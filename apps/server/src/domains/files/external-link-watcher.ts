import { stat } from 'node:fs/promises';
import { relative } from 'node:path';

import type { FileChange } from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';

import { isOutsideRoot } from '../path-security';
import type { ResolvedSessionPath } from '../project-roots';
import type { WatchHandle, WatchHub } from '../watch-hub';
import type { ResolveSessionPath } from './documents';
import type { WatchScope } from './watcher';

const MAX_OBSERVED_ENTRIES = 512;
const PROBE_TIMEOUT_MS = 2_000;
const MISSING = '<missing>';

interface Observation {
    fingerprint: string;
}

/**
 * The root native stream cannot see external link targets. Observe only workspace entries actually read or listed,
 * using bounded metadata polling instead of recursively subscribing to an external directory (possibly a home root).
 * Directory metadata detects membership changes; separately read files detect content changes. No contents are read.
 */
export class ExternalLinkWatcher {
    private readonly entries = new Map<string, Observation>();
    private scope?: WatchScope;
    private generation = 0;
    private handle?: WatchHandle;
    private overflowed = false;
    private readonly pendingProbes = new Map<string, Promise<string>>();
    private readonly targetProbes = new Map<string, Promise<string>>();

    constructor(
        private readonly resolveWorkspacePath: ResolveSessionPath,
        private readonly hub: WatchHub,
        private readonly intervalMs: number,
        private readonly onChange: (scope: WatchScope, change: FileChange) => void,
        private readonly onOverflow: (scope: WatchScope) => void,
    ) {}

    private async fingerprint(target: string): Promise<string> {
        try {
            const value = await stat(target);
            return `${target}:${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.mode}:${value.ino}`;
        } catch (error) {
            if (this.isMissing(error)) return MISSING;
            throw error;
        }
    }

    private isMissing(error: unknown): boolean {
        return (
            error instanceof Error &&
            'code' in error &&
            ['ENOENT', 'ENOTDIR', 'NOT_FOUND'].includes(String(error.code))
        );
    }

    private async readFingerprint(
        scope: WatchScope,
        entry: string,
        targets: Map<string, Promise<string>>,
    ): Promise<string> {
        const resolved = await this.resolveWorkspacePath(scope.sessionId, entry);
        let snapshot = targets.get(resolved.path) ?? this.targetProbes.get(resolved.path);
        if (!snapshot) {
            // eslint-disable-next-line unicorn/prefer-await -- retain one physical read until uncancellable I/O settles
            snapshot = this.fingerprint(resolved.path).finally(() => {
                this.targetProbes.delete(resolved.path);
            });
            this.targetProbes.set(resolved.path, snapshot);
        }
        targets.set(resolved.path, snapshot);
        return snapshot;
    }

    /**
     * A mount can hang an uncancellable fs request. Keep that request single-flight even across scope resets; never
     * reuse its result as another Session's authority. The deadline releases the poll batch, not the underlying I/O.
     */
    private async probe(
        scope: WatchScope,
        entry: string,
        targets: Map<string, Promise<string>>,
    ): Promise<string | undefined> {
        if (this.pendingProbes.has(entry)) return undefined;
        if (this.pendingProbes.size >= MAX_OBSERVED_ENTRIES) {
            this.onOverflow(scope);
            return undefined;
        }
        // eslint-disable-next-line unicorn/prefer-await -- cleanup must follow actual I/O settlement, not timeout
        const pending = this.readFingerprint(scope, entry, targets).finally(() => {
            this.pendingProbes.delete(entry);
        });
        this.pendingProbes.set(entry, pending);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('External link metadata probe timed out')),
                PROBE_TIMEOUT_MS,
            );
        });
        try {
            return await Promise.race([pending, deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async poll(generation: number): Promise<void> {
        const scope = this.scope;
        if (!scope || generation !== this.generation) return;
        if (this.overflowed) {
            this.onOverflow(scope);
            return;
        }
        const targets = new Map<string, Promise<string>>();
        const failures: unknown[] = [];
        await mapWithConcurrency([...this.entries], 4, async ([entry, observation]) => {
            if (generation !== this.generation) return;
            let fingerprint = MISSING;
            try {
                // Re-resolve the authorized workspace entry each time: a retargeted link must not keep watching its
                // old physical target, and two workspace aliases still share one metadata read per current target.
                const snapshot = await this.probe(scope, entry, targets);
                if (snapshot === undefined) return;
                fingerprint = snapshot;
            } catch (error) {
                if (!this.isMissing(error)) {
                    if (failures.length === 0) failures.push(error);
                    return;
                }
            }
            if (generation !== this.generation || this.entries.get(entry) !== observation) return;
            if (fingerprint === observation.fingerprint) return;
            const wasMissing = observation.fingerprint === MISSING;
            observation.fingerprint = fingerprint;
            this.onChange(scope, {
                path: entry,
                kind: fingerprint === MISSING ? 'delete' : wasMissing ? 'create' : 'update',
            });
        });
        // Drain every entry before reporting a failure so an inaccessible alias cannot starve healthy documents.
        if (generation === this.generation && failures.length > 0) throw failures[0];
    }

    /**
     * Invalidates in-flight reads before releasing the shared-hub registration.
     */
    async reset(scope?: WatchScope): Promise<void> {
        this.generation += 1;
        this.scope = scope;
        this.entries.clear();
        this.overflowed = false;
        const handle = this.handle;
        this.handle = undefined;
        await handle?.dispose();
    }

    async note(sessionId: string, resolved: ResolvedSessionPath): Promise<void> {
        if (this.overflowed || this.scope?.sessionId !== sessionId || !resolved.workspacePath)
            return;
        if (!isOutsideRoot(relative(resolved.root, resolved.path))) return;
        const generation = this.generation;
        const entry = resolved.workspacePath;
        if (this.entries.has(entry)) return;
        const fingerprint = await this.fingerprint(resolved.path);
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- concurrent notes can overflow during the metadata read
        if (generation !== this.generation || this.overflowed || this.entries.has(entry)) return;
        this.entries.set(entry, { fingerprint });
        if (this.entries.size > MAX_OBSERVED_ENTRIES) {
            /**
             * Historical reads cannot evict a still-open document silently. Once the metadata budget is exceeded, use
             * the existing overflow protocol to reconcile current visible consumers, not an unbounded path set. A
             * Session/root reset restores targeted observation.
             */
            this.overflowed = true;
            this.entries.clear();
        }
        this.handle ??= this.hub.registerPoller({
            label: 'files-external-links',
            intervalMs: this.intervalMs,
            pollOnce: () => this.poll(generation),
        });
    }
}

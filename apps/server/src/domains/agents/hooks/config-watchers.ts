import { readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { WatchHandle, WatchHub } from '../../watch-hub';

const CONFIG_FALLBACK_POLL_INTERVAL_MS = 30_000;
/**
 * Linux's `SYMLOOP_MAX`. The kernel refuses a longer chain with `ELOOP`, so there is no further target to watch.
 */
const MAX_SYMLINK_HOPS = 40;

interface HookConfigWatcher {
    handle: WatchHandle;
    targets: Set<string>;
}

interface AgentHookConfigWatchersOptions {
    watchHub: WatchHub;
    /**
     * A watched provider config file, or a file its symlink chain passes through, changed.
     */
    onChange: () => void;
    /**
     * Degraded-mode work for a directory whose native subscription failed: one pass that re-checks every provider
     * config.
     */
    pollOnce: () => Promise<void>;
}

/**
 * Watches provider hook config files so an edit made outside Caxri is reconciled without a settings change or restart.
 * Each file's directory is watched and only events for the file itself count, so Codex state and transcript churn in
 * the same home is ignored, and so is a same-named file deeper in the directory (the native watch is recursive, and a
 * dotfiles checkout holding a link target often has other tools' `settings.json`).
 *
 * Users commonly symlink a provider config (`~/.claude/settings.json`) into a dotfiles checkout. Reads and writes
 * follow that link to its target, but the link's own directory never sees a `git pull` that rewrites or deletes the
 * target. Every file the link chain passes through is therefore watched as well, in its canonical directory. A
 * repointed link is an event in the link's own directory; the reconcile it triggers calls {@link refresh} again, which
 * moves the target watch to the new chain. A target whose directory is missing is not watched (a native subscription on
 * a missing root would only degrade into a 30-second reconcile poll); the link is re-checked on its next event or
 * settings change.
 */
export class AgentHookConfigWatchers {
    private readonly watchers = new Map<string, HookConfigWatcher>();

    constructor(private readonly options: AgentHookConfigWatchersOptions) {}

    async refresh(configPaths: readonly string[]): Promise<void> {
        const desired = await watchTargetsByDirectory(configPaths);
        const obsoleteHandles: WatchHandle[] = [];
        for (const [directory, watcher] of this.watchers) {
            const nextTargets = desired.get(directory);
            if (
                nextTargets &&
                // A degraded (polling) registration is replaced so every reconcile retries the native backend.
                watcher.handle.mode === 'native' &&
                [...nextTargets].every((target) => watcher.targets.has(target)) &&
                nextTargets.size === watcher.targets.size
            ) {
                continue;
            }
            this.watchers.delete(directory);
            obsoleteHandles.push(watcher.handle);
        }
        await Promise.all(obsoleteHandles.map((handle) => handle.dispose()));
        const pendingWatchers: Array<[string, Set<string>]> = [];
        for (const [directory, targets] of desired)
            if (!this.watchers.has(directory)) pendingWatchers.push([directory, targets]);
        await Promise.all(
            pendingWatchers.map(async ([directory, targets]) => {
                const targetNames = new Set([...targets].map((target) => basename(target)));
                // Native macOS event paths are canonical (`/var` reads as `/private/var`), so compare parents canonically.
                const parents = new Set([directory, await canonicalPath(directory)]);
                const handle = await this.options.watchHub.register({
                    label: 'agent-hooks-config',
                    root: directory,
                    onEvents: (events) => {
                        if (
                            events.some(
                                (event) =>
                                    parents.has(dirname(event.path)) &&
                                    targetNames.has(basename(event.path)),
                            )
                        )
                            this.options.onChange();
                    },
                    onError: (error, erroredHandle) => erroredHandle.startFallback(error),
                    /**
                     * All config directories share one degraded reconcile loop: a single `reconcile` pass re-checks
                     * every provider config, so the hub group runs it once per interval no matter how many directory
                     * watchers failed.
                     */
                    fallback: {
                        groupKey: 'agent-hooks-reconcile',
                        intervalMs: CONFIG_FALLBACK_POLL_INTERVAL_MS,
                        pollOnce: this.options.pollOnce,
                    },
                });
                this.watchers.set(directory, { handle, targets });
            }),
        );
    }

    async close(): Promise<void> {
        await Promise.all(this.watchers.values().map((watcher) => watcher.handle.dispose()));
        this.watchers.clear();
    }
}

async function canonicalPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

async function watchTargetsByDirectory(
    configPaths: readonly string[],
): Promise<Map<string, Set<string>>> {
    const chains = await Promise.all(
        configPaths.map(async (path) => [path, ...(await symlinkTargets(path))]),
    );
    const targetsByDirectory = new Map<string, Set<string>>();
    for (const path of chains.flat()) {
        const directory = dirname(path);
        const targets = targetsByDirectory.get(directory) ?? new Set<string>();
        targets.add(path);
        targetsByDirectory.set(directory, targets);
    }
    return targetsByDirectory;
}

/**
 * Follows `path`'s symlink chain one hop at a time and returns each hop's target, ending at the first entry that is not
 * a link: the canonical file, or a missing one when the link dangles. `realpath` cannot be used for the chain because a
 * dangling link has no real path, yet its missing target is exactly what must be watched to notice its return. A
 * relative link resolves against the link's canonical directory, as the kernel does, and each target carries its
 * canonical directory so it matches the native watcher's root. The walk is best-effort: an entry it cannot read ends
 * the chain, and reconciliation itself reports whether the config can be read or written.
 */
async function symlinkTargets(path: string, remainingHops = MAX_SYMLINK_HOPS): Promise<string[]> {
    if (remainingHops === 0) return [];
    let target: string;
    try {
        const resolved = resolve(await realpath(dirname(path)), await readlink(path));
        target = join(await realpath(dirname(resolved)), basename(resolved));
    } catch {
        return [];
    }
    return [target, ...(await symlinkTargets(target, remainingHops - 1))];
}

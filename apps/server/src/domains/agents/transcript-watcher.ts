import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';

import type { WatchHandle, WatchHub } from '../watch-hub';
import type { AgentTranscriptLocation } from './transcript-security';
import { resolveSafeAgentTranscriptPath } from './transcript-security';

const DEFAULT_POLL_INTERVAL_MS = 500;

interface TranscriptWatchEntry {
    handle: WatchHandle;
    path: string;
    signature: string;
    sourcePath: string;
    sourceRoot: string;
    terminalId: string;
}

interface PendingTranscriptInstall {
    generation: number;
    invalidationGeneration: number;
    location: AgentTranscriptLocation;
    promise: Promise<void>;
}

export interface AgentTranscriptWatcherOptions {
    emit: (event: ServerEvent) => void;
    onForgetTerminal?: (terminalId: string) => void;
    locationForTerminal: (terminalId: string) => AgentTranscriptLocation | undefined;
    locateForTerminal?: (terminalId: string) => Promise<AgentTranscriptLocation | undefined>;
    mobileDiscoveryIntervalMs?: number;
    pollIntervalMs?: number;
    terminalIdsForSession: (sessionId: string) => readonly string[];
    watchHub: WatchHub;
}

async function transcriptSignature(path: string): Promise<string> {
    try {
        const value = await stat(path);
        return value.isFile()
            ? `${value.dev}:${value.ino}:${value.birthtimeMs}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
            : 'missing';
    } catch {
        return 'missing';
    }
}

/**
 * Retains one Server/WatchHub subscription per transcript that a Renderer has actually opened. Native events carry no
 * content; fallback polling compares only filesystem metadata. A post-subscribe signature check closes the race between
 * the initial signature read and WatchHub becoming live.
 */
/* eslint-disable unicorn/consistent-class-member-order -- Subscription lifecycle remains adjacent to the public watch API. */
export class AgentTranscriptWatcher {
    private closed = false;
    private closePromise?: Promise<void>;
    private readonly entries = new Map<string, TranscriptWatchEntry>();
    private generationCounter = 0;
    private readonly generations = new Map<string, number>();
    private readonly installs = new Map<string, PendingTranscriptInstall>();
    private readonly desktopTerminals = new Set<string>();
    private readonly mobileUsers = new Map<string, number>();
    private readonly mobileDiscovery = new Map<string, ReturnType<typeof setInterval>>();

    constructor(private readonly options: AgentTranscriptWatcherOptions) {}

    private advanceGeneration(terminalId: string): number {
        this.generationCounter += 1;
        this.generations.set(terminalId, this.generationCounter);
        return this.generationCounter;
    }

    private pruneGeneration(terminalId: string): void {
        if (this.entries.has(terminalId) || this.installs.has(terminalId)) return;
        this.generations.delete(terminalId);
    }

    private emitChange(entry: TranscriptWatchEntry): void {
        if (this.closed || this.entries.get(entry.terminalId) !== entry) return;
        this.options.emit({
            event: 'agentTranscript.changed',
            payload: { terminalId: entry.terminalId },
        });
    }

    private async detectChange(entry: TranscriptWatchEntry): Promise<void> {
        const signature = await transcriptSignature(entry.path);
        if (signature === entry.signature) return;
        entry.signature = signature;
        this.emitChange(entry);
    }

    private async install(
        terminalId: string,
        location: AgentTranscriptLocation,
        generation: number,
    ): Promise<void> {
        const safe = await resolveSafeAgentTranscriptPath(location);
        if (!safe) return;
        const { path } = safe;
        const previous = this.entries.get(terminalId);
        if (previous) {
            this.entries.delete(terminalId);
            await previous.handle.dispose();
        }
        const entry = {
            terminalId,
            path,
            sourcePath: location.path,
            sourceRoot: location.root,
            signature: await transcriptSignature(path),
        } as Omit<TranscriptWatchEntry, 'handle'> & { handle?: WatchHandle };
        const acceptedPaths = new Set([resolve(location.path), path]);
        const handle = await this.options.watchHub.register({
            label: 'agent-transcript',
            root: dirname(path),
            onEvents: (events) => {
                if (events.some((event) => acceptedPaths.has(resolve(event.path))))
                    this.emitChange(entry as TranscriptWatchEntry);
            },
            onError: (error, failedHandle) => failedHandle.startFallback(error),
            fallback: {
                intervalMs: this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
                activate: async () => {
                    entry.signature = await transcriptSignature(path);
                },
                pollOnce: () => this.detectChange(entry as TranscriptWatchEntry),
            },
        });
        entry.handle = handle;
        if (this.closed || this.generations.get(terminalId) !== generation) {
            await handle.dispose();
            return;
        }
        const completeEntry = entry as TranscriptWatchEntry;
        this.entries.set(terminalId, completeEntry);
        const initialSignature = entry.signature;
        await this.detectChange(completeEntry);
        /**
         * A mobile reader may have received `missing` before the Agent bound its transcript. An empty transcript is
         * already available, so its first late-discovery install must invalidate that read too.
         */
        if (
            initialSignature !== 'missing' &&
            this.mobileDiscovery.has(terminalId) &&
            completeEntry.signature === initialSignature
        )
            this.emitChange(completeEntry);
    }

    async watch(terminalId: string): Promise<void> {
        this.desktopTerminals.add(terminalId);
        await this.ensureWatch(terminalId);
    }

    async watchMobile(terminalId: string): Promise<void> {
        this.mobileUsers.set(terminalId, (this.mobileUsers.get(terminalId) ?? 0) + 1);
        try {
            await this.ensureWatch(terminalId);
            if (!this.entries.has(terminalId) && !this.installs.has(terminalId))
                this.startMobileDiscovery(terminalId);
        } catch (error) {
            this.unwatchMobile(terminalId);
            throw error;
        }
    }

    /**
     * Whether a phone holds this Terminal's Conversation open. Idle suspension treats that as viewing the Agent, so a
     * reply sent from the phone never finds the Terminal parked.
     */
    isObservedRemotely(terminalId: string): boolean {
        return this.mobileUsers.has(terminalId);
    }

    unwatchMobile(terminalId: string): void {
        const users = this.mobileUsers.get(terminalId);
        if (users === undefined) return;
        if (users > 1) {
            this.mobileUsers.set(terminalId, users - 1);
            return;
        }
        this.mobileUsers.delete(terminalId);
        this.stopMobileDiscovery(terminalId);
        if (!this.desktopTerminals.has(terminalId)) this.forgetTerminal(terminalId);
    }

    private async ensureWatch(terminalId: string): Promise<void> {
        if (this.closed) return;
        const location =
            this.options.locationForTerminal(terminalId) ??
            (await this.options.locateForTerminal?.(terminalId));
        if (!location) {
            if (!this.mobileUsers.has(terminalId) && !this.desktopTerminals.has(terminalId))
                this.forgetTerminal(terminalId);
            return;
        }
        const entry = this.entries.get(terminalId);
        if (entry?.sourcePath === location.path && entry.sourceRoot === location.root) return;
        const pending = this.installs.get(terminalId);
        if (pending) {
            const invalidationGeneration = pending.invalidationGeneration;
            await pending.promise;
            // Another lifecycle call can close the watcher while the install promise is pending.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- concurrent lifecycle mutation across await
            if (this.closed) return;
            if (pending.invalidationGeneration !== invalidationGeneration) return;
            const latest =
                this.options.locationForTerminal(terminalId) ??
                (await this.options.locateForTerminal?.(terminalId));
            if (
                latest &&
                (invalidationGeneration !== pending.generation ||
                    latest.path !== pending.location.path ||
                    latest.root !== pending.location.root)
            )
                await this.ensureWatch(terminalId);
            return;
        }
        const generation = this.advanceGeneration(terminalId);
        const install = this.install(terminalId, location, generation);
        const pendingInstall = {
            generation,
            invalidationGeneration: generation,
            location,
            promise: install,
        };
        this.installs.set(terminalId, pendingInstall);
        try {
            await install;
        } finally {
            if (this.installs.get(terminalId) === pendingInstall) this.installs.delete(terminalId);
            this.pruneGeneration(terminalId);
        }
    }

    forgetTerminal(terminalId: string): void {
        this.options.onForgetTerminal?.(terminalId);
        this.stopMobileDiscovery(terminalId);
        this.desktopTerminals.delete(terminalId);
        this.mobileUsers.delete(terminalId);
        const pending = this.installs.get(terminalId);
        if (this.generations.has(terminalId)) {
            const generation = this.advanceGeneration(terminalId);
            if (pending) pending.invalidationGeneration = generation;
        }
        const entry = this.entries.get(terminalId);
        this.entries.delete(terminalId);
        // Fire-and-forget: lifecycle handlers are synchronous and WatchHub disposal is idempotent.
        // eslint-disable-next-line no-void -- synchronous lifecycle boundary, see comment above
        if (entry) void entry.handle.dispose();
        this.pruneGeneration(terminalId);
    }

    forgetSession(sessionId: string): void {
        for (const terminalId of this.options.terminalIdsForSession(sessionId))
            this.forgetTerminal(terminalId);
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        for (const terminalId of this.mobileDiscovery.keys()) this.stopMobileDiscovery(terminalId);
        const terminalIds = new Set([...this.entries.keys(), ...this.installs.keys()]);
        for (const terminalId of terminalIds) this.advanceGeneration(terminalId);
        const entries = this.entries.values().toArray();
        this.entries.clear();
        this.closePromise = (async () => {
            try {
                await Promise.all([
                    ...entries.map((entry) => entry.handle.dispose()),
                    ...this.installs.values().map((install) => install.promise),
                ]);
            } finally {
                this.installs.clear();
                this.generations.clear();
                this.desktopTerminals.clear();
                this.mobileUsers.clear();
            }
        })();
        return this.closePromise;
    }

    private startMobileDiscovery(terminalId: string): void {
        if (this.mobileDiscovery.has(terminalId)) return;
        const timer = setInterval(() => {
            if (this.closed || !this.mobileUsers.has(terminalId)) {
                this.stopMobileDiscovery(terminalId);
                return;
            }
            // eslint-disable-next-line no-void -- The next bounded discovery tick handles a transient lookup miss.
            void this.ensureWatch(terminalId)
                .then(() => {
                    if (this.entries.has(terminalId)) this.stopMobileDiscovery(terminalId);
                })
                .catch(() => {});
        }, this.options.mobileDiscoveryIntervalMs ?? 2_000);
        timer.unref();
        this.mobileDiscovery.set(terminalId, timer);
    }

    private stopMobileDiscovery(terminalId: string): void {
        const timer = this.mobileDiscovery.get(terminalId);
        if (timer) clearInterval(timer);
        this.mobileDiscovery.delete(terminalId);
    }
}
/* eslint-enable unicorn/consistent-class-member-order */

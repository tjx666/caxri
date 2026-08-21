import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { RuntimeEvent } from '../../shared/ipc/events';
import type { WatchHandle, WatchHub } from '../watch-hub';

const DEFAULT_POLL_INTERVAL_MS = 500;

interface TranscriptWatchEntry {
    handle: WatchHandle;
    path: string;
    signature: string;
    sourcePath: string;
    terminalId: string;
}

export interface AgentTranscriptWatcherOptions {
    emit: (event: RuntimeEvent) => void;
    pathForTerminal: (terminalId: string) => string | undefined;
    pollIntervalMs?: number;
    terminalIdsForSession: (sessionId: string) => readonly string[];
    watchHub: WatchHub;
}

async function transcriptSignature(path: string): Promise<string> {
    try {
        const value = await stat(path);
        return value.isFile() ? `${value.size}:${value.mtimeMs}:${value.ctimeMs}` : 'missing';
    } catch {
        return 'missing';
    }
}

/**
 * Native macOS events canonicalize `/var` to `/private/var`, while provider paths can retain the symlinked spelling.
 * Canonicalizing the existing file (or its parent before the file exists) keeps exact-path filtering reliable without
 * broadening a transcript subscription to unrelated files in the same provider directory.
 */
async function canonicalTranscriptPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        try {
            return join(await realpath(dirname(path)), basename(path));
        } catch {
            return resolve(path);
        }
    }
}

/**
 * Retains one Runtime/WatchHub subscription per transcript that a Renderer has actually opened. Native events carry no
 * content; fallback polling compares only filesystem metadata. A post-subscribe signature check closes the race between
 * the initial signature read and WatchHub becoming live.
 */
export class AgentTranscriptWatcher {
    private closed = false;
    private readonly entries = new Map<string, TranscriptWatchEntry>();
    private readonly generations = new Map<string, number>();
    private readonly installs = new Map<string, Promise<void>>();

    constructor(private readonly options: AgentTranscriptWatcherOptions) {}

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
        sourcePath: string,
        generation: number,
    ): Promise<void> {
        const path = await canonicalTranscriptPath(sourcePath);
        const previous = this.entries.get(terminalId);
        if (previous) {
            this.entries.delete(terminalId);
            await previous.handle.dispose();
        }
        const entry = {
            terminalId,
            path,
            sourcePath,
            signature: await transcriptSignature(path),
        } as Omit<TranscriptWatchEntry, 'handle'> & { handle?: WatchHandle };
        const acceptedPaths = new Set([resolve(sourcePath), path]);
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
        await this.detectChange(completeEntry);
    }

    async watch(terminalId: string): Promise<void> {
        if (this.closed) return;
        const sourcePath = this.options.pathForTerminal(terminalId);
        if (!sourcePath) {
            this.forgetTerminal(terminalId);
            return;
        }
        if (this.entries.get(terminalId)?.sourcePath === sourcePath) return;
        const pending = this.installs.get(terminalId);
        if (pending) return pending;
        const generation = (this.generations.get(terminalId) ?? 0) + 1;
        this.generations.set(terminalId, generation);
        const install = this.install(terminalId, sourcePath, generation);
        this.installs.set(terminalId, install);
        try {
            await install;
        } finally {
            if (this.installs.get(terminalId) === install) this.installs.delete(terminalId);
        }
    }

    forgetTerminal(terminalId: string): void {
        this.generations.set(terminalId, (this.generations.get(terminalId) ?? 0) + 1);
        const entry = this.entries.get(terminalId);
        this.entries.delete(terminalId);
        // Fire-and-forget: lifecycle handlers are synchronous and WatchHub disposal is idempotent.
        // eslint-disable-next-line no-void -- synchronous lifecycle boundary, see comment above
        if (entry) void entry.handle.dispose();
    }

    forgetSession(sessionId: string): void {
        for (const terminalId of this.options.terminalIdsForSession(sessionId))
            this.forgetTerminal(terminalId);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const terminalIds = new Set([...this.entries.keys(), ...this.installs.keys()]);
        for (const terminalId of terminalIds)
            this.generations.set(terminalId, (this.generations.get(terminalId) ?? 0) + 1);
        const entries = this.entries.values().toArray();
        this.entries.clear();
        await Promise.all([
            ...entries.map((entry) => entry.handle.dispose()),
            ...this.installs.values(),
        ]);
    }
}

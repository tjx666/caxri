import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { chmod, lstat, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AppSettings,
    ServerOperationParameters,
    TerminalLongPasteResult,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { AsyncSemaphore, waitForSharedOperation } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import {
    agentPasteSummaryCharacterLimit,
    countAgentPasteLines,
    normalizeAgentPasteSummary,
} from './paste-summary-generation';
import type { AgentService } from './service';

const LONG_PASTE_DIRECTORY_NAME = 'pastes';
const LONG_PASTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LONG_PASTE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_LONG_PASTE_DIRECTORY_BYTES = 128 * 1024 * 1024;
const MAX_LONG_PASTE_CONTENT_BYTES = 4 * 1024 * 1024;
const LONG_PASTE_SUMMARY_TIMEOUT_MS = 12_000;
const MAX_CONCURRENT_LONG_PASTE_SUMMARIES = 2;
const PASTE_FILE_NAME = /^paste-\d{8}T\d{6}-[\da-f-]{36}\.txt$/u;

interface LongPasteFile {
    modifiedAt: number;
    path: string;
    size: number;
}

async function pruneLongPastes(
    directory: string,
    now: number,
    reserveBytes: number,
): Promise<void> {
    let entries: Array<Dirent<string>>;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch {
        return;
    }
    const files: LongPasteFile[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !PASTE_FILE_NAME.test(entry.name)) continue;
        const path = join(directory, entry.name);
        try {
            // eslint-disable-next-line no-await-in-loop -- every candidate must be revalidated before cleanup
            const stats = await lstat(path);
            if (!stats.isFile() || stats.isSymbolicLink()) continue;
            if (now - stats.mtimeMs >= LONG_PASTE_RETENTION_MS) {
                // eslint-disable-next-line no-await-in-loop -- bounded, known files are removed before size accounting
                await unlink(path);
                continue;
            }
            files.push({ modifiedAt: stats.mtimeMs, path, size: stats.size });
        } catch {
            // A concurrent cleanup or external deletion is harmless.
        }
    }
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const oldestFirst = files.toSorted((a, b) => a.modifiedAt - b.modifiedAt);
    for (const file of oldestFirst) {
        if (totalBytes + reserveBytes <= MAX_LONG_PASTE_DIRECTORY_BYTES) break;
        try {
            // eslint-disable-next-line no-await-in-loop -- deletion order preserves the newest references
            await unlink(file.path);
            totalBytes -= file.size;
        } catch {
            // A concurrent cleanup or external deletion is harmless.
        }
    }
}

function pasteFileName(now: number, identifier: string): string {
    const timestamp = new Date(now).toISOString().replaceAll(/[-:]/g, '').slice(0, 15);
    return `paste-${timestamp}-${identifier}.txt`;
}

/**
 * Owns the privacy boundary for long Terminal pastes: the original is persisted before any provider call, never enters
 * logs or SQLite, and survives provider failure as a local path the active Agent can read explicitly.
 */
export class LongPasteService {
    private cleanupTimer?: NodeJS.Timeout;
    private isClosed = false;
    private readonly directory: string;
    private readonly mutations = new AsyncSemaphore(1);
    private readonly summaries = new AsyncSemaphore(MAX_CONCURRENT_LONG_PASTE_SUMMARIES);

    constructor(
        userDataPath: string,
        private readonly database: CaxriDatabase,
        private readonly agents: Pick<AgentService, 'summarizePaste'>,
        private readonly settings: () => AppSettings,
        private readonly agentLaunchId: (terminalId: string) => string | undefined,
        private readonly now: () => number = Date.now,
        private readonly identifier: () => string = randomUUID,
        private readonly summaryTimeoutMs: number = LONG_PASTE_SUMMARY_TIMEOUT_MS,
        private readonly cleanupIntervalMs: number = LONG_PASTE_CLEANUP_INTERVAL_MS,
    ) {
        this.directory = join(userDataPath, LONG_PASTE_DIRECTORY_NAME);
    }

    /**
     * Enforces retention even when no later paste arrives. Cleanup shares the file-mutation semaphore with writes so a
     * long model call may settle concurrently without racing directory capacity accounting or deleting a new file.
     */
    async initialize(): Promise<void> {
        await this.mutations.run(() => pruneLongPastes(this.directory, this.now(), 0));
        if (this.isClosed || this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            // eslint-disable-next-line no-void -- pruning is content-free, internally best-effort, and timer-owned
            void this.mutations.run(() => pruneLongPastes(this.directory, this.now(), 0));
        }, this.cleanupIntervalMs);
        this.cleanupTimer.unref();
    }

    close(): void {
        this.isClosed = true;
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
        this.cleanupTimer = undefined;
    }

    async prepare(
        parameters: ServerOperationParameters<'terminal.prepareLongPaste'>,
        signal?: AbortSignal,
    ): Promise<TerminalLongPasteResult> {
        if (this.isClosed) throw new CaxriError('CONFLICT', 'Long paste service is closed');
        const terminal = this.database.getTerminal(parameters.terminalId);
        if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
        if (
            terminal.kind === 'shell' ||
            terminal.lastProcessState !== 'running' ||
            terminal.lastAgentProcessState !== 'running'
        )
            throw new CaxriError('CONFLICT', 'Long paste summaries require a running Agent');
        const provider = terminal.provider ?? terminal.kind;
        const settings = this.settings();
        if (!settings['agents.providers'][provider].pasteSummary.enabled)
            throw new CaxriError('CONFLICT', 'Long paste summaries are disabled for this Agent');
        if (parameters.content.length <= settings['terminal.longPasteThreshold'])
            throw new CaxriError('CONFLICT', 'Pasted text is below the configured threshold');
        const contentBytes = Buffer.byteLength(parameters.content, 'utf8');
        if (contentBytes > MAX_LONG_PASTE_CONTENT_BYTES)
            throw new CaxriError('VALIDATION', 'Pasted text exceeds the local file safety limit');
        if (signal?.aborted)
            throw new CaxriError('CANCELLED', 'Long paste preparation was cancelled');

        const initialAgentLaunchId = this.agentLaunchId(parameters.terminalId);
        /**
         * Foreground detection can promote a Shell to an Agent without a managed launch. It keeps native paste:
         * asynchronous summaries cannot be fenced to that child's lifetime. This is eligibility, not error recovery.
         */
        if (initialAgentLaunchId === undefined) return { status: 'passthrough' };

        const now = this.now();
        const filePath = join(this.directory, pasteFileName(now, this.identifier()));
        const originalSize = {
            characterCount: parameters.content.length,
            lineCount: countAgentPasteLines(parameters.content),
        };
        await this.mutations.run(async () => {
            await mkdir(this.directory, { recursive: true, mode: 0o700 });
            await chmod(this.directory, 0o700);
            await pruneLongPastes(this.directory, now, contentBytes);
            await writeFile(filePath, parameters.content, {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
            await chmod(filePath, 0o600);
        });
        if (signal?.aborted)
            throw new CaxriError('CANCELLED', 'Long paste preparation was cancelled');
        if (this.agentLaunchId(parameters.terminalId) !== initialAgentLaunchId)
            throw new CaxriError('CONFLICT', 'Managed Agent changed while saving the long paste');

        const summaryAbort = new AbortController();
        const relayAbort = (): void => summaryAbort.abort();
        signal?.addEventListener('abort', relayAbort, { once: true });
        if (signal?.aborted) summaryAbort.abort();
        const summaryTimeout = setTimeout(() => summaryAbort.abort(), this.summaryTimeoutMs);
        summaryTimeout.unref();
        let result: TerminalLongPasteResult;
        try {
            const generation = this.summaries.run(() => {
                if (summaryAbort.signal.aborted)
                    throw new CaxriError('CANCELLED', 'Long paste summary was cancelled');
                return this.agents.summarizePaste(provider, {
                    cwd: terminal.cwd,
                    prompt: parameters.content,
                    signal: summaryAbort.signal,
                });
            });
            const summary = normalizeAgentPasteSummary(
                await waitForSharedOperation(
                    generation,
                    summaryAbort.signal,
                    () => new CaxriError('CANCELLED', 'Long paste summary was cancelled'),
                ),
                agentPasteSummaryCharacterLimit(parameters.content),
            );
            result = summary
                ? {
                      agentLaunchId: initialAgentLaunchId,
                      filePath,
                      ...originalSize,
                      status: 'summarized',
                      summary,
                  }
                : {
                      agentLaunchId: initialAgentLaunchId,
                      filePath,
                      ...originalSize,
                      status: 'unavailable',
                  };
        } catch {
            result = {
                agentLaunchId: initialAgentLaunchId,
                filePath,
                ...originalSize,
                status: 'unavailable',
            };
        } finally {
            clearTimeout(summaryTimeout);
            signal?.removeEventListener('abort', relayAbort);
        }
        if (this.agentLaunchId(parameters.terminalId) !== initialAgentLaunchId)
            throw new CaxriError(
                'CONFLICT',
                'Managed Agent changed while summarizing the long paste',
            );
        return result;
    }
}

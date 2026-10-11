import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    AppSettings,
    ServerOperationParameters,
    TerminalLongPasteResult,
} from '@caxri/protocol';
import { CaxriError, MAX_LONG_PASTE_BYTES } from '@caxri/protocol';
import { AsyncSemaphore } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import type { OwnedFileRetention } from '../owned-file-retention';
import { ownedFileTimestamp, pruneOwnedFiles } from '../owned-file-retention';
import { assertPtyTerminal } from '../pty-guard';

const LONG_PASTE_DIRECTORY_NAME = 'pastes';
const LONG_PASTE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LONG_PASTE_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_LONG_PASTE_DIRECTORY_BYTES = 128 * 1024 * 1024;
const PASTE_FILE_NAME = /^paste-\d{8}T\d{6}-[\da-f-]{36}\.txt$/u;

/**
 * Counts lines the way a text editor does, so the reference tells the Agent the same size the file will report.
 */
export function countAgentPasteLines(value: string): number {
    if (value.length === 0) return 0;
    let count = 1;
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === '\r' && value[index + 1] === '\n') index += 1;
        if (value[index] === '\r' || value[index] === '\n') count += 1;
    }
    return count;
}

function pasteFileName(now: number, identifier: string): string {
    return `paste-${ownedFileTimestamp(now)}-${identifier}.txt`;
}

const LONG_PASTE_RETENTION: OwnedFileRetention = {
    fileName: PASTE_FILE_NAME,
    maxBytes: MAX_LONG_PASTE_DIRECTORY_BYTES,
    retentionMs: LONG_PASTE_RETENTION_MS,
};

function pruneLongPastes(directory: string, now: number, reserveBytes: number): Promise<void> {
    return pruneOwnedFiles(directory, LONG_PASTE_RETENTION, now, reserveBytes);
}

/**
 * Owns the privacy boundary for long Terminal pastes: the original is persisted locally, never enters logs or SQLite,
 * and reaches the Agent as a path it can read explicitly instead of as text pushed through the PTY.
 */
export class LongPasteService {
    private cleanupTimer?: NodeJS.Timeout;
    private isClosed = false;
    private readonly directory: string;
    private readonly mutations = new AsyncSemaphore(1);

    constructor(
        userDataPath: string,
        private readonly database: CaxriDatabase,
        private readonly settings: () => AppSettings,
        private readonly agentLaunchId: (terminalId: string) => string | undefined,
        private readonly now: () => number = Date.now,
        private readonly identifier: () => string = randomUUID,
        private readonly cleanupIntervalMs: number = LONG_PASTE_CLEANUP_INTERVAL_MS,
    ) {
        this.directory = join(userDataPath, LONG_PASTE_DIRECTORY_NAME);
    }

    /**
     * Enforces retention even when no later paste arrives. Cleanup shares the file-mutation semaphore with writes so a
     * concurrent paste cannot race directory capacity accounting or have its new file deleted.
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
        assertPtyTerminal(terminal);
        if (
            terminal.kind === 'shell' ||
            terminal.lastProcessState !== 'running' ||
            terminal.lastAgentProcessState !== 'running'
        )
            throw new CaxriError('CONFLICT', 'Saving a long paste requires a running Agent');
        const settings = this.settings();
        if (parameters.content.length <= settings['terminal.longPasteThreshold'])
            throw new CaxriError('CONFLICT', 'Pasted text is below the configured threshold');
        const contentBytes = Buffer.byteLength(parameters.content, 'utf8');
        if (contentBytes > MAX_LONG_PASTE_BYTES)
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
        return { agentLaunchId: initialAgentLaunchId, filePath, ...originalSize, status: 'saved' };
    }
}

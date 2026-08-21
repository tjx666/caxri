import { Buffer } from 'node:buffer';

import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';
import { Terminal } from '@xterm/headless';

import { boundSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_LINES } from '../snapshot';

type ScreenOperation =
    | { chunks: string[]; type: 'write' }
    | { cols: number; rows: number; type: 'resize' }
    | { droppedBytes: number; type: 'reset' }
    | {
          maximumCharacters: number;
          reject: (error: unknown) => void;
          resolve: (tail: TerminalTextTail) => void;
          type: 'text-tail';
      }
    | {
          options: TerminalScreenSnapshotOptions;
          reject: (error: unknown) => void;
          resolve: (snapshot: TerminalScreenSnapshot) => void;
          type: 'snapshot';
      };

export type TerminalScreenSnapshot = ReturnType<typeof boundSnapshot> & {
    cols: number;
    rows: number;
};

export interface TerminalTextTail {
    beforeCursorLine: string;
    cursorLine: string;
    full: string;
}

export interface TerminalScreenSnapshotOptions {
    /**
     * Omits terminal interaction modes from a durable visual snapshot so restoring history cannot reactivate them.
     */
    excludeModes?: boolean;
}

/**
 * Receives the OSC 0/2 window titles xterm parses out of the PTY stream, and hands its delivery lifetime to the screen.
 *
 * `cancel` runs from `dispose()`. A title observer is normally throttled, and `restart()` finalizes the outgoing screen
 * before spawning the replacement under the same durable Terminal ID — without an explicit cancel the retired PTY's
 * still-pending trailing delivery would land after the replacement wrote its own title and silently overwrite it.
 */
export interface TerminalTitleObserver {
    (title: string): void;
    cancel: () => void;
}

export interface TerminalScreenStateOptions {
    /**
     * Test seam and hard ceiling for raw input waiting on xterm's asynchronous parser.
     */
    maximumQueuedBytes?: number;
    onOverflow?: (droppedBytes: number) => void;
    /**
     * Emitted for every Terminal the Runtime owns, mounted or not, because this parser runs independently of any
     * Renderer pane.
     */
    onTitleChange?: TerminalTitleObserver;
}

/**
 * Allow the 2 MiB recovery snapshot to be rebuilt under a burst while bounding sustained parser lag.
 */
const DEFAULT_MAXIMUM_QUEUED_BYTES = 4 * MAX_SNAPSHOT_BYTES;

/**
 * Maintains the bounded, parsed Terminal screen owned by a live PTY. Both live reattachment and durable recovery are
 * serialized from this state so arbitrary PTY input is never replayed as history.
 */
export class TerminalScreenState {
    private disposed = false;
    private draining?: Promise<void>;
    private readonly maximumQueuedBytes: number;
    private readonly onOverflow?: (droppedBytes: number) => void;
    private readonly onTitleChange?: TerminalTitleObserver;
    private readonly operations: ScreenOperation[] = [];
    private queuedWriteBytes = 0;
    private readonly serialize = new SerializeAddon();
    private readonly terminal: HeadlessTerminal;

    constructor(
        initialSnapshot: string,
        cols = 100,
        rows = 30,
        options: TerminalScreenStateOptions = {},
    ) {
        this.maximumQueuedBytes = options.maximumQueuedBytes ?? DEFAULT_MAXIMUM_QUEUED_BYTES;
        this.onOverflow = options.onOverflow;
        this.onTitleChange = options.onTitleChange;
        if (!Number.isSafeInteger(this.maximumQueuedBytes) || this.maximumQueuedBytes < 1)
            throw new RangeError('Terminal screen queue limit must be a positive integer');
        this.terminal = new Terminal({
            allowProposedApi: true,
            cols,
            convertEol: false,
            logLevel: 'off',
            rows,
            scrollback: MAX_SNAPSHOT_LINES,
        });
        /**
         * These addons declare the browser Terminal activation type, but their Unicode and buffer APIs are shared with
         * `@xterm/headless` and are the supported Node.js composition.
         */
        this.terminal.loadAddon(new Unicode11Addon());
        this.terminal.unicode.activeVersion = '11';
        this.terminal.loadAddon(this.serialize);
        /**
         * Attached before the snapshot replay below so a recovered Terminal re-derives its title from whatever OSC the
         * replay happens to carry. The serializer does not currently emit the window title, so in practice recovery
         * relies on the persisted `terminals.title` until the shell reprints its own at the next prompt.
         */
        if (this.onTitleChange) this.terminal.onTitleChange(this.onTitleChange);
        this.write(initialSnapshot);
    }

    private resetOverflowedQueue(incomingBytes: number): void {
        let droppedBytes = this.queuedWriteBytes + incomingBytes;
        const snapshots: Array<Extract<ScreenOperation, { type: 'snapshot' }>> = [];
        const pendingOperations = [...this.operations];
        this.operations.length = 0;
        for (const operation of pendingOperations) {
            if (operation.type === 'reset') droppedBytes += operation.droppedBytes;
            else if (operation.type === 'snapshot') snapshots.push(operation);
        }
        this.queuedWriteBytes = 0;
        /**
         * A queued attach barrier now resolves from the explicit reset state. Output arriving after this overflow is
         * appended behind those barriers and remains live-only.
         */
        this.operations.push({ droppedBytes, type: 'reset' }, ...snapshots);
        this.onOverflow?.(droppedBytes);
    }

    private startDrain(): void {
        if (this.draining || this.disposed) return;
        this.draining = this.runDrainCycle();
    }

    private async runDrainCycle(): Promise<void> {
        try {
            await this.drain();
        } finally {
            this.draining = undefined;
            if (this.operations.length > 0) this.startDrain();
        }
    }

    private async drain(): Promise<void> {
        while (!this.disposed) {
            const operation = this.operations.shift();
            if (!operation) return;
            if (operation.type === 'write') {
                const data = operation.chunks.join('');
                this.queuedWriteBytes -= Buffer.byteLength(data, 'utf8');
                // eslint-disable-next-line no-await-in-loop -- xterm's parser is not reentrant; each queued operation must finish before the next is written, and this await is immediately followed by a `return`, so it never repeats within a single loop pass
                await new Promise<void>((resolve) => this.terminal.write(data, resolve));
                return this.drain();
            }
            if (operation.type === 'resize') {
                this.terminal.resize(operation.cols, operation.rows);
                continue;
            }
            if (operation.type === 'reset') {
                this.terminal.reset();
                const warning = `\r\n[Caxri reset Terminal screen recovery after ${operation.droppedBytes} bytes exceeded parser backpressure]\r\n`;
                // eslint-disable-next-line no-await-in-loop -- xterm's parser is not reentrant; each queued operation must finish before the next is written, and this await is immediately followed by a `return`, so it never repeats within a single loop pass
                await new Promise<void>((resolve) => this.terminal.write(warning, resolve));
                return this.drain();
            }
            if (operation.type === 'text-tail') {
                try {
                    operation.resolve(this.serializeTextTail(operation.maximumCharacters));
                } catch (error) {
                    operation.reject(error);
                }
                continue;
            }
            try {
                operation.resolve(this.serializeBounded(operation.options));
            } catch (error) {
                operation.reject(error);
            }
        }
    }

    private serializeBounded(options: TerminalScreenSnapshotOptions): TerminalScreenSnapshot {
        let scrollback = MAX_SNAPSHOT_LINES;
        let payload = this.serialize.serialize({ excludeModes: options.excludeModes, scrollback });
        while (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES && scrollback > 0) {
            scrollback = Math.floor(scrollback / 2);
            payload = this.serialize.serialize({ excludeModes: options.excludeModes, scrollback });
        }
        return {
            ...boundSnapshot(payload),
            cols: this.terminal.cols,
            rows: this.terminal.rows,
        };
    }

    /**
     * Reads displayed text from the parsed buffer instead of raw PTY bytes. Wrapped physical rows are rejoined so a
     * user-authored suffix is independent of the receiving Terminal width.
     */
    private serializeTextTail(maximumCharacters: number): TerminalTextTail {
        const buffer = this.terminal.buffer.active;
        const logicalLines: string[] = [];
        let cursorLogicalLine = -1;
        const cursorPhysicalLine = buffer.baseY + buffer.cursorY;
        for (let index = 0; index < buffer.length; index += 1) {
            const line = buffer.getLine(index);
            if (!line) continue;
            const text = line.translateToString(true);
            if (line.isWrapped && logicalLines.length > 0)
                logicalLines[logicalLines.length - 1] += text;
            else logicalLines.push(text);
            if (index === cursorPhysicalLine) cursorLogicalLine = logicalLines.length - 1;
        }
        const bounded = (lines: readonly string[]): string =>
            lines.join('\n').trimEnd().slice(-maximumCharacters);
        return {
            beforeCursorLine: bounded(
                logicalLines.filter((_, index) => index !== cursorLogicalLine),
            ),
            cursorLine: cursorLogicalLine < 0 ? '' : (logicalLines[cursorLogicalLine] ?? ''),
            full: bounded(logicalLines),
        };
    }

    write(data: string): void {
        if (!data || this.disposed) return;
        const bytes = Buffer.byteLength(data, 'utf8');
        if (this.queuedWriteBytes + bytes > this.maximumQueuedBytes) {
            this.resetOverflowedQueue(bytes);
            this.startDrain();
            return;
        }
        const last = this.operations.at(-1);
        if (last?.type === 'write') last.chunks.push(data);
        else this.operations.push({ chunks: [data], type: 'write' });
        this.queuedWriteBytes += bytes;
        this.startDrain();
    }

    resize(cols: number, rows: number): void {
        if (this.disposed) return;
        const last = this.operations.at(-1);
        if (last?.type === 'resize') {
            last.cols = cols;
            last.rows = rows;
        } else {
            this.operations.push({ cols, rows, type: 'resize' });
        }
        this.startDrain();
    }

    /**
     * Inserts an exact ordering barrier so later live output can stream to the attached Renderer.
     */
    snapshot(options: TerminalScreenSnapshotOptions = {}): Promise<TerminalScreenSnapshot> {
        if (this.disposed)
            return Promise.resolve({
                ...boundSnapshot(''),
                cols: this.terminal.cols,
                rows: this.terminal.rows,
            });
        return new Promise((resolve, reject) => {
            this.operations.push({ options, reject, resolve, type: 'snapshot' });
            this.startDrain();
        });
    }

    /**
     * Inserts an ordering barrier and returns a bounded, control-sequence-free tail for in-memory behavior matching.
     */
    textTail(maximumCharacters: number): Promise<TerminalTextTail> {
        if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1)
            return Promise.reject(new RangeError('Terminal text tail limit must be positive'));
        if (this.disposed)
            return Promise.resolve({ beforeCursorLine: '', cursorLine: '', full: '' });
        return new Promise((resolve, reject) => {
            this.operations.push({ maximumCharacters, reject, resolve, type: 'text-tail' });
            this.startDrain();
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.onTitleChange?.cancel();
        const pendingOperations = [...this.operations];
        this.operations.length = 0;
        for (const operation of pendingOperations) {
            if (operation.type === 'snapshot' || operation.type === 'text-tail')
                operation.reject(new Error('Terminal screen was disposed before serialization'));
        }
        this.terminal.dispose();
    }

    /**
     * Pending bytes exclude the one bounded write currently inside xterm's parser.
     */
    pendingByteCount(): number {
        return this.queuedWriteBytes;
    }
}

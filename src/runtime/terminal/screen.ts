import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';

import type * as SerializeAddonModule from '@xterm/addon-serialize';
import type * as Unicode11AddonModule from '@xterm/addon-unicode11';
import type * as HeadlessModule from '@xterm/headless';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

import { boundSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_LINES } from '../snapshot';

/** electron-vite externalizes production dependencies, and these xterm Node packages publish
 *  CommonJS entry points whose named exports Node ESM cannot load directly. */
const runtimeRequire = createRequire(import.meta.url);
const { SerializeAddon } = runtimeRequire('@xterm/addon-serialize') as typeof SerializeAddonModule;
const { Unicode11Addon } = runtimeRequire('@xterm/addon-unicode11') as typeof Unicode11AddonModule;
const { Terminal } = runtimeRequire('@xterm/headless') as typeof HeadlessModule;

type ScreenOperation =
    | { chunks: string[]; type: 'write' }
    | { cols: number; rows: number; type: 'resize' }
    | { droppedBytes: number; type: 'reset' }
    | {
          reject: (error: unknown) => void;
          resolve: (snapshot: ReturnType<typeof boundSnapshot>) => void;
          type: 'snapshot';
      };

export interface TerminalScreenStateOptions {
    /** Test seam and hard ceiling for raw input waiting on xterm's asynchronous parser. */
    maximumQueuedBytes?: number;
    onOverflow?: (droppedBytes: number) => void;
}

/** Allow the 2 MiB recovery snapshot to be rebuilt under a burst while bounding sustained parser lag. */
const DEFAULT_MAXIMUM_QUEUED_BYTES = 4 * MAX_SNAPSHOT_BYTES;

/**
 * Maintains the bounded, parsed Terminal screen owned by a live PTY. Raw ANSI retention can start
 * in the middle of a control sequence after trimming, so reattachment uses this serialized xterm
 * state while durable crash recovery keeps the existing raw snapshot fallback.
 */
export class TerminalScreenState {
    private disposed = false;
    private draining?: Promise<void>;
    private readonly maximumQueuedBytes: number;
    private readonly onOverflow?: (droppedBytes: number) => void;
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
        if (!Number.isInteger(this.maximumQueuedBytes) || this.maximumQueuedBytes < 1)
            throw new RangeError('Terminal screen queue limit must be a positive integer');
        this.terminal = new Terminal({
            allowProposedApi: true,
            cols,
            convertEol: false,
            logLevel: 'off',
            rows,
            scrollback: MAX_SNAPSHOT_LINES,
        });
        /** These addons declare the browser Terminal activation type, but their Unicode and buffer
         *  APIs are shared with @xterm/headless and are the supported Node.js composition. */
        this.terminal.loadAddon(new Unicode11Addon());
        this.terminal.unicode.activeVersion = '11';
        this.terminal.loadAddon(this.serialize);
        this.write(initialSnapshot);
    }

    write(data: string): void {
        if (this.disposed || !data) return;
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

    /** Inserts an exact ordering barrier so later live output can stream to the attached Renderer. */
    snapshot(): Promise<ReturnType<typeof boundSnapshot>> {
        if (this.disposed) return Promise.resolve(boundSnapshot(''));
        return new Promise((resolve, reject) => {
            this.operations.push({ reject, resolve, type: 'snapshot' });
            this.startDrain();
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const operation of this.operations.splice(0)) {
            if (operation.type === 'snapshot')
                operation.reject(new Error('Terminal screen was disposed before serialization'));
        }
        this.terminal.dispose();
    }

    /** Pending bytes exclude the one bounded write currently inside xterm's parser. */
    pendingByteCount(): number {
        return this.queuedWriteBytes;
    }

    private resetOverflowedQueue(incomingBytes: number): void {
        let droppedBytes = this.queuedWriteBytes + incomingBytes;
        const snapshots: Extract<ScreenOperation, { type: 'snapshot' }>[] = [];
        for (const operation of this.operations.splice(0)) {
            if (operation.type === 'reset') droppedBytes += operation.droppedBytes;
            if (operation.type === 'snapshot') snapshots.push(operation);
        }
        this.queuedWriteBytes = 0;
        /** A queued attach barrier now resolves from the explicit reset state. Output arriving
         *  after this overflow is appended behind those barriers and remains live-only. */
        this.operations.push({ droppedBytes, type: 'reset' }, ...snapshots);
        this.onOverflow?.(droppedBytes);
    }

    private startDrain(): void {
        if (this.draining || this.disposed) return;
        this.draining = this.drain().finally(() => {
            this.draining = undefined;
            if (this.operations.length > 0) this.startDrain();
        });
    }

    private drain(): Promise<void> {
        while (!this.disposed) {
            const operation = this.operations.shift();
            if (!operation) return Promise.resolve();
            if (operation.type === 'write') {
                const data = operation.chunks.join('');
                this.queuedWriteBytes -= Buffer.byteLength(data, 'utf8');
                return new Promise<void>((resolve) => this.terminal.write(data, resolve)).then(() =>
                    this.drain(),
                );
            }
            if (operation.type === 'resize') {
                this.terminal.resize(operation.cols, operation.rows);
                continue;
            }
            if (operation.type === 'reset') {
                this.terminal.reset();
                const warning = `\r\n[Caxri reset Terminal screen recovery after ${operation.droppedBytes} bytes exceeded parser backpressure]\r\n`;
                return new Promise<void>((resolve) => this.terminal.write(warning, resolve)).then(
                    () => this.drain(),
                );
            }
            try {
                operation.resolve(this.serializeBounded());
            } catch (error) {
                operation.reject(error);
            }
        }
        return Promise.resolve();
    }

    private serializeBounded(): ReturnType<typeof boundSnapshot> {
        let scrollback = MAX_SNAPSHOT_LINES;
        let payload = this.serialize.serialize({ scrollback });
        while (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES && scrollback > 0) {
            scrollback = Math.floor(scrollback / 2);
            payload = this.serialize.serialize({ scrollback });
        }
        return boundSnapshot(payload);
    }
}

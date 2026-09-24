import { decodeHex } from '@caxri/mobile-transport';
import type { TerminalSnapshot } from '@caxri/protocol';
import { terminalSnapshotSchema } from '@caxri/protocol';

const MAXIMUM_ASSEMBLED_BYTES = 4 * 1_024 * 1_024;

interface SnapshotChunk {
    kind: 'terminal.snapshot';
    generation: number;
    nextHostSequence: number;
    chunkIndex: number;
    chunkCount: number;
    chunkHex: string;
}

interface OutputChunk {
    kind: 'terminal.output';
    generation: number;
    hostSequence: number;
    chunkIndex: number;
    chunkCount: number;
    chunkHex: string;
}

type TerminalChunk = SnapshotChunk | OutputChunk;
type StreamResult =
    | { kind: 'pending' }
    | { kind: 'snapshot'; generation: number; snapshot: TerminalSnapshot | null }
    | { kind: 'output'; data: string }
    | { kind: 'resync' };

interface ChunkBuffer {
    chunkCount: number;
    chunks: Uint8Array[];
    length: number;
    sequence: number;
}

const appendChunk = (buffer: ChunkBuffer, chunk: TerminalChunk): Uint8Array | null => {
    if (chunk.chunkCount !== buffer.chunkCount || chunk.chunkIndex !== buffer.chunks.length)
        throw new Error('Terminal stream chunks changed order');
    const bytes = decodeHex(chunk.chunkHex);
    buffer.length += bytes.byteLength;
    if (buffer.length > MAXIMUM_ASSEMBLED_BYTES)
        throw new Error('Terminal stream exceeded its limit');
    buffer.chunks.push(bytes);
    if (buffer.chunks.length < buffer.chunkCount) return null;
    const assembled = new Uint8Array(buffer.length);
    let offset = 0;
    for (const part of buffer.chunks) {
        assembled.set(part, offset);
        offset += part.byteLength;
    }
    return assembled;
};

/**
 * Reconstructs a snapshot and its exact Host output suffix without persisting Terminal contents.
 */
export const createTerminalStreamAssembly = (terminalId: string) => {
    let generation: number | null = null;
    let nextHostSequence: number | null = null;
    let pending: ChunkBuffer | null = null;
    let isInvalid = false;
    const resync = (): StreamResult => {
        isInvalid = true;
        pending = null;
        return { kind: 'resync' };
    };
    return {
        invalidate: (): void => {
            isInvalid = true;
            pending = null;
        },
        receive: (chunk: TerminalChunk): StreamResult => {
            if (isInvalid) return { kind: 'resync' };
            try {
                if (
                    chunk.chunkCount < 1 ||
                    chunk.chunkIndex < 0 ||
                    chunk.chunkIndex >= chunk.chunkCount
                )
                    return resync();
                if (generation !== null && chunk.generation !== generation) return resync();
                if (chunk.kind === 'terminal.snapshot') {
                    if (
                        nextHostSequence !== null ||
                        (pending && pending.sequence !== chunk.nextHostSequence)
                    )
                        return resync();
                    if (chunk.chunkIndex === 0) {
                        if (pending) return resync();
                        generation = chunk.generation;
                        pending = {
                            chunkCount: chunk.chunkCount,
                            chunks: [],
                            length: 0,
                            sequence: chunk.nextHostSequence,
                        };
                    }
                } else {
                    if (nextHostSequence === null || chunk.hostSequence !== nextHostSequence)
                        return resync();
                    if (chunk.chunkIndex === 0) {
                        if (pending) return resync();
                        pending = {
                            chunkCount: chunk.chunkCount,
                            chunks: [],
                            length: 0,
                            sequence: chunk.hostSequence,
                        };
                    } else if (pending?.sequence !== chunk.hostSequence) return resync();
                }
                if (!pending) return resync();
                const assembled = appendChunk(pending, chunk);
                if (!assembled) return { kind: 'pending' };
                pending = null;
                const data = new TextDecoder('utf-8', { fatal: true }).decode(assembled);
                if (chunk.kind === 'terminal.snapshot') {
                    const raw = JSON.parse(data) as unknown;
                    const snapshot = raw === null ? null : terminalSnapshotSchema.parse(raw);
                    if (snapshot && snapshot.terminalId !== terminalId) return resync();
                    nextHostSequence = chunk.nextHostSequence;
                    return { kind: 'snapshot', generation: chunk.generation, snapshot };
                }
                nextHostSequence = chunk.hostSequence + 1;
                return { kind: 'output', data };
            } catch {
                return resync();
            }
        },
    };
};

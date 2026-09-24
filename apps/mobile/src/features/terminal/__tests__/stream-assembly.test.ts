import { encodeHex } from '@caxri/mobile-transport';
import { describe, expect, it } from 'vitest';

import { createTerminalStreamAssembly } from '../stream-assembly';

const hex = (value: string): string => encodeHex(new TextEncoder().encode(value));
const snapshot = {
    terminalId: 'terminal-1',
    encodingVersion: 1,
    cols: 80,
    rows: 24,
    lineCount: 1,
    byteCount: 2,
    payload: 'hi',
    updatedAt: 1,
};

describe('mobile Terminal stream assembly', () => {
    it('assembles a split UTF-8 snapshot before delivering matching output', () => {
        const state = createTerminalStreamAssembly('terminal-1');
        const source = new TextEncoder().encode(JSON.stringify(snapshot));
        const midpoint = source.length - 1;
        const firstHex = encodeHex(source.subarray(0, midpoint));
        const secondHex = encodeHex(source.subarray(midpoint));
        expect(
            state.receive({
                kind: 'terminal.snapshot',
                generation: 7,
                nextHostSequence: 31,
                chunkIndex: 0,
                chunkCount: 2,
                chunkHex: firstHex,
            }),
        ).toEqual({ kind: 'pending' });
        expect(
            state.receive({
                kind: 'terminal.snapshot',
                generation: 7,
                nextHostSequence: 31,
                chunkIndex: 1,
                chunkCount: 2,
                chunkHex: secondHex,
            }),
        ).toEqual({ kind: 'snapshot', generation: 7, snapshot });
        expect(
            state.receive({
                kind: 'terminal.output',
                generation: 7,
                hostSequence: 31,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: hex('\u{1B}[31mred✓'),
            }),
        ).toEqual({ kind: 'output', data: '\u{1B}[31mred✓' });
    });

    it('requests a fresh subscription after a lost Host event or generation change', () => {
        const state = createTerminalStreamAssembly('terminal-1');
        const snapshotHex = hex(JSON.stringify(snapshot));
        expect(
            state.receive({
                kind: 'terminal.snapshot',
                generation: 7,
                nextHostSequence: 31,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: snapshotHex,
            }),
        ).toMatchObject({ kind: 'snapshot' });
        expect(
            state.receive({
                kind: 'terminal.output',
                generation: 7,
                hostSequence: 32,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: hex('lost event'),
            }),
        ).toEqual({ kind: 'resync' });
        expect(
            state.receive({
                kind: 'terminal.output',
                generation: 8,
                hostSequence: 31,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: hex('old screen'),
            }),
        ).toEqual({ kind: 'resync' });
    });

    it('rejects out-of-order chunks and a snapshot for another Terminal', () => {
        const state = createTerminalStreamAssembly('terminal-1');
        const otherSnapshotHex = hex(JSON.stringify({ ...snapshot, terminalId: 'other' }));
        expect(
            state.receive({
                kind: 'terminal.snapshot',
                generation: 7,
                nextHostSequence: 31,
                chunkIndex: 1,
                chunkCount: 2,
                chunkHex: hex('part'),
            }),
        ).toEqual({ kind: 'resync' });
        expect(
            state.receive({
                kind: 'terminal.snapshot',
                generation: 7,
                nextHostSequence: 31,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: otherSnapshotHex,
            }),
        ).toEqual({ kind: 'resync' });
    });

    it('ignores output from a subscription after resync was requested', () => {
        const state = createTerminalStreamAssembly('terminal-1');
        state.invalidate();
        expect(
            state.receive({
                kind: 'terminal.output',
                generation: 7,
                hostSequence: 1,
                chunkIndex: 0,
                chunkCount: 1,
                chunkHex: hex('late output'),
            }),
        ).toEqual({ kind: 'resync' });
    });
});

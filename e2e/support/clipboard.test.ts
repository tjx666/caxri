import { describe, expect, it, vi } from 'vitest';

import type { ClipboardNativeAdapter } from './clipboard.ts';
import { snapshotClipboard } from './clipboard.ts';

const PRIVATE_PAYLOAD = 'private clipboard snapshot payload';

function nativeAdapter(overrides: Partial<ClipboardNativeAdapter> = {}): ClipboardNativeAdapter {
    return {
        claimImage: vi.fn().mockResolvedValue(11),
        claimText: vi.fn().mockResolvedValue(11),
        matchesFixture: vi.fn().mockResolvedValue(true),
        matchesSnapshot: vi.fn().mockResolvedValue(true),
        restore: vi.fn().mockResolvedValue({ generation: 12, status: 'restored' }),
        snapshot: vi.fn().mockResolvedValue({
            formatCount: 3,
            generation: 10,
            itemCount: 2,
            payload: PRIVATE_PAYLOAD,
        }),
        writeFixture: vi.fn().mockResolvedValue({
            formatCount: 3,
            generation: 11,
            itemCount: 2,
        }),
        ...overrides,
    };
}

describe('E2E clipboard ownership session', () => {
    it('preserves an external write whose generation replaced the last test-owned generation', async () => {
        let generation = 11;
        let nativeWrites = 0;
        const adapter = nativeAdapter({
            matchesSnapshot: vi.fn().mockResolvedValue(true),
            restore: vi.fn((_payload, expectedGeneration) => {
                if (generation !== expectedGeneration) {
                    return Promise.resolve({
                        generation,
                        status: 'skipped-external-write' as const,
                    });
                }
                nativeWrites += 1;
                generation += 1;
                return Promise.resolve({ generation, status: 'restored' as const });
            }),
        });
        const session = await snapshotClipboard(adapter);
        await session.claimText('TEST_OWNED_TEXT');
        generation = 12;

        await expect(session.restore()).resolves.toMatchObject({
            status: 'skipped-external-write',
        });
        expect(nativeWrites).toBe(0);
    });

    it('serializes concurrent close paths into one native restore', async () => {
        const adapter = nativeAdapter();
        const session = await snapshotClipboard(adapter);
        session.claimGeneration(11);

        const outcomes = await Promise.all([session.restore(), session.restore()]);

        expect(outcomes).toEqual([
            { generation: 12, status: 'restored' },
            { generation: 12, status: 'restored' },
        ]);
        expect(adapter.restore).toHaveBeenCalledOnce();
    });

    it('replaces native failures with a content-free error', async () => {
        const adapter = nativeAdapter({
            restore: vi.fn().mockRejectedValue(new Error(PRIVATE_PAYLOAD)),
        });
        const session = await snapshotClipboard(adapter);

        let failure: unknown;
        try {
            await session.restore();
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe('Could not restore the E2E clipboard');
        expect((failure as Error).message.includes(PRIVATE_PAYLOAD)).toBe(false);
    });
});

import { describe, expect, it, vi } from 'vitest';

import { readTreeChildren } from '../tree-children-read';

const item = (handle: string) => ({
    collapsibleState: 'none' as const,
    handle,
    label: handle,
});
const root = { items: [item('repository'), item('check')] };
const children = { items: [item('job')] };

describe('readTreeChildren', () => {
    it('returns an ordinary level unchanged', async () => {
        const onRootSnapshot = vi.fn();
        await expect(
            readTreeChildren({
                onRootSnapshot,
                parentHandle: 'check',
                read: () => Promise.resolve(children),
            }),
        ).resolves.toEqual(children);
        expect(onRootSnapshot).not.toHaveBeenCalled();
    });

    it('never returns a reset root snapshot as a branch’s children', async () => {
        const onRootSnapshot = vi.fn();
        const read = vi
            .fn()
            .mockResolvedValueOnce({ ...root, reset: true })
            .mockResolvedValueOnce(children);
        await expect(
            readTreeChildren({ onRootSnapshot, parentHandle: 'check', read }),
        ).resolves.toEqual(children);
        expect(onRootSnapshot).toHaveBeenCalledWith(root);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('fails the branch when the tree resets again', async () => {
        const onRootSnapshot = vi.fn();
        const read = vi.fn().mockResolvedValue({ ...root, reset: true });
        await expect(
            readTreeChildren({ onRootSnapshot, parentHandle: 'check', read }),
        ).rejects.toThrow();
        expect(onRootSnapshot).toHaveBeenCalledTimes(2);
    });

    it('accepts a reset at the root level as the root', async () => {
        const onRootSnapshot = vi.fn();
        await expect(
            readTreeChildren({
                onRootSnapshot,
                read: () => Promise.resolve({ ...root, reset: true as const }),
            }),
        ).resolves.toEqual(root);
        expect(onRootSnapshot).not.toHaveBeenCalled();
    });
});

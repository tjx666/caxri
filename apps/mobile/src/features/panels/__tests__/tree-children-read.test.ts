import { describe, expect, it, vi } from 'vitest';

import { readTreeChildren } from '../tree-children-read';

const item = (handle: string) => ({
    collapsibleState: 'none' as const,
    handle,
    label: handle,
});
const root = { items: [item('repository'), item('check')] };
const children = { items: [item('job')] };

/**
 * Mirrors the Extension Host's handle bookkeeping for the Status panel (`repository` > `deployments` > `deployment`):
 * reading a level registers its rows and retires every handle below it, and a branch read for an unknown handle comes
 * back as the root level with `reset`, as `requestTreeChildren` answers on the Server.
 */
const statusTreeHost = () => {
    const tree: Record<string, string[]> = {
        '': ['repository'],
        'repository': ['main', 'deployments'],
        'deployments': ['deployment'],
    };
    const known = new Set<string>();
    const readLevel = (parent: string) => {
        const retire = (handle: string): void => {
            const handleChildren = tree[handle] ?? [];
            for (const child of handleChildren) {
                known.delete(child);
                retire(child);
            }
        };
        retire(parent);
        const parentChildren = tree[parent] ?? [];
        for (const child of parentChildren) known.add(child);
        return { items: parentChildren.map(item) };
    };
    return {
        read: vi.fn((parentHandle: string | undefined) => {
            if (parentHandle === undefined || known.has(parentHandle))
                return Promise.resolve(readLevel(parentHandle ?? ''));
            return Promise.resolve({ ...readLevel(''), reset: true as const });
        }),
        readLevel,
    };
};

describe('readTreeChildren', () => {
    it('returns an ordinary level unchanged', async () => {
        const onLevelSnapshot = vi.fn();
        await expect(
            readTreeChildren({
                onLevelSnapshot,
                parentHandle: 'check',
                read: () => Promise.resolve(children),
            }),
        ).resolves.toEqual(children);
        expect(onLevelSnapshot).not.toHaveBeenCalled();
    });

    it('never returns a reset root snapshot as a branch’s children', async () => {
        const onLevelSnapshot = vi.fn();
        const read = vi
            .fn()
            .mockResolvedValueOnce({ ...root, reset: true })
            .mockResolvedValueOnce(children);
        await expect(
            readTreeChildren({ onLevelSnapshot, parentHandle: 'check', read }),
        ).resolves.toEqual(children);
        expect(onLevelSnapshot).toHaveBeenCalledWith(undefined, root);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('re-reads the ancestor levels before retrying a nested branch after a root refresh', async () => {
        const host = statusTreeHost();
        host.readLevel('');
        host.readLevel('repository');
        // Another client's refresh re-read the root, retiring `deployments`.
        host.readLevel('');
        const onLevelSnapshot = vi.fn();

        await expect(
            readTreeChildren({
                ancestorHandles: ['repository'],
                onLevelSnapshot,
                parentHandle: 'deployments',
                read: host.read,
            }),
        ).resolves.toEqual({ items: [item('deployment')] });
        expect(host.read.mock.calls.map(([handle]) => handle)).toEqual([
            'deployments',
            'repository',
            'deployments',
        ]);
        expect(onLevelSnapshot).toHaveBeenCalledWith(undefined, { items: [item('repository')] });
        expect(onLevelSnapshot).toHaveBeenCalledWith('repository', {
            items: [item('main'), item('deployments')],
        });
    });

    it('fails the branch when the tree resets again', async () => {
        const onLevelSnapshot = vi.fn();
        const read = vi.fn().mockResolvedValue({ ...root, reset: true });
        await expect(
            readTreeChildren({ onLevelSnapshot, parentHandle: 'check', read }),
        ).rejects.toThrow();
        expect(onLevelSnapshot).toHaveBeenCalledTimes(2);
    });

    it('fails the branch when an ancestor is gone after the refresh', async () => {
        const onLevelSnapshot = vi.fn();
        const read = vi.fn().mockResolvedValue({ ...root, reset: true });
        await expect(
            readTreeChildren({
                ancestorHandles: ['repository'],
                onLevelSnapshot,
                parentHandle: 'deployments',
                read,
            }),
        ).rejects.toThrow();
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('accepts a reset at the root level as the root', async () => {
        const onLevelSnapshot = vi.fn();
        await expect(
            readTreeChildren({
                onLevelSnapshot,
                read: () => Promise.resolve({ ...root, reset: true as const }),
            }),
        ).resolves.toEqual(root);
        expect(onLevelSnapshot).not.toHaveBeenCalled();
    });
});

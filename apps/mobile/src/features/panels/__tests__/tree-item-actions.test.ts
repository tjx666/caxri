import { describe, expect, it, vi } from 'vitest';

import { runTreeAction, treeActionTint } from '../tree-item-actions';

const t = ((key: string, values?: Record<string, unknown>) =>
    `${key}${values ? JSON.stringify(values) : ''}`) as never;

const dependencies = () => ({
    execute: vi.fn(() => Promise.resolve({ executed: true as const })),
    notify: vi.fn(),
    openLink: vi.fn(() => Promise.resolve()),
    t,
});

const merge = {
    command: {
        id: 'caxri.project-status.mergePullRequest',
        title: 'Merge Pull Request',
        arguments: [{ repositoryId: 'repo-1', number: 42, headSha: 'a'.repeat(40) }],
    },
    feedback: { success: 'Merged #42', failure: "Couldn't merge #42" },
};

describe('runTreeAction', () => {
    it('runs an extension command and prefers its own result message', async () => {
        const dependencies_ = dependencies();
        dependencies_.execute.mockResolvedValueOnce({
            executed: true,
            message: 'Squash-merged #42',
        } as never);
        await runTreeAction(merge, dependencies_);
        expect(dependencies_.execute).toHaveBeenCalledWith(
            merge.command.id,
            merge.command.arguments,
        );
        expect(dependencies_.notify).toHaveBeenCalledWith('success', 'Squash-merged #42');
    });

    it('falls back to the declared success copy', async () => {
        const dependencies_ = dependencies();
        await runTreeAction(merge, dependencies_);
        expect(dependencies_.notify).toHaveBeenCalledWith('success', 'Merged #42');
    });

    it("leads a failure with the provider's prefix and keeps GitHub's reason", async () => {
        const dependencies_ = dependencies();
        dependencies_.execute.mockRejectedValueOnce(new Error('Head branch was modified'));
        await runTreeAction(merge, dependencies_);
        expect(dependencies_.notify).toHaveBeenCalledWith(
            'error',
            "Couldn't merge #42",
            'Head branch was modified',
        );
    });

    it('opens an external link on the phone without a Server round trip', async () => {
        const dependencies_ = dependencies();
        await runTreeAction(
            {
                command: {
                    id: 'caxri.openExternal',
                    title: 'Open',
                    arguments: ['https://github.com/o/r/pull/1'],
                },
            },
            dependencies_,
        );
        expect(dependencies_.openLink).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
        expect(dependencies_.execute).not.toHaveBeenCalled();
    });

    it('reports a link action that names no URL', async () => {
        const dependencies_ = dependencies();
        await runTreeAction(
            { command: { id: 'caxri.openExternal', title: 'Open' } },
            dependencies_,
        );
        expect(dependencies_.notify).toHaveBeenCalledWith(
            'error',
            'panels.treeActionFailed{"title":"Open"}',
        );
    });
});

describe('treeActionTint', () => {
    const theme = { danger: 'red', muted: 'gray', success: 'green', warning: 'amber' };
    it("maps Desktop's tones and keeps an untoned action muted", () => {
        expect(treeActionTint('success', theme)).toBe('green');
        expect(treeActionTint('danger', theme)).toBe('red');
        expect(treeActionTint(undefined, theme)).toBe('gray');
    });
});

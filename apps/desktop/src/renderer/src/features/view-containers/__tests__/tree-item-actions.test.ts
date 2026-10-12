import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getToasts } from '../../../stores/toasts';
import type { TreeItemAction } from '../tree-item-actions';
import {
    runTreeItemAction,
    runTreeItemCommand,
    treeItemActionKeyIntent,
} from '../tree-item-actions';

const mocks = vi.hoisted(() => ({
    dispatch: vi.fn(() => Promise.resolve('executed' as const)),
    openExternalUrl: vi.fn(() => Promise.resolve()),
    sendPromptToSessionAgent: vi.fn<(prompt: string) => Promise<string>>(),
    showConfirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { window: { showConfirm: mocks.showConfirm } } }));
vi.mock('../../../lib/external-link', () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock('../view-container-commands', () => ({
    actionFailureMessage: (error: Error, label: string) => `${label}: ${error.message}`,
    dispatchExtensionViewAction: mocks.dispatch,
}));
vi.mock('../../terminal/agent-prompt-commands', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    sendPromptToSessionAgent: mocks.sendPromptToSessionAgent,
}));

const action: TreeItemAction = {
    command: {
        id: 'caxri.project-status.mergePullRequest',
        title: 'Merge Pull Request',
        arguments: [{ number: 42 }],
    },
    icon: { kind: 'theme', id: 'git-merge' },
};

describe('runTreeItemCommand', () => {
    beforeEach(() => {
        mocks.dispatch.mockClear();
        mocks.openExternalUrl.mockClear();
    });

    it("opens a link row's page without dispatching to the extension", async () => {
        await runTreeItemCommand({
            id: 'caxri.openExternal',
            title: 'Open Pull Request',
            arguments: ['https://github.com/acme/widget/pull/42'],
        });

        expect(mocks.dispatch).not.toHaveBeenCalled();
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(
            'https://github.com/acme/widget/pull/42',
            expect.any(Function),
        );
    });

    it('reports a link command without a URL', async () => {
        await runTreeItemCommand({ id: 'caxri.openExternal', title: 'Open Pull Request' });

        expect(mocks.openExternalUrl).not.toHaveBeenCalled();
        expect(getToasts().at(-1)).toMatchObject({
            type: 'error',
            title: 'Unable to run Open Pull Request. The link is missing.',
        });
    });
});

describe('runTreeItemCommand caxri.sendToAgent', () => {
    const sendCommand = (prompt: unknown) => ({
        id: 'caxri.sendToAgent',
        title: 'Send Comments to Agent',
        arguments: [prompt],
    });

    beforeEach(() => {
        mocks.dispatch.mockClear();
        mocks.sendPromptToSessionAgent.mockReset();
    });

    it("sends the cleaned prompt to the Session's Agent without dispatching to the extension", async () => {
        mocks.sendPromptToSessionAgent.mockResolvedValueOnce('Claude Code');

        await runTreeItemCommand(sendCommand('Fix\r\nthis\u{1B}'));

        expect(mocks.dispatch).not.toHaveBeenCalled();
        expect(mocks.sendPromptToSessionAgent).toHaveBeenCalledWith('Fix\nthis');
        expect(getToasts().at(-1)).toMatchObject({ type: 'success', title: 'Sent to Claude Code' });
    });

    it("prefixes a failed send with the action's failure copy", async () => {
        mocks.sendPromptToSessionAgent.mockRejectedValueOnce(
            new Error('Start an Agent in this Session first'),
        );

        await runTreeItemCommand(sendCommand('Fix'), { failure: "Couldn't send the comments" });

        expect(getToasts().at(-1)).toMatchObject({
            type: 'error',
            title: "Couldn't send the comments: Start an Agent in this Session first",
        });
    });

    it('reports a missing prompt without sending anything', async () => {
        await runTreeItemCommand(sendCommand(42));

        expect(mocks.sendPromptToSessionAgent).not.toHaveBeenCalled();
        expect(getToasts().at(-1)).toMatchObject({
            type: 'error',
            title: 'Unable to run Send Comments to Agent. The prompt is missing.',
        });
    });
});

describe('runTreeItemAction', () => {
    beforeEach(() => {
        mocks.dispatch.mockClear();
        mocks.showConfirm.mockReset();
    });

    it('dispatches an unconfirmed action straight away', async () => {
        await runTreeItemAction(action);

        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(mocks.dispatch).toHaveBeenCalledWith(
            'caxri.project-status.mergePullRequest',
            'Merge Pull Request',
            [{ number: 42 }],
            undefined,
        );
    });

    it('opens the page itself for caxri.openExternal after the explanation is confirmed', async () => {
        mocks.showConfirm.mockResolvedValueOnce(true);
        await runTreeItemAction({
            command: {
                id: 'caxri.openExternal',
                title: 'Merge Pull Request',
                arguments: ['https://github.com/acme/widget/pull/42'],
            },
            icon: { kind: 'theme', id: 'git-merge' },
            confirmation: {
                title: 'Pull request #42 has conflicts',
                message: 'Resolve them on GitHub.',
                confirmLabel: 'Open on GitHub',
            },
        });

        expect(mocks.dispatch).not.toHaveBeenCalled();
        expect(mocks.openExternalUrl).toHaveBeenCalledWith(
            'https://github.com/acme/widget/pull/42',
            expect.any(Function),
        );
    });

    it('asks first and dispatches nothing when the user cancels', async () => {
        const confirmation = {
            title: 'Merge pull request #42?',
            message: 'Checks are still running.',
            confirmLabel: 'Merge',
        };
        mocks.showConfirm.mockResolvedValueOnce(false);
        await runTreeItemAction({ ...action, confirmation });

        expect(mocks.showConfirm).toHaveBeenCalledWith(confirmation);
        expect(mocks.dispatch).not.toHaveBeenCalled();

        mocks.showConfirm.mockResolvedValueOnce(true);
        await runTreeItemAction({ ...action, confirmation });
        expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('treeItemActionKeyIntent', () => {
    it('walks the actions with Left and Right without wrapping', () => {
        expect(treeItemActionKeyIntent('ArrowRight', 0, 3)).toEqual({ kind: 'focus', index: 1 });
        expect(treeItemActionKeyIntent('ArrowLeft', 2, 3)).toEqual({ kind: 'focus', index: 1 });
        expect(treeItemActionKeyIntent('ArrowRight', 2, 3)).toEqual({ kind: 'none' });
    });

    it('returns to the row on Left from the first action and on Escape', () => {
        expect(treeItemActionKeyIntent('ArrowLeft', 0, 2)).toEqual({ kind: 'row' });
        expect(treeItemActionKeyIntent('Escape', 1, 2)).toEqual({ kind: 'row' });
    });

    it('leaves Enter and Space to the button and other keys to the row', () => {
        expect(treeItemActionKeyIntent('Enter', 0, 1)).toEqual({ kind: 'native' });
        expect(treeItemActionKeyIntent(' ', 0, 1)).toEqual({ kind: 'native' });
        expect(treeItemActionKeyIntent('ArrowDown', 0, 1)).toBeUndefined();
        expect(treeItemActionKeyIntent('Tab', 0, 1)).toBeUndefined();
    });
});

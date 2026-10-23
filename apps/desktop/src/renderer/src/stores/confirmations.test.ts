import { beforeEach, describe, expect, it } from 'vitest';

import {
    confirmationLabels,
    resolveConfirm,
    setDontAskAgain,
    showConfirm,
    showConfirmChoice,
    useConfirmationStore,
} from './confirmations';

const request = { message: 'Terminals switch to WebGL.', title: 'Turn on GPU acceleration?' };

describe('confirmation store', () => {
    beforeEach(() => {
        useConfirmationStore.setState({ request: undefined, resolve: undefined });
    });

    it('publishes the request so the mounted dialog can render it', () => {
        void showConfirm(request);

        expect(useConfirmationStore.getState().request).toEqual(request);
    });

    it('resolves true for the confirming action and clears the request', async () => {
        const answer = showConfirm(request);

        resolveConfirm(true);

        await expect(answer).resolves.toBe(true);
        expect(useConfirmationStore.getState().request).toBeUndefined();
    });

    it('resolves false for a dismissal', async () => {
        const answer = showConfirm(request);

        resolveConfirm(false);

        await expect(answer).resolves.toBe(false);
    });

    it('ignores an answer once the question is already settled', async () => {
        const answer = showConfirm(request);
        resolveConfirm(true);

        resolveConfirm(false);

        await expect(answer).resolves.toBe(true);
    });

    it('answers a stale question so a second request never leaves a promise dangling', async () => {
        const first = showConfirm(request);
        const second = showConfirm({ ...request, title: 'Second question?' });

        await expect(first).resolves.toBe(false);
        expect(useConfirmationStore.getState().request?.title).toBe('Second question?');

        resolveConfirm(true);
        await expect(second).resolves.toBe(true);
    });

    it('reports "Don\'t ask again" only when the user confirms with it ticked', async () => {
        const offered = { ...request, dontAskAgainLabel: "Don't ask again" };
        const confirmed = showConfirmChoice(offered);
        setDontAskAgain(true);
        resolveConfirm(true);
        await expect(confirmed).resolves.toEqual({ isConfirmed: true, dontAskAgain: true });

        const dismissed = showConfirmChoice(offered);
        expect(useConfirmationStore.getState().isDontAskAgainChecked).toBe(false);
        setDontAskAgain(true);
        resolveConfirm(false);
        await expect(dismissed).resolves.toEqual({ isConfirmed: false, dontAskAgain: false });
    });

    it('ignores the checkbox for a request that never offered it', async () => {
        const answer = showConfirmChoice(request);
        setDontAskAgain(true);
        resolveConfirm(true);
        await expect(answer).resolves.toEqual({ isConfirmed: true, dontAskAgain: false });
    });

    it('falls back to the shared button labels when the request omits them', () => {
        expect(confirmationLabels(request)).toEqual({ cancel: 'Cancel', confirm: 'OK' });
    });

    it('keeps the caller labels when the request names them', () => {
        expect(
            confirmationLabels({ ...request, cancelLabel: 'Not Now', confirmLabel: 'Turn On' }),
        ).toEqual({ cancel: 'Not Now', confirm: 'Turn On' });
    });
});

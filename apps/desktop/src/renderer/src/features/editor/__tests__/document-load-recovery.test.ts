import { CaxriError, externalEditorTabPath } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '../../../i18n';

const mocks = vi.hoisted(() => ({
    openExternalDocumentWithDefaultApp: vi.fn(() => Promise.resolve()),
    openFileWithDefaultApp: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../../lib/desktop-file-actions', () => mocks);

import { useEnvironmentStore } from '../../../stores/environment';
import { documentLoadRecoveryAction, documentReadRecovery } from '../document-load-recovery';

beforeEach(() => {
    useEnvironmentStore.setState({ state: { kind: 'local' } });
    mocks.openExternalDocumentWithDefaultApp.mockClear();
    mocks.openFileWithDefaultApp.mockClear();
});

describe('documentReadRecovery', () => {
    it('offers the default app for a file over a size ceiling, which no retry can open', () => {
        expect(
            documentReadRecovery(
                new CaxriError('CAPACITY', 'File exceeds the 2.0 MB safety limit'),
            ),
        ).toBe('openWithDefaultApp');
    });

    it('keeps Retry for failures that can go away', () => {
        expect(documentReadRecovery(new CaxriError('NOT_FOUND', 'File not found'))).toBe('retry');
        expect(documentReadRecovery(new CaxriError('IO', 'EBUSY'))).toBe('retry');
        expect(documentReadRecovery(new Error('boom'))).toBe('retry');
    });
});

describe('documentLoadRecoveryAction', () => {
    it('runs the retry for a retryable failure', () => {
        const retry = vi.fn();
        const action = documentLoadRecoveryAction('retry', '/project/a.txt', retry, translate);
        action.onAction();
        expect(action.actionLabel).toBe('Retry');
        expect(retry).toHaveBeenCalledOnce();
    });

    it('opens a Project file by path and an external document by its opaque ID', () => {
        const retry = vi.fn();
        documentLoadRecoveryAction(
            'openWithDefaultApp',
            '/project/big.log',
            retry,
            translate,
        ).onAction();
        expect(mocks.openFileWithDefaultApp).toHaveBeenCalledWith('/project/big.log');
        const external = documentLoadRecoveryAction(
            'openWithDefaultApp',
            externalEditorTabPath('doc-1', 'big.log'),
            retry,
            translate,
        );
        external.onAction();
        expect(external.actionLabel).toBe('Open with Default App');
        expect(mocks.openExternalDocumentWithDefaultApp).toHaveBeenCalledWith('doc-1');
        expect(retry).not.toHaveBeenCalled();
    });

    it('falls back to Retry in an SSH Host window, which cannot open the file on this Mac', () => {
        const retry = vi.fn();
        const action = documentLoadRecoveryAction(
            'openWithDefaultApp',
            '/project/big.log',
            retry,
            translate,
            false,
        );
        action.onAction();
        expect(action.actionLabel).toBe('Retry');
        expect(retry).toHaveBeenCalledOnce();
        expect(mocks.openFileWithDefaultApp).not.toHaveBeenCalled();
    });
});

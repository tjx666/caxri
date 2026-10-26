import { describe, expect, it, vi } from 'vitest';

const requestMock = vi.hoisted(() => vi.fn());

vi.mock('./caxri', () => ({
    caxri: { request: requestMock },
}));

const { externalOpenRejectionMessage, openExternalUrl } = await import('./external-link');

describe('externalOpenRejectionMessage', () => {
    it('describes an unsupported protocol', () => {
        expect(externalOpenRejectionMessage('unsupported_protocol')).toBe(
            'Only HTTP and HTTPS links can be opened',
        );
    });

    it('describes embedded credentials', () => {
        expect(externalOpenRejectionMessage('credentials_not_allowed')).toBe(
            'External links cannot include credentials',
        );
    });

    it('falls back to a generic message for an invalid URL', () => {
        expect(externalOpenRejectionMessage('invalid_url')).toBe('External link is invalid');
    });
});

describe('openExternalUrl', () => {
    it('does not call onError when the URL opens', async () => {
        requestMock.mockResolvedValueOnce({ status: 'opened' });
        const onError = vi.fn();

        await openExternalUrl('https://example.com', onError);

        expect(requestMock).toHaveBeenCalledWith('external.open', { url: 'https://example.com' });
        expect(onError).not.toHaveBeenCalled();
    });

    it('does not call onError when the prompt is canceled', async () => {
        requestMock.mockResolvedValueOnce({ status: 'canceled' });
        const onError = vi.fn();

        await openExternalUrl('https://example.com', onError);

        expect(onError).not.toHaveBeenCalled();
    });

    it('reports the mapped message when the request is rejected', async () => {
        requestMock.mockResolvedValueOnce({
            status: 'rejected',
            reason: 'unsupported_protocol',
        });
        const onError = vi.fn();

        await openExternalUrl('ftp://example.com', onError);

        expect(onError).toHaveBeenCalledWith('Only HTTP and HTTPS links can be opened');
    });

    it('reports a fallback message when the request throws', async () => {
        requestMock.mockRejectedValueOnce(new Error('boom'));
        const onError = vi.fn();

        await openExternalUrl('https://example.com', onError);

        expect(onError).toHaveBeenCalledWith('External link could not be opened. boom.');
    });
});

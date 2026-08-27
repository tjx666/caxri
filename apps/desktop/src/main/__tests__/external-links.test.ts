import { describe, expect, it, vi } from 'vitest';

import type { ExternalOpenDecision } from '../external-links';
import { openExternalUrl } from '../external-links';

function dependencies(decision: ExternalOpenDecision = 'open_once') {
    return {
        getTrustedDomains: vi.fn(() => Promise.resolve([] as string[])),
        open: vi.fn(() => Promise.resolve()),
        prompt: vi.fn(() => Promise.resolve(decision)),
        trust: vi.fn(() => Promise.resolve()),
    };
}

const ALLOW_TRUST = { allowTrust: true } as const;

describe('openExternalUrl', () => {
    it.each([
        ['not a URL', 'invalid_url'],
        ['file:///tmp/private', 'unsupported_protocol'],
        ['javascript:alert(1)', 'unsupported_protocol'],
        ['https://user:secret@example.com', 'credentials_not_allowed'],
    ] as const)('rejects %s before confirmation or OS dispatch', async (url, reason) => {
        const target = dependencies();

        await expect(openExternalUrl(url, target, ALLOW_TRUST)).resolves.toEqual({
            status: 'rejected',
            reason,
        });
        expect(target.getTrustedDomains).not.toHaveBeenCalled();
        expect(target.prompt).not.toHaveBeenCalled();
        expect(target.open).not.toHaveBeenCalled();
    });

    it('returns canceled without dispatching the URL', async () => {
        const target = dependencies('cancel');

        await expect(
            openExternalUrl('https://example.com/path', target, ALLOW_TRUST),
        ).resolves.toEqual({
            status: 'canceled',
        });
        expect(target.prompt).toHaveBeenCalledOnce();
        expect(target.trust).not.toHaveBeenCalled();
        expect(target.open).not.toHaveBeenCalled();
    });

    it('normalizes and dispatches a confirmed HTTP(S) URL exactly once', async () => {
        const target = dependencies();

        await expect(
            openExternalUrl('https://example.com/a b', target, ALLOW_TRUST),
        ).resolves.toEqual({
            status: 'opened',
        });
        expect(target.prompt).toHaveBeenCalledWith(new URL('https://example.com/a%20b'));
        expect(target.trust).not.toHaveBeenCalled();
        expect(target.open).toHaveBeenCalledOnce();
        expect(target.open).toHaveBeenCalledWith('https://example.com/a%20b');
    });

    it('opens a trusted origin without prompting again', async () => {
        const target = dependencies();
        target.getTrustedDomains.mockResolvedValueOnce(['https://example.com']);

        await expect(
            openExternalUrl('https://example.com/again', target, ALLOW_TRUST),
        ).resolves.toEqual({
            status: 'opened',
        });
        expect(target.prompt).not.toHaveBeenCalled();
        expect(target.open).toHaveBeenCalledWith('https://example.com/again');
    });

    it('persists the exact origin before opening when the user trusts it', async () => {
        const target = dependencies('trust');

        await expect(
            openExternalUrl('https://example.com/path?q=1', target, ALLOW_TRUST),
        ).resolves.toEqual({
            status: 'opened',
        });
        expect(target.trust).toHaveBeenCalledWith('https://example.com');
        expect(target.trust.mock.invocationCallOrder[0]).toBeLessThan(
            target.open.mock.invocationCallOrder[0],
        );
        expect(target.open).toHaveBeenCalledWith('https://example.com/path?q=1');
    });

    it('does not persist trust when the caller allows only a one-time open', async () => {
        const target = dependencies('trust');

        await expect(
            openExternalUrl('https://example.com/path', target, { allowTrust: false }),
        ).resolves.toEqual({ status: 'canceled' });
        expect(target.trust).not.toHaveBeenCalled();
        expect(target.open).not.toHaveBeenCalled();
    });

    it('opens loopback URLs without a prompt or a persisted rule', async () => {
        const target = dependencies();

        await expect(
            openExternalUrl('http://127.0.0.1:5173', target, ALLOW_TRUST),
        ).resolves.toEqual({
            status: 'opened',
        });
        expect(target.prompt).not.toHaveBeenCalled();
        expect(target.trust).not.toHaveBeenCalled();
    });

    it('does not open when persisting a trusted origin fails', async () => {
        const target = dependencies('trust');
        target.trust.mockRejectedValueOnce(new Error('settings unavailable'));

        await expect(openExternalUrl('https://example.com', target, ALLOW_TRUST)).rejects.toThrow(
            'settings unavailable',
        );
        expect(target.open).not.toHaveBeenCalled();
    });

    it('propagates an OS dispatch failure instead of reporting success', async () => {
        const target = dependencies();
        target.open.mockRejectedValueOnce(new Error('browser unavailable'));

        await expect(openExternalUrl('https://example.com', target, ALLOW_TRUST)).rejects.toThrow(
            'browser unavailable',
        );
    });
});

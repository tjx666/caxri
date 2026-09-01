import { describe, expect, it, vi } from 'vitest';

import { createTerminalOsc52ClipboardWriteFailureDiagnostic } from '../terminal-osc52-clipboard-diagnostics';

const context = {
    documentFocused: true,
    documentVisible: true,
    secureContext: true,
    terminalFocused: true,
    userActivationActive: false,
    userActivationHasBeenActive: true,
};

describe('Terminal OSC 52 clipboard diagnostics', () => {
    it('classifies a denied write without retaining the error or clipboard content', async () => {
        const queryPermission = vi.fn(() => Promise.resolve('granted' as PermissionState));
        const error = new DOMException('private clipboard content', 'NotAllowedError');

        const diagnostic = await createTerminalOsc52ClipboardWriteFailureDiagnostic(
            {
                diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                error,
                terminalId: 'terminal-1',
            },
            { ...context, queryPermission },
        );

        expect(diagnostic).toEqual({
            kind: 'terminal-osc52-clipboard-write-failure',
            diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
            terminalId: 'terminal-1',
            errorCategory: 'not-allowed',
            clipboardWritePermission: 'granted',
            ...context,
        });
        expect(queryPermission).toHaveBeenCalledOnce();
        expect(JSON.stringify(diagnostic)).not.toContain('private clipboard content');
        expect(diagnostic).not.toHaveProperty('error');
    });

    it('keeps permission-query failure and arbitrary rejection values content-free', async () => {
        const diagnostic = await createTerminalOsc52ClipboardWriteFailureDiagnostic(
            {
                diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                error: { message: 'private payload', name: 'NotAllowedError' },
                terminalId: 'terminal-1',
            },
            {
                ...context,
                queryPermission: () => Promise.reject(new Error('private permission failure')),
                userActivationActive: null,
                userActivationHasBeenActive: null,
            },
        );

        expect(diagnostic).toMatchObject({
            errorCategory: 'non-error',
            clipboardWritePermission: 'query-failed',
            userActivationActive: null,
            userActivationHasBeenActive: null,
        });
        expect(JSON.stringify(diagnostic)).not.toMatch(/private|NotAllowedError/u);
    });

    it('distinguishes known DOM exception classes and unavailable permission inspection', async () => {
        await Promise.all(
            (
                [
                    ['AbortError', 'abort'],
                    ['InvalidStateError', 'invalid-state'],
                    ['SecurityError', 'security'],
                    ['UnknownError', 'other-dom-exception'],
                ] as const
            ).map(async ([name, errorCategory]) => {
                await expect(
                    createTerminalOsc52ClipboardWriteFailureDiagnostic(
                        {
                            diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                            error: new DOMException('private', name),
                            terminalId: 'terminal-1',
                        },
                        context,
                    ),
                ).resolves.toMatchObject({
                    errorCategory,
                    clipboardWritePermission: 'unavailable',
                });
            }),
        );

        await expect(
            createTerminalOsc52ClipboardWriteFailureDiagnostic(
                {
                    diagnosticId: '3fcf11c1-19de-4fdd-8d6c-17ce43c70aae',
                    error: new Error('private'),
                    terminalId: 'terminal-1',
                },
                context,
            ),
        ).resolves.toMatchObject({ errorCategory: 'error' });
    });
});

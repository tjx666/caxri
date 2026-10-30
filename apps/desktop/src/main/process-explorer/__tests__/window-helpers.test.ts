import { describe, expect, it } from 'vitest';

import {
    assertTrustedProcessExplorerSender,
    resolveProcessExplorerRendererUrl,
} from '../window-helpers';

describe('Process Explorer window helpers', () => {
    it('resolves development, E2E failure, and packaged entry URLs', () => {
        expect(
            resolveProcessExplorerRendererUrl({
                currentDirectory: '/project/out/main',
                isPackaged: false,
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe('http://localhost:5173/process-explorer.html');
        expect(
            resolveProcessExplorerRendererUrl({
                currentDirectory: '/project/out/main',
                forceRenderError: true,
                isPackaged: false,
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe('http://localhost:5173/process-explorer.html?caxri-test-render-error=1');
        expect(
            resolveProcessExplorerRendererUrl({
                currentDirectory: '/project/out/main',
                isPackaged: false,
                locale: 'zh-CN',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe('http://localhost:5173/process-explorer.html?caxri-locale=zh-CN');
        expect(
            resolveProcessExplorerRendererUrl({
                currentDirectory: '/Applications/Caxri.app/Contents/Resources/app.asar/out/main',
                isPackaged: true,
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/process-explorer.html',
        );
    });

    it('accepts only the current Process Explorer WebContents identity', () => {
        const trusted = {};
        expect(() => assertTrustedProcessExplorerSender(trusted, trusted)).not.toThrow();
        expect(() => assertTrustedProcessExplorerSender(undefined, trusted)).toThrow(
            expect.objectContaining({ code: 'PATH_DENIED' }),
        );
        expect(() => assertTrustedProcessExplorerSender(trusted, {})).toThrow(
            expect.objectContaining({ code: 'PATH_DENIED' }),
        );
    });
});

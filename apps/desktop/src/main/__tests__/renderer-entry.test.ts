import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadRendererEntry } from '../renderer-entry';

describe('renderer entry loading', () => {
    it('keeps packaged renderer entry points inside the application when a development URL leaks in', () => {
        const loadURL = vi.fn();
        const window = { loadURL };
        expect(
            loadRendererEntry(window, {
                currentDirectory: '/Applications/Caxri.app/Contents/Resources/app.asar/out/main',
                isPackaged: true,
                page: 'index.html',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/index.html',
        );
        expect(loadURL).toHaveBeenLastCalledWith(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/index.html',
        );
        expect(
            loadRendererEntry(window, {
                currentDirectory: '/Applications/Caxri.app/Contents/Resources/app.asar/out/main',
                isPackaged: true,
                page: 'process-explorer.html',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/process-explorer.html',
        );
        expect(loadURL).toHaveBeenLastCalledWith(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/process-explorer.html',
        );
        expect(
            loadRendererEntry(window, {
                currentDirectory: '/Applications/Caxri.app/Contents/Resources/app.asar/out/main',
                isPackaged: true,
                page: 'agent-commander.html',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/agent-commander.html',
        );
        expect(loadURL).toHaveBeenLastCalledWith(
            'file:///Applications/Caxri.app/Contents/Resources/app.asar/out/renderer/agent-commander.html',
        );
    });

    it('retains the development renderer origin for every unpackaged window', () => {
        const loadURL = vi.fn();
        const window = { loadURL };
        expect(
            loadRendererEntry(window, {
                currentDirectory: '/project/out/main',
                isPackaged: false,
                page: 'index.html',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe('http://localhost:5173');
        expect(
            loadRendererEntry(window, {
                currentDirectory: '/project/out/main',
                isPackaged: false,
                page: 'process-explorer.html',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe('http://localhost:5173/process-explorer.html');
        expect(
            loadRendererEntry(window, {
                currentDirectory: '/project/out/main',
                isPackaged: false,
                page: 'agent-commander.html',
                rendererUrl: 'http://localhost:5173',
            }),
        ).toBe('http://localhost:5173/agent-commander.html');
        expect(loadURL).toHaveBeenNthCalledWith(1, 'http://localhost:5173');
        expect(loadURL).toHaveBeenNthCalledWith(2, 'http://localhost:5173/process-explorer.html');
        expect(loadURL).toHaveBeenNthCalledWith(3, 'http://localhost:5173/agent-commander.html');
    });

    it('keeps every production window on the shared packaged-origin loading contract', () => {
        const mainSource = readFileSync(
            join(import.meta.dirname, '..', 'workbench-windows', 'window.ts'),
            'utf8',
        );
        const processExplorerSource = readFileSync(
            join(import.meta.dirname, '..', 'process-explorer-window.ts'),
            'utf8',
        );
        const agentCommanderSource = readFileSync(
            join(import.meta.dirname, '..', 'agent-commander-window.ts'),
            'utf8',
        );

        expect(mainSource).toMatch(
            /loadRendererEntry\(window, \{[\s\S]*?isPackaged: app\.isPackaged,[\s\S]*?page: 'index\.html'/,
        );
        expect(processExplorerSource).toMatch(
            /resolveProcessExplorerRendererUrl\(\{\s*\.\.\.this\.options,\s*locale: mainLocale\(\),?\s*\}\)/,
        );
        expect(agentCommanderSource).toMatch(
            /resolveRendererEntryUrl\(\{[\s\S]*?isPackaged: this\.options\.isPackaged,[\s\S]*?page: 'agent-commander\.html'/,
        );
    });
});

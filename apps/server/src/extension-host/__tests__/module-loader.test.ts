import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    extensionApiModuleUrl,
    replaceExtensionModuleRegistrations,
    resolveExtensionImport,
} from '../module-loader';

const apiSymbol = Symbol.for('caxri.extension-api');

interface LoadedExtensionApiModule {
    readonly default: unknown;
    readonly TreeItem: unknown;
}

function isLoadedExtensionApiModule(value: unknown): value is LoadedExtensionApiModule {
    return typeof value === 'object' && value !== null && 'default' in value && 'TreeItem' in value;
}

async function loadExtensionApiModule(url: string): Promise<LoadedExtensionApiModule> {
    const module: unknown = await import(url);
    if (!isLoadedExtensionApiModule(module))
        throw new Error('Extension API module did not expose the expected exports');
    return module;
}

afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[apiSymbol];
});

describe('extensionApiModuleUrl', () => {
    it('keeps one generation identity stable and fences extension and reload identities', async () => {
        class RuntimeTreeItem {}
        const bindings = new Map([
            [
                'first-token-1',
                {
                    api: { id: 'first-generation-1' },
                    runtime: {
                        Disposable: class {},
                        EventEmitter: class {},
                        CancellationTokenSource: class {},
                        ThemeIcon: class {},
                        TreeItem: RuntimeTreeItem,
                        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
                    },
                },
            ],
            [
                'second-token-1',
                {
                    api: { id: 'second-generation-1' },
                    runtime: {
                        Disposable: class {},
                        EventEmitter: class {},
                        CancellationTokenSource: class {},
                        ThemeIcon: class {},
                        TreeItem: class {},
                        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
                    },
                },
            ],
            [
                'first-token-2',
                {
                    api: { id: 'first-generation-2' },
                    runtime: {
                        Disposable: class {},
                        EventEmitter: class {},
                        CancellationTokenSource: class {},
                        ThemeIcon: class {},
                        TreeItem: class {},
                        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
                    },
                },
            ],
        ]);
        Object.defineProperty(globalThis, apiSymbol, {
            configurable: true,
            value: (apiToken: string) => bindings.get(apiToken),
        });
        const firstUrl = extensionApiModuleUrl({
            apiToken: 'first-token-1',
            extensionId: 'publisher.first',
            generation: 1,
            rootPath: '/extensions/first',
        });
        const secondUrl = extensionApiModuleUrl({
            apiToken: 'second-token-1',
            extensionId: 'publisher.second',
            generation: 1,
            rootPath: '/extensions/second',
        });
        const reloadedUrl = extensionApiModuleUrl({
            apiToken: 'first-token-2',
            extensionId: 'publisher.first',
            generation: 2,
            rootPath: '/extensions/first',
        });

        const first = await loadExtensionApiModule(firstUrl);
        const firstAgain = await loadExtensionApiModule(firstUrl);
        const second = await loadExtensionApiModule(secondUrl);
        const reloaded = await loadExtensionApiModule(reloadedUrl);

        expect(first.default).toBe(firstAgain.default);
        expect(first.TreeItem).toBe(RuntimeTreeItem);
        expect(first.default).not.toBe(second.default);
        expect(first.default).not.toBe(reloaded.default);
        expect(new Set([firstUrl, secondUrl, reloadedUrl]).size).toBe(3);
    });

    it('fails closed for unowned API imports and extension-owned Electron imports', () => {
        replaceExtensionModuleRegistrations([
            {
                apiToken: 'first-token-1',
                extensionId: 'publisher.first',
                generation: 1,
                rootPath: '/extensions/first',
            },
        ]);
        const ownedParent = pathToFileURL('/extensions/first/dist/extension.js').href;
        const outsideParent = pathToFileURL('/desktop/main.js').href;

        expect(resolveExtensionImport('caxri', ownedParent)?.url).toContain('publisher.first%3A1');
        expect(() => resolveExtensionImport('caxri', outsideParent)).toThrow(
            expect.objectContaining({ code: 'API_IMPORT_UNOWNED' }),
        );
        for (const specifier of ['electron', 'electron/main'])
            expect(() => resolveExtensionImport(specifier, ownedParent)).toThrow(
                expect.objectContaining({ code: 'ELECTRON_IMPORT_DENIED' }),
            );
        expect(resolveExtensionImport('electron', outsideParent)).toBeUndefined();
        expect(resolveExtensionImport('node:path', ownedParent)).toBeUndefined();
    });
});

import { registerHooks } from 'node:module';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

interface RegisteredExtensionModule {
    apiToken: string;
    extensionId: string;
    generation: number;
    rootPath: string;
}

const registrations = new Map<string, RegisteredExtensionModule>();
const hookState = { isRegistered: false };

function codedError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function isPathOwned(rootPath: string, path: string): boolean {
    const nested = relative(rootPath, path);
    return nested === '' || (!nested.startsWith('..') && !isAbsolute(nested));
}

function ownerForParent(parentUrl: string | undefined): RegisteredExtensionModule | undefined {
    if (!parentUrl?.startsWith('file:')) return undefined;
    let parentPath: string;
    try {
        parentPath = fileURLToPath(parentUrl);
    } catch {
        return undefined;
    }
    return registrations.values().find(({ rootPath }) => isPathOwned(rootPath, parentPath));
}

export function resolveExtensionImport(
    specifier: string,
    parentUrl: string | undefined,
): { shortCircuit: true; url: string } | undefined {
    const isElectronImport = specifier === 'electron' || specifier.startsWith('electron/');
    if (specifier !== 'caxri' && !isElectronImport) return undefined;
    const owner = ownerForParent(parentUrl);
    if (isElectronImport) {
        if (owner)
            throw codedError(
                'ELECTRON_IMPORT_DENIED',
                `Extension ${owner.extensionId} cannot import electron`,
            );
        return undefined;
    }
    if (!owner)
        throw codedError(
            'API_IMPORT_UNOWNED',
            'The caxri API may only be imported by a registered extension module graph',
        );
    return { shortCircuit: true, url: extensionApiModuleUrl(owner) };
}

export function extensionApiModuleUrl(owner: RegisteredExtensionModule): string {
    const source = [
        `const binding = globalThis[Symbol.for('caxri.extension-api')](${JSON.stringify(owner.apiToken)});`,
        'export default binding.api;',
        'export const Disposable = binding.runtime.Disposable;',
        'export const EventEmitter = binding.runtime.EventEmitter;',
        'export const isGlobMatch = binding.runtime.isGlobMatch;',
        'export const l10n = binding.api.l10n;',
        'export const CancellationTokenSource = binding.runtime.CancellationTokenSource;',
        'export const ProjectStatusSummaryErrorMessage = binding.runtime.ProjectStatusSummaryErrorMessage;',
        'export const GitPullRequestErrorMessage = binding.runtime.GitPullRequestErrorMessage;',
        'export const ThemeIcon = binding.runtime.ThemeIcon;',
        'export const TreeItem = binding.runtime.TreeItem;',
        'export const TreeItemCollapsibleState = binding.runtime.TreeItemCollapsibleState;',
    ].join('\n');
    const key = `${owner.extensionId}:${owner.generation}`;
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}#${encodeURIComponent(key)}`;
}

/**
 * Installs the ESM-only API boundary once. Identity is derived from canonical extension roots and `parentURL`; an
 * unowned graph never receives an anonymous API object, and extension-owned Electron imports fail before evaluation.
 */
export function installExtensionModuleHooks(): void {
    if (hookState.isRegistered) return;
    hookState.isRegistered = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            return (
                resolveExtensionImport(specifier, context.parentURL) ??
                nextResolve(specifier, context)
            );
        },
    });
}

export function replaceExtensionModuleRegistrations(
    next: readonly RegisteredExtensionModule[],
): void {
    registrations.clear();
    for (const registration of next) registrations.set(registration.extensionId, registration);
}

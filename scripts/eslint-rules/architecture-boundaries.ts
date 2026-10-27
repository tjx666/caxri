import { isBuiltin } from 'node:module';
import { dirname, posix, relative } from 'node:path';

import type { Rule } from 'eslint';
import type { Node } from 'estree';

import {
    appBoundaries,
    browserUnsafeImports,
    legacyOwnershipRoots,
    netSocketImporters,
    netSocketRoots,
    packageBoundaries,
    transitionalImportAllowances,
} from '../architecture-boundaries';

interface ImportOwner {
    id: string;
    kind: 'application' | 'extension' | 'package' | 'shared';
    root: string;
}

type ServerLayer = 'core' | 'domains' | 'extension-host' | 'observability' | 'terminal-host';

const fixturePrefix = 'scripts/fixtures/eslint/architecture/';
const sourceExtensionPattern = /\.[cm]?[jt]sx?$/u;

function normalizeRepoPath(path: string): string {
    const normalized = path.replaceAll('\\', '/');
    const fixtureIndex = normalized.indexOf(fixturePrefix);
    return fixtureIndex === -1 ? normalized : normalized.slice(fixtureIndex + fixturePrefix.length);
}

function isPathInside(root: string, path: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

function ownerForPath(path: string): ImportOwner | undefined {
    for (const boundary of appBoundaries) {
        if (isPathInside(boundary.root, path)) {
            return { id: boundary.id, kind: 'application', root: boundary.root };
        }
    }
    for (const boundary of packageBoundaries) {
        if (isPathInside(boundary.root, path)) {
            return { id: boundary.id, kind: 'package', root: boundary.root };
        }
    }
    for (const boundary of legacyOwnershipRoots) {
        if (isPathInside(boundary.root, path)) {
            return { id: boundary.owner, kind: boundary.kind, root: boundary.root };
        }
    }
    if (path.startsWith('extensions/')) {
        return { id: 'extension', kind: 'extension', root: path.split('/').slice(0, 2).join('/') };
    }
    return undefined;
}

function ownerForBareSpecifier(specifier: string): ImportOwner | undefined {
    for (const boundary of appBoundaries) {
        for (const packageName of boundary.packageNames) {
            if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
                return { id: boundary.id, kind: 'application', root: boundary.root };
            }
        }
    }
    for (const boundary of packageBoundaries) {
        for (const packageName of boundary.packageNames) {
            if (specifier === packageName || specifier.startsWith(`${packageName}/`)) {
                return { id: boundary.id, kind: 'package', root: boundary.root };
            }
        }
    }
    return undefined;
}

function targetPath(importer: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.')) return undefined;
    return posix
        .normalize(posix.join(dirname(importer), specifier))
        .replace(sourceExtensionPattern, '');
}

function isPackageSubpathPublic(packageId: string, specifier: string): boolean {
    const boundary = packageBoundaries.find(({ id }) => id === packageId);
    if (!boundary) return true;
    const packageName = boundary.packageNames.find(
        (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
    );
    if (!packageName) return true;
    const subpath =
        specifier === packageName ? '.' : `./${specifier.slice(packageName.length + 1)}`;
    return boundary.publicSubpaths.includes(subpath);
}

function packageSubpath(packageId: string, specifier: string): string | undefined {
    const boundary = packageBoundaries.find(({ id }) => id === packageId);
    const packageName = boundary?.packageNames.find(
        (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
    );
    if (!packageName) return undefined;
    return specifier === packageName ? '.' : `./${specifier.slice(packageName.length + 1)}`;
}

function isTestSource(path: string): boolean {
    return path.includes('/__tests__/') || /\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(path);
}

function serverLayerForPath(path: string): ServerLayer | undefined {
    const prefix = 'apps/server/src/';
    if (!path.startsWith(prefix)) return;
    const layer = path.slice(prefix.length).split('/', 1)[0];
    return ['core', 'domains', 'extension-host', 'observability', 'terminal-host'].includes(layer)
        ? (layer as ServerLayer)
        : undefined;
}

function isForbiddenServerLayerImport(importer: string, target: string): boolean {
    if (importer.includes('/__tests__/')) return false;
    const importerLayer = serverLayerForPath(importer);
    const targetLayer = serverLayerForPath(target);
    if (!importerLayer || !targetLayer || importerLayer === targetLayer) return false;
    if (targetLayer === 'observability') return false;
    if (importerLayer === 'observability') return true;
    return importerLayer !== 'core';
}

function isBrowserSafePackageSource(path: string): boolean {
    const boundary = packageBoundaries.find(
        ({ browserSafe, root }) => browserSafe && isPathInside(root, path),
    );
    if (!boundary) return false;
    return (boundary.browserUnsafeSourceRoots ?? []).every((root) => !isPathInside(root, path));
}

function isBrowserUnsafeSpecifier(specifier: string): boolean {
    if (isBuiltin(specifier)) return true;
    return browserUnsafeImports.some(
        (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
    );
}

function isAllowedTransition(importer: string, specifier: string): boolean {
    return transitionalImportAllowances.some(
        (allowance) => allowance.importer === importer && allowance.specifiers.includes(specifier),
    );
}

function isForbiddenNetSocketImport(importer: string, specifier: string): boolean {
    if (specifier !== 'node:net' && specifier !== 'net') return false;
    if (isTestSource(importer) || netSocketImporters.includes(importer)) return false;
    return netSocketRoots.some((root) => isPathInside(root, importer));
}

function isBrowserConsumer(path: string): boolean {
    if (isTestSource(path)) return false;
    return (
        isBrowserSafePackageSource(path) ||
        isPathInside('apps/desktop/src/renderer', path) ||
        isPathInside('apps/mobile/app', path) ||
        isPathInside('apps/mobile/src', path)
    );
}

function isPlatformClientTarget(specifier: string, resolvedTarget: string | undefined): boolean {
    return (
        specifier === '@caxri/client/supervise' ||
        specifier.startsWith('@caxri/client/supervise/') ||
        (resolvedTarget !== undefined &&
            isPathInside('packages/client/src/supervise', resolvedTarget))
    );
}

function isAllowedPackageDependency(
    importer: ImportOwner,
    importerPath: string,
    targetPackageId: string,
): boolean {
    if (importer.kind === 'extension') return targetPackageId === 'extension-api';
    if (importer.kind === 'shared') return true;
    const packageId = packageBoundaries.find(({ id }) => id === targetPackageId)?.id;
    if (!packageId) return false;
    if (importer.kind === 'application') {
        const boundary = appBoundaries.find(({ id }) => id === importer.id);
        return (
            (boundary?.allowedPackages.includes(packageId) ?? false) ||
            (isTestSource(importerPath) &&
                (boundary?.testAllowedPackages?.includes(packageId) ?? false))
        );
    }
    const boundary = packageBoundaries.find(({ id }) => id === importer.id);
    return boundary?.allowedPackages.includes(packageId) ?? false;
}

/**
 * Enforces the dependency direction defined by the accepted Server repository topology.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: { description: 'enforce Caxri application and package ownership boundaries' },
        schema: [],
        messages: {
            extensionImplementationImport:
                "Application '{{importer}}' must not import bundled extension implementation; use the public Extension API and Host protocol.",
            applicationImport:
                "Application '{{importer}}' must not import application '{{target}}' source; depend on a public package contract instead.",
            packageImportsApplication:
                "Package '{{importer}}' must not depend on application '{{target}}'; packages are lower-level reusable boundaries.",
            packagePrivateImport:
                "Import '{{specifier}}' bypasses package '{{target}}' exports; use a reviewed public package export.",
            browserUnsafeImport:
                "Browser runtime source must not import '{{specifier}}'; move platform code behind an explicit environment-specific boundary.",
            forbiddenPackageDependency:
                "'{{importer}}' must not depend on package '{{target}}' in the current ownership graph.",
            platformClientImport:
                "Browser code must not import '{{specifier}}'; @caxri/client/supervise is platform-only.",
            serverLayerImport:
                "Server layer '{{importer}}' must not import '{{target}}'; Core is the only composition layer allowed to cross Server process and Domain boundaries.",
            netSocketImport:
                "'{{specifier}}' is reserved for the Mobile gateway and preview proxy; Server Core and the Client supervisor must not open another socket.",
            testOnlyPackageImport:
                "Production source must not import test-only package entry '{{specifier}}'.",
        },
    },
    create(context) {
        const importer = normalizeRepoPath(relative(context.cwd, context.filename));
        const importerOwner = ownerForPath(importer);

        function inspect(node: Node, specifier: string): void {
            if (isAllowedTransition(importer, specifier)) return;
            if (isForbiddenNetSocketImport(importer, specifier)) {
                context.report({ node, messageId: 'netSocketImport', data: { specifier } });
                return;
            }

            const resolvedTarget = targetPath(importer, specifier);
            if (resolvedTarget && isForbiddenServerLayerImport(importer, resolvedTarget)) {
                context.report({
                    node,
                    messageId: 'serverLayerImport',
                    data: {
                        importer: serverLayerForPath(importer),
                        target: serverLayerForPath(resolvedTarget),
                    },
                });
                return;
            }
            if (isBrowserConsumer(importer) && isPlatformClientTarget(specifier, resolvedTarget)) {
                context.report({ node, messageId: 'platformClientImport', data: { specifier } });
                return;
            }

            if (isBrowserConsumer(importer) && isBrowserUnsafeSpecifier(specifier)) {
                context.report({ node, messageId: 'browserUnsafeImport', data: { specifier } });
                return;
            }

            const targetOwner = resolvedTarget
                ? ownerForPath(resolvedTarget)
                : ownerForBareSpecifier(specifier);
            if (!targetOwner) return;

            if (importerOwner?.kind === 'application' && targetOwner.kind === 'extension') {
                context.report({
                    node,
                    messageId: 'extensionImplementationImport',
                    data: { importer: importerOwner.id },
                });
                return;
            }

            if (
                targetOwner.kind === 'application' &&
                importerOwner?.kind === 'application' &&
                importerOwner.id !== targetOwner.id
            ) {
                context.report({
                    node,
                    messageId: 'applicationImport',
                    data: { importer: importerOwner.id, target: targetOwner.id },
                });
                return;
            }

            if (targetOwner.kind === 'application' && importerOwner?.kind === 'package') {
                context.report({
                    node,
                    messageId: 'packageImportsApplication',
                    data: { importer: importerOwner.id, target: targetOwner.id },
                });
                return;
            }

            if (targetOwner.kind !== 'package' || importerOwner?.id === targetOwner.id) return;
            const subpath = packageSubpath(targetOwner.id, specifier);
            const targetBoundary = packageBoundaries.find(({ id }) => id === targetOwner.id);
            if (
                subpath &&
                targetBoundary?.testOnlySubpaths?.includes(subpath) &&
                !isTestSource(importer)
            ) {
                context.report({
                    node,
                    messageId: 'testOnlyPackageImport',
                    data: { specifier },
                });
                return;
            }
            if (
                importerOwner &&
                !isAllowedPackageDependency(importerOwner, importer, targetOwner.id)
            ) {
                context.report({
                    node,
                    messageId: 'forbiddenPackageDependency',
                    data: { importer: importerOwner.id, target: targetOwner.id },
                });
                return;
            }
            const isPhysicalExportsBypass =
                resolvedTarget && isPathInside(`${targetOwner.root}/src`, resolvedTarget);
            const isNamedExportsBypass =
                !resolvedTarget && !isPackageSubpathPublic(targetOwner.id, specifier);
            if (isPhysicalExportsBypass || isNamedExportsBypass) {
                context.report({
                    node,
                    messageId: 'packagePrivateImport',
                    data: { specifier, target: targetOwner.id },
                });
            }
        }

        return {
            ExportAllDeclaration(node) {
                inspect(node, String(node.source.value));
            },
            ExportNamedDeclaration(node) {
                if (node.source) inspect(node, String(node.source.value));
            },
            ImportDeclaration(node) {
                inspect(node, String(node.source.value));
            },
            CallExpression(node) {
                const firstArgument = node.arguments[0];
                if (
                    node.callee.type === 'Identifier' &&
                    node.callee.name === 'require' &&
                    node.arguments.length > 0 &&
                    firstArgument.type === 'Literal' &&
                    typeof firstArgument.value === 'string'
                ) {
                    inspect(node, firstArgument.value);
                }
            },
            ImportExpression(node) {
                if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
                    inspect(node, node.source.value);
                }
            },
        };
    },
};

export default rule;

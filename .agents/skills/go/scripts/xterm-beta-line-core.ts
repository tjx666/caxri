import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { captureCommand } from './command-runner';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const EXACT_VERSION = /^\d+\.\d+\.\d+-beta\.\d+$/u;
const XTERM_PACKAGE = /^@xterm\/[a-z0-9-]+$/u;

const registryMetadataSchema = z.object({
    gitHead: z.string().regex(/^[0-9a-z-]+$/iu),
    name: z.string().regex(XTERM_PACKAGE),
    peerDependencies: z.record(z.string(), z.string()).optional(),
    version: z.string().min(1),
});

type RegistryMetadata = z.infer<typeof registryMetadataSchema>;

export interface XtermRegistryRunner {
    view(specifier: string): Promise<unknown>;
}

export interface XtermBetaLineInput {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    resolve: string[];
}

const manifestSchema = z.object({
    dependencies: z.record(z.string(), z.string()).default({}),
    devDependencies: z.record(z.string(), z.string()).default({}),
});

function mergeDependencies(target: Record<string, string>, source: Record<string, string>): void {
    for (const [name, version] of Object.entries(source)) {
        // Desktop and Expo intentionally use different React versions; only xterm pins must agree.
        if (!name.startsWith('@xterm/')) continue;
        const existing = target[name];
        if (existing && existing !== version)
            throw new Error(`${name} has conflicting workspace manifest versions`);
        target[name] = version;
    }
}

/**
 * Reads the root and every declared one-level Caxri workspace package manifest.
 */
export async function readWorkspaceDependencies(
    projectRoot = PROJECT_ROOT,
): Promise<Pick<XtermBetaLineInput, 'dependencies' | 'devDependencies'>> {
    const workspaceGroups = await Promise.all(
        ['apps', 'extensions', 'packages'].map(async (group) => {
            const directory = resolve(projectRoot, group);
            const entries = await readdir(directory, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => resolve(directory, entry.name, 'package.json'));
        }),
    );
    const manifestPaths = [resolve(projectRoot, 'package.json'), ...workspaceGroups.flat()];
    const manifests = await Promise.all(
        manifestPaths.map(async (path) => {
            try {
                return manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
                throw error;
            }
        }),
    );
    const result = { dependencies: {}, devDependencies: {} } satisfies Pick<
        XtermBetaLineInput,
        'dependencies' | 'devDependencies'
    >;
    for (const manifest of manifests) {
        if (!manifest) continue;
        mergeDependencies(result.dependencies, manifest.dependencies);
        mergeDependencies(result.devDependencies, manifest.devDependencies);
    }
    return result;
}

const defaultRunner: XtermRegistryRunner = {
    async view(specifier) {
        const source = await captureCommand(
            'npm',
            ['view', specifier, 'name', 'version', 'gitHead', 'peerDependencies', '--json'],
            { cwd: PROJECT_ROOT },
        );
        const parsed = JSON.parse(source) as unknown;
        return parsed;
    },
};

function parseRegistryMetadata(source: unknown, specifier: string): RegistryMetadata {
    const candidate = Array.isArray(source) ? z.array(z.unknown()).parse(source).at(-1) : source;
    const metadata = registryMetadataSchema.parse(candidate);
    const separator = specifier.lastIndexOf('@');
    const expectedName = separator > 0 ? specifier.slice(0, separator) : specifier;
    if (metadata.name !== expectedName) {
        throw new Error(`Registry returned ${metadata.name} for ${specifier}`);
    }
    return metadata;
}

function collectXtermPackages(
    dependencies: Record<string, string>,
    packages: Map<string, string>,
): void {
    for (const [name, version] of Object.entries(dependencies)) {
        if (!name.startsWith('@xterm/')) continue;
        if (!XTERM_PACKAGE.test(name)) throw new Error(`Invalid xterm package name: ${name}`);
        if (!EXACT_VERSION.test(version)) {
            throw new Error(`${name} must use an exact version before resolving a beta line`);
        }
        const previous = packages.get(name);
        if (previous && previous !== version) {
            throw new Error(`${name} has conflicting manifest versions`);
        }
        packages.set(name, version);
    }
}

function manifestPackages(input: XtermBetaLineInput): Map<string, string> {
    const packages = new Map<string, string>();
    for (const dependencies of [input.dependencies, input.devDependencies]) {
        collectXtermPackages(dependencies, packages);
    }
    return packages;
}

function assertPeerRange(metadata: RegistryMetadata, coreVersion: string): void {
    const range = metadata.peerDependencies?.['@xterm/xterm'];
    if (range && ![coreVersion, `^${coreVersion}`, `~${coreVersion}`].includes(range)) {
        throw new Error(
            `${metadata.name}@${metadata.version} peer range ${range} does not bind ${coreVersion}`,
        );
    }
}

export async function resolveXtermBetaLine(
    input: XtermBetaLineInput,
    runner: XtermRegistryRunner = defaultRunner,
) {
    const packages = manifestPackages(input);
    if (!packages.has('@xterm/xterm')) {
        throw new Error('The xterm beta line requires an exact @xterm/xterm manifest version');
    }
    const requested = [...new Set(input.resolve)];
    for (const name of requested) {
        if (!XTERM_PACKAGE.test(name)) throw new Error(`Invalid xterm package name: ${name}`);
    }

    const specs = new Map(
        [...packages].map(([name, version]) => [name, `${name}@${version}`] as const),
    );
    for (const name of requested) {
        if (!specs.has(name)) specs.set(name, `${name}@beta`);
    }
    const metadata = await Promise.all(
        [...specs].map(async ([name, specifier]) => {
            const result = parseRegistryMetadata(await runner.view(specifier), specifier);
            return { ...result, name, source: packages.has(name) ? 'manifest' : 'beta' } as const;
        }),
    );
    const gitHeads = new Set(metadata.map(({ gitHead }) => gitHead));
    if (gitHeads.size !== 1) {
        throw new Error('All xterm beta packages must share one gitHead');
    }
    const core = metadata.find(({ name }) => name === '@xterm/xterm')!;
    for (const item of metadata) assertPeerRange(item, core.version);
    const byName = new Map(metadata.map((item) => [item.name, item] as const));
    return {
        coreVersion: core.version,
        gitHead: core.gitHead,
        installSpecs: requested.map((name) => {
            const item = byName.get(name)!;
            return `${name}@${item.version}`;
        }),
        packages: metadata
            .map(({ name, peerDependencies, source, version }) => ({
                name,
                peerDependencies,
                source,
                version,
            }))
            .toSorted((left, right) => left.name.localeCompare(right.name)),
    };
}

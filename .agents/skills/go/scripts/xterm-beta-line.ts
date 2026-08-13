#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
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

function manifestPackages(input: XtermBetaLineInput): Map<string, string> {
    const packages = new Map<string, string>();
    for (const dependencies of [input.dependencies, input.devDependencies]) {
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
            .sort((left, right) => left.name.localeCompare(right.name)),
    };
}

function parseArguments(argv: string[]): { help: boolean; json: boolean; resolve: string[] } {
    const options = { help: false, json: false, resolve: [] as string[] };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--json') options.json = true;
        else if (argument === '--resolve') {
            const name = argv[++index];
            if (!name) throw new Error('Missing --resolve package name');
            options.resolve.push(name);
        } else throw new Error(`Unknown option: ${argument}`);
    }
    return options;
}

function help(): string {
    return `Resolve and verify one exact xterm beta package line without installing it.

Usage:
  bun run .agents/skills/go/scripts/xterm-beta-line.ts [--resolve @xterm/PACKAGE] [--json]

The resolver reads exact manifest versions, resolves new packages through their beta tag, and
requires one gitHead plus a compatible @xterm/xterm peer before printing exact ni specs.`;
}

async function main(argv: string[]): Promise<void> {
    const options = parseArguments(argv);
    if (options.help) {
        console.log(help());
        return;
    }
    const manifest = z
        .object({
            dependencies: z.record(z.string(), z.string()).default({}),
            devDependencies: z.record(z.string(), z.string()).default({}),
        })
        .parse(JSON.parse(await readFile(resolve(PROJECT_ROOT, 'package.json'), 'utf8')));
    const result = await resolveXtermBetaLine({ ...manifest, resolve: options.resolve });
    if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    console.log(`xterm gitHead: ${result.gitHead}`);
    for (const item of result.packages) {
        console.log(`${item.name}@${item.version} (${item.source})`);
    }
    if (result.installSpecs.length > 0) {
        console.log(`Install with: ni ${result.installSpecs.join(' ')}`);
    }
}

if (import.meta.main) {
    void main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}

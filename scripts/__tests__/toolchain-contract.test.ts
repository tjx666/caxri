import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { execFileAsync } from '../exec';

interface ActionStep {
    env?: Record<string, string>;
    id?: string;
    name?: string;
    run?: string;
    uses?: string;
    with?: Record<string, string>;
}

interface ActionDocument {
    runs: { steps: ActionStep[] };
}

interface PackageManifest {
    devDependencies: Record<string, string>;
}

const mise = await readFile(new URL('../../mise.toml', import.meta.url), 'utf8');
const setupAction = await readFile(
    new URL('../../.github/actions/setup-caxri-job/action.yml', import.meta.url),
    'utf8',
);
const setupActionDocument = parse(setupAction) as ActionDocument;
const packageManifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageManifest;
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function miseVersion(tool: 'node' | 'pnpm'): string {
    const match = mise.match(new RegExp(`^${tool} = "([^"]+)"$`, 'mu'));

    if (!match?.[1]) throw new Error(`mise.toml does not define an exact ${tool} version`);
    return match[1];
}

function stepByName(name: string): ActionStep {
    const step = setupActionDocument.runs.steps.find((candidate) => candidate.name === name);

    if (!step) throw new Error(`Missing setup action step: ${name}`);
    return step;
}

function literalVersionLocations(): string[] {
    const versions = [miseVersion('node'), miseVersion('pnpm')];

    return setupAction
        .split('\n')
        .flatMap((line, index) =>
            versions.some((version) => line.includes(version))
                ? `.github/actions/setup-caxri-job/action.yml:${index + 1}`
                : [],
        );
}

describe('toolchain contract', () => {
    it('loads the exact Node.js and pnpm versions from mise.toml without action-local copies', () => {
        const versionStep = stepByName('Read mise tool versions');
        const nodeSetupStep = setupActionDocument.runs.steps.find((step) =>
            step.uses?.startsWith('actions/setup-node@'),
        );
        const pnpmSetupStep = setupActionDocument.runs.steps.find((step) =>
            step.uses?.startsWith('pnpm/setup@'),
        );
        const reuseStep = stepByName('Reuse runner-cached pnpm');
        const verifyStep = stepByName('Verify exact Node.js and pnpm');

        expect(versionStep.id).toBe('tool_versions');
        expect(versionStep.run).toContain('mise.toml');
        expect(versionStep.run).toContain('echo "node=$node_version" >> "$GITHUB_OUTPUT"');
        expect(versionStep.run).toContain('echo "pnpm=$pnpm_version" >> "$GITHUB_OUTPUT"');
        expect(nodeSetupStep?.with?.['node-version']).toBe(
            '${{ steps.tool_versions.outputs.node }}',
        );
        expect(pnpmSetupStep?.with?.version).toBe('${{ steps.tool_versions.outputs.pnpm }}');
        expect(pnpmSetupStep?.with?.dest).toBe(
            '${{ runner.tool_cache }}/caxri/pnpm/${{ steps.tool_versions.outputs.pnpm }}-node-${{ steps.tool_versions.outputs.node }}',
        );
        const versionEnvironment = {
            CAXRI_NODE_VERSION: '${{ steps.tool_versions.outputs.node }}',
            CAXRI_PNPM_VERSION: '${{ steps.tool_versions.outputs.pnpm }}',
        };
        expect(reuseStep.env).toEqual(versionEnvironment);
        expect(reuseStep.run).toContain('${CAXRI_PNPM_VERSION}-node-${CAXRI_NODE_VERSION}');
        expect(verifyStep.env).toEqual(versionEnvironment);
        expect(verifyStep.run).toContain('"v$CAXRI_NODE_VERSION"');
        expect(verifyStep.run).toContain('"$CAXRI_PNPM_VERSION"');

        const literalLocations = literalVersionLocations();
        expect(
            literalLocations,
            `Action-local version copies: ${literalLocations.join(', ')}`,
        ).toEqual([]);
    });

    it('exports the mise versions for later composite-action steps', async () => {
        const versionStep = stepByName('Read mise tool versions');
        const workspace = await mkdtemp(join(tmpdir(), 'caxri-toolchain-contract-'));
        const githubOutput = join(workspace, 'github-output');

        try {
            await writeFile(join(workspace, 'mise.toml'), mise);
            await writeFile(githubOutput, '');
            await execFileAsync(
                'bash',
                ['-e', '-o', 'pipefail', '-c', versionStep.run ?? 'exit 1'],
                {
                    cwd: workspace,
                    env: { ...process.env, GITHUB_OUTPUT: githubOutput },
                },
            );

            expect((await readFile(githubOutput, 'utf8')).trim().split('\n')).toEqual([
                `node=${miseVersion('node')}`,
                `pnpm=${miseVersion('pnpm')}`,
            ]);
        } finally {
            await rm(workspace, { force: true, recursive: true });
        }
    });

    it('keeps the TypeScript 7 CLI and TypeScript 6 JavaScript API wired side by side', async () => {
        const tscPath = join(repoRoot, 'node_modules', '.bin', 'tsc');
        const { stdout } = await execFileAsync(tscPath, ['--version']);
        const typescript = (await import('typescript')) as { version: string };

        expect(packageManifest.devDependencies['@typescript/native']).toMatch(
            /^npm:typescript@7\./u,
        );
        expect(packageManifest.devDependencies.typescript).toMatch(
            /^npm:@typescript\/typescript6@6\./u,
        );
        expect(stdout.trim()).toMatch(/^Version 7\./u);
        expect(typescript.version).toMatch(/^6\./u);
    });
});

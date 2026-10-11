import { isAbsolute } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { e2eAgentEnvironmentKeys } from '@caxri/system';

import { acceptanceAgentFixtureIds } from './agent-fixture-ids';
import { prepareAcceptanceAgentFixture } from './agent-fixtures';

const USAGE =
    'Usage: bun run .agents/skills/acceptance/scripts/agent-fixture-environment.ts --fixture <id> --root <absolute dir> [--test-root <absolute dir>]';

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Prepares one repository-owned fake Agent fixture for a `switch-worktree dev` launch and renders it as `export` lines
 * for `eval`. It reuses the Acceptance fixture preparation, so a dev or render-audit instance gets the same fake
 * targets and isolated provider homes an Acceptance launch gets. Only the Agent policy and provider-state keys are
 * exported: the fixture's `HOME`, `PATH`, and XDG overrides would also re-home the dev launcher's own toolchain.
 * `CAXRI_E2E=1` is part of the output because Server Core honors the fake executables only under it; without this
 * explicit opt-in nothing changes.
 */
export async function agentFixtureShellExports(options: {
    fixtureId: string;
    root: string;
    sourceEnvironment?: NodeJS.ProcessEnv;
    testRoot?: string;
}): Promise<string> {
    for (const path of [options.root, options.testRoot]) {
        if (path !== undefined && !isAbsolute(path))
            throw new Error(`Agent fixture paths must be absolute: ${path}`);
    }
    const fixture = await prepareAcceptanceAgentFixture({
        fixtureId: options.fixtureId,
        sourceEnvironment: options.sourceEnvironment,
        userDataDir: options.root,
    });
    const agentKeys = new Set([...e2eAgentEnvironmentKeys(), 'CAXRI_E2E_AGENT_HOOKS']);
    const environment: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
            Object.entries(fixture.environment).filter(([key]) => agentKeys.has(key)),
        ),
        CAXRI_E2E: '1',
        CAXRI_E2E_WINDOW_MODE: 'visible',
        ...(options.testRoot && { CAXRI_TEST_ROOT_PATH: options.testRoot }),
    };
    return Object.entries(environment)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
        .join('\n');
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            'fixture': { type: 'string' },
            'root': { type: 'string' },
            'test-root': { type: 'string' },
        },
    });
    if (!values.fixture || !values.root) {
        throw new Error(`${USAGE}\nFixtures: ${acceptanceAgentFixtureIds.join(', ')}`);
    }
    console.log(
        await agentFixtureShellExports({
            fixtureId: values.fixture,
            root: values.root,
            testRoot: values['test-root'],
        }),
    );
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

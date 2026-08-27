import { access } from 'node:fs/promises';
import { delimiter } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';

import { execFileAsync } from './exec';

async function findExecutable(name: string): Promise<string | undefined> {
    const pathDirectories = (process.env.PATH ?? '').split(delimiter);
    // Sequential and short-circuiting: the first matching PATH entry wins, so
    // candidates must be probed in order rather than concurrently.
    for (const directory of pathDirectories) {
        const candidate = `${directory}/${name}`;
        try {
            // eslint-disable-next-line no-await-in-loop -- ordered PATH lookup must stop at the first match
            await access(candidate);
            return candidate;
        } catch {
            // Continue through the GUI process PATH before asking the login shell.
        }
    }

    // Intentional `||`: an empty `SHELL` value must also fall back to the default shell, not be
    // kept as `''`.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- see comment above
    const shell = process.env.SHELL || '/bin/zsh';
    try {
        const { stdout } = await execFileAsync(shell, ['-lic', `command -v ${name}`], {
            timeout: 5_000,
        });
        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

async function reportAgent(provider: AgentProvider): Promise<void> {
    const name = agentProviderCatalog[provider].executableName;
    const executable = await findExecutable(name);
    if (!executable) {
        console.log(JSON.stringify({ available: false, name }));
        return;
    }

    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 5_000 });
    console.log(JSON.stringify({ available: true, executable, name, version: stdout.trim() }));
}

await Promise.all(agentProviderIds.map((provider) => reportAgent(provider)));

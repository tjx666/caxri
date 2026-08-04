import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { delimiter } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function findExecutable(name: string): Promise<string | undefined> {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        const candidate = `${directory}/${name}`;
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Continue through the GUI process PATH before asking the login shell.
        }
    }

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

for (const name of ['claude', 'codex']) {
    const executable = await findExecutable(name);
    if (!executable) {
        console.log(JSON.stringify({ available: false, name }));
        continue;
    }

    const { stdout } = await execFileAsync(executable, ['--version'], { timeout: 5_000 });
    console.log(JSON.stringify({ available: true, executable, name, version: stdout.trim() }));
}

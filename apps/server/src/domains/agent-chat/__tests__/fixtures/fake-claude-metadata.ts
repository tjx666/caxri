import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Writes the live `sessions/<pid>.json` file Claude Code keeps for a running process and removes it on exit. Caxri
 * reads it to bind a Session to its Agent conversation, which AI Session naming needs before it applies a title. `name`
 * is the directory-derived placeholder real Claude Code assigns before any title exists.
 */
export function publishFakeClaudeSessionMetadata(options: {
    configDirectory: string;
    cwd: string;
    sessionId: string;
}): void {
    const directory = path.join(options.configDirectory, 'sessions');
    const file = path.join(directory, `${process.pid}.json`);
    const now = new Date().toISOString();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
        file,
        JSON.stringify({
            cwd: options.cwd,
            name: `${path.basename(options.cwd)}-xx`,
            nameSource: 'derived',
            sessionId: options.sessionId,
            startedAt: now,
            status: 'idle',
            updatedAt: now,
        }),
    );
    process.on('exit', () => fs.rmSync(file, { force: true }));
}

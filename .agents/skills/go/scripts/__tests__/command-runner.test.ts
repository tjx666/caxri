import { describe, expect, it } from 'vitest';

import { captureCommand } from '../command-runner';

describe('bounded Go command runner', () => {
    it('terminates commands that exceed their deadline', async () => {
        await expect(
            captureCommand(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
                killGraceMs: 25,
                timeoutMs: 25,
            }),
        ).rejects.toThrow('timed out after 25ms');
    });

    it('terminates commands that exceed the combined output limit', async () => {
        await expect(
            captureCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], {
                killGraceMs: 25,
                maxOutputBytes: 64,
            }),
        ).rejects.toThrow('output exceeded 64 bytes');
    });

    it('does not copy raw stderr into bounded failure evidence', async () => {
        const secret = 'token=private-command-value';
        const failure = await captureCommand(
            process.execPath,
            ['-e', `process.stderr.write(${JSON.stringify(secret)}); process.exit(7)`],
            { maxOutputBytes: 1024 },
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('exited 7');
        expect((failure as Error).message).toContain('stderrBytes=27');
        expect((failure as Error).message).not.toContain(secret);
    });
});

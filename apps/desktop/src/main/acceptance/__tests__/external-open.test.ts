import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { externalLinkPrompt } from '../../confirmations';
import { createAcceptanceExternalOpenFixture } from '../external-open';

const directories: string[] = [];
const environment = {
    CAXRI_ACCEPTANCE: '1',
    CAXRI_E2E: '1',
    CAXRI_ACCEPTANCE_EXTERNAL_OPEN: 'session-pr-open-parity-v1',
};
const url = new URL('https://github.com/tjx666/project/pull/42');
const prompt = externalLinkPrompt(url, true);
afterEach(async () => {
    const owned = [...directories];
    directories.length = 0;
    await Promise.all(owned.map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-acceptance-external-'));
    directories.push(directory);
    return {
        directory,
        io: createAcceptanceExternalOpenFixture({ environment, userDataPath: directory })!,
        command: join(directory, 'acceptance-external-open-command.json'),
    };
}

describe('Acceptance external-open fixture', () => {
    it.each(Object.keys(environment))('requires the %s gate', (key) => {
        expect(
            createAcceptanceExternalOpenFixture({
                environment: { ...environment, [key]: undefined },
                userDataPath: '/unused',
            }),
        ).toBeUndefined();
    });

    it.each(['confirm-success', 'cancel', 'confirm-reject'])(
        'records the real prompt and %s outcome without native I/O',
        async (decision) => {
            const { io, command, directory } = await fixture();
            await writeFile(command, JSON.stringify({ sequence: 1, decision }));
            const result = await io.prompt(url, prompt);
            expect(result.response).toBe(decision === 'cancel' ? prompt.cancelId : 0);
            if (decision === 'confirm-success')
                await expect(io.open(url.href)).resolves.toBeUndefined();
            else if (decision === 'confirm-reject')
                await expect(io.open(url.href)).rejects.toThrow(
                    'Acceptance external browser rejection',
                );
            const receipts = (
                await readFile(join(directory, 'acceptance-external-open-receipt.jsonl'), 'utf8')
            )
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as unknown);
            expect(receipts[0]).toMatchObject({
                kind: 'confirmation',
                message: prompt.message,
                detail: prompt.detail,
                buttons: prompt.buttons,
                sequence: 1,
            });
            expect(receipts).toHaveLength(decision === 'cancel' ? 1 : 2);
            await expect(io.open(url.href)).rejects.toThrow('requires a fresh confirmation');
            await expect(io.prompt(url, prompt)).rejects.toThrow('already consumed');
        },
    );

    it('rejects missing, malformed, linked and foreign inputs', async () => {
        const { io, command, directory } = await fixture();
        await expect(io.prompt(url, prompt)).rejects.toThrow();
        await writeFile(command, '{');
        await expect(io.prompt(url, prompt)).rejects.toThrow();
        await writeFile(command, JSON.stringify({ sequence: 1, decision: 'trust' }));
        await expect(io.prompt(url, prompt)).rejects.toThrow();
        await expect(io.prompt(new URL('https://example.com'), prompt)).rejects.toThrow(
            'Unexpected',
        );
        await rm(command);
        const linked = join(directory, 'linked.json');
        await writeFile(linked, JSON.stringify({ sequence: 1, decision: 'cancel' }));
        await symlink(linked, command);
        await expect(io.prompt(url, prompt)).rejects.toThrow();
    });
});

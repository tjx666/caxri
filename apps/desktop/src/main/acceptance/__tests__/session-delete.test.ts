import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createAcceptanceSessionDeleteFixture } from '../session-delete';

const caseId = 'audit-naming-cancel';
const sessionId = 'session-holding-the-naming-slot';
const prompt = {
    buttons: ['Delete', 'Cancel'],
    cancelId: 1,
    detail: 'Session Fixture naming hold',
    message: 'Delete “Fixture naming hold”?',
};
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

describe('Acceptance session delete fixture', () => {
    it('is disabled outside an armed Acceptance launch of the fixed case', () => {
        for (const environment of [
            { CAXRI_ACCEPTANCE: '1', CAXRI_E2E: '1' },
            { CAXRI_ACCEPTANCE_SESSION_DELETE: caseId, CAXRI_E2E: '1' },
            { CAXRI_ACCEPTANCE: '1', CAXRI_ACCEPTANCE_SESSION_DELETE: caseId },
            {
                CAXRI_ACCEPTANCE: '1',
                CAXRI_ACCEPTANCE_SESSION_DELETE: 'audit-argv-bounds',
                CAXRI_E2E: '1',
            },
        ])
            expect(
                createAcceptanceSessionDeleteFixture({ environment, userDataPath: '/unused' }),
            ).toBeUndefined();
    });

    it('answers one confirmation per freshly sequenced command and records no Session name', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-session-delete-fixture-'));
        directories.push(directory);
        const commandPath = join(directory, 'acceptance-session-delete-command.json');
        const receiptPath = join(directory, 'acceptance-session-delete-receipt.jsonl');
        const fixture = createAcceptanceSessionDeleteFixture({
            environment: {
                CAXRI_ACCEPTANCE: '1',
                CAXRI_ACCEPTANCE_SESSION_DELETE: caseId,
                CAXRI_E2E: '1',
            },
            userDataPath: directory,
        })!;
        const command = (
            decision: 'cancel' | 'confirm',
            sequence: number,
            overrides: { caseId?: string; sessionId?: string } = {},
        ) =>
            writeFile(
                commandPath,
                JSON.stringify({
                    caseId: overrides.caseId ?? caseId,
                    decision,
                    sequence,
                    sessionId: overrides.sessionId ?? sessionId,
                }),
            );

        await command('confirm', 1);
        await expect(fixture.confirm(sessionId, prompt)).resolves.toEqual({ response: 0 });
        // The command is consumed, so no second deletion can ride on it, not even after a restart reuses the profile.
        await expect(fixture.confirm(sessionId, prompt)).rejects.toThrow();
        await command('confirm', 2, { sessionId: 'a-different-session' });
        await expect(fixture.confirm(sessionId, prompt)).rejects.toThrow('does not match');
        // A rejected command is consumed too, so it cannot outlive this launch and be replayed by the next one.
        await expect(fixture.confirm(sessionId, prompt)).rejects.toThrow();
        await command('cancel', 2);
        await expect(fixture.confirm(sessionId, prompt)).resolves.toEqual({ response: 1 });
        await command('confirm', 3, { caseId: 'audit-argv-bounds' });
        await expect(fixture.confirm(sessionId, prompt)).rejects.toThrow('does not match');
        await writeFile(commandPath, JSON.stringify({ caseId, decision: 'delete-everything' }));
        await expect(fixture.confirm(sessionId, prompt)).rejects.toThrow();

        const receipt = await readFile(receiptPath, 'utf8');
        expect(receipt.trim().split('\n')).toHaveLength(2);
        expect(receipt).not.toContain(prompt.message);
        expect(receipt).not.toContain(prompt.detail);
        expect(JSON.parse(receipt.trim().split('\n', 1)[0])).toEqual({
            buttons: prompt.buttons,
            caseId,
            decision: 'confirm',
            sequence: 1,
            sessionId,
        });
    });
});

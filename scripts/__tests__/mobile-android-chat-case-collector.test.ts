import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectAndroidChatCases } from '../mobile-android-chat-case-collector';

const directories: string[] = [];

function groupDirectory(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'chat-cases-'));
    directories.push(directory);
    mkdirSync(directory, { recursive: true });
    for (const [name, source] of Object.entries(files)) {
        writeFileSync(join(directory, name), source);
    }
    return directory;
}

const definition = (id: string) =>
    `export const cases = { '${id}': { desktopProfile: 'managed-by-isolated-e2e', media: ['screenshot'], recordingOwner: 'scenario', scenario: 's' } };`;

afterEach(() => {
    for (const directory of directories) rmSync(directory, { force: true, recursive: true });
    directories.length = 0;
});

describe('collectAndroidChatCases', () => {
    it('merges the definitions of every group module', async () => {
        const collected = await collectAndroidChatCases(
            groupDirectory({
                'a.ts': definition('MOB-CHAT-A-01'),
                'b.ts': definition('MOB-CHAT-B-01'),
            }),
        );
        expect(Object.keys(collected).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'MOB-CHAT-A-01',
            'MOB-CHAT-B-01',
        ]);
    });

    it('rejects a duplicate id across groups', async () => {
        const directory = groupDirectory({
            'a.ts': definition('MOB-CHAT-X-01'),
            'b.ts': definition('MOB-CHAT-X-01'),
        });
        await expect(collectAndroidChatCases(directory)).rejects.toThrow(
            'Duplicate Agent Chat case definition: MOB-CHAT-X-01',
        );
    });

    it('rejects an id outside the Chat family and a module without cases', async () => {
        const outside = groupDirectory({ 'a.ts': definition('MOB-OTHER-01') });
        const empty = groupDirectory({ 'a.ts': 'export const x = 1;' });
        await expect(collectAndroidChatCases(outside)).rejects.toThrow('must start with MOB-CHAT-');
        await expect(collectAndroidChatCases(empty)).rejects.toThrow('must export cases');
    });
});

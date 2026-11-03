import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HostPreferences } from '@caxri/protocol';
import { detectedSystemOf } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostPreferencesStore } from '../host-preferences';

const directories: string[] = [];

async function store() {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-host-preferences-'));
    directories.push(directory);
    const onChanged = vi.fn<(preferences: HostPreferences) => void>();
    return { directory, onChanged, store: new HostPreferencesStore(directory, onChanged) };
}

afterEach(async () => {
    const removed = [...directories];
    directories.length = 0;
    await Promise.all(removed.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('detectedSystemOf', () => {
    it('picks a known distribution logo and falls back to Linux', () => {
        expect(detectedSystemOf({ system: 'macos' })).toBe('macos');
        expect(detectedSystemOf({ system: 'linux', distribution: 'ubuntu' })).toBe('ubuntu');
        expect(detectedSystemOf({ system: 'linux', distribution: 'rhel' })).toBe('redhat');
        expect(detectedSystemOf({ system: 'linux', distribution: 'alpine' })).toBe('linux');
        expect(detectedSystemOf({ system: 'linux' })).toBe('linux');
    });
});

describe('HostPreferencesStore', () => {
    it('keeps a name and icon across a restart and clears them with null', async () => {
        const { directory, onChanged, store: first } = await store();
        await first.update('dev@lab:22', {
            name: '  Lab  ',
            icon: { name: 'gpu', color: 'accent' },
        });
        await first.setShowHostNames(true);
        expect(onChanged).toHaveBeenCalledTimes(2);

        const second = new HostPreferencesStore(directory, vi.fn());
        expect(await second.read()).toEqual({
            shouldShowHostNames: true,
            hosts: { 'dev@lab:22': { name: 'Lab', icon: { name: 'gpu', color: 'accent' } } },
        });
        const cleared = await second.update('dev@lab:22', { name: null, icon: null });
        expect(cleared.hosts['dev@lab:22']).toEqual({});
    });

    it('records a connection only when the destination or system changed', async () => {
        const { onChanged, store: preferences } = await store();
        await preferences.recordConnected('dev@lab:22', 'lab', 'ubuntu');
        await preferences.recordConnected('dev@lab:22', 'lab', 'ubuntu');
        await preferences.recordConnected('dev@lab:22', 'lab', undefined);
        expect(onChanged).toHaveBeenCalledOnce();
        expect((await preferences.read()).hosts['dev@lab:22']).toEqual({
            destination: 'lab',
            detectedSystem: 'ubuntu',
        });
    });

    it('drops only the entries a hand edit broke', async () => {
        const { directory, store: preferences } = await store();
        await writeFile(
            join(directory, 'host-preferences.json'),
            JSON.stringify({
                shouldShowHostNames: 'yes',
                hosts: { good: { name: 'Good' }, bad: { icon: { name: 'nope' } } },
            }),
        );
        expect(await preferences.read()).toEqual({
            shouldShowHostNames: false,
            hosts: { good: { name: 'Good' } },
        });
        await preferences.update('good', { reconnectOnLaunch: false });
        const written = await readFile(join(directory, 'host-preferences.json'), 'utf8');
        expect(JSON.parse(written)).toMatchObject({
            hosts: { good: { name: 'Good', reconnectOnLaunch: false } },
        });
    });
});

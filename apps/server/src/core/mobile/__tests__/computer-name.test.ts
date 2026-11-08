import { describe, expect, it, vi } from 'vitest';

import { createMobileComputerName } from '../computer-name';

const settingsService = (initial: string | null) => {
    let computerName = initial;
    const request = vi.fn((method: string, parameters?: unknown) => {
        if (method === 'settings.get')
            return Promise.resolve({ value: { 'mobile.computerName': computerName } });
        if (method === 'settings.patch') {
            const { changes } = parameters as { changes: Array<{ value: string | null }> };
            computerName = changes[0].value;
            return Promise.resolve({});
        }
        return Promise.reject(new Error(`Unexpected ${method}`));
    });
    return { request };
};

describe('mobile computer name', () => {
    it('shows the system host label until the user names the computer', async () => {
        const service = settingsService('Studio Mac');
        const name = createMobileComputerName(() => service as never, 'work-laptop.example.test');
        expect(name.displayName()).toBe('work-laptop');
        await expect(name.refresh()).resolves.toBe(true);
        expect(name.displayName()).toBe('Studio Mac');
    });

    it('reports a change only when the name phones show differs, so other settings do not redraw dashboards', async () => {
        const service = settingsService(null);
        const name = createMobileComputerName(() => service as never, 'work-laptop');
        await expect(name.refresh()).resolves.toBe(false);
        await service.request('settings.patch', { changes: [{ value: 'Office Mac' }] });
        await expect(name.refresh()).resolves.toBe(true);
        await expect(name.refresh()).resolves.toBe(false);
    });

    it('still reports a phone rename to the refresh that follows it, so other paired phones redraw', async () => {
        const service = settingsService(null);
        const name = createMobileComputerName(() => service as never, 'work-laptop');
        await name.refresh();
        await name.rename('Studio Mac');
        await expect(name.refresh()).resolves.toBe(true);
        await expect(name.refresh()).resolves.toBe(false);
    });

    it('renames through the bounded settings patch and restores the host name for an empty name', async () => {
        const service = settingsService(null);
        const name = createMobileComputerName(() => service as never, 'work-laptop');
        await expect(name.rename('  Studio Mac ')).resolves.toBe('Studio Mac');
        expect(service.request).toHaveBeenCalledWith('settings.patch', {
            changes: [{ key: 'mobile.computerName', value: 'Studio Mac' }],
            dryRun: false,
        });
        await expect(name.rename(' '.repeat(3))).resolves.toBe('work-laptop');
        expect(service.request).toHaveBeenLastCalledWith('settings.patch', {
            changes: [{ key: 'mobile.computerName', value: null }],
            dryRun: false,
        });
    });

    it('keeps the current name when a rename is refused', async () => {
        const request = vi
            .fn()
            .mockRejectedValue(new Error('Computer names cannot contain control characters'));
        const name = createMobileComputerName(() => ({ request }), 'work-laptop');
        await expect(name.rename('bad‮name')).rejects.toThrow('control characters');
        expect(name.displayName()).toBe('work-laptop');
    });
});

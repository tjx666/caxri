import { describe, expect, it, vi } from 'vitest';

import type { TerminalImageStatus } from './terminal-images';
import {
    TERMINAL_IMAGE_GLOBAL_STORAGE_LIMIT_MB,
    TERMINAL_IMAGE_SEQUENCE_LIMIT_BYTES,
    TERMINAL_IMAGE_STORAGE_LIMIT_MB,
    terminalImageAddonOptions,
    TerminalImageBudgetManager,
} from './terminal-images';

function createImageAddon(storageUsage = 0) {
    let listener: (() => void) | undefined;
    return {
        addon: {
            onImageAdded: vi.fn((next: () => void) => {
                listener = next;
                return { dispose: vi.fn() };
            }),
            storageLimit: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
            storageUsage,
        },
        addImage: () => listener?.(),
    };
}

describe('terminal image limits', () => {
    it('configures bounded SIXEL and IIP support without terminal size reports or Kitty alpha', () => {
        expect(terminalImageAddonOptions).toMatchObject({
            enableSizeReports: false,
            iipSizeLimit: TERMINAL_IMAGE_SEQUENCE_LIMIT_BYTES,
            iipSupport: true,
            kittySupport: false,
            showPlaceholder: true,
            sixelSizeLimit: TERMINAL_IMAGE_SEQUENCE_LIMIT_BYTES,
            sixelSupport: true,
            storageLimit: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
        });
    });

    it('caps each Terminal and divides the global budget across larger split layouts', () => {
        const manager = new TerminalImageBudgetManager();
        const addons = Array.from({ length: 4 }, () => createImageAddon());
        const statuses = Array.from({ length: 4 }, () =>
            vi.fn<(status: TerminalImageStatus) => void>(),
        );
        const unregister = addons.map(({ addon }, index) =>
            manager.register(`terminal-${index}`, addon, statuses[index]),
        );

        expect(addons.map(({ addon }) => addon.storageLimit)).toEqual([6, 6, 6, 6]);
        expect(statuses[0]).toHaveBeenLastCalledWith(
            expect.objectContaining({
                globalStorageLimitMb: TERMINAL_IMAGE_GLOBAL_STORAGE_LIMIT_MB,
                storageLimitMb: 6,
            }),
        );

        unregister[3]();
        expect(addons.slice(0, 3).map(({ addon }) => addon.storageLimit)).toEqual([8, 8, 8]);
    });

    it('publishes only content-free counts and memory usage when an image is added', () => {
        const manager = new TerminalImageBudgetManager();
        const first = createImageAddon(2.5);
        const second = createImageAddon(1.25);
        const publish = vi.fn<(status: TerminalImageStatus) => void>();
        manager.register('first', first.addon, publish);
        manager.register('second', second.addon, vi.fn());

        first.addImage();

        expect(publish).toHaveBeenLastCalledWith({
            globalStorageLimitMb: TERMINAL_IMAGE_GLOBAL_STORAGE_LIMIT_MB,
            globalStorageUsageMb: 3.75,
            imagesAdded: 1,
            storageLimitMb: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
            storageUsageMb: 2.5,
        });
    });
});

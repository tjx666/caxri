import type { IImageAddonOptions } from '@xterm/addon-image';
import { ImageAddon } from '@xterm/addon-image';
import type { IDisposable } from '@xterm/xterm';

const TERMINAL_IMAGE_PIXEL_LIMIT = 1024 * 1024;
export const TERMINAL_IMAGE_SEQUENCE_LIMIT_BYTES = 64 * 1024;
export const TERMINAL_IMAGE_STORAGE_LIMIT_MB = 8;
export const TERMINAL_IMAGE_GLOBAL_STORAGE_LIMIT_MB = 24;

export const terminalImageAddonOptions = {
    enableSizeReports: false,
    iipSizeLimit: TERMINAL_IMAGE_SEQUENCE_LIMIT_BYTES,
    iipSupport: true,
    /**
     * Kitty graphics is still alpha in the pinned addon and is disabled until its recovery and
     *  resource semantics are stable enough to share Caxri's bounded image contract.
     */
    kittySupport: false,
    pixelLimit: TERMINAL_IMAGE_PIXEL_LIMIT,
    showPlaceholder: true,
    sixelPaletteLimit: 256,
    sixelScrolling: true,
    sixelSizeLimit: TERMINAL_IMAGE_SEQUENCE_LIMIT_BYTES,
    sixelSupport: true,
    storageLimit: TERMINAL_IMAGE_STORAGE_LIMIT_MB,
} satisfies IImageAddonOptions;

export interface TerminalImageStatus {
    globalStorageLimitMb: number;
    globalStorageUsageMb: number;
    imagesAdded: number;
    storageLimitMb: number;
    storageUsageMb: number;
}

interface ManagedImageAddon {
    onImageAdded(listener: () => void): IDisposable;
    storageLimit: number;
    readonly storageUsage: number;
}

interface ManagedTerminalImages {
    addon: ManagedImageAddon;
    imagesAdded: number;
    listener: IDisposable;
    publish: (status: TerminalImageStatus) => void;
}

function finiteStorageUsage(value: number): number {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Divides one bounded cache budget across every mounted xterm image addon. Reducing a limit asks
 * the official addon to synchronously evict FIFO entries, while disposal removes the Terminal from
 * the global calculation without retaining image canvases or payloads in Caxri state.
 */
export class TerminalImageBudgetManager {
    private readonly terminals = new Map<string, ManagedTerminalImages>();

    private rebalance(): void {
        const count = this.terminals.size;
        if (count === 0) return;
        const perTerminalLimit = Math.min(
            TERMINAL_IMAGE_STORAGE_LIMIT_MB,
            TERMINAL_IMAGE_GLOBAL_STORAGE_LIMIT_MB / count,
        );
        for (const { addon } of this.terminals.values()) addon.storageLimit = perTerminalLimit;
        this.publishAll();
    }

    private publishAll(): void {
        const globalStorageUsageMb = this.terminals
            .values()
            .reduce((total, { addon }) => total + finiteStorageUsage(addon.storageUsage), 0);
        for (const { addon, imagesAdded, publish } of this.terminals.values())
            publish({
                globalStorageLimitMb: TERMINAL_IMAGE_GLOBAL_STORAGE_LIMIT_MB,
                globalStorageUsageMb,
                imagesAdded,
                storageLimitMb: addon.storageLimit,
                storageUsageMb: finiteStorageUsage(addon.storageUsage),
            });
    }

    register(
        terminalId: string,
        addon: ManagedImageAddon,
        publish: (status: TerminalImageStatus) => void,
    ): () => void {
        if (this.terminals.has(terminalId))
            throw new Error(`Terminal image budget already registered for ${terminalId}`);
        const entry: ManagedTerminalImages = {
            addon,
            imagesAdded: 0,
            listener: addon.onImageAdded(() => {
                entry.imagesAdded += 1;
                this.publishAll();
            }),
            publish,
        };
        this.terminals.set(terminalId, entry);
        this.rebalance();
        return () => {
            if (this.terminals.get(terminalId) !== entry) return;
            entry.listener.dispose();
            this.terminals.delete(terminalId);
            this.rebalance();
        };
    }
}

const terminalImageBudgetManager = new TerminalImageBudgetManager();

export function createTerminalImageAddon(): ImageAddon {
    return new ImageAddon(terminalImageAddonOptions);
}

export function registerTerminalImageAddon(
    terminalId: string,
    addon: ImageAddon,
    publish: (status: TerminalImageStatus) => void,
): () => void {
    return terminalImageBudgetManager.register(terminalId, addon, publish);
}

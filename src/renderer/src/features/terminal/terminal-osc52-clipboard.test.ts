import { describe, expect, it, vi } from 'vitest';

import {
    ControlledOsc52Clipboard,
    MAX_OSC52_ENCODED_LENGTH,
    MAX_OSC52_TEXT_CHARACTERS,
    OSC52_MIN_WRITE_INTERVAL_MS,
    OSC52_NOTIFICATION_THROTTLE_MS,
} from './terminal-osc52-clipboard';

function osc52Fixture(options?: { enabled?: boolean; now?: () => number }) {
    const writeClipboard = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());
    const onBlocked = vi.fn();
    const onWriteFailure = vi.fn();
    const clipboard = new ControlledOsc52Clipboard({
        enabled: () => options?.enabled ?? false,
        now: options?.now,
        onBlocked,
        onWriteFailure,
        writeClipboard,
    });
    return { clipboard, onBlocked, onWriteFailure, writeClipboard };
}

async function writeOsc52(
    clipboard: ControlledOsc52Clipboard,
    text: string,
    selection = 'c',
): Promise<void> {
    const decoded = clipboard.decodeText(clipboard.encodeText(text));
    await clipboard.writeText(selection, decoded);
}

describe('ControlledOsc52Clipboard', () => {
    it('does not access the system clipboard while disabled and never reports its contents', async () => {
        const { clipboard, onBlocked, writeClipboard } = osc52Fixture();

        await writeOsc52(clipboard, 'blocked');

        expect(writeClipboard).not.toHaveBeenCalled();
        expect(clipboard.readText()).toBe('');
        expect(writeClipboard).not.toHaveBeenCalled();
        expect(onBlocked).toHaveBeenCalledExactlyOnceWith('disabled');
    });

    /**
     * The throttle is per reason. Collapsing a burst of one kind is the anti-spam goal; collapsing
     * four different explanations into whichever fired first would hide the only one with a next
     * step (`disabled`) behind a chatty program's repeated oversized writes.
     */
    it('throttles a repeated block reason without suppressing a different one', () => {
        let now = 2_000;
        const { clipboard, onBlocked, writeClipboard } = osc52Fixture({
            enabled: true,
            now: () => now,
        });
        const oversized = 'A'.repeat(MAX_OSC52_ENCODED_LENGTH + 1);

        clipboard.decodeText('not base64');
        expect(onBlocked).toHaveBeenCalledExactlyOnceWith('malformed');

        /**
        A different reason inside the same window is a different explanation, so it still lands.
         */
        clipboard.decodeText(oversized);
        expect(onBlocked).toHaveBeenCalledTimes(2);
        expect(onBlocked).toHaveBeenNthCalledWith(2, 'oversized');

        /**
        Repeats of either reason inside the window are suppressed.
         */
        clipboard.decodeText(oversized);
        clipboard.decodeText('not base64');
        expect(onBlocked).toHaveBeenCalledTimes(2);

        now += OSC52_NOTIFICATION_THROTTLE_MS;
        clipboard.decodeText(oversized);
        expect(onBlocked).toHaveBeenCalledTimes(3);
        expect(onBlocked).toHaveBeenNthCalledWith(3, 'oversized');
        expect(writeClipboard).not.toHaveBeenCalled();
    });

    it('reports a throttled rate-limit block distinct from the write failure path', async () => {
        let now = 2_000;
        const { clipboard, onBlocked } = osc52Fixture({ enabled: true, now: () => now });

        await writeOsc52(clipboard, 'first');
        now += OSC52_MIN_WRITE_INTERVAL_MS - 1;
        await writeOsc52(clipboard, 'too soon');

        expect(onBlocked).toHaveBeenCalledExactlyOnceWith('rate-limited');
    });

    it('writes one valid bounded clipboard selection when enabled', async () => {
        const { clipboard, writeClipboard } = osc52Fixture({ enabled: true, now: () => 2_000 });

        await writeOsc52(clipboard, 'safe fixture');

        expect(writeClipboard).toHaveBeenCalledOnce();
        expect(writeClipboard).toHaveBeenCalledWith('safe fixture');
    });

    it('rejects invalid base64, unsupported selections, and encoded or decoded overflows', async () => {
        const { clipboard, writeClipboard } = osc52Fixture({ enabled: true, now: () => 2_000 });

        await clipboard.writeText('c', clipboard.decodeText('not base64'));
        await clipboard.writeText(
            'c',
            clipboard.decodeText('A'.repeat(MAX_OSC52_ENCODED_LENGTH + 1)),
        );
        await writeOsc52(clipboard, 'x'.repeat(MAX_OSC52_TEXT_CHARACTERS + 1));
        await writeOsc52(clipboard, 'primary selection', 'p');

        expect(writeClipboard).not.toHaveBeenCalled();
    });

    it('rate-limits valid writes before accessing the system clipboard', async () => {
        let now = 2_000;
        const { clipboard, writeClipboard } = osc52Fixture({ enabled: true, now: () => now });

        await writeOsc52(clipboard, 'first');
        now += OSC52_MIN_WRITE_INTERVAL_MS - 1;
        await writeOsc52(clipboard, 'too soon');
        now += 1;
        await writeOsc52(clipboard, 'second');

        expect(writeClipboard).toHaveBeenCalledTimes(2);
        expect(writeClipboard).toHaveBeenNthCalledWith(1, 'first');
        expect(writeClipboard).toHaveBeenNthCalledWith(2, 'second');
    });

    it('reports clipboard permission failure once without including content', async () => {
        let now = 2_000;
        const { clipboard, onWriteFailure, writeClipboard } = osc52Fixture({
            enabled: true,
            now: () => now,
        });
        writeClipboard.mockRejectedValue(new Error('denied with private clipboard content'));

        await writeOsc52(clipboard, 'first secret');
        now += OSC52_MIN_WRITE_INTERVAL_MS;
        await writeOsc52(clipboard, 'second secret');

        expect(writeClipboard).toHaveBeenCalledTimes(2);
        expect(onWriteFailure).toHaveBeenCalledOnce();
        expect(onWriteFailure).toHaveBeenCalledWith();
    });
});

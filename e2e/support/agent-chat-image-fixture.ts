import type { Locator } from '@playwright/test';

/**
 * Pastes a generated PNG through Chromium's clipboard event without using the system clipboard.
 */
export async function pasteAgentChatImage(message: Locator): Promise<void> {
    await message.evaluate(async (element) => {
        const canvas = new OffscreenCanvas(96, 64);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('2D canvas unavailable');
        const gradient = context.createLinearGradient(0, 0, 96, 64);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(1, '#f97316');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 96, 64);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const clipboardData = new DataTransfer();
        clipboardData.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }));
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData }));
    });
}

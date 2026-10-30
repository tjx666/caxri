import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { seriesColor } from './benchmark-presentation';
import type { ShareCardModel, ShareCardPalette } from './benchmark-share-card';
import { renderShareCardSvg, SHARE_CARD_SCALE } from './benchmark-share-card';

const PROVIDERS = agentProviderIds;

/**
 * Reads the active theme into concrete values. The share card follows the current theme, but it is rasterized from a
 * standalone SVG that cannot resolve `var(--…)` or the relative-color `seriesColor`, so each color is resolved through
 * a probe element the browser computes for us.
 */
function resolveShareCardPalette(): ShareCardPalette {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) =>
        root.getPropertyValue(name).trim() || fallback;
    const probe = document.createElement('span');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.display = 'none';
    document.body.append(probe);
    try {
        const series = Object.fromEntries(
            PROVIDERS.map((provider) => {
                probe.style.color = seriesColor(provider);
                return [provider, getComputedStyle(probe).color];
            }),
        ) as Record<AgentProvider, string>;
        return {
            background: token('--background', '#ffffff'),
            border: token('--border', '#d4d4d8'),
            fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
            foreground: token('--foreground', '#18181b'),
            muted: token('--muted', '#71717a'),
            series,
        };
    } finally {
        probe.remove();
    }
}

function loadImage(url: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () => resolve(image));
        image.addEventListener('error', () =>
            reject(new Error('The share card could not be drawn')),
        );
        image.src = url;
    });
}

function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('The share card could not be encoded'));
        }, 'image/png');
    });
}

async function blobBase64(blob: Blob): Promise<string> {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize)
        binary += String.fromCodePoint(...bytes.subarray(index, index + chunkSize));
    return btoa(binary);
}

/**
 * Rasterizes the card offscreen at {@link SHARE_CARD_SCALE}x and returns the PNG as base64 for the Main-side clipboard
 * and save methods. The SVG goes through an `Image` as a blob URL, so nothing is attached to the page and the
 * Content-Security-Policy keeps forbidding remote loads.
 */
async function rasterizeShareCard(card: ShareCardModel): Promise<string> {
    const svg = renderShareCardSvg(card, resolveShareCardPalette());
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    try {
        const image = await loadImage(url);
        const canvas = document.createElement('canvas');
        canvas.width = card.width * SHARE_CARD_SCALE;
        canvas.height = card.height * SHARE_CARD_SCALE;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('The share card could not be drawn');
        context.scale(SHARE_CARD_SCALE, SHARE_CARD_SCALE);
        context.drawImage(image, 0, 0, card.width, card.height);
        return await blobBase64(await canvasPng(canvas));
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Puts the rasterized card on the system clipboard through Main.
 */
export async function copyShareCard(card: ShareCardModel): Promise<void> {
    await caxri.request('benchmark.shareImage.copy', { pngBase64: await rasterizeShareCard(card) });
}

/**
 * Saves the rasterized card through the native save dialog. Resolves with the chosen path, or `undefined` when the user
 * dismissed the dialog.
 */
export async function saveShareCard(
    card: ShareCardModel,
    fileName: string,
): Promise<string | undefined> {
    const result = await caxri.request('benchmark.shareImage.save', {
        fileName,
        pngBase64: await rasterizeShareCard(card),
    });
    return result?.path;
}

import { describe, expect, it } from 'vitest';

import { codexHistoryImage } from '../codex-input';

const ITEM_ID = '01a00000-0000-7000-8000-000000000001';

/**
 * Rollout lines shaped as codex-cli 0.164.0-alpha.8 writes them; only the user message's `item_completed` event carries
 * the app-server item id.
 */
function rollout(content: unknown[], id = ITEM_ID): string {
    return [
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
        {
            type: 'event_msg',
            payload: {
                type: 'item_completed',
                thread_id: 'thread',
                turn_id: 'turn',
                item: { type: 'UserMessage', id, client_id: 'client', content },
            },
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
    ]
        .map((record) => JSON.stringify(record))
        .join('\n');
}

describe('codexHistoryImage', () => {
    it('reads an image by the user message item id and its position among the images', () => {
        const record = rollout([
            { type: 'image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
            { type: 'text', text: 'look', text_elements: [] },
            { type: 'image', image_url: 'data:image/webp;base64,UklGRg==' },
        ]);
        expect(codexHistoryImage(record, ITEM_ID, 0)).toEqual({
            mediaType: 'image/png',
            data: 'iVBORw0KGgo=',
        });
        expect(codexHistoryImage(record, ITEM_ID, 1)).toEqual({
            mediaType: 'image/webp',
            data: 'UklGRg==',
        });
        expect(codexHistoryImage(record, ITEM_ID, 2)).toBeNull();
        expect(codexHistoryImage(record, 'other-item', 0)).toBeUndefined();
    });

    it('keeps a local image in the count but never reads its path', () => {
        const record = rollout([
            { type: 'local_image', path: '/outside/screenshot.png' },
            { type: 'image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
        ]);
        expect(codexHistoryImage(record, ITEM_ID, 0)).toBeNull();
        expect(codexHistoryImage(record, ITEM_ID, 1)).toEqual({
            mediaType: 'image/png',
            data: 'iVBORw0KGgo=',
        });
    });

    it('rejects a remote URL or a media type the Chat cannot render', () => {
        const record = rollout([
            { type: 'image', image_url: 'https://example.com/a.png' },
            { type: 'image', image_url: 'data:image/svg+xml;base64,PHN2Zz4=' },
        ]);
        expect(codexHistoryImage(record, ITEM_ID, 0)).toBeNull();
        expect(codexHistoryImage(record, ITEM_ID, 1)).toBeNull();
    });
});

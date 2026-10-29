import type { MobileMessageChunk } from '@caxri/protocol';
import { MOBILE_TIMELINE_MESSAGE_PREVIEW_LENGTH } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-errors';

/**
 * The most slices one message may arrive in. The Server's bound on a message (256 KiB) needs at most a few dozen, so
 * more means a Server that never ends the series; the read fails instead of looping.
 */
const MAX_SLICES = 128;

/**
 * Pages one message through a Server read and joins the slices. Fails when the message changed between slices (a
 * streaming reply grew) rather than copying two different texts glued together.
 */
export async function readWholeMessage(
    readChunk: (offset: number) => Promise<MobileMessageChunk>,
): Promise<string> {
    const parts: string[] = [];
    let offset = 0;
    let totalLength: number | undefined;
    for (let slice = 0; slice < MAX_SLICES; slice += 1) {
        // Each slice starts where the previous one ended, so the reads cannot run together.
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const chunk = await readChunk(offset); // eslint-disable-line no-await-in-loop
        if (totalLength !== undefined && chunk.totalLength !== totalLength)
            throw new Error('The message changed while it was loading.');
        totalLength = chunk.totalLength;
        parts.push(chunk.text);
        if (chunk.nextOffset === undefined) {
            const text = parts.join('');
            if (text.length !== totalLength) throw new Error('The message was read incompletely.');
            return text;
        }
        if (chunk.nextOffset <= offset) throw new Error('The message read did not advance.');
        offset = chunk.nextOffset;
    }
    throw new Error('The message is too long to read.');
}

/**
 * Whether a Terminal timeline message may have been cut to the timeline's preview length, so its whole text has to be
 * read from the computer before it is copied.
 */
export const isTimelineMessageClipped = (text: string): boolean =>
    text.length >= MOBILE_TIMELINE_MESSAGE_PREVIEW_LENGTH;

/**
 * Thrown when a clipped message cannot be read because the phone is offline, so the sheet can say what to do.
 */
export class MessageReadOfflineError extends Error {
    constructor() {
        super('Only the start of this message is on the phone');
        this.name = 'MessageReadOfflineError';
    }
}

/**
 * The sheet's sentence for a failed read: why the whole text is out of reach when the cause is known (offline, over the
 * Server's bound), otherwise the generic retry line.
 */
export const messageReadErrorText = (error: unknown, t: Translate): string => {
    if (error instanceof MessageReadOfflineError) return t('conversation.message.readOffline');
    if (error instanceof MobileGatewayRequestError && error.code === 'VALIDATION')
        return t('conversation.message.tooLong');
    return t('conversation.message.readFailed');
};

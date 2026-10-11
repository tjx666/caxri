import { join } from 'node:path';

import { adbShell, pushMobileFixture, waitForMobile } from './mobile-android';

const IMAGE_NAME = 'caxri-acceptance-image.jpg';
const REMOTE_IMAGE = `/sdcard/Pictures/${IMAGE_NAME}`;
const MEDIA_URI = 'content://media/external/images/media';

const rescan = (serial: string) =>
    adbShell(serial, [
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${REMOTE_IMAGE}`,
    ]);

const queryGallery = (serial: string) =>
    adbShell(serial, ['content', 'query', '--uri', MEDIA_URI, '--projection', '_display_name']);

/**
 * Puts the repository's one acceptance photo in the disposable emulator's gallery, so the system photo picker shows a
 * single tile. A copy an interrupted run left behind is removed first; any other image is refused, because it could
 * belong to someone and would end up in evidence.
 */
export async function addMobileGalleryImage(serial: string): Promise<void> {
    await removeMobileGalleryImage(serial);
    await waitForMobile(
        () => queryGallery(serial),
        (result) => !result.includes(IMAGE_NAME),
    );
    if ((await queryGallery(serial)).includes('Row:'))
        throw new Error('Disposable Android gallery contains unrelated images');
    await pushMobileFixture(
        serial,
        join(import.meta.dirname, '../fixtures/mobile-acceptance-image.jpg'),
        REMOTE_IMAGE,
    );
    await rescan(serial);
    await waitForMobile(
        () => queryGallery(serial),
        (result) => result.includes(IMAGE_NAME),
    );
}

export async function removeMobileGalleryImage(serial: string): Promise<void> {
    await adbShell(serial, ['rm', '-f', REMOTE_IMAGE]);
    await rescan(serial);
}

import { join } from 'node:path';

import {
    adbShell,
    pushMobileFixture,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';

/**
 * The most copies of the acceptance photo a case may put in the gallery; removal clears every one of them.
 */
const MAX_GALLERY_IMAGES = 3;
const MEDIA_URI = 'content://media/external/images/media';

const imageName = (index: number) => `caxri-acceptance-image-${index + 1}.jpg`;
const remoteImage = (index: number) => `/sdcard/Pictures/${imageName(index)}`;

const rescan = (serial: string, index: number) =>
    adbShell(serial, [
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${remoteImage(index)}`,
    ]);

const queryGallery = (serial: string) =>
    adbShell(serial, ['content', 'query', '--uri', MEDIA_URI, '--projection', '_display_name']);

const galleryIndexes = (count: number) => Array.from({ length: count }, (_, index) => index);

/**
 * Puts `count` copies of the repository's acceptance photo in the disposable emulator's gallery, so the system photo
 * picker shows exactly that many tiles. Copies an interrupted run left behind are removed first; any other image is
 * refused, because it could belong to someone and would end up in evidence.
 */
export async function addMobileGalleryImages(serial: string, count = 1): Promise<void> {
    if (count < 1 || count > MAX_GALLERY_IMAGES)
        throw new Error(`The gallery takes 1 to ${MAX_GALLERY_IMAGES} acceptance photos`);
    await removeMobileGalleryImages(serial);
    await waitForMobile(
        () => queryGallery(serial),
        (result) => !result.includes('caxri-acceptance-image'),
    );
    if ((await queryGallery(serial)).includes('Row:'))
        throw new Error('Disposable Android gallery contains unrelated images');
    for (const index of galleryIndexes(count)) {
        // eslint-disable-next-line no-await-in-loop -- one adb transfer at a time keeps the device output ordered.
        await pushMobileFixture(
            serial,
            join(import.meta.dirname, '../fixtures/mobile-acceptance-image.jpg'),
            remoteImage(index),
        );
        // eslint-disable-next-line no-await-in-loop -- Same as above.
        await rescan(serial, index);
    }
    await waitForMobile(
        () => queryGallery(serial),
        (result) => galleryIndexes(count).every((index) => result.includes(imageName(index))),
    );
}

export async function removeMobileGalleryImages(serial: string): Promise<void> {
    for (const index of galleryIndexes(MAX_GALLERY_IMAGES)) {
        // eslint-disable-next-line no-await-in-loop -- one adb command at a time.
        await adbShell(serial, ['rm', '-f', remoteImage(index)]);
        // eslint-disable-next-line no-await-in-loop -- Same as above.
        await rescan(serial, index);
    }
}

/**
 * Ticks the first `count` gallery tiles in the open system Photo Picker. The composer opens it in multi-select mode,
 * where a tap only ticks a tile and `Done` returns the selection.
 */
export async function selectMobileGalleryImages(serial: string, count: number): Promise<void> {
    for (const index of galleryIndexes(count)) {
        // eslint-disable-next-line no-await-in-loop -- each tap ticks one tile of the same picker.
        await tapMobileNativeControl(serial, { imageTile: index });
    }
}

/**
 * Picks the first `count` gallery tiles and returns them to the composer.
 */
export async function pickMobileGalleryImages(serial: string, count = 1): Promise<void> {
    await selectMobileGalleryImages(serial, count);
    await tapMobileNativeControl(serial, { text: 'Done' });
}

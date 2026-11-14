import { writeJsonAtomic } from '../../scripts/atomic-json';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    mobileRegionFingerprint,
    mobileSemantics,
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import {
    addMobileGalleryImages,
    pickMobileGalleryImages,
    removeMobileGalleryImages,
} from './mobile-gallery';
import { broadcastMobileUnicode, insertMobileInputUnicode } from './mobile-unicode-input';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The lines typed under the image's placeholder, ending on the second item's committed marker. The field grows by a few
 * dp, once, when an empty last line gets its first character, so the marker is in place before the reference frame.
 */
const TYPED_LINES = '\n1. 这文件路径没法滚动\n2. ';
const DRAFT = `[Image #1] ${TYPED_LINES}`;
/**
 * The composer's top padding and line height in dp (`sessionDetailStyles.composerExpanded`): the first two lines, the
 * pill and the first item, sit inside `11 + 2 * 21` dp below the field's top. The region stops 7dp short of that,
 * because the caret on the typed line reaches up to the line's top edge and moves with every key.
 */
const SETTLED_LINES_DP = 11 + 2 * 21 - 7;
/**
 * The keys typed after the marker, each held as the open composition the way a Chinese IME holds a key while its
 * candidates show, and then committed. The reported jump lasted a frame or two after a key, so every key is sampled at
 * once.
 */
const KEYS: ReadonlyArray<{ commit?: string; hold: readonly string[] }> = [
    { commit: '第', hold: ['d', 'di'] },
    { commit: '二项', hold: ['e', 'er', 'erx', 'erxi', 'erxia', 'erxian', 'erxiang'] },
];
const TYPED_ITEM = '第二项';
/**
 * Frames read right after each key.
 */
const SAMPLES = 3;

async function settledLinesBounds(serial: string) {
    const input = (await mobileSemantics(serial)).find(
        ({ checkId }) => checkId === 'agent-chat-composer-input',
    );
    const bounds = input && androidBounds(input.bounds);
    if (!bounds) throw new Error('The Chat composer has no bounds');
    const density = Number(
        /(\d+)\s*$/u.exec((await adbShell(serial, ['wm', 'density'])).trim())?.[1],
    );
    if (!density) throw new Error('The emulator density is unavailable');
    return {
        bottom: bounds.top + Math.floor((SETTLED_LINES_DP * density) / 160),
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
    };
}

/**
 * `MOB-CHAT-COMPOSER-IME-01`: typing a new list item under an image placeholder while the IME holds a composition, as a
 * Chinese IME does for each key, leaves the lines above the caret where they are. Before the fix the field redrew its
 * whole text on every keystroke, and the pill and the first item jumped onto one line and back while the composition
 * was open.
 */
export async function executeMobileChatComposerImeScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('MOB-CHAT-COMPOSER-IME-01 records the composition');
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    try {
        if (!fixture.agentChat || !fixture.allowedSessionId)
            throw new Error('Chat fixture is unavailable');
        await addMobileGalleryImages(serial);
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await tapMobileCheck(serial, 'image-source-library');
        await pickMobileGalleryImages(serial);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'session-image-open-0') &&
                !hasCheck(nodes, 'session-image-status-0'),
            120_000,
        );
        await insertMobileInputUnicode(serial, 'agent-chat-composer-input', TYPED_LINES, DRAFT);
        // The capsule eases to its new height after the new line, so read the region once two reads agree.
        let region = await settledLinesBounds(serial);
        let settled = await mobileRegionFingerprint(serial, region);
        for (let attempt = 0; ; attempt += 1) {
            if (attempt === 20) throw new Error('The Chat composer did not settle');
            // eslint-disable-next-line no-await-in-loop -- each read compares with the previous one.
            await pause(400);
            // eslint-disable-next-line no-await-in-loop -- see above.
            const nextRegion = await settledLinesBounds(serial);
            // eslint-disable-next-line no-await-in-loop -- see above.
            const next = await mobileRegionFingerprint(serial, nextRegion);
            const isSame = next === settled && nextRegion.top === region.top;
            region = nextRegion;
            settled = next;
            if (isSame) break;
        }

        const moved: string[] = [];
        const frames =
            SAMPLES *
            KEYS.reduce(
                (count, key) => count + key.hold.length + (key.commit === undefined ? 0 : 1),
                0,
            );
        const sample = async (label: string) => {
            for (let index = 0; index < SAMPLES; index += 1) {
                // eslint-disable-next-line no-await-in-loop -- each frame is read after the previous one, in time order.
                if ((await mobileRegionFingerprint(serial, region)) !== settled)
                    moved.push(`${label}-${index}`);
            }
        };
        const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        try {
            await pause(800);
            for (const key of KEYS) {
                for (const held of key.hold) {
                    // eslint-disable-next-line no-await-in-loop -- keys arrive one at a time, as typed.
                    await broadcastMobileUnicode(serial, held, 'hold');
                    // eslint-disable-next-line no-await-in-loop -- see above.
                    await sample(`hold-${held}`);
                }
                if (key.commit !== undefined) {
                    // eslint-disable-next-line no-await-in-loop -- see above.
                    await broadcastMobileUnicode(serial, key.commit, 'commit');
                    // eslint-disable-next-line no-await-in-loop -- see above.
                    await sample(`commit-${key.commit}`);
                }
            }
            await pause(800);
        } finally {
            await recording.stop();
        }
        await capture(environment, 'composer-ime-settled', artifacts);
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: `${DRAFT}${TYPED_ITEM}`,
        });
        // Both outcomes are reported together: a field that drops the composition can also move the lines above it.
        const failures = [
            ...(draft.exists && draft.textMatches === true
                ? []
                : ['the composer does not hold the typed draft']),
            ...(moved.length === 0
                ? []
                : [
                      `the lines above the caret moved in ${moved.length} of ${frames} frames (${moved.join(', ')})`,
                  ]),
        ];
        if (failures.length > 0) {
            await writeJsonAtomic(environment.artifactManifestPath, {
                artifacts,
                schemaVersion: 1,
            });
            throw new Error(`IME composition failed: ${failures.join('; ')}`);
        }
        await finish(environment, artifacts, {
            framesSampled: frames,
            imeInput: 'setComposingText-held',
            motion: 'live',
            status: 'passed',
        });
    } finally {
        await removeMobileGalleryImages(serial);
        await fixture.stop();
    }
}

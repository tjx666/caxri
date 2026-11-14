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
 * The lines typed under the image's placeholder, ending on a new empty line where the next item is typed.
 */
const TYPED_LINES = '\n1. 这文件路径没法滚动\n';
const DRAFT = `[Image #1] ${TYPED_LINES}`;
/**
 * The composer's top padding and line height in dp (`sessionDetailStyles.composerExpanded`): the first two lines, the
 * pill and the first item, sit inside `11 + 2 * 21` dp below the field's top.
 */
const SETTLED_LINES_DP = 11 + 2 * 21;
/**
 * Frames sampled while each composition is held: a Chinese IME holds a typed key while its candidates show, and the
 * reported jitter lasted about a second.
 */
const SAMPLES = 10;

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
        const region = await settledLinesBounds(serial);
        const settled = await mobileRegionFingerprint(serial, region);

        const moved: string[] = [];
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
            await broadcastMobileUnicode(serial, '2', 'hold');
            await sample('hold-2');
            await broadcastMobileUnicode(serial, '2.', 'hold');
            await sample('hold-2.');
            await broadcastMobileUnicode(serial, '2.', 'commit');
            await sample('commit-2.');
            await pause(800);
        } finally {
            await recording.stop();
        }
        await capture(environment, 'composer-ime-settled', artifacts);
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: `${DRAFT}2.`,
        });
        if (!draft.exists || draft.textMatches !== true) {
            await writeJsonAtomic(environment.artifactManifestPath, {
                artifacts,
                schemaVersion: 1,
            });
            throw new Error('The composer does not hold the typed draft');
        }
        if (moved.length > 0) {
            await writeJsonAtomic(environment.artifactManifestPath, {
                artifacts,
                schemaVersion: 1,
            });
            throw new Error(
                `The lines above the caret moved during the IME composition in ${moved.length} of ${3 * SAMPLES} frames: ${moved.join(', ')}`,
            );
        }
        await finish(environment, artifacts, {
            framesSampled: 3 * SAMPLES,
            imeInput: 'setComposingText-held',
            motion: 'live',
            status: 'passed',
        });
    } finally {
        await removeMobileGalleryImages(serial);
        await fixture.stop();
    }
}

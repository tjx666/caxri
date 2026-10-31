import { repoContext, withRepoLock } from '../.agents/skills/switch-worktree/scripts/repo';

/**
 * How many Android Acceptance release builds may run at once across every worktree of this repository. Each Gradle
 * build already parallelizes across all cores, and concurrent builds contend on the shared `~/.gradle/caches` locks:
 * extra builds then fail with `Timeout waiting to lock file hash cache` instead of finishing sooner. See
 * `.agents/skills/acceptance/surfaces/android.md` for the measurements behind the value.
 */
export const ANDROID_BUILD_SLOT_COUNT = 2;

const SLOT_POLL_MS = 2_000;

/**
 * Runs `task` while holding one of the machine-wide Android build slots, queueing behind sibling worktrees' builds
 * until `deadlineMs`. The slot is released when the task settles, including after a failure.
 */
export async function withAndroidBuildSlot<T>(
    root: string,
    task: () => Promise<T> | T,
    options: {
        deadlineMs: number;
        onWait?: () => void;
        slotCount?: number;
    },
): Promise<T> {
    const context = await repoContext(root);
    const slotCount = options.slotCount ?? ANDROID_BUILD_SLOT_COUNT;
    let hasWaited = false;
    // Each attempt depends on which slots sibling runs hold now, so the poll is sequential.
    /* eslint-disable no-await-in-loop */
    for (;;) {
        for (let slot = 0; slot < slotCount; slot += 1) {
            const attempt = { isAcquired: false };
            try {
                return await withRepoLock(
                    context,
                    async () => {
                        attempt.isAcquired = true;
                        return task();
                    },
                    // A held slot fails this attempt at once so the next slot can be tried.
                    { namespace: `android-build-slot-${slot}`, timeoutMs: 0 },
                );
            } catch (error) {
                if (attempt.isAcquired) throw error;
                if (!(error instanceof Error) || !error.message.startsWith('Timed out waiting'))
                    throw error;
            }
        }
        if (Date.now() + SLOT_POLL_MS >= options.deadlineMs)
            throw new Error('Timed out waiting for an Android Acceptance build slot');
        if (!hasWaited) options.onWait?.();
        hasWaited = true;
        await new Promise((resolve) => setTimeout(resolve, SLOT_POLL_MS));
    }
    /* eslint-enable no-await-in-loop */
}

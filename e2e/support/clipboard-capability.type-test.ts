import type { RunningCaxri } from './helpers.ts';

export async function assertClipboardCapabilityBoundary(running: RunningCaxri): Promise<void> {
    await running.app.evaluate(
        // @ts-expect-error -- native clipboard access requires the explicit clipboard capability.
        ({ clipboard: systemClipboard }) => {
            // oxlint-disable-next-line typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- the intentionally rejected value exists only to prove the type boundary
            return systemClipboard.readText();
        },
    );
}

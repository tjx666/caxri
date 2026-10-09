import type { ITerminalAddon } from '@xterm/xterm';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type { TerminalWebglSessionPolicy } from '../terminal-webgl-session-policy';

/**
 * Stands in for xterm's WebGL addon; `loseContext()` fires the listener xterm would call once Chromium dropped the
 * context and no restore followed.
 */
export class FakeWebglAddon implements ITerminalAddon {
    private listener: (() => void) | undefined;
    readonly clearTextureAtlas: Mock<() => void> = vi.fn();
    readonly dispose: Mock<() => void> = vi.fn();

    activate(): void {}

    onContextLoss(listener: () => void) {
        this.listener = listener;
        return {
            dispose: () => {
                if (this.listener === listener) this.listener = undefined;
            },
        };
    }

    loseContext(): void {
        this.listener?.();
    }
}

export function createPolicy(
    overrides: Partial<TerminalWebglSessionPolicy> & { supported?: boolean } = {},
): TerminalWebglSessionPolicy {
    return {
        applyPreference: overrides.applyPreference ?? (() => {}),
        isPinnedToDom: overrides.isPinnedToDom ?? (() => false),
        isWebgl2Available: overrides.isWebgl2Available ?? (() => overrides.supported ?? true),
        liveWebglContextCount: overrides.liveWebglContextCount ?? (() => 0),
        recordContextLoss: overrides.recordContextLoss ?? (() => {}),
        recordWebglContextAcquired: overrides.recordWebglContextAcquired ?? (() => {}),
        recordWebglContextReleased: overrides.recordWebglContextReleased ?? (() => {}),
        resetForManualRetry: overrides.resetForManualRetry ?? (() => {}),
    };
}

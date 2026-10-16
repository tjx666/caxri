import type { AgentProvider } from '@caxri/protocol';

import type { PublicE2ELaunchStage } from '../../scripts/reporters/public-e2e-diagnostics.ts';
import type { ClipboardFixture } from './clipboard.ts';

export interface LaunchCaxriOptions {
    /**
     * Closed numeric checkpoints distinguish test setup from the application's own startup profile.
     */
    onLaunchStage?: (stage: PublicE2ELaunchStage, durationMs: number) => void;
    /**
     * Electron `userData` directory; callers create this with `mkdtemp`.
     */
    userDataDir: string;
    /**
     * Project root exposed to the app through `CAXRI_TEST_ROOT_PATH`.
     */
    testRootPath: string;
    /**
     * Extra environment variables layered over `process.env` and the Caxri E2E defaults below. Agent executables and
     * provider state belong in `agentMode`; use this only for a scenario-specific shell or tool environment.
     */
    env?: NodeJS.ProcessEnv;
    /**
     * Launches a packaged build instead of `.` (used by the startup benchmark).
     */
    executablePath?: string;
    /**
     * Bounded wait for another checkout's active desktop lease before launching this E2E instance.
     */
    desktopLeaseWaitMs?: number;
    /**
     * Hidden by default; use visible only for native focus, pointer, or desktop behavior.
     */
    windowMode?: 'hidden' | 'visible';
    /**
     * Keeps deterministic software rendering by default; WebGL renderer specs opt into GPU.
     */
    gpuMode?: 'disabled' | 'enabled';
    /**
     * Blocks host Agents by default; fake and real modes require an explicit per-spec choice.
     */
    agentMode?: E2EAgentMode;
    /**
     * Native quit choice; independent Host cleanup lets restart tests preserve tasks before a harness stop.
     */
    quitDecisionOnClose?: 'keep-running' | 'stop';
    /**
     * Restart workflows let the next launch inherit the same live Host; the final launch cleans it.
     */
    preserveHostOnClose?: boolean;
    /**
     * Declares that the spec needs the protected clipboard snapshot handle. Parallel-safe workers reject this
     * capability before launching Electron; desktop-exclusive, control, and focused launches preserve the existing
     * restore path.
     */
    clipboard?: boolean;
    /**
     * Seeds a native pasteboard fixture after the shared desktop lease is held and restores the pre-launch clipboard
     * after the launch's own format-complete restoration has been verified.
     */
    clipboardFixture?: ClipboardFixture;
}

export type E2EAgentMode =
    | { mode: 'blocked' }
    | {
          mode: 'fake';
          environment: NodeJS.ProcessEnv;
          executables: Partial<Record<AgentProvider, string>>;
      }
    | { mode: 'real'; provider?: AgentProvider; surface?: 'chat' | 'pty' };

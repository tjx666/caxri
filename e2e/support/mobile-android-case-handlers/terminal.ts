import { test } from '../fixtures';
import { capture, finish } from '../mobile-agent-actions-scenarios';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileTerminalScenario } from '../mobile-terminal-scenarios';
import { executeMobileTerminalScrollFeelScenario } from '../mobile-terminal-scroll-scenario';
import { executeMobileTerminalScrollbackScenario } from '../mobile-terminal-scrollback-scenario';

/**
 * The three Terminal cases share one call shape; only which Terminal fixture behavior they drive differs.
 */
function terminalCase(
    execute:
        | typeof executeMobileTerminalScenario
        | typeof executeMobileTerminalScrollFeelScenario
        | typeof executeMobileTerminalScrollbackScenario,
): MobileAndroidCaseHandler {
    return (environment, artifacts) => {
        test.setTimeout(420_000);
        return execute(environment, artifacts, capture, finish);
    };
}

export const handlers = {
    'MOB-TERM-01': terminalCase(executeMobileTerminalScenario),
    'MOB-TERM-SCROLL-FEEL-01': terminalCase(executeMobileTerminalScrollFeelScenario),
    'MOB-TERM-SCROLLBACK-01': terminalCase(executeMobileTerminalScrollbackScenario),
} satisfies Record<string, MobileAndroidCaseHandler>;

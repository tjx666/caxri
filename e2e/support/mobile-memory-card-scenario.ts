import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, isReachedWithin, waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

/**
 * The fake Codex `memorycard` turn saves one memory, points `MEMORY.md` at it, and edits another memory.
 */
const SAVED = 'agent-chat-memory-fix-from-requirements-not-patch';
const UPDATED = 'agent-chat-memory-keep-replies-short';

const isIdle = (snapshot: AgentChatSnapshot): boolean =>
    !snapshot.activeTurnId && snapshot.turns.every((turn) => turn.status !== 'running');

/**
 * `MOB-CHAT-MEMORY-CARD-01`: a turn that wrote Claude Code memory files ends with a memory card per memory rather than
 * an edited-files card holding the frontmatter diff. A tap opens the saved memory's Markdown, then the updated memory's
 * diff.
 */
export async function executeMobileMemoryCardScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await chat.send({ text: 'memorycard' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                isIdle(snapshot) && snapshot.items.some((item) => item.type === 'fileChange'),
        );
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat');
        // A baseline round on the previous build shows the memory files in the edited-files card instead, so it
        // captures that turn end before failing on the missing card.
        const hasCards = await isReachedWithin(serial, (nodes) => hasCheck(nodes, SAVED), 10_000);
        await capture(environment, 'memory-cards', artifacts);
        if (!hasCards) throw new Error('The turn ends without a memory card');
        await tapMobileCheck(serial, SAVED);
        await capture(environment, 'memory-saved-open', artifacts);
        await tapMobileCheck(serial, SAVED);
        await tapMobileCheck(serial, UPDATED);
        await capture(environment, 'memory-updated-open', artifacts);
        await finish(environment, artifacts, { status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

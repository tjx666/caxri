import type { ScenarioEnvironment } from './mobile-conversation-scenarios.ts';
import { executeMobileConversationScenario } from './mobile-conversation-scenarios.ts';
import { executeMobileConversationTransitionScenario } from './mobile-conversation-transition-scenario.ts';
import { executeMobileTimelineScenario } from './mobile-timeline-scenario.ts';

/**
 * Routes the Conversation family (`MOB-TIMELINE-01`, `MOB-CONV-*`, `MOB-UI-04`) to its scenario module. The timeline
 * and transition scenarios import the shared helpers from `mobile-conversation-scenarios.ts`, so they are dispatched
 * here rather than from that module, which would make an import cycle.
 */
export async function executeMobileConversationCase(
    environment: ScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    switch (environment.caseId) {
        case 'MOB-TIMELINE-01':
            await executeMobileTimelineScenario(environment, artifacts);
            return;
        case 'MOB-CONV-05':
            await executeMobileConversationTransitionScenario(environment, artifacts);
            return;
        default:
            await executeMobileConversationScenario(environment, artifacts);
    }
}

/**
 * Per Chat, the proposed plan whose approval card the user closed (Keep Planning) or already approved. Only the latest
 * plan can show a card (`agentChatImplementablePlanId`), so one item id per Chat is all that needs remembering. Module
 * state so leaving the Session and coming back does not bring the card back; it is not persisted, like Desktop's, so a
 * relaunch shows the card again for a plan the user is still planning around, which is harmless.
 */
const dismissed = new Map<string, string>();

export const dismissAgentChatPlan = (key: string, itemId: string): void => {
    dismissed.set(key, itemId);
};

export const dismissedAgentChatPlanId = (key: string): string | undefined => dismissed.get(key);

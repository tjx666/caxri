/**
 * The acceptance-only fault each case builds its APK with. A fault breaks one thing on purpose (a credential read, a
 * render, a Chat send's answer), so it is baked in only when that case runs alone: a batch would carry it into every
 * other case.
 */
const CASE_FAULTS: ReadonlyMap<string, string> = new Map([
    ['MOB-STORAGE-01', 'storage-read-once'],
    ['MOB-RENDER-01', 'render-once'],
    ['MOB-CHAT-SEND-UNKNOWN-01', 'chat-send-unknown-once'],
]);

/**
 * The `EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT` build variable for a round's case list; empty unless exactly one faulting
 * case runs.
 */
export function mobileAcceptanceFaultEnvironment(caseIds: readonly string[]): {
    EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT?: string;
} {
    const fault = caseIds.length === 1 ? CASE_FAULTS.get(caseIds[0]) : undefined;
    return fault ? { EXPO_PUBLIC_CAXRI_ACCEPTANCE_FAULT: fault } : {};
}

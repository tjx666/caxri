import process from 'node:process';

export const NATIVE_DIALOG_AUTHORIZATION_ENV = 'CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION';
export const NATIVE_DIALOG_AUTHORIZATION_VALUE = 'explicit-user-request';

/**
 * Native macOS UI is a manual Acceptance boundary by default because it can take the user's focus and its Accessibility
 * tree is slower and less deterministic than Caxri's fixture-backed Main boundary. The exact opt-in value forces an
 * agent to acknowledge a current, explicit user request before either opening or driving native UI; a generic
 * Acceptance request never grants this authority.
 */
export function isNativeDialogAuthorized(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment[NATIVE_DIALOG_AUTHORIZATION_ENV] === NATIVE_DIALOG_AUTHORIZATION_VALUE;
}

/**
 * Throws the operator-facing refusal unless {@link isNativeDialogAuthorized} holds.
 */
export function assertNativeDialogAuthorization(
    environment: NodeJS.ProcessEnv = process.env,
): void {
    if (isNativeDialogAuthorized(environment)) return;
    throw new Error(
        `Native dialog automation requires an explicit user request in the current conversation; use deterministic Main fixtures or hand the native step to the user. Only then set ${NATIVE_DIALOG_AUTHORIZATION_ENV}=${NATIVE_DIALOG_AUTHORIZATION_VALUE}`,
    );
}

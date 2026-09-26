import process from 'node:process';

/**
 * Keep the result pending long enough for Android Acceptance to cancel pairing.
 */
export async function shouldCancelDelayedPairing(isAccepting: () => boolean): Promise<boolean> {
    if (
        process.env.CAXRI_E2E !== '1' ||
        process.env.CAXRI_E2E_MOBILE_PAIRING_RESULT_DELAY !== '1'
    ) {
        return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    return !isAccepting();
}

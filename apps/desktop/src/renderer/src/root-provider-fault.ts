/**
 * E2E-only seam: `sessionStorage` key that makes the next root render throw from where a provider sits, so the recovery
 * screen can be proven for a provider-level failure (not only a failure inside the feature tree). The key is consumed
 * on read, so the recovery screen's Reload action renders normally instead of looping.
 */
export const ROOT_PROVIDER_FAULT_KEY = 'caxri.test.root-provider-fault';

/**
 * Reads and clears {@link ROOT_PROVIDER_FAULT_KEY}. The decision is cached per `memo` because React re-invokes a
 * component that threw (and StrictMode renders twice), and every attempt of the same pass must agree.
 */
export function shouldFailRootProvider(
    storage: Pick<Storage, 'getItem' | 'removeItem'>,
    memo: { fault?: boolean },
): boolean {
    if (memo.fault !== undefined) return memo.fault;
    memo.fault = storage.getItem(ROOT_PROVIDER_FAULT_KEY) === '1';
    if (memo.fault) storage.removeItem(ROOT_PROVIDER_FAULT_KEY);
    return memo.fault;
}

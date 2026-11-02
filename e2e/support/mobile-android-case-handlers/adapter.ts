import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

/**
 * The runner drives these cases itself (`scripts/mobile-android-built-in-scenarios.ts`) and never starts Playwright for
 * them, so they have no handler.
 */
export const handlers = {} satisfies Record<string, MobileAndroidCaseHandler>;

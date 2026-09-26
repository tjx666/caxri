export const MOBILE_FILES_MAX_ENTRIES = 500;
/**
 * Mobile reads are inlined in one command reply, so this bound protects the gateway's reply budget.
 */
export const MOBILE_FILES_READ_MAX_BYTES = 48 * 1_024;

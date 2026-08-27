interface AcceptanceAccessibilityOptions {
    environment: Record<string, string | undefined>;
    platform: NodeJS.Platform;
}

/**
 * Acceptance drives real macOS sheets through semantic Accessibility attributes. Electron leaves its complete native
 * tree disabled by default because exposing it has a runtime cost, so only the isolated Acceptance launcher may opt
 * in.
 */
export function shouldEnableAcceptanceAccessibility({
    environment,
    platform,
}: AcceptanceAccessibilityOptions): boolean {
    return platform === 'darwin' && environment.CAXRI_ACCEPTANCE === '1';
}

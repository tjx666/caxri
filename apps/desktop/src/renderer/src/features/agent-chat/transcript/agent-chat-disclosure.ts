/**
 * Motion classes for an Agent Chat disclosure chevron. The glyph turns on the disclosure tokens (DESIGN.md Motion), so
 * it moves with the content it reveals: expanding takes `--motion-expand` with the emphasized ease, collapsing
 * `--motion-collapse` with ease-in. Reduced motion turns it instantly.
 */
export function agentChatChevronMotion(isExpanded: boolean): string {
    return isExpanded
        ? 'transition-transform duration-(--motion-expand) ease-(--motion-ease-emphasized) motion-reduce:transition-none'
        : 'transition-transform duration-(--motion-collapse) ease-(--motion-ease-exit) motion-reduce:transition-none';
}

/**
 * The whole-Chat drop tint with its one-line caption, shown while a drag is over the Chat. The pane's section is the
 * positioned ancestor (the composer wrapper is not), so the tint covers the transcript too, matching where a drop is
 * accepted. It never takes pointer events, so the drag keeps reaching the section's handlers.
 */
export function AgentChatDropOverlay({
    isDragOver,
    supportsImages,
}: {
    isDragOver: boolean;
    supportsImages: boolean;
}) {
    if (!isDragOver) return null;
    return (
        <div className="motion-safe:animate-in motion-safe:fade-in-0 pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-accent/10 duration-(--motion-overlay-enter) ease-(--motion-ease-enter)">
            <span className="rounded-md bg-elevated px-3 py-1.5 text-[12px] text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]">
                {supportsImages ? 'Drop to attach images or insert paths' : 'Drop to insert paths'}
            </span>
        </div>
    );
}

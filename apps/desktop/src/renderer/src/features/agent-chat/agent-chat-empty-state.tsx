/**
 * What an empty Chat says in place of a timeline, and the hint under it on what the composer accepts. A Chat handed
 * over to another client takes no input here, so it shows no hint.
 */
export function AgentChatEmptyState({
    hint,
    message,
}: {
    hint: string | false;
    message: string | undefined;
}) {
    if (!message) return null;
    return (
        <div className="flex flex-col items-center gap-1.5 py-8 text-center">
            <p className="m-0 text-[13px] text-muted">{message}</p>
            {hint && <p className="m-0 text-[11px] leading-4 text-muted">{hint}</p>}
        </div>
    );
}

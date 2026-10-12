/**
 * A horizontal bar for a row's share of its card's total (never of its top row), so every share bar in a card reads on
 * one scale. Used by the report pages (Usage, an Agent's Context). Neutral rather than `--success`: a large share is
 * neither good nor bad. The figure it encodes is always printed beside it, so the bar is decoration.
 */
export function ShareBar({ share }: { share: number }) {
    return (
        <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-sm bg-elevated">
            <div
                className="h-full rounded-sm bg-chart"
                style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.min(1, share) * 100)}%` }}
            />
        </div>
    );
}

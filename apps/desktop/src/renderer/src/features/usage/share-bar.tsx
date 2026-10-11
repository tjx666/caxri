/**
 * A horizontal share bar. The figure it encodes is always printed beside it, so the bar is decoration.
 */
export function ShareBar({ share }: { share: number }) {
    return (
        <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-sm bg-elevated">
            <div
                className="h-full rounded-sm bg-success"
                style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.min(1, share) * 100)}%` }}
            />
        </div>
    );
}

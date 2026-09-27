/**
 * Replaces Chromium's default drag image, a translucent snapshot of the whole row with its indentation and hover fill,
 * with a solid label chip naming what is being dragged. VS Code does the same for its lists (`applyDragImage` in
 * `src/vs/base/browser/dnd.ts`). `setDragImage` snapshots the element synchronously, so the chip only has to be in the
 * document for this task and is removed on the next one.
 */
export function setLabelDragImage(dataTransfer: DataTransfer, label: string): void {
    const chip = document.createElement('div');
    chip.className =
        'pointer-events-none fixed -top-[1000px] left-0 whitespace-nowrap rounded-md bg-elevated px-2 py-0.5 text-[12px] text-foreground';
    chip.textContent = label;
    document.body.append(chip);
    dataTransfer.setDragImage(chip, -10, -10);
    setTimeout(() => chip.remove(), 0);
}

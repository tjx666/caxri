import type { ReactElement } from 'react';

import { ChevronDown, ZoomIn, ZoomOut } from 'lucide-react';

import { Button } from '../../components/ui/button';
import {
    Menu,
    MenuContent,
    MenuRadioGroup,
    MenuRadioItem,
    MenuTrigger,
} from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

function ZoomButton({
    label,
    icon,
    onClick,
}: {
    label: string;
    icon: ReactElement;
    onClick: () => void;
}) {
    return (
        <Tooltip content={label}>
            <Button aria-label={label} size="icon" variant="ghost" onClick={onClick}>
                {icon}
            </Button>
        </Tooltip>
    );
}

/**
 * Zoom Out, the zoom percentage, and Zoom In, shared by every zoomable preview (PDF, SVG, Mermaid) so they read and
 * behave alike. The percentage opens the preview's zoom choices: its fits and fixed scales. The checked row is the fit
 * in force, or the fixed scale matching the current zoom.
 */
export function ZoomControls<Choice extends number | string>({
    checked,
    choiceLabel,
    choices,
    scale,
    onZoom,
    onZoomIn,
    onZoomOut,
}: {
    /**
     * The choice in force, or `undefined` for a scale no choice names (after a pinch, say).
     */
    checked: Choice | undefined;
    choiceLabel: (choice: Choice) => string;
    choices: readonly Choice[];
    /**
     * The scale the view renders at, 1 being natural size, which the percentage shows.
     */
    scale: number;
    onZoom: (choice: Choice) => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
}) {
    const { t } = useTranslation();
    const percent = Math.round(scale * 100);
    return (
        <>
            <ZoomButton
                icon={<ZoomOut aria-hidden="true" size={14} />}
                label={t('preview.zoom.out')}
                onClick={onZoomOut}
            />
            <Menu>
                <MenuTrigger
                    aria-label={t('preview.zoom.label', { percent })}
                    render={
                        <Button
                            className="w-16 gap-0.5 px-1 text-[12px] tabular-nums"
                            size="sm"
                            variant="ghost"
                        />
                    }
                >
                    {percent}%
                    <ChevronDown aria-hidden="true" size={12} />
                </MenuTrigger>
                <MenuContent align="end" className="min-w-32">
                    {/* The radio value is the choice itself, so the checked row does not depend on the display language. */}
                    <MenuRadioGroup
                        value={checked === undefined ? null : String(checked)}
                        onValueChange={(value: string) => {
                            const option = choices.find((choice) => String(choice) === value);
                            if (option !== undefined) onZoom(option);
                        }}
                    >
                        {choices.map((choice) => (
                            <MenuRadioItem key={choice} closeOnClick value={String(choice)}>
                                {choiceLabel(choice)}
                            </MenuRadioItem>
                        ))}
                    </MenuRadioGroup>
                </MenuContent>
            </Menu>
            <ZoomButton
                icon={<ZoomIn aria-hidden="true" size={14} />}
                label={t('preview.zoom.in')}
                onClick={onZoomIn}
            />
        </>
    );
}

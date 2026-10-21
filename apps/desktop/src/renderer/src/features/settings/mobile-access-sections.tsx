import QRCode from 'react-qr-code';

import type { MobileAccessStatus, MobileDeviceSummary, ProjectQueryResult } from '@caxri/protocol';
import { MOBILE_MAX_PROJECT_GRANTS } from '@caxri/protocol';
import { Check, Clipboard, QrCode, Smartphone, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { FOCUSABLE_TOOLTIP_TRIGGER_CLASS, Tooltip } from '../../components/ui/tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { MobilePairingState, useMobileAccessController } from './use-mobile-access-controller';

/**
 * The QR code's own two colors, and the only place in the Renderer where a color is not a theme token: a scanner reads
 * the symbol's contrast, not the workbench's palette, and the light module color has to extend past the symbol as a
 * quiet zone for the code to be found at all. Both the module colors and the padding around them therefore come from
 * here rather than from `theme.css`, so a theme that darkens the surface cannot make the code unreadable.
 */
const QR_LIGHT = '#ffffff';
const QR_DARK = '#111111';

/**
 * A pairing link carries every private IPv4 address the Mac advertises, so it often reaches about 300 characters. At
 * error-correction level Q that is a 77x77-module symbol, which at the former 152px left about 2px per module: phone
 * cameras pointed at a laptop screen did not recognize it at all. An on-screen code cannot be smudged or torn, so level
 * M's recovery margin is enough, and it saves two symbol versions. 240px with level M keeps each module above 3px.
 */
const QR_LEVEL = 'M';
const QR_SIZE = 240;
/**
 * About four modules of quiet zone at {@link QR_SIZE}, the width the QR specification requires around the symbol.
 */
const QR_QUIET_ZONE = 16;

const expirationLabel = (t: Translate, expiresAt: number, now: number): string => {
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
    if (seconds === 0) return t('settings.mobileAccess.pairing.expired');
    return t('settings.mobileAccess.pairing.expiresIn', {
        remaining: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
    });
};

const deviceStatus = (t: Translate, device: MobileDeviceSummary): string => {
    if (device.revokedAt) return t('settings.mobileAccess.devices.revoked');
    if (!device.lastConnectedAt) return t('settings.mobileAccess.devices.paired');
    return t('settings.mobileAccess.devices.lastConnected', {
        time: new Date(device.lastConnectedAt).toLocaleString(),
    });
};

const MobileAccessStatusCard = ({
    activeDeviceCount,
    busy,
    onToggle,
    status,
}: {
    activeDeviceCount: number;
    busy: boolean;
    onToggle: (isEnabled: boolean) => void;
    status: MobileAccessStatus;
}) => {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-background p-3">
            <div className="flex min-w-0 items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
                    <Smartphone aria-hidden="true" size={16} />
                </span>
                <div className="min-w-0">
                    <p className="m-0 text-[12px] font-medium text-foreground">
                        {t(
                            status.enabled
                                ? 'settings.mobileAccess.status.available'
                                : 'settings.mobileAccess.status.offByDefault',
                        )}
                    </p>
                    <p className="m-0 mt-0.5 truncate text-[11px] text-muted">
                        {status.enabled && status.address && status.port
                            ? t(
                                  activeDeviceCount === 1
                                      ? 'settings.mobileAccess.status.listeningOne'
                                      : 'settings.mobileAccess.status.listeningOther',
                                  {
                                      address: status.address,
                                      port: status.port,
                                      count: activeDeviceCount,
                                  },
                              )
                            : t('settings.mobileAccess.status.noListener')}
                    </p>
                </div>
            </div>
            <Button
                aria-label={t(
                    status.enabled
                        ? 'settings.mobileAccess.status.turnOffLabel'
                        : 'settings.mobileAccess.status.turnOnLabel',
                )}
                disabled={busy}
                onClick={() => onToggle(!status.enabled)}
                variant={status.enabled ? 'secondary' : 'default'}
            >
                {t(
                    status.enabled
                        ? 'settings.mobileAccess.status.turnOff'
                        : 'settings.mobileAccess.status.turnOn',
                )}
            </Button>
        </div>
    );
};

const MobileProjectAccessSection = ({
    busy,
    onCreatePairing,
    onToggleProject,
    projects,
    selectedProjectIds,
}: {
    busy: boolean;
    onCreatePairing: () => void;
    onToggleProject: (projectId: string, isChecked: boolean) => void;
    projects: ProjectQueryResult['projects'];
    selectedProjectIds: Set<string>;
}) => {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2">
            <p className="m-0 text-[12px] font-medium text-foreground">
                {t('settings.mobileAccess.projects.title')}
            </p>
            <p className="m-0 text-[11px] leading-4 text-muted">
                {t('settings.mobileAccess.projects.description', {
                    selected: selectedProjectIds.size,
                    max: MOBILE_MAX_PROJECT_GRANTS,
                })}
            </p>
            <div className="grid max-h-32 gap-1 overflow-y-auto rounded-md border border-border bg-background p-2">
                {projects.map((project) => {
                    const checked = selectedProjectIds.has(project.id);
                    return (
                        <label
                            key={project.id}
                            className="flex min-h-7 cursor-pointer items-center gap-2 rounded px-1.5 hover:bg-[var(--selection)]"
                        >
                            <Checkbox
                                aria-label={t('settings.mobileAccess.projects.allow', {
                                    project: project.displayTitle,
                                })}
                                checked={checked}
                                disabled={
                                    !checked && selectedProjectIds.size >= MOBILE_MAX_PROJECT_GRANTS
                                }
                                onCheckedChange={(next) =>
                                    onToggleProject(project.id, next === true)
                                }
                            />
                            <span className="truncate text-[12px] text-foreground">
                                {project.displayTitle}
                            </span>
                        </label>
                    );
                })}
            </div>
            <Button
                className="w-fit"
                disabled={busy || selectedProjectIds.size === 0}
                onClick={onCreatePairing}
            >
                <QrCode aria-hidden="true" size={14} />
                {t('settings.mobileAccess.projects.createPairing')}
            </Button>
        </div>
    );
};

const MobilePairingCard = ({
    copied,
    isActive,
    now,
    onCopy,
    pairing,
}: {
    copied: boolean;
    isActive: boolean;
    now: number;
    onCopy: () => void;
    pairing: MobilePairingState;
}) => {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-elevated p-3">
            <div className="rounded-md" style={{ background: QR_LIGHT, padding: QR_QUIET_ZONE }}>
                {isActive ? (
                    <QRCode
                        bgColor={QR_LIGHT}
                        fgColor={QR_DARK}
                        level={QR_LEVEL}
                        size={QR_SIZE}
                        value={pairing.pairingLink}
                    />
                ) : (
                    <div
                        className="flex items-center justify-center text-[12px]"
                        style={{ color: QR_DARK, height: QR_SIZE, width: QR_SIZE }}
                    >
                        {t('settings.mobileAccess.pairing.expired')}
                    </div>
                )}
            </div>
            <div className="grid min-w-48 flex-1 gap-2">
                <p className="m-0 text-[12px] font-medium text-foreground">
                    {t('settings.mobileAccess.pairing.scan')}
                </p>
                <p className="m-0 text-[11px] leading-4 text-muted">
                    {t('settings.mobileAccess.pairing.description', {
                        expiration: expirationLabel(t, pairing.expiresAt, now),
                    })}
                </p>
                <Button
                    className="w-fit"
                    disabled={!isActive}
                    onClick={onCopy}
                    size="sm"
                    variant="secondary"
                >
                    {copied ? (
                        <Check aria-hidden="true" size={13} />
                    ) : (
                        <Clipboard aria-hidden="true" size={13} />
                    )}
                    {t(copied ? 'common.copied' : 'settings.mobileAccess.pairing.copyLink')}
                </Button>
            </div>
        </div>
    );
};

const MobilePairedDevicesSection = ({
    busy,
    devices,
    onRevoke,
    projectAccessByDevice,
}: {
    busy: boolean;
    devices: MobileDeviceSummary[];
    onRevoke: (deviceId: string) => void;
    projectAccessByDevice: Map<string, string>;
}) => {
    const { t } = useTranslation();
    return (
        <div className="grid gap-2">
            <p className="m-0 text-[12px] font-medium text-foreground">
                {t('settings.mobileAccess.devices.title')}
            </p>
            <div className="divide-y divide-border rounded-md border border-border bg-background">
                {devices.map((device) => (
                    <div
                        key={device.deviceId}
                        className="flex min-h-12 items-center justify-between gap-3 px-3 py-2"
                    >
                        <div className="min-w-0">
                            <p className="m-0 truncate text-[12px] text-foreground">
                                {device.displayName}
                            </p>
                            <p className="m-0 mt-0.5 truncate text-[11px] text-muted">
                                {device.platform === 'ios' ? 'iOS' : 'Android'} ·{' '}
                                {t(`settings.mobileAccess.devices.role.${device.role}`)} ·{' '}
                                {deviceStatus(t, device)}
                            </p>
                            <Tooltip content={projectAccessByDevice.get(device.deviceId)}>
                                <p
                                    className={cn(
                                        'm-0 mt-0.5 truncate text-[11px] text-muted',
                                        FOCUSABLE_TOOLTIP_TRIGGER_CLASS,
                                    )}
                                    tabIndex={0}
                                >
                                    {t('settings.mobileAccess.devices.access', {
                                        projects: projectAccessByDevice.get(device.deviceId) ?? '',
                                    })}
                                </p>
                            </Tooltip>
                        </div>
                        <Button
                            aria-label={t('settings.mobileAccess.devices.revoke', {
                                device: device.displayName,
                            })}
                            disabled={busy}
                            onClick={() => onRevoke(device.deviceId)}
                            size="icon"
                            variant="ghost"
                        >
                            <Trash2 aria-hidden="true" size={14} />
                        </Button>
                    </div>
                ))}
            </div>
        </div>
    );
};

export const MobileAccessSections = ({
    controller,
    status,
}: {
    controller: ReturnType<typeof useMobileAccessController>;
    status: MobileAccessStatus;
}) => (
    <>
        <MobileAccessStatusCard
            activeDeviceCount={controller.activeDevices.length}
            busy={controller.busy}
            onToggle={controller.applyAccess}
            status={status}
        />

        {status.enabled ? (
            <>
                <MobileProjectAccessSection
                    busy={controller.busy}
                    onCreatePairing={controller.createPairing}
                    onToggleProject={controller.toggleProject}
                    projects={controller.projects}
                    selectedProjectIds={controller.selectedProjectIds}
                />

                {controller.pairing ? (
                    <MobilePairingCard
                        copied={controller.copied}
                        isActive={controller.isPairingActive}
                        now={controller.now}
                        onCopy={controller.copyPairingLink}
                        pairing={controller.pairing}
                    />
                ) : null}

                {controller.activeDevices.length > 0 ? (
                    <MobilePairedDevicesSection
                        busy={controller.busy}
                        devices={controller.activeDevices}
                        onRevoke={controller.revoke}
                        projectAccessByDevice={controller.projectAccessByDevice}
                    />
                ) : null}
            </>
        ) : null}
    </>
);

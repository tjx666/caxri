import QRCode from 'react-qr-code';

import type { MobileAccessStatus, MobileDeviceSummary, ProjectQueryResult } from '@caxri/protocol';
import { MOBILE_MAX_PROJECT_GRANTS } from '@caxri/protocol';
import { Check, Clipboard, QrCode, Smartphone, Trash2 } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import type { MobilePairingState, useMobileAccessController } from './use-mobile-access-controller';

/**
 * The QR code's own two colors, and the only place in the Renderer where a color is not a theme token: a scanner reads
 * the symbol's contrast, not the workbench's palette, and the light module color has to extend past the symbol as a
 * quiet zone for the code to be found at all. Both the module colors and the padding around them therefore come from
 * here rather than from `theme.css`, so a theme that darkens the surface cannot make the code unreadable.
 */
const QR_LIGHT = '#ffffff';
const QR_DARK = '#111111';

const expirationLabel = (expiresAt: number, now: number): string => {
    const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
    if (seconds === 0) return 'Expired';
    return `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

const deviceStatus = (device: MobileDeviceSummary): string => {
    if (device.revokedAt) return 'Revoked';
    if (!device.lastConnectedAt) return 'Paired';
    return `Last connected ${new Date(device.lastConnectedAt).toLocaleString()}`;
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
}) => (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-background p-3">
        <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-elevated text-muted">
                <Smartphone aria-hidden="true" size={16} />
            </span>
            <div className="min-w-0">
                <p className="m-0 text-[12px] font-medium text-foreground">
                    {status.enabled ? 'Available on this network' : 'Off by default'}
                </p>
                <p className="m-0 mt-0.5 truncate text-[11px] text-muted">
                    {status.enabled && status.address && status.port
                        ? `${status.address}:${status.port} · ${activeDeviceCount} active device${activeDeviceCount === 1 ? '' : 's'}`
                        : 'No local network listener is running'}
                </p>
            </div>
        </div>
        <Button
            aria-label={status.enabled ? 'Turn off mobile access' : 'Turn on mobile access'}
            disabled={busy}
            onClick={() => onToggle(!status.enabled)}
            variant={status.enabled ? 'secondary' : 'default'}
        >
            {status.enabled ? 'Turn off' : 'Turn on'}
        </Button>
    </div>
);

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
}) => (
    <div className="grid gap-2">
        <p className="m-0 text-[12px] font-medium text-foreground">Project access</p>
        <p className="m-0 text-[11px] leading-4 text-muted">
            The new device can see only the selected Projects. You can revoke it at any time.
            Selected {selectedProjectIds.size} of up to {MOBILE_MAX_PROJECT_GRANTS}.
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
                            aria-label={`Allow ${project.displayTitle}`}
                            checked={checked}
                            disabled={
                                !checked && selectedProjectIds.size >= MOBILE_MAX_PROJECT_GRANTS
                            }
                            onCheckedChange={(next) => onToggleProject(project.id, next === true)}
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
            Create pairing code
        </Button>
    </div>
);

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
}) => (
    <div className="flex flex-wrap items-center gap-4 rounded-md border border-border bg-elevated p-3">
        <div className="rounded-md p-2" style={{ background: QR_LIGHT }}>
            {isActive ? (
                <QRCode
                    bgColor={QR_LIGHT}
                    fgColor={QR_DARK}
                    level="Q"
                    size={152}
                    value={pairing.pairingLink}
                />
            ) : (
                <div
                    className="flex size-38 items-center justify-center text-[12px]"
                    style={{ color: QR_DARK }}
                >
                    Expired
                </div>
            )}
        </div>
        <div className="grid min-w-48 flex-1 gap-2">
            <p className="m-0 text-[12px] font-medium text-foreground">Scan with Caxri Mobile</p>
            <p className="m-0 text-[11px] leading-4 text-muted">
                {expirationLabel(pairing.expiresAt, now)}. This code works once and stays on your
                local network.
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
                {copied ? 'Copied' : 'Copy pairing link'}
            </Button>
        </div>
    </div>
);

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
}) => (
    <div className="grid gap-2">
        <p className="m-0 text-[12px] font-medium text-foreground">Paired devices</p>
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
                            {device.platform === 'ios' ? 'iOS' : 'Android'} · {device.role} ·{' '}
                            {deviceStatus(device)}
                        </p>
                        <p
                            className="m-0 mt-0.5 truncate text-[11px] text-muted"
                            title={projectAccessByDevice.get(device.deviceId)}
                        >
                            Access: {projectAccessByDevice.get(device.deviceId)}
                        </p>
                    </div>
                    <Button
                        aria-label={`Revoke ${device.displayName}`}
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

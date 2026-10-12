export const gpu = {
    'gpu.turnOffConfirm.title': 'Turn off hardware acceleration and restart Caxri?',
    'gpu.turnOffConfirm.message':
        'Caxri restarts now and keeps drawing with software rendering every time it starts. Terminals keep working, but drawing may feel slower. You can turn hardware acceleration back on in Settings.',
    'gpu.turnOffConfirm.confirmLabel': 'Turn Off and Restart',
    'gpu.restartFailed': 'Unable to restart Caxri',
    'gpu.notice.gpuProcessRecovery':
        'A graphics failure interrupted drawing. Affected Terminals switched to software rendering. Retry GPU rendering from the status bar.',
    'gpu.notice.softwareRenderingPinned':
        'Caxri switched to software rendering after repeated graphics failures, and stays there until it restarts. Terminals keep working, but drawing may feel slower. Settings can turn hardware acceleration off for every launch, or leave it on to try the GPU again next time.',
    'gpu.notice.terminalFallback':
        'A graphics failure interrupted drawing in one Terminal. Caxri switched it to software rendering; it keeps working.',
} as const;

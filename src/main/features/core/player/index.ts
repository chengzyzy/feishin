import type {
    MpvInitializeResult,
    MpvOperationResult,
    MpvPropertySet,
} from '/@/shared/types/mpv-settings';
import type { ChildProcess } from 'node:child_process';

import { app, dialog, ipcMain, powerMonitor } from 'electron';
import { access, rm } from 'fs/promises';
import uniq from 'lodash/uniq';
import MpvAPI from 'node-mpv';
import { once } from 'node:events';
import { pid } from 'node:process';
import process from 'process';

import { getMainWindow, isTrustedIpcSender, sendToastToRenderer } from '../../../index';
import log from '../../../logger';
import { validateExecutableFile } from '../../../security/file-policy';
import {
    buildMpvLaunchOptions,
    sanitizeMpvExtraParameters,
    toMpvOperationError,
    validateMpvCompressorSettings,
    validateMpvEqSettings,
    validateMpvProperties,
} from '../../../security/mpv-policy';
import { store } from '../settings';

import { isMacOS, isWindows } from '/@/main/env';
import { PlayerData } from '/@/shared/types/domain-types';
import { buildMpvAudioFilters } from '/@/shared/utils/mpv-audio-filters';

declare module 'node-mpv';

// function wait(timeout: number) {
//     return new Promise((resolve) => {
//         setTimeout(() => {
//             resolve('resolved');
//         }, timeout);
//     });
// }

let mpvInstance: MpvAPI | null = null;
let mpvLifecycle: Promise<unknown> = Promise.resolve();
let currentPlayerData: null | PlayerData = null;
const socketPath = isWindows() ? `\\\\.\\pipe\\mpvserver-${pid}` : `/tmp/node-mpv-${pid}.sock`;

// While quitting/restarting mpv, playlist-pos goes to -1 and node-mpv emits stopped/paused/
// resumed. Those look identical to a real track end and must not reach the renderer — otherwise
// handleTrackEnded runs mediaAutoNext while status is STOPPED and flips the UI back to Playing
// on the next queue item (e.g. MPV reload after mediaStop).
let suppressRendererPlaybackEvents = false;
// Bumped on quit so late events from a dying instance are ignored after a new one starts.
let playbackEventGeneration = 0;

const sendRendererPlaybackEvent = (channel: string, ...args: unknown[]) => {
    if (suppressRendererPlaybackEvents) {
        return;
    }
    getMainWindow()?.webContents.send(channel, ...args);
};

const NodeMpvErrorCode = {
    0: 'Unable to load file or stream',
    1: 'Invalid argument',
    2: 'Binary not found',
    3: 'IPC command invalid',
    4: 'Unable to bind IPC socket',
    5: 'Connection timeout',
    6: 'MPV is already running',
    7: 'Could not send IPC message',
    8: 'MPV is not running',
    9: 'Unsupported protocol',
};

type NodeMpvError = {
    errcode: number;
    method: string;
    stackTrace: string;
    verbose: string;
};

const mpvLog = (
    data: {
        action: string;
        level?: 'debug' | 'error' | 'info' | 'warn';
        toast?: 'info' | 'success' | 'warning';
    },
    err?: NodeMpvError,
) => {
    const { action, toast } = data;

    if (err) {
        const message = `${action} - mpv errorcode ${err.errcode} - ${
            NodeMpvErrorCode[err.errcode as keyof typeof NodeMpvErrorCode]
        }`;

        sendToastToRenderer({ message, type: 'error' });
        log.error(message);
        return;
    }

    const level = data.level ?? 'info';
    log[level](action);
    if (toast) {
        sendToastToRenderer({ message: action, type: toast });
    }
};

const MACOS_MPV_BINARY_PATHS = ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'];

const prefetchPlaylistParams = [
    '--prefetch-playlist=no',
    '--prefetch-playlist=yes',
    '--prefetch-playlist',
];

const DEFAULT_MPV_PARAMETERS = (extraParameters?: string[]) => {
    const parameters = ['--idle=yes', '--no-config', '--load-scripts=no'];

    if (!extraParameters?.some((param) => prefetchPlaylistParams.includes(param))) {
        parameters.push('--prefetch-playlist=yes');
    }

    // Without these, mpv/ffmpeg will block indefinitely on a dead TCP connection
    // instead of failing or reconnecting. This commonly happens when the OS network
    // adapter resets after the system wakes from sleep while a stream is open.
    if (!extraParameters?.some((param) => param.startsWith('--network-timeout'))) {
        parameters.push('--network-timeout=10');
    }

    if (!extraParameters?.some((param) => param.startsWith('--stream-lavf-o'))) {
        parameters.push(
            '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_at_eof=1,reconnect_delay_max=5',
        );
    }

    return parameters;
};

const resolveMpvBinaryPath = async () => {
    const storedBinaryPath = store.get('mpv_path') as string | undefined;
    if (storedBinaryPath) {
        const validated = await validateExecutableFile(storedBinaryPath);
        if (validated.ok && validated.paths?.[0]) {
            return validated.paths[0];
        }

        log.warn('Configured mpv executable is no longer valid');
    }

    if (!isMacOS()) {
        return undefined;
    }

    for (const candidate of MACOS_MPV_BINARY_PATHS) {
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the next common Homebrew location.
        }
    }

    return undefined;
};

const createMpv = async ({
    extraParameters = [],
    properties = {},
}: {
    extraParameters?: string[];
    properties?: MpvPropertySet;
}): Promise<MpvAPI> => {
    const resolvedBinaryPath = await resolveMpvBinaryPath();
    const params = uniq([...DEFAULT_MPV_PARAMETERS(extraParameters), ...extraParameters]);
    const launchOptions = buildMpvLaunchOptions(resolvedBinaryPath, socketPath);

    // ipc_command is set in launchOptions, so node-mpv skips its shell-based
    // mpv --version probe and starts the binary through the argument vector.
    const mpv = new MpvAPI(
        launchOptions as unknown as ConstructorParameters<typeof MpvAPI>[0],
        params,
    );

    try {
        await mpv.start();
        await mpv.setMultipleProperties(properties);
        log.info('mpv initialized', { binary: resolvedBinaryPath ?? 'bundled/default' });
    } catch (error) {
        if (getMpvChildProcess(mpv)) {
            try {
                await quit(mpv);
            } catch (cleanupError) {
                // 保留未完成清理的实例，下次启动前仍需等待它退出。
                mpvInstance = mpv;
                log.error('Failed to clean up MPV after startup failure', cleanupError);
            }
        }
        throw error;
    }

    let previousPlaylistPos: number | undefined;
    const eventGeneration = playbackEventGeneration;

    suppressRendererPlaybackEvents = false;

    const sendIfCurrent = (channel: string, ...args: unknown[]) => {
        if (eventGeneration !== playbackEventGeneration) {
            return;
        }
        sendRendererPlaybackEvent(channel, ...args);
    };

    mpv.on('status', (status) => {
        if (status.property === 'playlist-pos') {
            const currentPos = typeof status.value === 'number' ? status.value : undefined;

            // mpv uses playlist-pos = -1 when nothing is playing (ended, cleared, load failure, etc).
            if (currentPos === -1) {
                if (previousPlaylistPos === 0) {
                    sendIfCurrent('renderer-player-track-ended');
                }
                mpv?.pause();
                previousPlaylistPos = currentPos;
                return;
            }

            // In our 2-item queue model, playlist-pos should normally be 0.
            // When mpv auto-advances to the next track it becomes > 0 (typically 1).
            if (typeof currentPos === 'number' && currentPos > 0) {
                sendIfCurrent('renderer-player-auto-next');
            }

            previousPlaylistPos = currentPos;
        }
    });

    // Automatically updates the play button when the player is playing
    mpv.on('resumed', () => {
        sendIfCurrent('renderer-player-play');
    });

    // Automatically updates the play button when the player is stopped
    mpv.on('stopped', () => {
        sendIfCurrent('renderer-player-stop');
    });

    // Automatically updates the play button when the player is paused
    mpv.on('paused', () => {
        sendIfCurrent('renderer-player-pause');
    });

    // Event output every interval set by time_update, used to update the current time
    mpv.on('timeposition', (time: number) => {
        if (eventGeneration !== playbackEventGeneration) {
            return;
        }
        getMainWindow()?.webContents.send('renderer-player-current-time', time);
    });

    return mpv;
};

export const getMpvInstance = () => {
    return mpvInstance;
};

const QUIT_TIMEOUT_MS = 3000;

// 固定版本在运行时保留子进程句柄，但未在类型声明中暴露该字段。
const getMpvChildProcess = (mpv: MpvAPI): ChildProcess | undefined =>
    (mpv as MpvAPI & { mpvPlayer?: ChildProcess }).mpvPlayer;

const isMpvChildRunning = (child?: ChildProcess): child is ChildProcess =>
    child?.pid !== undefined && child.exitCode === null && child.signalCode === null;

const runMpvLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
    // 设备枚举、退出和初始化共用同一个 socket，需要按请求顺序执行。
    const pending = mpvLifecycle.then(operation);
    mpvLifecycle = pending.catch(() => undefined);
    return pending;
};

const withMpvDeadline = async <T>(operation: Promise<T>, message: string): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), QUIT_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
};

const waitForMpvExit = async (child?: ChildProcess) => {
    if (!isMpvChildRunning(child)) return;
    const listener = new AbortController();
    try {
        await withMpvDeadline(once(child, 'exit', { signal: listener.signal }), 'MPV did not exit');
    } finally {
        listener.abort();
    }
};

const quit = async (mpv: MpvAPI) => {
    suppressRendererPlaybackEvents = true;
    playbackEventGeneration += 1;
    const child = getMpvChildProcess(mpv);

    try {
        // IPC 回复可能因网络流卡住而永远不到。收到回复后仍须确认进程退出。
        await withMpvDeadline(mpv.quit(), 'MPV did not answer the quit request');
        await waitForMpvExit(child);
    } catch (error) {
        if (!child) throw error;
        if (isMpvChildRunning(child)) {
            child.kill('SIGKILL');
            await waitForMpvExit(child);
        }
        log.warn('MPV quit needed forced cleanup', error);
    }

    if (!isWindows()) await rm(socketPath, { force: true });
};

const setAudioPlayerFallback = (isError: boolean) => {
    if (isError) {
        log.warn('MPV is unavailable');
    }
    getMainWindow()?.webContents.send('renderer-player-fallback', isError);
};

const quitCurrentMpv = async () => {
    if (mpvInstance) await quit(mpvInstance);
    mpvInstance = null;
};

const sendMpvPolicyWarning = (kind: 'parameters' | 'properties', rejected: string[]) => {
    if (rejected.length === 0) return;
    const visible = rejected.slice(0, 5).join(', ');
    const suffix = rejected.length > 5 ? ', ...' : '';
    sendToastToRenderer({
        message: `Ignored unsupported MPV ${kind}: ${visible}${suffix}`,
        type: 'warning',
    });
};

ipcMain.handle(
    'player-set-properties',
    async (event, data: unknown): Promise<MpvOperationResult> => {
        if (!isTrustedIpcSender(event)) {
            return { error: 'Untrusted renderer', success: false };
        }

        const validation = validateMpvProperties(data);
        sendMpvPolicyWarning('properties', validation.rejected);
        const properties = validation.accepted;
        const propertyNames = Object.keys(properties);
        if (propertyNames.length === 0) {
            return {
                rejectedProperties: validation.rejected,
                success: validation.rejected.length === 0,
            };
        }

        const mpv = getMpvInstance();
        if (!mpv) {
            return {
                error: 'MPV is not running',
                rejectedProperties: validation.rejected,
                success: false,
            };
        }

        try {
            if (propertyNames.length === 1) {
                await mpv.setProperty(propertyNames[0], properties[propertyNames[0]]);
            } else {
                await mpv.setMultipleProperties(properties);
            }
            return {
                rejectedProperties: validation.rejected,
                success: true,
            };
        } catch (err) {
            mpvLog({ action: 'Failed to set properties' }, err as NodeMpvError);
            return {
                ...toMpvOperationError(err),
                rejectedProperties: validation.rejected,
            };
        }
    },
);

ipcMain.handle(
    'player-set-audio-filters',
    async (
        event,
        data: { compressor?: unknown; equalizer?: unknown },
    ): Promise<MpvOperationResult> => {
        if (!isTrustedIpcSender(event)) {
            return { error: 'Untrusted renderer', success: false };
        }

        const equalizer = validateMpvEqSettings(data?.equalizer);
        const compressor = validateMpvCompressorSettings(data?.compressor);
        if (!equalizer.ok || !equalizer.value || !compressor.ok || !compressor.value) {
            sendToastToRenderer({
                message: 'Rejected invalid MPV audio filter settings',
                type: 'warning',
            });
            return { error: 'Invalid MPV audio filter settings', success: false };
        }

        const mpv = getMpvInstance();
        if (!mpv) {
            return { error: 'MPV is not running', success: false };
        }

        try {
            const filterValue = buildMpvAudioFilters(equalizer.value, compressor.value);
            await mpv.setProperty('af', filterValue);
            return { success: true };
        } catch (err) {
            mpvLog({ action: 'Failed to set audio filters' }, err as NodeMpvError);
            return toMpvOperationError(err);
        }
    },
);

ipcMain.handle('mpv-select-binary', async (event) => {
    if (!isTrustedIpcSender(event)) return null;

    const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        title: 'Select mpv executable',
    });

    const selectedPath = result.filePaths[0];
    if (result.canceled || !selectedPath) return null;

    const validated = await validateExecutableFile(selectedPath);
    if (!validated.ok || !validated.paths?.[0]) {
        log.warn('Rejected mpv executable selection', { reason: validated.reason });
        return null;
    }

    store.set('mpv_path', validated.paths[0]);
    return validated.paths[0];
});

ipcMain.handle('mpv-clear-binary', (event) => {
    if (!isTrustedIpcSender(event)) return false;
    store.delete('mpv_path');
    return true;
});

const initializeMpv = async (
    event: Electron.IpcMainInvokeEvent,
    data: unknown,
): Promise<MpvInitializeResult> => {
    if (!isTrustedIpcSender(event)) {
        return { error: 'Untrusted renderer', success: false };
    }

    const raw = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const extraParameters = sanitizeMpvExtraParameters(raw.extraParameters);
    const properties = validateMpvProperties(raw.properties);
    const rejectedOptions = {
        rejectedParameters: extraParameters.rejected,
        rejectedProperties: properties.rejected,
    };
    sendMpvPolicyWarning('parameters', extraParameters.rejected);
    sendMpvPolicyWarning('properties', properties.rejected);

    return runMpvLifecycle(async () => {
        try {
            await quitCurrentMpv();
            mpvInstance = await createMpv({
                extraParameters: extraParameters.accepted,
                properties: properties.accepted,
            });
            setAudioPlayerFallback(false);
            return { ...rejectedOptions, success: true };
        } catch (error) {
            mpvLog({ action: 'Failed to initialize MPV' }, error as NodeMpvError);
            setAudioPlayerFallback(true);
            return { ...rejectedOptions, ...toMpvOperationError(error) };
        }
    });
};

ipcMain.handle('player-initialize', initializeMpv);

ipcMain.handle('player-restart', async (event, settings: unknown) => {
    const result = await initializeMpv(event, settings);
    if (result.success) mpvLog({ action: 'Restarted mpv', toast: 'success' });
    return result;
});

ipcMain.on('player-quit', async (event) => {
    if (!isTrustedIpcSender(event)) return;
    try {
        await runMpvLifecycle(quitCurrentMpv);
    } catch (error) {
        mpvLog({ action: 'Failed to quit MPV' }, error as NodeMpvError);
    }
});

ipcMain.handle('player-is-running', async () => {
    return getMpvInstance()?.isRunning();
});

ipcMain.handle('player-clean-up', async () => {
    getMpvInstance()?.stop();
    getMpvInstance()?.clearPlaylist();
});

ipcMain.on('player-start', async () => {
    try {
        await getMpvInstance()?.play();
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: 'Failed to start mpv playback' }, err);
    }
});

// Starts the player
ipcMain.on('player-play', async () => {
    try {
        await getMpvInstance()?.play();
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: 'Failed to start mpv playback' }, err);
    }
});

// Pauses the player
ipcMain.on('player-pause', async () => {
    try {
        await getMpvInstance()?.pause();
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: 'Failed to pause mpv playback' }, err);
    }
});

// Stops the player
ipcMain.on('player-stop', async () => {
    try {
        await getMpvInstance()?.stop();
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: 'Failed to stop mpv playback' }, err);
    }
});

// Goes to the next track in the playlist
ipcMain.on('player-next', async () => {
    try {
        await getMpvInstance()?.next();
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: 'Failed to go to next track' }, err);
    }
});

// Goes to the previous track in the playlist
ipcMain.on('player-previous', async () => {
    try {
        await getMpvInstance()?.prev();
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: 'Failed to go to previous track' }, err);
    }
});

// Seeks forward or backward by the given amount of seconds
ipcMain.on('player-seek', async (_event, time: number) => {
    try {
        await getMpvInstance()?.seek(time);
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to seek by ${time} seconds` }, err);
    }
});

// Seeks to the given time in seconds
ipcMain.on('player-seek-to', async (_event, time: number) => {
    try {
        await getMpvInstance()?.goToPosition(time);
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to seek to ${time} seconds` }, err);
    }
});

// Sets the queue in position 0 and 1 to the given data. Used when manually starting a song or using the next/prev buttons
ipcMain.on('player-set-queue', async (_event, current?: string, next?: string, pause?: boolean) => {
    if (!current && !next) {
        try {
            await getMpvInstance()?.clearPlaylist();
            await getMpvInstance()?.pause();
            return;
        } catch (err: any | NodeMpvError) {
            mpvLog({ action: `Failed to clear play queue` }, err);
        }
    }

    // When pause is requested (e.g. preload after reload while UI is STOPPED/PAUSED), mpv still
    // briefly resumes on load. Suppress those events so they do not overwrite renderer status.
    const shouldSuppressLoadEvents = pause === true;
    if (shouldSuppressLoadEvents) {
        suppressRendererPlaybackEvents = true;
    }

    try {
        if (current) {
            try {
                await getMpvInstance()?.load(current, 'replace');
            } catch (error: any | NodeMpvError) {
                mpvLog({ action: `Failed to load current song` }, error);
                await getMpvInstance()?.play();
            }

            if (next) {
                await getMpvInstance()?.load(next, 'append');
            }
        }

        if (pause) {
            await getMpvInstance()?.pause();
        } else if (pause === false) {
            // Only force play if pause is explicitly false
            await getMpvInstance()?.play();
        }
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to set play queue` }, err);
    } finally {
        if (shouldSuppressLoadEvents) {
            suppressRendererPlaybackEvents = false;
        }
    }
});

// Replaces the queue in position 1 to the given data
ipcMain.on('player-set-queue-next', async (_event, url?: string) => {
    try {
        const size = await getMpvInstance()?.getPlaylistSize();

        if (size && size > 1) {
            await getMpvInstance()?.playlistRemove(1);
        }

        if (url) {
            getMpvInstance()?.load(url, 'append');
        }
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to set play queue` }, err);
    }
});

// Sets the next song in the queue when reaching the end of the queue
ipcMain.on('player-auto-next', async (_event, url?: string) => {
    // Always keep the current song as position 0 in the mpv queue
    // This allows us to easily set update the next song in the queue without
    // disturbing the currently playing song

    try {
        await getMpvInstance()
            ?.playlistRemove(0)
            .catch(() => {
                getMpvInstance()?.pause();
            });

        if (url) {
            await getMpvInstance()?.load(url, 'append');
        }
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to load next song` }, err);
    }
});

// Sets the volume to the given value (0-100)
ipcMain.on('player-volume', async (_event, value: number) => {
    try {
        if (!value || value < 0 || value > 100) {
            return;
        }

        await getMpvInstance()?.volume(value);
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to set volume to ${value}` }, err);
    }
});

// Toggles the mute status
ipcMain.on('player-mute', async (_event, mute: boolean) => {
    try {
        await getMpvInstance()?.mute(mute);
    } catch (err: any | NodeMpvError) {
        mpvLog({ action: `Failed to set mute status` }, err);
    }
});

ipcMain.handle('player-get-time', async (): Promise<number | undefined> => {
    try {
        const mpv = getMpvInstance();
        if (!mpv) {
            return undefined;
        }
        const isIdle = await mpv.getProperty('idle-active').catch(() => true);
        if (isIdle) {
            return undefined;
        }
        return await mpv.getTimePosition();
    } catch (err: any | NodeMpvError) {
        // Err 3: IPC command invalid — e.g. time-pos unavailable when idle / between tracks
        if (err?.errcode === 3) {
            return undefined;
        }
        mpvLog({ action: `Failed to get current time` }, err);
        return undefined;
    }
});

// Updates the current player metadata (song data)
ipcMain.on('player-update-metadata', (_event, data: PlayerData) => {
    currentPlayerData = data;
});

// Returns the current player metadata (song data)
ipcMain.handle('player-metadata', async (): Promise<null | PlayerData> => {
    return currentPlayerData;
});

// Returns the stream metadata from mpv (for radio streams)
ipcMain.handle(
    'player-stream-metadata',
    async (): Promise<null | { artist: null | string; title: null | string }> => {
        try {
            const metadata = await getMpvInstance()?.getProperty('metadata');
            if (metadata && typeof metadata === 'object') {
                // Try to get separate title and artist fields first
                let artist: null | string =
                    (metadata['artist'] as string) ||
                    (metadata['ARTIST'] as string) ||
                    (metadata['icy-artist'] as string) ||
                    null;
                let title: null | string =
                    (metadata['title'] as string) || (metadata['TITLE'] as string) || null;

                // If we don't have separate fields, try to parse from combined formats
                if (!title && !artist) {
                    const combinedTitle =
                        (metadata['icy-title'] as string) ||
                        (metadata['StreamTitle'] as string) ||
                        (metadata['stream-title'] as string) ||
                        null;

                    if (combinedTitle && typeof combinedTitle === 'string') {
                        // Try to parse "Artist - Title" format
                        const match = combinedTitle.match(/^(.*?)\s*[-–—]\s*(.+)$/);
                        if (match) {
                            artist = match[1].trim() || null;
                            title = match[2].trim() || null;
                        } else {
                            // If no separator found, treat the whole thing as title
                            title = combinedTitle;
                        }
                    }
                } else if (!title) {
                    // If we have artist but no title, try to get from combined format
                    const combinedTitle =
                        (metadata['icy-title'] as string) ||
                        (metadata['StreamTitle'] as string) ||
                        (metadata['stream-title'] as string) ||
                        null;
                    if (combinedTitle && typeof combinedTitle === 'string') {
                        title = combinedTitle;
                    }
                } else if (!artist) {
                    // If we have title but no artist, try to get from combined format
                    const combinedTitle =
                        (metadata['icy-title'] as string) ||
                        (metadata['StreamTitle'] as string) ||
                        (metadata['stream-title'] as string) ||
                        null;
                    if (
                        combinedTitle &&
                        typeof combinedTitle === 'string' &&
                        combinedTitle !== title
                    ) {
                        // Try to parse artist from combined format
                        const match = combinedTitle.match(/^(.*?)\s*[-–—]\s*(.+)$/);
                        if (match && match[2].trim() === title) {
                            artist = match[1].trim() || null;
                        }
                    }
                }

                return { artist, title };
            }
            return null;
        } catch (err: any | NodeMpvError) {
            mpvLog({ action: `Failed to get stream metadata` }, err);
            return null;
        }
    },
);

ipcMain.handle(
    'player-get-audio-devices',
    async (event): Promise<{ label: string; value: string }[]> => {
        if (!isTrustedIpcSender(event)) return [];
        try {
            return await runMpvLifecycle(async () => {
                const current = mpvInstance?.isRunning() ? mpvInstance : null;
                if (!current) await quitCurrentMpv();
                const mpv = current ?? (await createMpv({}));

                try {
                    const devices = await withMpvDeadline(
                        mpv.getProperty('audio-device-list'),
                        'MPV did not answer the audio device request',
                    );
                    if (!Array.isArray(devices)) return [];

                    return devices.map((device) => {
                        const name = device.name || device.description || 'Unknown Device';
                        const description = device.description || '';
                        return {
                            label: description ? `${name} (${description})` : name,
                            value: name,
                        };
                    });
                } finally {
                    if (!current) {
                        try {
                            await quit(mpv);
                        } catch (error) {
                            // 让下一次生命周期操作重试清理这个实例。
                            mpvInstance = mpv;
                            mpvLog(
                                { action: 'Failed to clean up the MPV device probe' },
                                error as NodeMpvError,
                            );
                        }
                    }
                }
            });
        } catch (error) {
            mpvLog({ action: 'Failed to get audio devices' }, error as NodeMpvError);
            return [];
        }
    },
);

enum MpvState {
    STARTED,
    IN_PROGRESS,
    DONE,
}

let mpvState = MpvState.STARTED;

// Cleanup function that can be called from multiple places
const cleanupMpv = async (force = false) => {
    if (mpvState === MpvState.DONE && !force) return;

    try {
        await runMpvLifecycle(quitCurrentMpv);
    } catch (error) {
        mpvLog({ action: 'Failed to clean up MPV' }, error as NodeMpvError);
    }
};

// When the OS resumes from sleep, any network stream mpv had open is likely dead
// (the connection silently dropped while the network adapter was suspended). Tell
// the renderer to reload mpv so it reconnects with a fresh stream instead of staying
// stuck on the old, now-dead connection until the app is manually restarted.
powerMonitor.on('resume', () => {
    mpvLog({ action: 'System resumed from sleep, notifying renderer to reconnect mpv' });
    getMainWindow()?.webContents.send('renderer-mpv-reconnect');
});

app.on('before-quit', async (event) => {
    switch (mpvState) {
        case MpvState.DONE:
            return;
        case MpvState.IN_PROGRESS:
            event.preventDefault();
            break;
        case MpvState.STARTED: {
            try {
                mpvState = MpvState.IN_PROGRESS;
                event.preventDefault();
                await cleanupMpv();
            } catch (err: any | NodeMpvError) {
                mpvLog({ action: `Failed to cleanly before-quit` }, err);
            } finally {
                mpvState = MpvState.DONE;
                app.quit();
            }
            break;
        }
    }
});

// Handle process exit events to ensure mpv is killed even if app crashes
process.on('exit', () => {
    const instance = getMpvInstance();
    if (instance) {
        // Try to access and kill the process directly
        const mpvProcess = getMpvChildProcess(instance);
        if (mpvProcess) {
            try {
                mpvProcess.kill('SIGKILL');
            } catch {
                // Ignore errors during exit
            }
        }
    }
});

// Handle signals that can terminate the process
process.on('SIGINT', async () => {
    await cleanupMpv(true);
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await cleanupMpv(true);
    process.exit(0);
});

// Handle uncaught exceptions - cleanup mpv before crashing
process.on('uncaughtException', async (error) => {
    log.error('Uncaught exception:', error);
    await cleanupMpv(true).catch(() => {
        // Ignore cleanup errors during crash
    });
});

// Handle unhandled rejections - cleanup mpv
process.on('unhandledRejection', async (reason) => {
    log.error('Unhandled rejection:', reason);
    await cleanupMpv(true).catch(() => {
        // Ignore cleanup errors
    });
});

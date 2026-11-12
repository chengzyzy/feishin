import type {
    MpvCompressorSettings,
    MpvEqBand,
    MpvEqSettings,
    MpvOperationResult,
    MpvPropertySet,
} from '/@/shared/types/mpv-settings';

// MPV 0.17.0 and newer use --input-ipc-server. The older --input-unix-socket
// form is intentionally not accepted because it would require the shell probe.
export const MPV_IPC_COMMAND = '--input-ipc-server';

const MAX_EXTRA_PARAMETERS = 64;
const MAX_PARAMETER_LENGTH = 512;
const MAX_PROPERTIES = 32;
const MAX_EQ_BANDS = 32;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const inRange = (value: unknown, min: number, max: number): value is number =>
    isFiniteNumber(value) && value >= min && value <= max;

const hasSafeText = (value: string): boolean =>
    value.length > 0 && value.length <= MAX_PARAMETER_LENGTH && !/[\0\r\n]/.test(value);

const numericValue = (value: string): null | number => {
    if (!/^-?\d+(?:\.\d+)?$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const integerValue = (value: string): null | number => {
    if (!/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const allowedExtraParameter = (parameter: string): boolean => {
    if (!parameter.startsWith('--') || !hasSafeText(parameter)) return false;

    if (parameter === '--prefetch-playlist') return true;
    if (/^--prefetch-playlist=(?:no|yes)$/.test(parameter)) return true;
    if (/^--audio-pitch-correction=(?:no|yes)$/.test(parameter)) return true;
    if (/^--audio-format=(?:float|s16|s32)$/.test(parameter)) return true;
    if (/^--gapless-audio=(?:no|weak|yes)$/.test(parameter)) return true;
    if (/^--replaygain=(?:album|no|track)$/.test(parameter)) return true;
    if (/^--replaygain-clip=(?:no|yes)$/.test(parameter)) return true;

    const audioDevice = parameter.match(/^--audio-device=(.+)$/);
    if (audioDevice) {
        return /^[^\0\r\n]{1,256}$/.test(audioDevice[1]);
    }

    const networkTimeout = parameter.match(/^--network-timeout=(.+)$/);
    if (networkTimeout) {
        const parsed = numericValue(networkTimeout[1]);
        return parsed !== null && parsed >= 0.1 && parsed <= 300;
    }

    const streamLavf = parameter.match(/^--stream-lavf-o=(.+)$/);
    if (streamLavf) {
        const reconnectOptions = new Set<string>();
        return streamLavf[1].split(',').every((option) => {
            const match = /^(reconnect(?:_streamed|_at_eof|_delay_max)?)=(\d+)$/.exec(option);
            if (!match || reconnectOptions.has(match[1])) return false;
            const [, name, value] = match;
            const valid =
                name === 'reconnect_delay_max' ? Number(value) <= 300 : /^[01]$/.test(value);
            reconnectOptions.add(name);
            return valid;
        });
    }

    const volume = parameter.match(/^--volume=(.+)$/);
    if (volume) {
        const parsed = numericValue(volume[1]);
        return parsed !== null && parsed >= 0 && parsed <= 100;
    }

    const speed = parameter.match(/^--speed=(.+)$/);
    if (speed) {
        const parsed = numericValue(speed[1]);
        return parsed !== null && parsed >= 0.25 && parsed <= 4;
    }

    const sampleRate = parameter.match(/^--audio-samplerate=(.+)$/);
    if (sampleRate) {
        const parsed = integerValue(sampleRate[1]);
        return parsed !== null && parsed >= 0 && parsed <= 192000;
    }

    const replayGainPreamp = parameter.match(/^--replaygain-preamp=(.+)$/);
    if (replayGainPreamp) {
        const parsed = numericValue(replayGainPreamp[1]);
        return parsed !== null && parsed >= -100 && parsed <= 100;
    }

    const replayGainFallback = parameter.match(/^--replaygain-fallback=(.+)$/);
    if (replayGainFallback) {
        const parsed = numericValue(replayGainFallback[1]);
        return parsed !== null && parsed >= -100 && parsed <= 100;
    }

    return false;
};

export interface MpvParameterValidation {
    accepted: string[];
    rejected: string[];
}

/**
 * 先过滤用户参数，再交给 MPV 启动逻辑补上可信默认值。
 * 这里不使用简单的属性名前缀放行，避免 --script、--config、--load-scripts
 * 等改变执行权限的参数绕过策略。
 */
export const sanitizeMpvExtraParameters = (input: unknown): MpvParameterValidation => {
    if (input === undefined || input === null) {
        return { accepted: [], rejected: [] };
    }
    if (!Array.isArray(input) || input.length > MAX_EXTRA_PARAMETERS) {
        return { accepted: [], rejected: ['<invalid-extra-parameters>'] };
    }

    const accepted: string[] = [];
    const rejected: string[] = [];

    for (const item of input) {
        if (typeof item !== 'string') {
            rejected.push('<non-string-parameter>');
            continue;
        }
        const parameter = item.trim();
        if (parameter.length === 0) continue;
        if (!allowedExtraParameter(parameter)) {
            const option = parameter.split('=', 1)[0];
            rejected.push(/^--[a-z\d-]{1,80}$/.test(option) ? option : '<invalid-parameter>');
        } else {
            accepted.push(parameter);
        }
    }

    return { accepted, rejected };
};

type PropertyValidator = (value: unknown) => boolean;

const PROPERTY_VALIDATORS: Record<string, PropertyValidator> = {
    'audio-exclusive': (value) => value === 'no' || value === 'yes',
    'audio-format': (value) => value === 'float' || value === 's16' || value === 's32',
    'audio-pitch-correction': (value) => value === 'no' || value === 'yes',
    'audio-samplerate': (value) => inRange(value, 0, 192000) && Number.isInteger(value),
    'gapless-audio': (value) => value === 'no' || value === 'weak' || value === 'yes',
    replaygain: (value) => value === 'album' || value === 'no' || value === 'track',
    'replaygain-clip': (value) => value === 'no' || value === 'yes',
    'replaygain-fallback': (value) => inRange(value, -100, 100),
    'replaygain-preamp': (value) => inRange(value, -100, 100),
    speed: (value) => inRange(value, 0.25, 4),
    volume: (value) => inRange(value, 0, 100),
};

export interface MpvPropertyValidation {
    accepted: MpvPropertySet;
    rejected: string[];
}

export const validateMpvProperties = (input: unknown): MpvPropertyValidation => {
    if (input === undefined || input === null) {
        return { accepted: {}, rejected: [] };
    }
    if (!isRecord(input) || Object.keys(input).length > MAX_PROPERTIES) {
        return { accepted: {}, rejected: ['<invalid-properties>'] };
    }

    const accepted: MpvPropertySet = {};
    const rejected: string[] = [];

    for (const [key, value] of Object.entries(input)) {
        const validator = PROPERTY_VALIDATORS[key];
        if (!Object.hasOwn(PROPERTY_VALIDATORS, key) || !validator || !validator(value)) {
            rejected.push(key);
            continue;
        }
        accepted[key] = value as number | string;
    }

    return { accepted, rejected };
};

export interface MpvSettingsValidation<T> {
    error?: string;
    ok: boolean;
    value?: T;
}

const validateEqBand = (value: unknown): value is MpvEqBand => {
    if (!isRecord(value)) return false;
    return inRange(value.freq, 20, 20000) && inRange(value.gain, -12, 12);
};

export const validateMpvEqSettings = (input: unknown): MpvSettingsValidation<MpvEqSettings> => {
    if (!isRecord(input) || !Array.isArray(input.bands) || input.bands.length > MAX_EQ_BANDS) {
        return { error: 'invalid-eq-settings', ok: false };
    }
    if (typeof input.enabled !== 'boolean' || !inRange(input.preamp, -12, 12)) {
        return { error: 'invalid-eq-settings', ok: false };
    }
    if (!input.bands.every(validateEqBand)) {
        return { error: 'invalid-eq-settings', ok: false };
    }

    return {
        ok: true,
        value: {
            bands: input.bands.map((band) => ({ freq: band.freq, gain: band.gain })),
            enabled: input.enabled,
            preamp: input.preamp,
        },
    };
};

export const validateMpvCompressorSettings = (
    input: unknown,
): MpvSettingsValidation<MpvCompressorSettings> => {
    if (!isRecord(input) || typeof input.enabled !== 'boolean') {
        return { error: 'invalid-compressor-settings', ok: false };
    }
    if (
        !inRange(input.attack, 0.1, 2000) ||
        !inRange(input.knee, 0, 40) ||
        !inRange(input.makeup, 0, 30) ||
        !inRange(input.ratio, 1, 20) ||
        !inRange(input.release, 1, 9000) ||
        !inRange(input.threshold, -100, 0)
    ) {
        return { error: 'invalid-compressor-settings', ok: false };
    }

    return {
        ok: true,
        value: {
            attack: input.attack,
            enabled: input.enabled,
            knee: input.knee,
            makeup: input.makeup,
            ratio: input.ratio,
            release: input.release,
            threshold: input.threshold,
        },
    };
};

export interface MpvLaunchOptions {
    audio_only: boolean;
    auto_restart: boolean;
    binary: string | undefined;
    ipc_command: string;
    socket: string;
    time_update: number;
}

/**
 * node-mpv 在未提供 ipc_command 时会执行一次 `mpv --version` shell 探测。
 * 固定使用 Unix socket/Windows pipe 都支持的 --input-ipc-server 后，版本探测
 * 直接返回，不再进入 node-mpv 的 shell 分支。普通参数仍通过 spawn 参数数组传递。
 */
export const buildMpvLaunchOptions = (
    binary: string | undefined,
    socket: string,
): MpvLaunchOptions => ({
    audio_only: true,
    auto_restart: false,
    binary,
    ipc_command: MPV_IPC_COMMAND,
    socket,
    time_update: 1,
});

export const toMpvOperationError = (error: unknown): MpvOperationResult => ({
    error: error instanceof Error ? error.message : String(error),
    success: false,
});

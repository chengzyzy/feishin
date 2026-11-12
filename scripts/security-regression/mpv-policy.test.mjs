import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
    buildMpvLaunchOptions,
    MPV_IPC_COMMAND,
    sanitizeMpvExtraParameters,
    validateMpvCompressorSettings,
    validateMpvEqSettings,
    validateMpvProperties,
} from '../../src/main/security/mpv-policy.ts';
import { buildMpvAudioFilters } from '../../src/shared/utils/mpv-audio-filters.ts';

const require = createRequire(import.meta.url);

const DEFAULT_COMPRESSOR = {
    attack: 20,
    enabled: false,
    knee: 2.83,
    makeup: 6,
    ratio: 4,
    release: 250,
    threshold: -24,
};

const DEFAULT_EQ = {
    bands: [
        { freq: 31.5, gain: 0 },
        { freq: 1000, gain: 3 },
        { freq: 16000, gain: 0 },
    ],
    enabled: true,
    preamp: -2,
};

test('MPV launch options use the supported IPC command and skip the shell probe path', () => {
    assert.equal(MPV_IPC_COMMAND, '--input-ipc-server');
    const options = buildMpvLaunchOptions('/usr/local/bin/mpv', '/tmp/mpv-test.sock');
    assert.equal(options.ipc_command, '--input-ipc-server');
    assert.equal(options.binary, '/usr/local/bin/mpv');
    assert.equal(options.audio_only, true);
    assert.equal(options.auto_restart, false);
});

test('safe MPV extra parameters are retained', () => {
    const result = sanitizeMpvExtraParameters([
        '--audio-device=auto',
        '--prefetch-playlist=yes',
        '--network-timeout=10',
        '--stream-lavf-o=reconnect=1,reconnect_streamed=1',
        '--volume=70',
        '--speed=1.5',
        '--audio-pitch-correction=yes',
        '--audio-samplerate=48000',
        '--gapless-audio=weak',
        '--replaygain=track',
        '--replaygain-clip=yes',
        '--replaygain-preamp=-3',
        '--replaygain-fallback=-6',
        '--audio-format=float',
    ]);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.accepted.length, 14);
});

test('script, config, IPC and unknown MPV parameters are rejected one by one', () => {
    const result = sanitizeMpvExtraParameters([
        '--script=/tmp/local.lua',
        '--load-scripts=yes',
        '--config=/tmp/mpv.conf',
        '--input-ipc-server=/tmp/other.sock',
        '--include=/tmp/extra.conf',
        '--network-timeout=not-a-number',
        '--audio-device=',
        'not-a-parameter',
    ]);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected.length, 8);
});

test('MPV property names, types and ranges are validated', () => {
    const valid = validateMpvProperties({
        'audio-exclusive': 'no',
        'audio-format': 'float',
        'audio-pitch-correction': 'yes',
        'audio-samplerate': 48000,
        'gapless-audio': 'weak',
        replaygain: 'track',
        'replaygain-clip': 'yes',
        'replaygain-fallback': -6,
        'replaygain-preamp': 0,
        speed: 1.5,
        volume: 70,
    });
    assert.deepEqual(valid.rejected, []);
    assert.equal(Object.keys(valid.accepted).length, 11);

    const invalid = validateMpvProperties({
        af: 'lavfi=[anything=1]',
        'audio-samplerate': 1.5,
        replaygain: 'invalid',
        script: '/tmp/local.lua',
        speed: 10,
        volume: -1,
    });
    assert.deepEqual(Object.keys(invalid.accepted), []);
    assert.deepEqual(
        invalid.rejected.sort(),
        ['af', 'audio-samplerate', 'replaygain', 'script', 'speed', 'volume'].sort(),
    );
});

test('FFmpeg reconnect overrides accept only supported keys and bounded values', () => {
    const result = sanitizeMpvExtraParameters([
        '--stream-lavf-o=reconnect=1,reconnect_delay_max=10',
        '--stream-lavf-o=reconnect=1,unused_option=2',
        '--stream-lavf-o=reconnect=2',
        '--stream-lavf-o=reconnect_delay_max=301',
    ]);
    assert.deepEqual(result.accepted, ['--stream-lavf-o=reconnect=1,reconnect_delay_max=10']);
    assert.deepEqual(result.rejected, Array(3).fill('--stream-lavf-o'));
});

test('EQ and compressor values are validated and produce a controlled filter', () => {
    const eq = validateMpvEqSettings(DEFAULT_EQ);
    assert.equal(eq.ok, true);
    assert.ok(eq.value);

    const compressor = validateMpvCompressorSettings(DEFAULT_COMPRESSOR);
    assert.equal(compressor.ok, true);
    assert.ok(compressor.value);

    const filter = buildMpvAudioFilters(eq.value, compressor.value);
    assert.match(filter, /equalizer=f=1000:width_type=o:w=1:g=3/);
    assert.match(filter, /volume=-2dB/);
    assert.doesNotMatch(filter, /script|config|include/);

    const cleared = buildMpvAudioFilters(
        { ...DEFAULT_EQ, enabled: false },
        { ...DEFAULT_COMPRESSOR, enabled: false },
    );
    assert.equal(cleared, '');
});

test('invalid EQ and compressor settings are rejected before filter generation', () => {
    assert.equal(
        validateMpvEqSettings({ bands: [{ freq: 1, gain: 99 }], enabled: true, preamp: 0 }).ok,
        false,
    );
    assert.equal(validateMpvEqSettings({ bands: [], enabled: true, preamp: 99 }).ok, false);
    assert.equal(validateMpvCompressorSettings({ ...DEFAULT_COMPRESSOR, ratio: 100 }).ok, false);
    assert.equal(validateMpvCompressorSettings({ ...DEFAULT_COMPRESSOR, threshold: 1 }).ok, false);
});

test('node-mpv ipc_command option completes without invoking its shell probe', async () => {
    const childProcess = require('node:child_process');
    const originalExec = childProcess.exec;
    let shellCalls = 0;
    childProcess.exec = () => {
        shellCalls += 1;
        throw new Error('shell probe must not run');
    };

    try {
        const util = require(require.resolve('node-mpv/lib/util.js'));
        const command = await util.findIPCCommand({ ipc_command: '--input-ipc-server' });
        assert.equal(command, '--input-ipc-server');
        assert.equal(shellCalls, 0);
    } finally {
        childProcess.exec = originalExec;
    }
});

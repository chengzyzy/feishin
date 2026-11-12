/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import ts from 'typescript';

import * as mpvPolicy from '../../src/main/security/mpv-policy.ts';
import * as audioFilters from '../../src/shared/utils/mpv-audio-filters.ts';

const source = await readFile(
    new URL('../../src/main/features/core/player/index.ts', import.meta.url),
    'utf8',
);
const mainModule = compileFunction(
    ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText,
    ['require', 'exports', 'setTimeout'],
);

const createPlayer = ({ failLaunch, failProperty, stalledQuit } = {}) => {
    const handlers = new Map();
    const lifecycle = [];
    const options = [];
    const notices = [];
    const noop = () => undefined;
    const logger = { debug: noop, error: noop, info: noop, warn: noop };
    const event = { trusted: true };

    class Mpv extends EventEmitter {
        constructor(launchOptions) {
            super();
            options.push(launchOptions);
            const id = options.length;
            const child = new EventEmitter();
            this.id = id;
            this.mpvPlayer = child;
            this.running = false;
            child.pid = id;
            child.exitCode = null;
            child.signalCode = null;
            child.kill = () => {
                lifecycle.push(`kill:${id}`);
                this.scheduleExit();
                return true;
            };
        }

        async getProperty() {
            return [{ name: 'auto' }];
        }

        isRunning() {
            return this.running;
        }

        async quit() {
            lifecycle.push(`quit:${this.id}`);
            if (stalledQuit) return new Promise(() => {});
            this.scheduleExit();
        }

        scheduleExit() {
            setImmediate(() => {
                this.running = false;
                this.mpvPlayer.exitCode = 0;
                lifecycle.push(`exit:${this.id}`);
                this.mpvPlayer.emit('exit', 0, null);
            });
        }
        async setMultipleProperties() {
            return undefined;
        }
        async setProperty() {
            if (failProperty) throw new Error('Audio property unavailable');
        }
        async start() {
            lifecycle.push(`start:${this.id}`);
            if (failLaunch) throw new Error('Audio backend unavailable');
            this.running = true;
        }
    }

    const imports = {
        '../../../index': {
            getMainWindow: () => ({
                webContents: { send: (...args) => notices.push(args) },
            }),
            isTrustedIpcSender: (sender) => sender.trusted,
            sendToastToRenderer: noop,
        },
        '../../../logger': logger,
        '../../../security/file-policy': {},
        '../../../security/mpv-policy': mpvPolicy,
        '../settings': { store: { get: () => undefined } },
        '/@/main/env': { isMacOS: () => false, isWindows: () => false },
        '/@/shared/utils/mpv-audio-filters': audioFilters,
        electron: {
            app: { on: noop },
            dialog: {},
            ipcMain: {
                handle: (name, handler) => handlers.set(name, handler),
                on: (name, handler) => handlers.set(name, handler),
            },
            powerMonitor: { on: noop },
        },
        'fs/promises': { rm: async () => {} },
        'lodash/uniq': (items) => [...new Set(items)],
        'node-mpv': Mpv,
        'node:events': { once },
        'node:process': { pid: 1 },
        process: { on: noop },
    };
    const exports = {};
    mainModule(
        (name) => {
            assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
            return imports[name];
        },
        exports,
        (callback, delay) => setTimeout(callback, Math.min(delay, 25)),
    );

    return {
        instance: exports.getMpvInstance,
        invoke: (channel, input) => handlers.get(channel)(event, input),
        lifecycle,
        notices,
        options,
    };
};

test('an MPV startup failure returns failure without marking an instance ready', async () => {
    const player = createPlayer({ failLaunch: true });
    const result = await player.invoke('player-initialize', {});
    assert.equal(result.success, false);
    assert.equal(result.error, 'Audio backend unavailable');
    assert.equal(player.instance(), null);
    assert.deepEqual(player.notices.at(-1), ['renderer-player-fallback', true]);
});

test('a recoverable property failure leaves the running MPV instance intact', async () => {
    const player = createPlayer({ failProperty: true });
    assert.equal((await player.invoke('player-initialize', {})).success, true);
    const instance = player.instance();
    const result = await player.invoke('player-set-properties', { speed: 1.25 });
    assert.equal(result.success, false);
    assert.equal(player.instance(), instance);
    assert.deepEqual(player.lifecycle, ['start:1']);
    await player.invoke('player-quit');
});

test('device probes and overlapping initializations wait for the previous child to exit', async () => {
    const player = createPlayer();
    const [devices, initialized, restarted] = await Promise.all([
        player.invoke('player-get-audio-devices'),
        player.invoke('player-initialize', {}),
        player.invoke('player-restart', {}),
    ]);
    assert.deepEqual(devices, [{ label: 'auto', value: 'auto' }]);
    assert.equal(initialized.success, true);
    assert.equal(restarted.success, true);
    assert.deepEqual(player.lifecycle, [
        'start:1',
        'quit:1',
        'exit:1',
        'start:2',
        'quit:2',
        'exit:2',
        'start:3',
    ]);
    assert.ok(player.options.every(({ ipc_command }) => ipc_command === '--input-ipc-server'));
    await player.invoke('player-quit');
});

test('a stalled quit kills the owned child and waits for its exit before restarting', async () => {
    const player = createPlayer({ stalledQuit: true });
    await player.invoke('player-initialize', {});
    assert.equal((await player.invoke('player-restart', {})).success, true);
    assert.deepEqual(player.lifecycle, ['start:1', 'quit:1', 'kill:1', 'exit:1', 'start:2']);
    await player.invoke('player-quit');
});

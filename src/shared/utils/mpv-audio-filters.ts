import type { MpvCompressorSettings, MpvEqBand, MpvEqSettings } from '/@/shared/types/mpv-settings';

// 每个频段的倍频程宽度。十个频段覆盖 20Hz 到 20kHz，并保留轻微重叠。
const BAND_WIDTHS: Record<number, number> = {
    31.5: 1.9,
    63: 1.3,
    125: 1.0,
    250: 1.0,
    500: 1.0,
    1000: 1.0,
    2000: 1.0,
    3000: 1.0,
    4000: 1.0,
    6300: 1.2,
    10000: 1.2,
    16000: 1.5,
};

/**
 * 返回受控的 MPV `af` 属性字符串。
 * 输入必须已经在主进程完成数值和范围校验；这里只负责生成滤镜文本，
 * 空字符串表示清除全部滤镜并恢复直通。
 */
export function buildMpvAudioFilters(
    equalizer: MpvEqSettings,
    compressor: MpvCompressorSettings,
): string {
    const parts: string[] = [];

    if (equalizer.enabled) {
        if (equalizer.preamp !== 0) {
            parts.push(`volume=${equalizer.preamp}dB`);
        }

        for (const band of equalizer.bands) {
            if (band.gain === 0) continue;
            const width = BAND_WIDTHS[band.freq] ?? 1.0;
            parts.push(`lavfi=[equalizer=f=${band.freq}:width_type=o:w=${width}:g=${band.gain}]`);
        }
    }

    if (compressor.enabled) {
        const thresholdLinear = Math.pow(10, compressor.threshold / 20);
        const makeupLinear = Math.pow(10, compressor.makeup / 20);
        parts.push(
            `lavfi=[acompressor=` +
                `threshold=${thresholdLinear.toFixed(6)}:` +
                `ratio=${compressor.ratio}:` +
                `attack=${compressor.attack}:` +
                `release=${compressor.release}:` +
                `makeup=${makeupLinear.toFixed(6)}:` +
                `knee=${compressor.knee}` +
                `]`,
        );
    }

    return parts.join(',');
}

export type { MpvCompressorSettings, MpvEqBand, MpvEqSettings };

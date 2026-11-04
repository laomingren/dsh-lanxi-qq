/**
 * 2026-11-02 (fork): canvas 的保险丝。
 *
 * 上游把 `@napi-rs/canvas` 写成顶层 import（lib/image-shrink.js、
 * lib/t2i/canvas.js、lib/t2i/fonts.js），只要目标平台没有对应的预编译包，
 * 整个插件在 import 阶段就失败 —— 连 QQ 都连不上，界面上什么都不显示。
 *
 * 这里用 createRequire 同步地试着加载一次：
 *  - 成功：原样导出真模块，行为跟上游完全一致；
 *  - 失败：导出一组 stub，画图函数返回空白 canvas、字体注册什么都不做，
 *    于是 t2i 卡片退化成纯文字发送，其余功能照常。
 *
 * 注意：stub 只保证「不崩」，不保证「画得出来」。真要用卡片请装好 canvas。
 * @module dsh-lanxi-qq/canvas-guard
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 真模块，加载失败时为 undefined。 */
let real;

/** 加载失败的原因（真模块可用时为 undefined）。 */
let loadError;

try {
    real = require('@napi-rs/canvas');
}
catch (error) {
    loadError = error;
}

/** canvas 是否可用。t2i 渲染前先问一句，能省掉一堆无意义的绘制。 */
export const canvasAvailable = real !== undefined;

/** 加载失败的原因（用于日志；可用时为 undefined）。 */
export function canvasLoadError() {
    return loadError;
}

/** 一个什么都不画的假 canvas：宽高对，getContext 返回空操作 stubs。 */
function stubCanvas(width, height) {
    const noop = () => undefined;
    const context = {
        canvas: undefined,
        fillStyle: '#000',
        strokeStyle: '#000',
        font: '10px sans-serif',
        textBaseline: 'alphabetic',
        textAlign: 'left',
        lineWidth: 1,
        globalAlpha: 1,
        fillRect: noop,
        strokeRect: noop,
        clearRect: noop,
        fillText: noop,
        strokeText: noop,
        measureText: (text) => ({ width: String(text ?? '').length * 8 }),
        beginPath: noop,
        closePath: noop,
        moveTo: noop,
        lineTo: noop,
        arc: noop,
        rect: noop,
        fill: noop,
        stroke: noop,
        save: noop,
        restore: noop,
        translate: noop,
        scale: noop,
        rotate: noop,
        clip: noop,
        drawImage: noop,
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        putImageData: noop,
        createLinearGradient: () => ({ addColorStop: noop }),
        setTransform: noop,
    };
    const canvas = {
        width,
        height,
        getContext: () => context,
        toBuffer: () => Buffer.alloc(0),
        toDataURL: () => '',
        encodeSync: () => Buffer.alloc(0),
        encode: async () => Buffer.alloc(0),
    };
    context.canvas = canvas;
    return canvas;
}

/** createCanvas：真模块优先，缺了给 stub。 */
export function createCanvas(width, height) {
    if (real !== undefined) {
        return real.createCanvas(width, height);
    }
    return stubCanvas(width, height);
}

/** loadImage：真模块优先；缺了返回一个 1×1 占位。 */
export async function loadImage(source) {
    if (real !== undefined) {
        return real.loadImage(source);
    }
    return stubCanvas(1, 1);
}

/**
 * GlobalFonts：缺 canvas 时是个空壳，registerFromPath 静默返回 false，
 * 让字体注册那段代码不用加 if。
 */
export const GlobalFonts = real?.GlobalFonts ?? {
    registerFromPath: () => false,
    register: () => false,
    has: () => false,
    families: [],
};

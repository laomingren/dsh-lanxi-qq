/**
 * Media handling: inbound download/resolution (url / base64:// / file:// /
 * hash via get_image), 6h temp-file cleanup, and outbound base64 encoding.
 * Ported from the Hermes OneBotAdapter media half.
 * @module dsh-onebot/media
 */
import { mkdir, open, readFile, readdir, realpath, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { shrinkImage } from './image-shrink.js';
import { describeError } from './errors.js';
/** Size limits (bytes), matching the Hermes adapter's constants. */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const VOICE_MAX_BYTES = 15 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** Hard wall clock for one download, matching the OneBot call timeout; covers every redirect hop and the body. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Maximum redirects followed manually — every hop is re-checked for protocol + private address. */
const MAX_REDIRECTS = 3;
/**
 * Media storage: a scratch directory under the plugin's media root.
 * Downloads land here with a TTL; cleanup runs on each inbound message.
 */
export class MediaStore {
    dir;
    ttlHours;
    imageMaxSize;
    downloadMaxBytes;
    allowPrivateHosts;
    /**
     * @param dir - absolute scratch directory (created on demand).
     * @param ttlHours - files older than this are deleted on cleanup.
     * @param imageMaxSize - inbound-image long-edge cap in px; images larger
     *   than this are downscaled right after download (`<=0` disables).
     * @param download - download guards: the default size cap for resolveInner
     *   URL downloads and the allowPrivateHosts SSRF escape hatch.
     */
    constructor(dir, ttlHours, imageMaxSize = 0, download = {}) {
        this.dir = dir;
        this.ttlHours = ttlHours > 0 ? ttlHours : 6;
        this.imageMaxSize = imageMaxSize;
        this.downloadMaxBytes = download.maxBytes ?? 0;
        this.allowPrivateHosts = download.allowPrivateHosts ?? false;
    }
    /** Ensure the scratch directory exists. */
    async ensure() {
        await mkdir(this.dir, { recursive: true });
    }
    /** A fresh scratch file path with the given extension. */
    freshPath(ext) {
        return join(this.dir, 'media_' + Date.now() + '_' + randomUUID().slice(0, 8) + ext);
    }
    /**
     * Delete plugin scratch older than the TTL, whitelisted by name: only
     * `media_*` files and `stt_*` work dirs are ours to delete (state files
     * like chat-sessions.json share this directory and must survive).
     * Called on every inbound message; failures are logged and contained.
     */
    async cleanupExpired() {
        const cutoff = Date.now() - this.ttlHours * 3600_000;
        try {
            await mkdir(this.dir, { recursive: true });
            const entries = await readdir(this.dir);
            for (const name of entries) {
                if (!name.startsWith('media_') && !name.startsWith('stt_'))
                    continue;
                const path = join(this.dir, name);
                try {
                    const info = await stat(path);
                    if (info.mtimeMs < cutoff) {
                        await rm(path, { recursive: info.isDirectory(), force: true });
                    }
                }
                catch {
                    // file vanished mid-scan
                }
            }
        }
        catch (error) {
            console.warn('[dsh-onebot] media cleanup failed:', describeError(error));
        }
    }
    /**
     * Resolve one media reference (from cq.ts MediaRef) to a local file.
     * @param ref - the media reference.
     * @param resolveHash - callback for hash-only refs (calls get_image etc.);
     *   returns { url, file } or undefined when unresolvable.
     * @returns the resolved file, or undefined when the ref cannot be fetched.
     */
    async resolve(ref, resolveHash) {
        const result = await this.resolveInner(ref, resolveHash);
        // Downscale inbound images right after download (long-edge cap).
        if (result !== undefined && result.kind === 'image' && this.imageMaxSize > 0) {
            try {
                const shrunk = await shrinkImage(result.path, this.imageMaxSize);
                if (shrunk !== undefined)
                    result.path = shrunk;
            }
            catch (error) {
                console.warn('[dsh-onebot] image shrink failed, keeping original:', describeError(error));
            }
        }
        return result;
    }
    async resolveInner(ref, resolveHash) {
        await this.ensure();
        try {
            if (ref.url !== undefined && ref.url !== '') {
                const path = await this.downloadUrl(ref.url, extForUrl(ref.url, ref.kind), this.downloadMaxBytes);
                return { path, kind: ref.kind };
            }
            const file = ref.file ?? '';
            if (file.startsWith('base64://')) {
                // 2026-11-05 P0：base64 分支原先直接全量 Buffer.from —— 远端发一张
                // 巨图/巨文件就能让宿主分配巨大内存（URL 分支早有上限，这里漏了）。
                // 解码前按编码长度预检：base64 膨胀约 4/3，留 16 字节给 padding。
                const encoded = file.slice('base64://'.length);
                const cap = this.downloadMaxBytes > 0 ? this.downloadMaxBytes : 0;
                if (cap > 0 && encoded.length > Math.ceil(cap * 4 / 3) + 16) {
                    console.warn('[dsh-onebot] base64 media too large, skipped');
                    return undefined;
                }
                const data = Buffer.from(encoded, 'base64');
                // 2026-10-28 蓝汐补丁：按真实字节定扩展名（QQ 常把 PNG/GIF/WebP
                // 报成 .jpg，错扩展名会让 read_image 直接拒绝）。
                const path = this.freshPath(imageExtFromBytes(data) ?? extForKind(ref.kind));
                await writeFile(path, data);
                return { path, kind: ref.kind };
            }
            if (file.startsWith('file://')) {
                const source = file.slice('file://'.length);
                const cap = this.downloadMaxBytes > 0 ? this.downloadMaxBytes : 0;
                let info;
                try {
                    info = await stat(source);
                }
                catch {
                    return undefined;
                }
                if (cap > 0 && info.size > cap) {
                    console.warn('[dsh-onebot] file:// media too large, skipped');
                    return undefined;
                }
                const ext = (await sniffFileExt(source)) ?? extForKind(ref.kind);
                const path = this.freshPath(ext);
                try {
                    await copyFile(source, path);
                    return { path, kind: ref.kind };
                }
                catch {
                    return undefined;
                }
            }
            if (file !== '') {
                // Hash-only ref: ask the implementation (get_image / get_record).
                const resolved = await resolveHash(ref.kind, file);
                if (resolved === undefined)
                    return undefined;
                if (resolved.url !== undefined && resolved.url !== '') {
                    const path = await this.downloadUrl(resolved.url, extForUrl(resolved.url, ref.kind), this.downloadMaxBytes);
                    return { path, kind: ref.kind };
                }
                if (resolved.file !== undefined && resolved.file.startsWith('file://')) {
                    const source = resolved.file.slice('file://'.length);
                    const cap = this.downloadMaxBytes > 0 ? this.downloadMaxBytes : 0;
                    let info;
                    try {
                        info = await stat(source);
                    }
                    catch {
                        return undefined;
                    }
                    if (cap > 0 && info.size > cap) {
                        console.warn('[dsh-onebot] file:// media too large, skipped');
                        return undefined;
                    }
                    const ext = (await sniffFileExt(source)) ?? extForKind(ref.kind);
                    const path = this.freshPath(ext);
                    await copyFile(source, path);
                    return { path, kind: ref.kind };
                }
            }
            return undefined;
        }
        catch (error) {
            console.warn('[dsh-onebot] media resolve failed:', describeError(error));
            return undefined;
        }
    }
    /**
     * Download a URL into the scratch dir, behind the SSRF fence: http/https
     * only, private/loopback targets refused (unless allowPrivateHosts is on),
     * every redirect hop re-checked (max 3), and a hard wall-clock deadline
     * per download. The body is streamed so the size cap aborts mid-flight.
     * @param url - remote URL.
     * @param ext - file extension for the target.
     * @param maxBytes - size cap; `<=0`/undefined disables it.
     * @returns the local path.
     */
    async downloadUrl(url, ext, maxBytes) {
        await this.ensure();
        const cap = maxBytes !== undefined && maxBytes > 0 ? maxBytes : undefined;
        const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
        let current = url;
        for (let hops = 0;; hops += 1) {
            await assertDownloadableUrl(current, this.allowPrivateHosts);
            const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(0, deadline - Date.now())) });
            if (isRedirectStatus(response.status)) {
                const location = response.headers.get('location');
                void response.body?.cancel().catch(() => undefined);
                if (location === null) {
                    throw new Error('redirect without location header: ' + current);
                }
                if (hops >= MAX_REDIRECTS) {
                    throw new Error('too many redirects (> ' + MAX_REDIRECTS + '): ' + url);
                }
                current = new URL(location, current).toString();
                continue;
            }
            if (!response.ok || response.body === null) {
                throw new Error('download failed: HTTP ' + response.status + ' for ' + url);
            }
            const reader = response.body.getReader();
            const chunks = [];
            let total = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value !== undefined) {
                    total += value.byteLength;
                    if (cap !== undefined && total > cap) {
                        reader.cancel().catch(() => undefined);
                        throw new Error('download exceeds ' + cap + ' bytes: ' + url);
                    }
                    chunks.push(value);
                }
            }
            const data = Buffer.concat(chunks);
            // 2026-10-28 蓝汐补丁：落盘前按真实字节定扩展名（整包已在内存里，
            // 直接以正确扩展名写入，避免写错再 rename 的竞态）。
            const path = this.freshPath(imageExtFromBytes(data) ?? ext);
            await writeFile(path, data);
            return path;
        }
    }
}
/** 3xx statuses fetch would auto-follow; we follow them manually to re-check each hop. */
function isRedirectStatus(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/**
 * Refuse download targets that are not plain http(s) or that point at a
 * private/loopback/link-local address (SSRF fence for sender-controlled
 * URLs). Hostnames go through DNS and every resolved address is checked;
 * IP-literal oddities (hex/octal/decimal spellings) fall through to the
 * lookup and are judged by their resolved address. `allowPrivate` skips
 * only the private-address check — the protocol whitelist always applies.
 */
async function assertDownloadableUrl(rawUrl, allowPrivate) {
    let parsed;
    try {
        parsed = new URL(rawUrl);
    }
    catch {
        throw new Error('download refused: invalid URL: ' + rawUrl);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('download refused: protocol not allowed (' + parsed.protocol + '): ' + rawUrl);
    }
    if (allowPrivate)
        return;
    const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (isPrivateIp(host)) {
        throw new Error('download refused: private/loopback address not allowed: ' + rawUrl);
    }
    let addresses;
    try {
        addresses = await lookup(host, { all: true });
    }
    catch (cause) {
        throw new Error('download refused: DNS lookup failed for ' + host + ': ' + describeError(cause));
    }
    if (addresses.some(entry => isPrivateIp(entry.address))) {
        throw new Error('download refused: ' + host + ' resolves to a private/loopback address: ' + rawUrl);
    }
}
/** Whether an IP address (v4 literal, or v6 without brackets) is private/loopback/link-local. */
function isPrivateIp(address) {
    if (address.includes(':'))
        return isPrivateIpv6(address);
    return isPrivateIpv4(address);
}
/** Private/loopback/link-local ranges for IPv4 literals. */
function isPrivateIpv4(address) {
    const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (match === null)
        return false;
    const first = Number(match[1]);
    const second = Number(match[2]);
    return first === 0 || first === 10 || first === 127 ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 169 && second === 254);
}
/** Private/loopback/link-local ranges for IPv6 literals (no brackets). */
function isPrivateIpv6(address) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1')
        return true;
    // IPv4-mapped endings (::ffff:0:0/96) are judged by their embedded IPv4:
    // the URL parser spells them in hex (::ffff:7f00:1), DNS in dotted form.
    const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (dotted !== null)
        return isPrivateIpv4(dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hex !== null) {
        const high = parseInt(hex[1], 16);
        const low = parseInt(hex[2], 16);
        return isPrivateIpv4((high >> 8) + '.' + (high & 255) + '.' + (low >> 8) + '.' + (low & 255));
    }
    // fe80::/10 link-local (fe80–febf), fc00::/7 unique local (fc00–fdff).
    const first = parseInt(lower, 16);
    if (Number.isNaN(first))
        return false;
    return (first >= 0xfe80 && first <= 0xfebf) || (first >= 0xfc00 && first <= 0xfdff);
}
/** Guess a file extension for a URL. */
export function extForUrl(url, kind) {
    try {
        const path = new URL(url).pathname;
        const dot = path.lastIndexOf('.');
        if (dot >= 0) {
            const ext = path.slice(dot).toLowerCase();
            if (ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext))
                return ext;
        }
    }
    catch {
        // malformed URL
    }
    return extForKind(kind);
}
/**
 * Whitelisted extension for an inbound (sender-controlled) file name: the
 * name itself never becomes the on-disk path (MediaStore.freshPath mints an
 * unpredictable media_<ts>_<uuid> name), only a validated trailing extension
 * is kept — same rule as extForUrl.
 */
export function extForInboundName(name) {
    const dot = name.lastIndexOf('.');
    if (dot >= 0) {
        const ext = name.slice(dot).toLowerCase();
        if (ext.length <= 6 && /^\.[a-z0-9]+$/.test(ext))
            return ext;
    }
    return '.bin';
}
/** Default extension per media kind. */
export function extForKind(kind) {
    switch (kind) {
        case 'image': return '.jpg';
        case 'voice': return '.mp3';
        case 'video': return '.mp4';
        default: return '.bin';
    }
}
/**
 * 2026-10-28 蓝汐补丁：按文件头魔数判断真实图片格式，返回对应扩展名；
 * 不认识的字节返回 undefined（调用方保留原扩展名）。
 * QQ/NapCat 的图片 URL/文件名经常把 PNG/GIF/WebP 报成 .jpg，扩展名和
 * 真实字节不符时 read_image 会直接拒绝，所以在落盘前用字节说话。
 * 判定顺序固定：JPEG FFD8FF / PNG 89504E47 / GIF 47494638 /
 * WEBP RIFF....WEBP / BMP 424D。
 */
export function imageExtFromBytes(data) {
    if (data === undefined || data === null || data.length < 4)
        return undefined;
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
        return '.jpg';
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47)
        return '.png';
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38)
        return '.gif';
    if (data.length >= 12 &&
        data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
        data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50)
        return '.webp';
    if (data[0] === 0x42 && data[1] === 0x4d)
        return '.bmp';
    return undefined;
}
/**
 * 读文件前 12 字节判图片格式；读不到/不认识返回 undefined。
 * 仅用于 file:// 拷贝分支（拿不到整包时才需要先看头再决定落盘名）。
 */
async function sniffFileExt(path) {
    let handle;
    try {
        handle = await open(path, 'r');
        const head = Buffer.alloc(12);
        const { bytesRead } = await handle.read(head, 0, 12, 0);
        return imageExtFromBytes(head.subarray(0, bytesRead));
    }
    catch {
        return undefined;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
/**
 * Resolve `target` through symlinks and require it to live under one of
 * `allowedRoots`: separator-boundary prefix match on both sides' realpaths,
 * so root /foo/bar does not contain /foo/baz. A symlink escaping every root
 * and a missing target both yield null — outbound media must exist to be
 * read, so there is no deepest-existing-ancestor fallback. Returns the
 * resolved realpath.
 */
export async function resolveContainedPath(allowedRoots, target) {
    let resolved;
    try {
        resolved = await realpath(target);
    }
    catch {
        return null;
    }
    for (const root of allowedRoots) {
        let rootReal;
        try {
            rootReal = await realpath(root);
        }
        catch {
            continue; // a missing root cannot contain anything
        }
        const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
        if (resolved === rootReal || resolved.startsWith(prefix))
            return resolved;
    }
    return null;
}
/**
 * Read a local file as a base64 data URI for OneBot media segments.
 * @param path - absolute file path.
 * @param maxBytes - size cap; exceeding it throws.
 * @param allowedRoots - when provided, the path is refused unless it
 *   resolves inside one of the roots (M1-A3a outbound fence; tools pass it
 *   once wired, until then absence keeps the legacy uncaged behavior).
 * @returns "base64://<data>".
 */
export async function fileToBase64(path, maxBytes, allowedRoots) {
    if (allowedRoots !== undefined && (await resolveContainedPath(allowedRoots, path)) === null) {
        throw new Error('path not allowed or does not exist: ' + path);
    }
    const info = await stat(path);
    if (info.size > maxBytes) {
        throw new Error('file too large: ' + info.size + ' bytes (limit ' + maxBytes + ')');
    }
    const data = await readFile(path);
    return 'base64://' + data.toString('base64');
}
/** Whether a string looks like a remote URL. */
export function isUrl(value) {
    return /^https?:\/\//.test(value);
}

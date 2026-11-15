import { FSError } from '@nestos/vfs-core';

export function davRoot(endpoint: string): URL {
    let root: URL;
    try { root = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/'); }
    catch { throw new FSError('EINVAL', 'Invalid WebDAV address'); }
    if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password || root.search || root.hash)
        throw new FSError('EINVAL', 'Invalid WebDAV address');
    return root;
}

export function davPath(path: string): string {
    if (typeof path !== 'string' || path.startsWith('/') || /[\\\0]/.test(path) || new TextEncoder().encode(path).length > 4096
        || path.split('/').some(part => ['.', '..'].includes(part)) || /^[a-zA-Z]:/.test(path))
        throw new FSError('EINVAL', 'Expected a WebDAV root-relative path');
    return path;
}

export function davUrl(root: URL, path: string): URL {
    return new URL(davPath(path).split('/').map(encodeURIComponent).join('/'), root);
}

/** Server hrefs are untrusted and may never escape the configured collection. */
export function hrefPath(root: URL, href: string): string {
    if (/%(?:2f|5c|00)/i.test(href) || /[\\\0]/.test(href)) throw invalidHref();
    const rawPath = href.replace(/^[a-z]+:\/\/[^/]+/i, '').split(/[?#]/)[0];
    try { if (rawPath.split('/').some(part => ['.', '..'].includes(decodeURIComponent(part)))) throw invalidHref(); }
    catch { throw invalidHref(); }
    const url = new URL(href, root);
    if (url.origin === root.origin && url.pathname + '/' === root.pathname && !url.search && !url.hash && !url.username && !url.password) return '';
    if (url.origin !== root.origin || url.search || url.hash || url.username || url.password || !url.pathname.startsWith(root.pathname))
        throw invalidHref();
    try { return davPath(decodeURIComponent(url.pathname.slice(root.pathname.length)).replace(/\/$/, '')); }
    catch { throw invalidHref(); }
}

function invalidHref() { return new FSError('EACCES', 'WebDAV response path is outside the collection', 'protocol'); }

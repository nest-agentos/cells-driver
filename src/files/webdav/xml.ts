import { SaxesParser } from 'saxes';
import { FSError, type FileStat } from '@nestos/vfs-core';

interface Element { name: string; text: string; children: Element[]; }
const dav = 'DAV:';
const tag = (name: string) => dav + '|' + name;
const children = (node: Element, name: string) => node.children.filter(child => child.name === tag(name));
const child = (node: Element, name: string) => children(node, name)[0];
const value = (node: Element, name: string) => child(node, name)?.text.trim();
export const invalidXml = () => new FSError('EIO', 'Invalid WebDAV XML response', 'protocol');

/** Namespace-aware bounded XML; external declarations and deep trees are rejected. */
export function parseXml(xml: string): Element {
    const parser = new SaxesParser({ xmlns: true }), stack: Element[] = [];
    let root: Element | undefined, count = 0;
    parser.on('doctype', () => { throw invalidXml(); });
    parser.on('error', () => { throw invalidXml(); });
    parser.on('opentag', item => {
        if (++count > 150_000 || stack.length >= 32) throw invalidXml();
        const node = { name: item.uri + '|' + item.local, text: '', children: [] as Element[] };
        if (stack.length) stack[stack.length - 1].children.push(node); else root = node;
        stack.push(node);
    });
    const text = (text: string) => { if (stack.length) stack[stack.length - 1].text += text; };
    parser.on('text', text); parser.on('cdata', text); parser.on('closetag', () => { stack.pop(); });
    try { parser.write(xml).close(); } catch { throw invalidXml(); }
    if (!root || stack.length) throw invalidXml();
    return root;
}

export function multistatus(xml: string): Array<{ href: string; stat: FileStat }> {
    const root = parseXml(xml);
    if (root.name !== tag('multistatus')) throw invalidXml();
    return children(root, 'response').map(response => {
        const href = value(response, 'href');
        if (!href) throw invalidXml();
        const groups = children(response, 'propstat').filter(group => /^HTTP\/\d(?:\.\d)? 200(?:\s|$)/.test(value(group, 'status') ?? ''));
        if (!groups.length) throw new FSError('EACCES', 'WebDAV properties unavailable', 'propfind');
        const props = { name: '', text: '', children: groups.flatMap(group => child(group, 'prop')?.children ?? []) };
        return { href, stat: properties(props) };
    });
}

function properties(props: Element): FileStat {
    const resource = child(props, 'resourcetype');
    if (!resource) throw invalidXml();
    const length = value(props, 'getcontentlength'), revision = value(props, 'getetag');
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw invalidXml();
    return { kind: resource.children.some(item => item.name === tag('collection')) ? 'directory' : 'file',
        ...(length !== undefined ? { size: Number(length) } : {}),
        ...(revision && /^"[^"\r\n]*"$/.test(revision) ? { revision } : {}),
        ...dateProperty(props, 'getlastmodified', 'modifiedAt'), ...dateProperty(props, 'creationdate', 'createdAt') };
}

function dateProperty(props: Element, name: string, key: 'modifiedAt' | 'createdAt'): Partial<FileStat> {
    const text = value(props, name), time = text ? Date.parse(text) : NaN;
    return Number.isFinite(time) ? { [key]: time } : {};
}

export const propertyRequest = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getetag/><d:getlastmodified/><d:creationdate/></d:prop></d:propfind>';
export const lockRequest = '<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>';

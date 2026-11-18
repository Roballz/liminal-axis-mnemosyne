export function node(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
}
export function button(text, action, cls = '') {
    const b = node('button',cls,text); b.type = 'button'; b.onclick = action; return b;
}
export function select(options, value, onChange) {
    const el = node('select');
    for (const [v,label] of options) { const o = node('option','',label); o.value = v; el.append(o); }
    el.value = value;
    if (onChange) el.onchange = () => onChange(el.value);
    return el;
}
export function field(name,control) {
    const label = node('label','mn-field');
    label.append(node('span','mn-caption',name),control);
    return label;
}
export function input(value = '',placeholder = '',multiline = false) {
    const el = node(multiline ? 'textarea' : 'input');
    el.value = value; el.placeholder = placeholder; return el;
}
export function icon(name) {
    const paths = {
        book:'M5 3h13a2 2 0 0 1 2 2v15H6a3 3 0 0 1-3-3V5a2 2 0 0 1 2-2Zm1 0v14m-3 1c0-1 1-2 3-2h14M10 3v7l2-1.5 2 1.5V3',
        mark:'M6 4h12v17l-6-4-6 4z', people:'M16 20v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2m14-6a4 4 0 0 1 3 4v2M14 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm3-3a4 4 0 0 1 0 7',
        folder:'M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
        inbox:'M3 5h18v12H11l-5 4v-4H3zM7 9h10m-10 4h6',
        close:'m6 6 12 12m0-12L6 18', arrow:'m9 5 7 7-7 7', settings:'M4 6h5m4 0h7M4 12h10m4 0h2M4 18h2m4 0h10M9 3v6m5 0v6M7 15v6',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
    const p = document.createElementNS(svg.namespaceURI,'path'); p.setAttribute('d',paths[name]); svg.append(p);
    return svg;
}
export function iconButton(label,key,fn) {
    const b = button('',fn,'mn-icon'); b.setAttribute('aria-label',label); b.title=label; b.append(icon(key));return b;
}
// Only text and a small set of locally generated elements leave the inert template.
export function reader(source) {
    const template = node('template'); template.innerHTML = source;
    const out = node('div','mn-reading');
    const excluded = 'BUTTON,SCRIPT,STYLE,IFRAME,OBJECT,EMBED,INPUT,SELECT,TEXTAREA,TEMPLATE,NOSCRIPT,SVG,LINK,META';
    const skip = new Set(excluded.split(','));
    function visit(item,parent) {
        if (item.nodeType === 3) { parent.append(document.createTextNode(item.data)); return; }
        if (item.nodeType !== 1 || skip.has(item.tagName) || item.hasAttribute('data-nvwa-draft')) return;
        if (item.tagName === 'BR') { parent.append(node('br')); return; }
        if (item.tagName === 'IMG') { if (item.alt) parent.append(document.createTextNode(item.alt)); return; }
        const block = /^(DIV|P|SECTION|ARTICLE|LI|TR|H[1-6]|BLOCKQUOTE)$/.test(item.tagName);
        const target = block ? node('div') : parent;
        if (block) {
            if (item.style?.textAlign === 'right') target.className='mn-outgoing';
            if (item.style?.textAlign === 'center') target.className='mn-time';
            parent.append(target);
        }
        for (const child of item.childNodes) visit(child,target);
    }
    for (const child of template.content.childNodes) visit(child,out);
    return out;
}

import { blankBook } from './model.js';
const pending = req => new Promise((resolve,reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});
const finish = tx => new Promise((resolve,reject) => {
    tx.oncomplete = resolve;
    tx.onabort = tx.onerror = () => reject(tx.error || Error('记事簿写入已取消'));
});
const range = (...parts) => IDBKeyRange.bound(parts, [...parts, []]);
let connection;
export function database() {
    if (!connection) connection = new Promise((resolve,reject) => {
        const req = indexedDB.open('mnemosyne-notes-v1', 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            db.createObjectStore('meta');
            const s = db.createObjectStore('items', {keyPath:'key'});
            s.createIndex('order', 'order', {unique:true});
            s.createIndex('facets', 'facets', {multiEntry:true});
            s.createIndex('filteredOrder', 'filteredOrder', {multiEntry:true});
        };
        req.onsuccess = () => {
            const db = req.result;
            db.onversionchange = () => { db.close(); connection = null; };
            resolve(db);
        };
        req.onerror = () => { connection = null; reject(req.error); };
    });
    return connection;
}
export async function meta(key, fallback) {
    const db = await database();
    return (await pending(db.transaction('meta').objectStore('meta').get(key))) ?? fallback;
}
export const getBook = chat => meta(['book',chat], blankBook());
export const getProgress = chat => meta(['scan',chat], {next:0,revision:0});
export async function mutateBook(chat, change, invalidate = false) {
    const db = await database();
    const tx = db.transaction(['meta','items'], 'readwrite'), committed = finish(tx);
    const store = tx.objectStore('meta');
    const req = store.get(['book',chat]);
    let result, failure;
    req.onsuccess = () => {
        try {
            result = req.result ?? blankBook();
            change(result);
            if (invalidate) {
                result.revision++;
                if (invalidate === 'existing') {
                    const scan = store.get(['scan',chat]);
                    scan.onsuccess = () => store.put({...scan.result, next:scan.result?.next || 0,
                        revision:result.revision,revisit:0}, ['scan',chat]);
                } else {
                    tx.objectStore('items').delete(range(chat,'block'));
                    store.put({next:0,revision:result.revision}, ['scan',chat]);
                }
            }
            store.put(result, ['book',chat]);
        } catch (e) { failure = e; tx.abort(); }
    };
    try { await committed; } catch (e) { throw failure || e; }
    return result;
}
function prepare(chat,kind,id,row) {
    const key = [chat,kind,id,row.slot || 0], facets = [];
    const p = row.people.length ? row.people : [''], f = row.folders.length ? row.folders : [''];
    for (const person of p) {
        facets.push([chat,kind,'person',person]);
        for (const folder of f) {
            facets.push([chat,kind,'person/folder',person,folder], [chat,kind,'folder/person',folder,person]);
        }
    }
    for (const folder of f) facets.push([chat,kind,'folder',folder]);
    for (const tag of row.tags || []) facets.push([chat,kind,'tag',tag]);
    const sort = [row.floor,row.slot || 0,String(id)];
    const filteredOrder = facets.filter(k=>k.length===4).map(k=>[...k,...sort]);
    return {...row,key,facets,filteredOrder,order:[chat,kind,...sort]};
}
export async function writeBatch(chat, floors, progress, active) {
    const db = await database();
    if (!active()) return false;
    const tx = db.transaction(['meta','items'], 'readwrite'), committed = finish(tx), items = tx.objectStore('items');
    for (const {floor,rows} of floors) {
        items.delete(range(chat,'block',floor));
        for (const row of rows) items.put(prepare(chat,'block',floor,{...row,floor}));
    }
    if (progress) tx.objectStore('meta').put(progress,['scan',chat]);
    await committed;
    return true;
}
export async function rewind(chat, floor, revision, next) {
    const db = await database(), tx = db.transaction(['meta','items'],'readwrite'), done = finish(tx);
    tx.objectStore('items').delete(IDBKeyRange.bound([chat,'block',floor],[chat,'block',[]]));
    tx.objectStore('meta').put({next:Math.min(next,floor),revision}, ['scan',chat]);
    await done;
}
export async function saveNote(chat,row,updateBook) {
    const db = await database(), tx = db.transaction(['items','meta'],'readwrite'), done = finish(tx);
    tx.objectStore('items').put(prepare(chat,'note',row.id,row));
    const meta = tx.objectStore('meta');
    const request = meta.get(['book',chat]);
    let book;
    request.onsuccess = () => { book = request.result || blankBook(); updateBook(book); meta.put(book,['book',chat]); };
    await done;
    return book;
}
export async function list(chat,kind,filters = {},before,limit = 36) {
    const db = await database();
    const primary = ['tag','person','folder'].find(dim => filters[dim] != null);
    const prefix = primary ? [chat,kind,primary,filters[primary]] : [chat,kind];
    const index = db.transaction('items').objectStore('items').index(primary ? 'filteredOrder' : 'order');
    const bounds = IDBKeyRange.bound(prefix,before ? [...prefix,...before.slice(2)] : [...prefix,[]],false,!!before);
    const result = [];
    return new Promise((resolve,reject) => {
        const req = index.openCursor(bounds,'prev');
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve({rows:result,more:false});
            const v = c.value;
            const match = (field, key) => filters[key] == null ||
                (v[field]?.length ? v[field] : ['']).includes(filters[key]);
            if (match('people','person') && match('folders','folder') && match('tags','tag')) {
                if (result.length === limit) return resolve({rows:result,more:true});
                result.push(v);
            }
            c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}
export async function groups(chat,kind,dimension,parent) {
    const db = await database();
    const prefix = parent == null ? [chat,kind,dimension] :
        [chat,kind,dimension === 'folder' ? 'person/folder' : 'folder/person',parent];
    const idx = db.transaction('items').objectStore('items').index('facets');
    return new Promise((resolve,reject) => {
        const out = [], req = idx.openKeyCursor(range(...prefix),'nextunique');
        req.onsuccess = () => {
            const c = req.result;
            if (!c) return resolve(out);
            out.push(c.key.at(-1)); c.continue();
        };
        req.onerror = () => reject(req.error);
    });
}
export async function notesAt(chat,floor) {
    const db = await database();
    return pending(db.transaction('items').objectStore('items').index('order').getAll(range(chat,'note',floor)));
}
export async function backup(chat) {
    const db = await database(), tx = db.transaction(['meta','items']);
    const [book,notes] = await Promise.all([pending(tx.objectStore('meta').get(['book',chat])),
        pending(tx.objectStore('items').getAll(range(chat,'note')))]);
    return {format:'mnemosyne-notes',version:1,chat,book:book || blankBook(),
        notes:notes.map(({key,order,facets,filteredOrder,...n}) => n)};
}
export async function restore(chat,data) {
    if (data.format !== 'mnemosyne-notes' || data.version !== 1 || data.chat !== chat ||
        !Array.isArray(data.notes) || !Array.isArray(data.book?.folders)) throw Error('备份格式或聊天不匹配');
    const db = await database(), tx = db.transaction(['items','meta'],'readwrite'), done = finish(tx);
    const book = {...blankBook(),...data.book};
    book.revision++;
    const items = tx.objectStore('items');
    try {
        for (const n of data.notes) {
            if (typeof n.id !== 'string' || !Number.isInteger(n.floor) || !Array.isArray(n.tags) ||
                !Array.isArray(n.people) || !Array.isArray(n.folders)) throw Error('收藏记录格式错误');
            items.put(prepare(chat,'note',n.id,n));
        }
        items.delete(range(chat,'block'));
        tx.objectStore('meta').put(book,['book',chat]);
        tx.objectStore('meta').put({next:0,revision:book.revision},['scan',chat]);
    } catch(e) { tx.abort(); await done.catch(()=>{}); throw e; }
    await done;
    return book;
}

export async function candidateFloors(chat,first,limit=16) {
    const db = await database(), items = db.transaction('items').objectStore('items');
    const bounds = IDBKeyRange.bound([chat,'block',first],[chat,'block',[]]);
    return new Promise((resolve,reject) => {
        const rows=[], req=items.openKeyCursor(bounds);
        req.onsuccess=()=>{
            const c=req.result;
            if(!c||rows.length===limit)return resolve(rows);
            const floor=c.key[2];rows.push(floor);c.continue([chat,'block',floor+1]);
        };
        req.onerror=()=>reject(req.error);
    });
}

export async function removeNote(chat,id) {
    const db=await database(),tx=db.transaction('items','readwrite'),done=finish(tx);
    tx.objectStore('items').delete([chat,'note',id,0]);await done;
}

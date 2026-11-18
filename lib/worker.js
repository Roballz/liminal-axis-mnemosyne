import { compile, extract } from './extract.js';
let cfg;
self.onmessage = ({data}) => {
    try {
        if (data.book) cfg = compile(data.book);
        const results = data.messages.map(m => /<[a-z]/i.test(m.mes) ? extract(m, cfg) : {rows:[],unmarkedDiv:false});
        self.postMessage({results});
    } catch (error) { self.postMessage({error:error.message}); }
};

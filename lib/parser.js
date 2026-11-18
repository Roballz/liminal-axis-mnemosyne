export class Parser {
    async run(messages, book) {
        if (!this.worker) this.worker = new Worker(new URL('./worker.js', import.meta.url), {type:'module'});
        const worker = this.worker;
        return new Promise((resolve, reject) => {
            this.reject = reject;
            const done = (value, error) => {
                clearTimeout(this.timer);
                this.reject = null;
                if (error) { this.stop(); reject(Error(error)); }
                else resolve(value);
            };
            worker.onmessage = ({data}) => done(data.results, data.error);
            worker.onerror = e => done(null, e.message || '识别线程未能启动');
            this.timer = setTimeout(() => done(null, '识别超时，请检查合集正则后重试'), 4500);
            worker.postMessage({messages:messages.map(m => ({mes:m.mes || '', name:m.name, send_date:m.send_date,
                is_user:m.is_user, swipe_id:m.swipe_id})), book:this.revision !== book.revision ? book : undefined});
            this.revision = book.revision;
        });
    }
    stop() {
        clearTimeout(this.timer);
        this.worker?.terminate();
        this.worker = null;
        this.revision = null;
        this.reject?.(Error('识别任务已切换'));
        this.reject = null;
    }
}

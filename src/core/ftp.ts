/**
 * Minimal FTP client (passive mode, binary) to upload the mod to the Switch
 * (mtheall's ftpd, sys-ftpd, sys-ftpd-light...). No external dependency.
 */
import * as net from "net";
import * as fs from "fs";

interface Reply {
    code: number;
    text: string;
}

export interface FtpOptions {
    host: string;
    port?: number;
    user?: string;
    password?: string;
    timeoutMs?: number;
    log?: (s: string) => void;
}

export class FtpClient {
    private sock!: net.Socket;
    private buf = "";
    private waiters: ((r: Reply) => void)[] = [];
    private replies: Reply[] = [];
    private pendingLines: string[] = [];
    private closedErr: Error | undefined;

    constructor(private o: FtpOptions) {}

    private log(s: string) {
        this.o.log?.(s);
    }

    async connect(): Promise<void> {
        const timeout = this.o.timeoutMs ?? 8000;
        await new Promise<void>((resolve, reject) => {
            const s = net.createConnection({ host: this.o.host, port: this.o.port ?? 5000 });
            this.sock = s;
            const t = setTimeout(() => {
                s.destroy();
                reject(new Error(`Timed out connecting to ${this.o.host}:${this.o.port ?? 5000}`));
            }, timeout);
            s.once("connect", () => {
                clearTimeout(t);
                resolve();
            });
            s.once("error", (e) => {
                clearTimeout(t);
                reject(e);
            });
            s.setEncoding("utf8");
            s.on("data", (d: string) => this.onData(d));
            s.on("close", () => {
                this.closedErr = new Error("FTP connection closed by the console");
                for (const w of this.waiters.splice(0)) w({ code: 0, text: "closed" });
            });
        });
        this.sock.on("error", (e) => (this.closedErr = e));
        const hello = await this.read();
        if (hello.code !== 220) throw new Error(`Unexpected FTP server reply: ${hello.code} ${hello.text}`);
        const u = await this.cmd(`USER ${this.o.user || "anonymous"}`);
        if (u.code === 331 || u.code === 332) {
            const p = await this.cmd(`PASS ${this.o.password ?? ""}`, true);
            if (p.code >= 400) throw new Error(`Authentication refused: ${p.text}`);
        } else if (u.code >= 400) throw new Error(`USER refused: ${u.text}`);
        await this.cmd("TYPE I");
    }

    private onData(d: string) {
        this.buf += d;
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
            const line = this.buf.slice(0, idx).replace(/\r$/, "");
            this.buf = this.buf.slice(idx + 1);
            this.pendingLines.push(line);
            // multi-line reply: "123-..." until "123 ..."
            const first = this.pendingLines[0];
            const m = /^(\d{3})([ -])/.exec(first);
            if (!m) {
                this.pendingLines = [];
                continue;
            }
            const done = this.pendingLines.length === 1 ? m[2] === " " : new RegExp(`^${m[1]} `).test(line);
            if (done) {
                const r = { code: parseInt(m[1], 10), text: this.pendingLines.join("\n") };
                this.pendingLines = [];
                const w = this.waiters.shift();
                if (w) w(r);
                else this.replies.push(r);
            }
        }
    }

    private read(): Promise<Reply> {
        const r = this.replies.shift();
        if (r) return Promise.resolve(r);
        if (this.closedErr) return Promise.reject(this.closedErr);
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("No reply from the FTP server")), this.o.timeoutMs ?? 15000);
            this.waiters.push((x) => {
                clearTimeout(t);
                if (x.code === 0) reject(this.closedErr ?? new Error("Connection closed"));
                else resolve(x);
            });
        });
    }

    async cmd(c: string, secret = false): Promise<Reply> {
        this.log("> " + (secret ? c.replace(/ .*/, " ****") : c));
        this.sock.write(c + "\r\n");
        const r = await this.read();
        this.log("< " + r.text);
        return r;
    }

    private async pasv(): Promise<net.Socket> {
        const r = await this.cmd("PASV");
        const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
        if (r.code !== 227 || !m) throw new Error(`PASV refused: ${r.text}`);
        let host = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
        if (host === "0.0.0.0" || host.startsWith("127.")) host = this.o.host;
        const port = parseInt(m[5], 10) * 256 + parseInt(m[6], 10);
        return await new Promise((resolve, reject) => {
            const s = net.createConnection({ host, port });
            const t = setTimeout(() => {
                s.destroy();
                reject(new Error("Could not open the FTP data connection"));
            }, this.o.timeoutMs ?? 8000);
            s.once("connect", () => {
                clearTimeout(t);
                resolve(s);
            });
            s.once("error", (e) => {
                clearTimeout(t);
                reject(e);
            });
        });
    }

    /** Creates a folder recursively ("already exists" errors are ignored). */
    async mkdirp(remoteDir: string) {
        const parts = remoteDir.split("/").filter(Boolean);
        let cur = "";
        for (const p of parts) {
            cur += "/" + p;
            const r = await this.cmd(`MKD ${cur}`);
            if (r.code >= 500 && !/exist|File exists|already/i.test(r.text)) {
                // some servers answer 550 when the folder exists: check with CWD
                const c = await this.cmd(`CWD ${cur}`);
                if (c.code >= 400) throw new Error(`Could not create ${cur}: ${r.text}`);
            }
        }
    }

    async upload(localPath: string, remotePath: string): Promise<number> {
        const data = await this.pasv();
        const size = fs.statSync(localPath).size;
        const r = await this.cmd(`STOR ${remotePath}`);
        if (r.code !== 150 && r.code !== 125) {
            data.destroy();
            throw new Error(`STOR refused for ${remotePath}: ${r.text}`);
        }
        await new Promise<void>((resolve, reject) => {
            const rs = fs.createReadStream(localPath);
            rs.on("error", reject);
            data.on("error", reject);
            rs.pipe(data);
            data.on("close", () => resolve());
        });
        const done = await this.read();
        this.log("< " + done.text);
        if (done.code !== 226 && done.code !== 250) throw new Error(`Incomplete transfer: ${done.text}`);
        return size;
    }

    async quit() {
        try {
            await this.cmd("QUIT");
        } catch {
            /* ignore */
        }
        this.sock.destroy();
    }
}

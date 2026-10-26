import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as http from "http";
import * as path from "path";
import { Detail, parseDocGot, RawIndex, SiteIndex } from "./core/site";
import { cfg } from "./env";

export const DEFAULT_SITE = "https://wibigen.github.io/OdysseyDoc/";

interface HttpResult {
    status: number;
    body: Buffer;
    etag?: string;
}

export function httpGet(url: string, headers: Record<string, string> = {}, redirects = 4): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith("http:") ? http : https;
        const req = mod.get(url, { headers: { "User-Agent": "odysseydoc-vscode", ...headers }, timeout: 60000 }, (res) => {
            const code = res.statusCode ?? 0;
            if (code >= 300 && code < 400 && code !== 304 && res.headers.location && redirects > 0) {
                res.resume();
                resolve(httpGet(new URL(res.headers.location, url).toString(), headers, redirects - 1));
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: code, body: Buffer.concat(chunks), etag: (res.headers.etag as string) || (res.headers["last-modified"] as string) }));
            res.on("error", reject);
        });
        req.on("timeout", () => req.destroy(new Error(`Timed out: ${url}`)));
        req.on("error", reject);
    });
}

/**
 * Access to the OdysseyDoc site data: the index (loaded at startup, revalidated in the background),
 * then entity / source / Ghidra pseudo-code bundles downloaded on demand and cached.
 */
export class DocState {
    readonly output: vscode.OutputChannel;
    private ix_: SiteIndex | undefined;
    private ixPromise: Promise<SiteIndex> | undefined;
    private mem = new Map<string, unknown>();
    private inflight = new Map<string, Promise<unknown>>();
    private readonly _onIndexChanged = new vscode.EventEmitter<SiteIndex>();
    readonly onIndexChanged = this._onIndexChanged.event;
    origin = "";

    constructor(readonly ctx: vscode.ExtensionContext) {
        this.output = vscode.window.createOutputChannel("OdysseyDoc");
    }

    log(s: string) {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);
    }

    get storage(): string {
        const p = this.ctx.globalStorageUri.fsPath;
        fs.mkdirSync(p, { recursive: true });
        return p;
    }

    /** Site URL (always ends with /). */
    siteUrl(): string {
        let u = cfg<string>("siteUrl", DEFAULT_SITE).trim() || DEFAULT_SITE;
        if (!u.endsWith("/")) u += "/";
        return u;
    }

    localSite(): string | undefined {
        const p = cfg<string>("localSitePath", "").trim();
        if (!p) return undefined;
        const d = fs.existsSync(path.join(p, "data", "index.js")) ? p : path.join(p, "OdysseyDoc");
        return fs.existsSync(path.join(d, "data", "index.js")) ? d : undefined;
    }

    private siteCacheDir(): string {
        const h = crypto.createHash("sha1").update(this.localSite() ?? this.siteUrl()).digest("hex").slice(0, 10);
        const d = path.join(this.storage, "site-" + h);
        fs.mkdirSync(d, { recursive: true });
        return d;
    }

    /** Bundle cache folder, specific to the data revision (a new site build invalidates everything). */
    private revCacheDir(): string {
        const m = this.ix_?.meta;
        const rev = m ? `${String(m.decomp_rev).slice(0, 8)}-${String(m.ghidra_rev).slice(0, 8)}` : "norev";
        const d = path.join(this.siteCacheDir(), rev);
        fs.mkdirSync(d, { recursive: true });
        return d;
    }

    pageUrl(ix: SiteIndex, i: number): string {
        return this.siteUrl() + "#/e/" + encodeURIComponent(ix.slug(i));
    }

    get ixIfLoaded(): SiteIndex | undefined {
        return this.ix_;
    }

    // ---------------------------------------------------------------- index
    ix(): Promise<SiteIndex> {
        if (!this.ixPromise) this.ixPromise = this.loadIndex(false);
        return this.ixPromise;
    }

    async refresh(): Promise<SiteIndex> {
        this.mem.clear();
        this.ixPromise = this.loadIndex(true);
        return this.ixPromise;
    }

    private build(text: string, origin: string): SiteIndex {
        const t = Date.now();
        const ix = new SiteIndex(parseDocGot(text).value as RawIndex);
        this.log(`OdysseyDoc index loaded (${origin}): ${ix.size} entities, ${ix.addr.length} addresses, ${Date.now() - t} ms`);
        return ix;
    }

    private async loadIndex(force: boolean): Promise<SiteIndex> {
        const local = this.localSite();
        let ix: SiteIndex;
        if (local) {
            ix = this.build(fs.readFileSync(path.join(local, "data", "index.js"), "utf8"), `local copy ${local}`);
            this.origin = `local copy (${local})`;
        } else {
            const dir = this.siteCacheDir();
            const file = path.join(dir, "index.js");
            const etagFile = path.join(dir, "index.etag");
            const cached = fs.existsSync(file);
            if (cached && !force) {
                ix = this.build(fs.readFileSync(file, "utf8"), "cache");
                this.origin = `${this.siteUrl()} (cache)`;
                void this.revalidate(file, etagFile);
            } else {
                ix = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: "OdysseyDoc: downloading the site index…" },
                    async () => {
                        try {
                            const r = await httpGet(this.siteUrl() + "data/index.js");
                            if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
                            fs.writeFileSync(file, r.body);
                            if (r.etag) fs.writeFileSync(etagFile, r.etag);
                            return this.build(r.body.toString("utf8"), this.siteUrl());
                        } catch (e) {
                            if (cached) {
                                this.log(`Site unreachable (${e}): using the cache`);
                                return this.build(fs.readFileSync(file, "utf8"), "cache (offline)");
                            }
                            throw new Error(`Could not download the OdysseyDoc index from ${this.siteUrl()}: ${e}`);
                        }
                    },
                );
                this.origin = this.siteUrl();
            }
        }
        this.setIndex(ix);
        await this.loadSmallData();
        return ix;
    }

    private setIndex(ix: SiteIndex) {
        this.ix_ = ix;
        this.mem.clear();
        this._onIndexChanged.fire(ix);
    }

    /** Checks in the background whether the site was regenerated (ETag); reloads if so. */
    private async revalidate(file: string, etagFile: string) {
        try {
            const etag = fs.existsSync(etagFile) ? fs.readFileSync(etagFile, "utf8") : "";
            const r = await httpGet(this.siteUrl() + "data/index.js", etag ? { "If-None-Match": etag } : {});
            if (r.status === 304) return;
            if (r.status !== 200) return;
            if (fs.readFileSync(file).equals(r.body)) return;
            fs.writeFileSync(file, r.body);
            if (r.etag) fs.writeFileSync(etagFile, r.etag);
            const ix = this.build(r.body.toString("utf8"), `${this.siteUrl()} (updated)`);
            this.ixPromise = Promise.resolve(ix);
            this.setIndex(ix);
            await this.loadSmallData();
            vscode.window.setStatusBarMessage("$(sync) OdysseyDoc: site data updated", 5000);
        } catch (e) {
            this.log(`Could not revalidate the index: ${e}`);
        }
    }

    private async loadSmallData() {
        const ix = this.ix_;
        if (!ix) return;
        try {
            ix.setStrings((await this.load("strings")) as [string, string][]);
            ix.setSymbols((await this.load("symbols")) as [string, string, string, number][]);
        } catch (e) {
            this.log(`Strings / symbols unavailable: ${e}`);
        }
    }

    // ---------------------------------------------------------------- bundles
    /** Loads data/<key>.js from the site (memory + disk cache). */
    async load(key: string): Promise<unknown> {
        if (this.mem.has(key)) {
            const v = this.mem.get(key);
            this.mem.delete(key); // LRU
            this.mem.set(key, v);
            return v;
        }
        const running = this.inflight.get(key);
        if (running) return running;
        const p = (async () => {
            const rel = "data/" + key.split("/").map(encodeURIComponent).join("/") + ".js";
            let text: string;
            const local = this.localSite();
            if (local) text = fs.readFileSync(path.join(local, "data", ...key.split("/")) + ".js", "utf8");
            else {
                const cacheFile = path.join(this.revCacheDir(), ...key.split("/")) + ".js";
                if (fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, "utf8");
                else {
                    const r = await httpGet(this.siteUrl() + rel);
                    if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${rel}`);
                    text = r.body.toString("utf8");
                    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
                    fs.writeFileSync(cacheFile, text);
                }
            }
            const v = parseDocGot(text).value;
            this.mem.set(key, v);
            while (this.mem.size > 400) this.mem.delete(this.mem.keys().next().value as string);
            return v;
        })();
        this.inflight.set(key, p);
        try {
            return await p;
        } finally {
            this.inflight.delete(key);
        }
    }

    async detail(i: number): Promise<Detail> {
        const ix = await this.ix();
        const b = (await this.load("e/" + ix.bundle(i))) as Record<string, Detail>;
        return b[i] || {};
    }

    async details(ids: number[]): Promise<Map<number, Detail>> {
        const ix = await this.ix();
        const bundles = [...new Set(ids.map((i) => ix.bundle(i)))];
        const loaded = await Promise.all(bundles.map((b) => this.load("e/" + b).then((v) => [b, v as Record<string, Detail>] as const)));
        const byB = new Map(loaded);
        const out = new Map<number, Detail>();
        for (const i of ids) out.set(i, byB.get(ix.bundle(i))?.[i] || {});
        return out;
    }

    async source(fi: number): Promise<string> {
        return (await this.load("src/" + fi)) as string;
    }

    /** Ghidra pseudo-code (bundle data/gh/<n>.js, same number as the entity bundle). */
    async ghidra(i: number, ghPath: string): Promise<string> {
        const ix = await this.ix();
        const b = (await this.load("gh/" + ix.bundle(i))) as Record<string, string>;
        if (!(ghPath in b)) throw new Error(`pseudo-code missing from the site: ${ghPath}`);
        return b[ghPath];
    }

    clearDiskCache() {
        fs.rmSync(this.siteCacheDir(), { recursive: true, force: true });
        this.mem.clear();
    }
}

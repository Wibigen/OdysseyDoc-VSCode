/** Windows <-> WSL path conversions, independent of VS Code. */

const UNC_RX = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(\\.*)?$/i;

export function uncDistro(p: string): string | undefined {
    const m = UNC_RX.exec(p.replace(/\//g, "\\"));
    return m ? m[1] : undefined;
}

/** "C:\\Users\\x\\proj" -> "/mnt/c/Users/x/proj" ; "\\\\wsl.localhost\\Ubuntu\\home\\x" -> "/home/x" */
export function winToWsl(p: string, mountRoot = "/mnt/"): string {
    const bs = p.replace(/\//g, "\\");
    const m = UNC_RX.exec(bs);
    if (m) return (m[2] ?? "\\").replace(/\\/g, "/") || "/";
    const d = /^([A-Za-z]):\\?(.*)$/.exec(bs);
    if (d) {
        const root = mountRoot.endsWith("/") ? mountRoot : mountRoot + "/";
        return `${root}${d[1].toLowerCase()}/${d[2].replace(/\\/g, "/")}`.replace(/\/+$/, "") || "/";
    }
    return p.replace(/\\/g, "/");
}

/** "/mnt/c/Users/x" -> "C:\\Users\\x" ; "/home/x" -> "\\\\wsl.localhost\\<distro>\\home\\x" */
export function wslToWin(p: string, distro: string | undefined, mountRoot = "/mnt/"): string {
    const root = mountRoot.endsWith("/") ? mountRoot : mountRoot + "/";
    if (p.startsWith(root)) {
        const rest = p.slice(root.length);
        const m = /^([a-zA-Z])(\/.*)?$/.exec(rest);
        if (m) return `${m[1].toUpperCase()}:${(m[2] ?? "\\").replace(/\//g, "\\")}`;
    }
    if (!p.startsWith("/")) return p;
    return `\\\\wsl.localhost\\${distro ?? "Ubuntu"}${p.replace(/\//g, "\\")}`;
}

export interface PathMapper {
    /** path seen by the build tool -> path seen by VS Code */
    toHost(p: string): string;
    /** VS Code path -> path seen by the build tool */
    toBuild(p: string): string;
}

export const identityMapper: PathMapper = { toHost: (p) => p, toBuild: (p) => p };

export function makeWslMapper(hostRoot: string, distro: string | undefined, mountRoot = "/mnt/"): PathMapper {
    const buildRoot = winToWsl(hostRoot, mountRoot);
    const hostNorm = hostRoot.replace(/[\\/]+$/, "");
    return {
        toHost(p: string) {
            if (!p.startsWith("/")) return p;
            if (p === buildRoot || p.startsWith(buildRoot + "/")) {
                return hostNorm + p.slice(buildRoot.length).replace(/\//g, "\\");
            }
            return wslToWin(p, distro, mountRoot);
        },
        toBuild(p: string) {
            return winToWsl(p, mountRoot);
        },
    };
}

/** POSIX quoting for bash. */
export function shQuote(s: string): string {
    if (/^[\w@%+=:,./-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, `'\\''`) + "'";
}

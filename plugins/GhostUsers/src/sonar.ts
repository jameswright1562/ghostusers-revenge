// Finding out who actually serves a screen, instead of guessing.
//
// Every getter on every store that could plausibly be about people is wrapped, and
// whatever comes back is searched for the id of someone hidden. When a match turns
// up, the store and method are printed once. Open the screen that still shows them,
// read the log, and the exact place to filter is known — no more shipping a version
// to find out it hooked nothing.
//
// This only reads and prints. It is switched off unless the setting is on.

import { after } from "@vendetta/patcher";
import { findAll } from "@vendetta/metro";
import { store } from "./core";

const log = (line: string) => console.log(`[GhostUsers][sonar] ${line}`);
const reported = new Set<string>();

/** Does this value mention the id anywhere near the surface? */
function mentions(value: any, id: string, depth = 0, budget = { n: 6000 }): boolean {
    if (budget.n-- <= 0 || value == null || depth > 7) return false;
    if (typeof value === "string") return value === id;
    if (typeof value !== "object") return false;
    if (Array.isArray(value)) {
        for (const v of value) if (mentions(v, id, depth + 1, budget)) return true;
        return false;
    }
    for (const [k, v] of Object.entries(value)) {
        if (k === id) return true;
        if (mentions(v, id, depth + 1, budget)) return true;
    }
    return false;
}

/** How many getters may be watched at once. Every one of them pays the search on
    every call, and a phone notices long before a desktop does. */
const MAX_WATCHED = 200;

export function startSonar(patches: (() => void)[]) {
    // Never in normal use. This asks the app for every module it has and then puts
    // a deep search in front of hundreds of getters that Discord calls constantly —
    // enough work, on a phone, to hold up the very first frames after launch.
    if (!store.debug) return;

    const targets = Object.keys(store.users ?? {});
    if (!targets.length) return log("nobody hidden — nothing to look for");

    let wrapped = 0;
    const stores = findAll((m: any) => typeof m?.getName === "function" && typeof m?.addChangeListener === "function");

    for (const s of stores) {
        if (wrapped >= MAX_WATCHED) break;
        let name = "";
        try {
            name = s.getName();
        } catch {
            continue;
        }
        if (!/member|channel|guild|user|voice|call|typing|reaction|message|friend|relationship|presence|private|dm/i.test(name)) continue;

        const proto = Object.getPrototypeOf(s) ?? {};
        const methods = [
            ...Object.keys(s),
            ...Object.getOwnPropertyNames(proto),
        ].filter(k => /^(get|use|load)/.test(k) && typeof (s as any)[k] === "function");

        for (const method of methods.slice(0, 20)) {
            try {
                patches.push(
                    after(method, s, (_args: any[], ret: any) => {
                        try {
                            const key = `${name}.${method}`;
                            if (reported.has(key) || ret == null) return ret;
                            for (const id of targets) {
                                if (mentions(ret, id)) {
                                    reported.add(key);
                                    log(key);
                                    break;
                                }
                            }
                        } catch { /* a getter that dislikes being watched */ }
                        return ret;
                    }),
                );
                wrapped++;
            } catch { /* not patchable */ }
        }
    }
    log(`listening on ${wrapped} getters across ${stores.length} stores`);
}

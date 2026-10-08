// One-off reconnaissance, printed to the app's log. Names of Discord's internals
// differ between builds, and guessing them is how the Aliucord port lost five
// releases to hooks that attached to nothing. So the plugin looks around the actual
// client it is running in and reports what it finds; the results decide which
// modules the next version targets.
//
// Everything here only reads and prints — it changes nothing and sends nothing.

import { findAll, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";

const log = (line: string) => console.log(`[GhostUsers][find] ${line}`);

const INTERESTING = /member|reaction|call|voice|ring|typing|message|channel|friend|relationship|presence|private|dm/i;

export function reconnoitre() {
    try {
        // 1. Flux stores, by their own reported name
        const stores = findAll((m: any) => typeof m?.getName === "function" && typeof m?.addChangeListener === "function");
        const names = new Set<string>();
        for (const s of stores) {
            try {
                const n = s.getName();
                if (typeof n === "string" && INTERESTING.test(n)) names.add(n);
            } catch { /* a store that dislikes being asked */ }
        }
        log(`stores: ${[...names].sort().join(", ") || "none"}`);

        // 2. the dispatcher's own entry points
        log(`dispatcher methods: ${Object.keys(FluxDispatcher ?? {}).filter(k => typeof (FluxDispatcher as any)[k] === "function").join(", ")}`);

        // 3. anything that can open a sheet — the profile button needs one of these
        const sheets = findAll((m: any) =>
            m && typeof m === "object" && Object.keys(m).some(k => /^open(Lazy|ActionSheet|Sheet)$/i.test(k)));
        log(`sheet modules: ${sheets.slice(0, 4).map((m: any) => Object.keys(m).slice(0, 6).join("/")).join(" | ") || "none"}`);

        // 4. whoever knows how to fetch who reacted
        const reactionMods = findAll((m: any) =>
            m && typeof m === "object" && Object.keys(m).some(k => /fetchReaction|getReactions|addReaction/i.test(k)));
        log(`reaction modules: ${reactionMods.slice(0, 4).map((m: any) => Object.keys(m).filter(k => /reaction/i.test(k)).slice(0, 5).join("/")).join(" | ") || "none"}`);

        // 5. what the stores that matter can actually do
        for (const name of [
            "ChannelMemberStore",
            "GuildMemberCountStore",
            "ChannelMemberCountStore",
            "MessageReactionsStore",
            "CallStore",
            "TypingStore",
            "SortedVoiceStateStore",
            "VoiceStateStore",
            "RelationshipStore",
            "PresenceStore",
            "PrivateChannelStore",
        ]) {
            const s = findByStoreName(name);
            if (!s) {
                log(`${name}: not found`);
                continue;
            }
            const proto = Object.getPrototypeOf(s) ?? {};
            const methods = [
                ...Object.keys(s).filter(k => typeof s[k] === "function"),
                ...Object.getOwnPropertyNames(proto).filter(k => k !== "constructor" && typeof proto[k] === "function"),
            ];
            log(`${name}: ${[...new Set(methods)].slice(0, 14).join(", ")}`);
        }

        // 6. rows usable inside an action sheet (ButtonRow is gone on this build)
        const rowNames = new Set<string>();
        for (const m of findAll((mod: any) => {
            const c = mod?.default ?? mod;
            const n = c?.displayName ?? c?.name;
            return typeof n === "string" && /^(TableRow|ActionSheetRow|ButtonRow|TableRowGroup|FormRow)/.test(n);
        })) {
            const c = (m as any)?.default ?? m;
            rowNames.add(c.displayName ?? c.name);
        }
        log(`sheet row components: ${[...rowNames].slice(0, 10).join(", ") || "none"}`);

        // 6b. which newer language features this engine actually has
        log(`engine: getOwnPropertyDescriptors=${typeof (Object as any).getOwnPropertyDescriptors}`
            + ` fromEntries=${typeof (Object as any).fromEntries}`
            + ` structuredClone=${typeof (globalThis as any).structuredClone}`
            + ` flat=${typeof [].flat}`);

        // 7. the dispatcher keeps its methods on the prototype
        const dproto = Object.getPrototypeOf(FluxDispatcher ?? {}) ?? {};
        log(`dispatcher proto: ${Object.getOwnPropertyNames(dproto).filter(k => k !== "constructor").slice(0, 14).join(", ")}`);
    } catch (e) {
        log(`failed: ${e}`);
    }
}

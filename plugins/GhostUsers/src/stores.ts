// Everything the app reads before it draws. Filtering here rather than in the UI is
// what keeps a hidden person from ever flashing on screen: the client is simply
// handed data they are not in, so there is nothing to un-draw a moment later.
//
// Every store and method name below was read out of the running client, not guessed.

import { after } from "@vendetta/patcher";
import { findByStoreName } from "@vendetta/metro";
import { anyHidden, BUILD_TAG, diag, isHiddenIn, isHidden, mark, note, noteLiveRelationships, onHiddenSetChanged, opt, SelectedChannelStore, store, wasStashedFriend } from "./core";
import { learnReactors, emojiKey } from "./reactions";

const idOf = (x: any): string | undefined =>
    typeof x === "string" ? x : x?.userId ?? x?.user?.id ?? x?.id;

/** Hidden here, and hidden from lists of people specifically. */
const hiddenInList = (userId?: string, channelId?: string) =>
    !!userId && isHiddenIn(userId, channelId) && opt(userId, "hideMemberList");

/** Friends list has no channel, so scope switches don't apply — the
    member-lists switch alone decides. */
const hiddenFriend = (userId?: string | null) =>
    !!userId && isHidden(userId) && opt(userId, "hideMemberList");

/** Whatever shape a relationship list takes on this build: ids, user
    objects, or a map keyed by id. Counts (numbers) are left alone. */
function filterRelationships(ret: any): any {
    if (Array.isArray(ret)) {
        const kept = ret.filter((r: any) => !hiddenFriend(idOf(r) ?? (r as any)?.user_id));
        if (kept.length === ret.length) return ret;
        diag.rows += ret.length - kept.length;
        return kept;
    }
    if (ret instanceof Map) {
        let changed = false;
        const out = new Map();
        for (const [k, v] of ret) {
            if (hiddenFriend(typeof k === "string" ? k : idOf(v))) { changed = true; continue; }
            out.set(k, v);
        }
        if (!changed) return ret;
        diag.rows++;
        return out;
    }
    if (ret && typeof ret === "object") {
        const keys = Object.keys(ret);
        if (!keys.length) return ret;
        // heuristic: a map of userId -> something (type, relationship)
        const looksLikeIdMap = keys.some(k => /^\d{15,}$/.test(k));
        if (!looksLikeIdMap) return ret;
        let changed = false;
        const out: any = {};
        for (const [k, v] of Object.entries(ret)) {
            if (hiddenFriend(k) || hiddenFriend(idOf(v))) { changed = true; continue; }
            out[k] = v;
        }
        if (!changed) return ret;
        diag.rows++;
        return out;
    }
    return ret;
}

/** A DM/group-DM channel row hides when any of its other people is hidden
    there. Respects their scope switches via the channel in hand. */
function channelHidesRow(ch: any): boolean {
    if (!ch || typeof ch !== "object") return false;
    const chId = ch.id ?? ch.channelId ?? ch.channel_id;
    const lists = [ch.recipients, ch.rawRecipients, ch.recipientIds];
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const r of list) {
            const id = idOf(r);
            if (id && hiddenInList(id, chId)) return true;
        }
    }
    const single = ch.recipientId ?? ch.recipient_id ?? ch.userId;
    if (typeof single === "string" && hiddenInList(single, chId)) return true;
    return false;
}

function filterDMChannels(ret: any): any {
    // Some builds hand over bare channel ids — resolve before deciding.
    const fullOf = (ch: any) => {
        if (typeof ch === "string") {
            try {
                return findByStoreName("ChannelStore")?.getChannel?.(ch) ?? ch;
            } catch {
                return ch;
            }
        }
        return ch;
    };
    if (Array.isArray(ret)) {
        const kept = ret.filter((ch: any) => !channelHidesRow(fullOf(ch)));
        if (kept.length === ret.length) return ret;
        diag.rows += ret.length - kept.length;
        return kept;
    }
    if (ret && typeof ret === "object") {
        const keys = Object.keys(ret);
        if (!keys.length) return ret;
        let changed = false;
        const out: any = {};
        for (const [k, v] of Object.entries(ret)) {
            if (v && typeof v === "object" && channelHidesRow(v)) { changed = true; continue; }
            out[k] = v;
        }
        if (!changed) return ret;
        diag.rows++;
        return out;
    }
    return ret;
}

/** Summarise a value's shape without dumping personal data. */
function shapeOf(v: any): string {
    try {
        if (Array.isArray(v)) {
            const f = v[0];
            const id = typeof f === "string" ? f : f?.userId ?? f?.user?.id ?? f?.id ?? f?.user_id;
            return `arr[${v.length}](${typeof f}${id ? `:${String(id).slice(0, 6)}..` : ""})`;
        }
        if (v && typeof v === "object") {
            const keys = Object.keys(v);
            return `obj{${keys.slice(0, 5).join(",")}}${keys.length > 5 ? `+${keys.length - 5}` : ""}`;
        }
        return typeof v;
    } catch {
        return "?";
    }
}

/** List social getters and sample the zero-arg ones. Runs once at load; the
    results land in Settings notes, so a renamed getter gets caught without
    adb. Never throws. */
function probeSocialStores() {
    note(`build: ${BUILD_TAG}`);
    for (const name of ["RelationshipStore", "PrivateChannelStore", "DirectMessageStore", "PresenceStore"]) {        let s: any = null;
        try {
            s = findByStoreName(name);
        } catch { s = null; }
        if (!s) {
            note(`${name}: missing`);
            continue;
        }
        try {
            const proto = Object.getPrototypeOf(s) ?? {};
            const methods = [...new Set([
                ...Object.keys(s),
                ...Object.getOwnPropertyNames(proto),
            ])].filter(k =>
                k !== "constructor" && typeof (s as any)[k] === "function"
                && /relation|friend|presence|private|sorted|blocked|pending/i.test(k));
            note(`${name}: ${methods.slice(0, 40).join(",") || "no match"}`);
            for (const m of ["getRelationships", "getMutableRelationships", "getFriendIDs", "getPrivateChannels", "getSortedPrivateChannels"]) {
                if (typeof s[m] !== "function") continue;
                try {
                    note(`${name}.${m}: ${shapeOf(s[m]())}`);
                } catch {
                    note(`${name}.${m}: threw`);
                }
            }
        } catch (e) {
            console.log(`[GhostUsers] probe ${name}`, e);
        }
    }
    // Do the list stores even offer a change emission for the hide/show poke?
    for (const name of ["RelationshipStore", "ChannelStore"]) {
        try {
            const s: any = findByStoreName(name);
            if (!s) {
                note(`${name}.emit: missing store`);
                continue;
            }
            const proto = Object.getPrototypeOf(s) ?? {};
            const methods = [...new Set([
                ...Object.keys(s),
                ...Object.getOwnPropertyNames(proto),
            ])].filter(k =>
                k !== "constructor" && typeof s[k] === "function"
                && /emit|change|notif|dispatch|update/i.test(k));
            note(`${name}.emit: ${methods.slice(0, 10).join(",") || "NONE"}`);
        } catch (e) {
            console.log(`[GhostUsers] probe emit ${name}`, e);
        }
    }
}

/** Bumped whenever the hidden set changes, so cached copies are thrown away. */
let generation = 0;
export const bumpGeneration = () => generation++;

onHiddenSetChanged(() => generation++);

export function patchStores(patches: (() => void)[]) {
    /* ---- group DMs: the member list and its count come from the channel's own
       recipients, not from any member store. The channel is handed over as a copy
       without the hidden people in it — memoised, because this is read constantly. */
    const ChannelStore = findByStoreName("ChannelStore");
    if (ChannelStore?.getChannel) {
        // a plain object, not a Map: this engine handed back a Map whose get()
        // was undefined, and a cache is not worth a mystery
        const memo: Record<string, { gen: number; from: any; copy: any }> = {};
        patches.push(
            after("getChannel", ChannelStore, ([channelId]: any[], ch: any) => {
                try {
                    if (!ch) return ch;
                    if (!anyHidden()) return ch;
                    if (ch.type !== 3) return ch;
                    const cached = memo[channelId];
                    if (cached && cached.gen === generation && cached.from === ch) return cached.copy;

                    // NB: the scope is decided from the channel in hand, never by
                    // asking the store what kind of channel this is — that call comes
                    // straight back here and never ends.
                    const dropped = (r: any) => {
                        const id = idOf(r);
                        return !!id && isHidden(id) && opt(id, "scopeGroups") && opt(id, "hideMemberList");
                    };
                    const filterList = (list: any) =>
                        Array.isArray(list) ? list.filter((r: any) => !dropped(r)) : list;
                    const recipients = filterList(ch.recipients);
                    const rawRecipients = filterList(ch.rawRecipients);
                    const recipientIds = filterList(ch.recipientIds);
                    const changed =
                        recipients?.length !== ch.recipients?.length
                        || rawRecipients?.length !== ch.rawRecipients?.length
                        || recipientIds?.length !== ch.recipientIds?.length;
                    if (!changed) return ch;

                    // A channel is a class instance whose methods the app calls
                    // (isMultiUserDM and friends). Copying only the enumerable
                    // properties strips those and the screen dies on "undefined is
                    // not a function" — so every descriptor comes along.
                    // built one descriptor at a time: the plural form of this call is
                    // newer than the engine some builds run on
                    const copy = Object.create(Object.getPrototypeOf(ch));
                    for (const key of Object.getOwnPropertyNames(ch)) {
                        const d = Object.getOwnPropertyDescriptor(ch, key);
                        if (d) Object.defineProperty(copy, key, d);
                    }
                    const set = (key: string, value: any) => {
                        if (value === undefined) return;
                        Object.defineProperty(copy, key, {
                            value,
                            writable: true,
                            enumerable: true,
                            configurable: true,
                        });
                    };
                    set("recipients", recipients);
                    set("rawRecipients", rawRecipients);
                    set("recipientIds", recipientIds);
                    memo[channelId] = { gen: generation, from: ch, copy };
                    diag.rows++;
                    return copy;
                } catch (e: any) {
                    console.log(`[GhostUsers] getChannel: ${e?.message}`);
                    return ch;
                }
            }),
        );
        mark("groupRecipients", true);
    } else {
        mark("groupRecipients", false, "ChannelStore.getChannel");
    }

    const on = (
        storeName: string,
        method: string,
        cb: (args: any[], ret: any) => any,
        mark$ = storeName,
        optional = false,
    ) => {
        const store = findByStoreName(storeName);
        if (!store || typeof store[method] !== "function") {
            // Some readers exist on one voice store and not the other; a build that
            // lacks one of those is not missing anything, so it is not reported.
            if (!optional) mark(mark$, false, `${storeName}.${method}`);
            return false;
        }
        patches.push(
            after(method, store, (args: any[], ret: any) => {
                try {
                    if (!anyHidden()) return ret;
                    return cb(args, ret);
                } catch (e) {
                    console.log(`[GhostUsers] ${storeName}.${method}`, e);
                    return ret;
                }
            }),
        );
        mark(mark$, true);
        return true;
    };

    /* ---- typing ---- */
    on("TypingStore", "getTypingUsers", ([channelId], ret) => {
        if (!ret || typeof ret !== "object") return ret;
        const out: any = {};
        let changed = false;
        for (const [userId, value] of Object.entries(ret)) {
            if (isHiddenIn(userId, channelId)) changed = true;
            else out[userId] = value;
        }
        return changed ? out : ret;
    }, "typing");

    /* ---- member list: the rows the panel draws ---- */
    /** A member row, whichever way this build shapes one. */
    const rowUserId = (row: any) =>
        row?.user?.id ?? row?.member?.user?.id ?? row?.userId ?? row?.member?.userId ?? row?.id;

    let sampled = false;
    on("ChannelMemberStore", "getProps", (args, ret) => {
        if (!ret || !Array.isArray(ret.rows)) return ret;
        if (!sampled) {
            sampled = true;
            const sample = ret.rows.find((r: any) => r);
            console.log(`[GhostUsers] member row shape: ${JSON.stringify(sample)?.slice(0, 200)}`);
        }
        const guildId = args[0];
        const rows = ret.rows.filter((row: any) => {
            const uid = rowUserId(row);
            return !(uid && isHiddenIn(uid, undefined, guildId) && opt(uid, "hideMemberList"));
        });
        if (rows.length === ret.rows.length) return ret;
        const removed = ret.rows.length - rows.length;
        diag.rows += removed;
        const groups = Array.isArray(ret.groups)
            ? ret.groups.map((g: any) =>
                typeof g?.count === "number" ? { ...g, count: Math.max(0, g.count - removed) } : g)
            : ret.groups;
        return { ...ret, rows, groups };
    }, "memberProps");

    let rowsLogged = 0;
    on("ChannelMemberStore", "getRows", (args, ret) => {
        if (!Array.isArray(ret)) return ret;
        if (rowsLogged < 3) {
            rowsLogged++;
            console.log(`[GhostUsers] getRows args=${args.map(a => typeof a === "object" ? "obj" : a).join(",")}`
                + ` rows=${ret.length} first=${JSON.stringify(ret[0])?.slice(0, 160)}`);
        }
        const channelId = args[1] ?? args[0];
        const kept = ret.filter((row: any) => {
            const userId = idOf(row?.user) ?? row?.userId ?? idOf(row);
            return !hiddenInList(userId, channelId);
        });
        if (kept.length === ret.length) return ret;
        diag.rows++;
        // headers carry their own count, which has to shrink with the rows
        return kept.map((row: any) => {
            const count = row?.count;
            if (typeof count !== "number") return row;
            const removed = ret.length - kept.length;
            return { ...row, count: Math.max(0, count - removed) };
        });
    }, "memberRows");

    /* ---- the counters above those lists ---- */
    const countHiddenIn = (channelId?: string) => {
        try {
            const store = findByStoreName("ChannelMemberStore");
            const rows = store?.getRows?.(undefined, channelId);
            if (!Array.isArray(rows)) return 0;
            return rows.filter((r: any) => hiddenInList(idOf(r?.user) ?? r?.userId, channelId)).length;
        } catch {
            return 0;
        }
    };

    /** How many hidden people are actually in this server. Membership is asked of
        the app rather than assumed, so a server they are not in keeps its count. */
    const hiddenInGuild = (guildId?: string) => {
        if (!guildId) return 0;
        try {
            const members = findByStoreName("GuildMemberStore");
            let n = 0;
            for (const id of Object.keys(store.users ?? {})) {
                if (!isHiddenIn(id, undefined, guildId) || !opt(id, "hideMemberList")) continue;
                const isMember = members?.isMember?.(guildId, id)
                    ?? !!members?.getMember?.(guildId, id)
                    ?? true;
                if (isMember) n++;
            }
            return n;
        } catch {
            return 0;
        }
    };

    on("GuildMemberCountStore", "getMemberCount", ([guildId], ret) =>
        typeof ret === "number" ? Math.max(0, ret - hiddenInGuild(guildId)) : ret,
        "memberCount");

    on("GuildMemberCountStore", "getOnlineCount", ([guildId], ret) => ret,
        "onlineCount");

    on("ChannelMemberCountStore", "getMemberCount", ([channelId], ret) =>
        typeof ret === "number" ? Math.max(0, ret - countHiddenIn(channelId)) : ret,
        "channelMemberCount");

    /* ---- friends list: no channel, so only the member-lists switch applies.
       Single-user lookups (isFriend/getRelationshipType) are deliberately left
       alone — the friendship still exists, it is just not listed. Method names
       differ per build, so every plausible getter is tried; the About block
       shows which ones attached. */
    for (const m of ["getRelationships", "getRelationshipsByType",
        "getFriends", "getPendingIDs", "getBlockedIDs", "getSortedRelationships",
        "getRelationshipIDs", "getAllRelationships"]) {
        on("RelationshipStore", m, (_a, ret) => filterRelationships(ret), `rel:${m}`, true);
    }
    // The IDs getter doubles as the Friends-screen source on some builds:
    // same filter, plus first-sight shape and drop reporting.
    on("RelationshipStore", "getFriendIDs", (_a, ret) => {
        try {
            if (Array.isArray(ret) && ret.length && !diag.notes.some(n => n.startsWith("ids-shape:"))) {
                note(`ids-shape: [${ret.length}]=${ret.slice(0, 3).join(",")}`);
            }
        } catch { /* ignore */ }
        const before = Array.isArray(ret) ? ret.length : 0;
        const out = filterRelationships(ret);
        try {
            const afterN = Array.isArray(out) ? out.length : 0;
            if (before > afterN && !diag.notes.some(n => n.startsWith("ids-dropped:")))
                note(`ids-dropped: ${before - afterN}`);
        } catch { /* ignore */ }
        return out;
    }, "rel:getFriendIDs", true);
    // Keep the raw-map capture fresh (ret here is always pristine). Installed
    // before the filter below so ordering can never hand us a filtered copy.
    try {
        const rs0 = findByStoreName("RelationshipStore");
        if (rs0 && typeof rs0.getMutableRelationships === "function") {
            patches.push(after("getMutableRelationships", rs0, (_a: any[], ret: any) => {
                try { noteLiveRelationships(ret); } catch { /* ignore */ }
                return ret;
            }));
            mark("relLive", true);
        } else {
            mark("relLive", false, "no getMutableRelationships");
        }
    } catch (e) {
        mark("relLive", false, "patch failed");
        console.log("[GhostUsers] relLive", e);
    }
    // The live Friends-screen getter: same filter, plus first-sight shape and
    // drop reporting (load-time probes always see it empty).
    on("RelationshipStore", "getMutableRelationships", (_a, ret) => {
        try {
            if (ret && typeof ret === "object") {
                const keys = Object.keys(ret);
                if (keys.length && !diag.notes.some(n => n.startsWith("rel-shape:"))) {
                    note(`rel-shape: keys[${keys.length}]=${keys.slice(0, 3).join(",")}|val=${JSON.stringify((ret as any)[keys[0]]).slice(0, 120)}`);
                }
            }
        } catch { /* ignore */ }
        const sizeOf = (v: any) => Array.isArray(v) ? v.length
            : v && typeof v === "object" ? Object.keys(v).length : 0;
        const before = sizeOf(ret);
        const out = filterRelationships(ret);
        try {
            if (before > sizeOf(out) && !diag.notes.some(n => n.startsWith("rel-dropped:")))
                note(`rel-dropped: ${before - sizeOf(out)}`);
        } catch { /* ignore */ }
        return out;
    }, "rel:getMutableRelationships", true);

    /** How many hidden people are actually friends (membership asked of the
        unpatched lookup, never assumed). */
    const hiddenFriendCount = () => {
        try {
            const rs = findByStoreName("RelationshipStore");
            let n = 0;
            for (const id of Object.keys(store.users ?? {})) {
                if (!opt(id, "hideMemberList")) continue;
                let friend = wasStashedFriend(id);
                try {
                    const f = rs?.isFriend?.(id);
                    if (typeof f === "boolean") friend = f || friend;
                    else if (rs?.getRelationshipType?.(id) === 1) friend = true;
                } catch { /* keep the stash verdict */ }
                if (friend) n++;
            }
            return n;
        } catch {
            return 0;
        }
    };
    for (const m of ["getFriendCount", "getRelationshipCount", "getRelationshipsCount", "getTotalCount"]) {
        on("RelationshipStore", m, (_a, ret) =>
            typeof ret === "number" ? Math.max(0, ret - hiddenFriendCount()) : ret,
            `rel:${m}`, true);
    }

    /* ---- DM list: 1:1 DMs hide via scopeDMs, group DMs via scopeGroups
       (through isHiddenIn inside channelHidesRow). Single-channel lookups are
       left alone so opening a DM from a profile still works. */
    for (const [sn, m] of [
        ["PrivateChannelStore", "getPrivateChannels"],
        ["PrivateChannelStore", "getSortedPrivateChannels"],
        ["ChannelStore", "getSortedPrivateChannels"],
        ["ChannelStore", "getPrivateChannels"],
        ["ChannelStore", "getMutablePrivateChannels"],
        ["DirectMessageStore", "getPrivateChannels"],
        ["DirectMessageStore", "getSortedPrivateChannels"],
    ] as [string, string][]) {
        on(sn, m, (_a, ret) => filterDMChannels(ret), `dm:${sn}.${m}`, true);
    }

    /* ---- one-time probe of the social stores; see Settings notes. */
    try {
        probeSocialStores();
    } catch (e) {
        console.log("[GhostUsers] probe", e);
    }

    // ChannelStore carries the DM list on builds without a dedicated store.
    try {
        const cs: any = findByStoreName("ChannelStore");
        if (cs) {
            const proto = Object.getPrototypeOf(cs) ?? {};
            const methods = [...new Set([
                ...Object.keys(cs),
                ...Object.getOwnPropertyNames(proto),
            ])].filter(k =>
                k !== "constructor" && typeof cs[k] === "function"
                && /private|sortedprivate|^getDM|direct/i.test(k));
            note(`ChannelStore: ${methods.slice(0, 40).join(",") || "no match"}`);
            for (const m of ["getPrivateChannels", "getSortedPrivateChannels", "getMutablePrivateChannels"]) {
                if (typeof cs[m] !== "function") continue;
                try {
                    note(`ChannelStore.${m}: ${shapeOf(cs[m]())}`);
                } catch {
                    note(`ChannelStore.${m}: threw`);
                }
            }
        } else {
            note("ChannelStore: missing");
        }
    } catch (e) {
        console.log("[GhostUsers] probe channels", e);
    }

    /* ---- reactions: who reacted, straight from the store ----
       This is the same trick the desktop plugin uses. Every list of reactors the app
       reads is filtered, and what it said is remembered, so the numbers on the chips
       can be corrected even for reactions left long before anyone was hidden. */
    on("MessageReactionsStore", "getReactions", ([channelId, messageId, emoji], ret) => {
        if (!Array.isArray(ret) || !ret.length) return ret;
        const ek = emojiKey(emoji);
        const hidden = ret.filter((u: any) => isHiddenIn(idOf(u), channelId)).map((u: any) => idOf(u)!);
        if (!hidden.length) {
            if (ek) learnReactors(channelId, messageId, ek, []);
            return ret;
        }
        if (ek) learnReactors(channelId, messageId, ek, hidden);
        return ret.filter((u: any) => !isHiddenIn(idOf(u), channelId));
    }, "reactors");

    /* ---- calls ---- */
    const visibleInCall = (channelId?: string) => {
        try {
            const store = findByStoreName("VoiceStateStore");
            const states = store?.getVoiceStatesForChannel?.(channelId);
            if (!states) return null;
            const list = Array.isArray(states) ? states : Object.values(states);
            return list.filter((vs: any) => !isHiddenIn(idOf(vs), channelId)).length;
        } catch {
            return null;
        }
    };

    const stripCall = (call: any) => {
        if (!call || typeof call !== "object") return call;
        const chId = call.channelId ?? call.channel_id;
        const ringing = call.ringing ?? call.ongoingRings;
        if (!Array.isArray(ringing)) return call;
        const kept = ringing.filter((r: any) => !isHiddenIn(idOf(r), chId));
        return kept.length === ringing.length ? call : { ...call, ringing: kept, ongoingRings: kept };
    };

    on("CallStore", "getCall", ([channelId], ret) => {
        if (!ret) return ret;
        // a call nobody visible is in does not exist for us
        return visibleInCall(channelId) === 0 ? null : stripCall(ret);
    }, "callStore");

    on("CallStore", "getCalls", (_a, ret) =>
        Array.isArray(ret)
            ? ret.filter((c: any) => visibleInCall(c?.channelId ?? c?.channel_id) !== 0).map(stripCall)
            : ret,
        "callList");

    on("CallStore", "isCallActive", ([channelId], ret) =>
        ret && visibleInCall(channelId) === 0 ? false : ret,
        "callActive");

    /* ---- who the call UI thinks is in the call ---- */
    const filterStates = (states: any, channelId?: string) => {
        if (!states) return states;
        if (Array.isArray(states)) {
            const kept = states.filter((vs: any) => !isHiddenIn(idOf(vs), channelId));
            return kept.length === states.length ? states : kept;
        }
        if (typeof states !== "object") return states;
        const out: any = {};
        let changed = false;
        for (const [userId, vs] of Object.entries(states)) {
            if (isHiddenIn(userId, channelId)) changed = true;
            else out[userId] = vs;
        }
        return changed ? out : states;
    };

    for (const storeName of ["VoiceStateStore", "SortedVoiceStateStore"]) {
        on(storeName, "getVoiceStatesForChannel", ([a, b], ret) => filterStates(ret, b ?? a), `${storeName}.forChannel`);
        on(storeName, "getVoiceStatesForChannelAlt", ([a, b], ret) => filterStates(ret, b ?? a), `${storeName}.forChannelAlt`, true);
        on(storeName, "getVideoVoiceStatesForChannel", ([a, b], ret) => filterStates(ret, b ?? a), `${storeName}.video`, true);
        on(storeName, "getVoiceStates", ([a], ret) => filterStates(ret, a), `${storeName}.states`);
        on(storeName, "getAllVoiceStates", (_a, ret) => {
            if (!ret || typeof ret !== "object") return ret;
            const out: any = {};
            for (const [ctx, states] of Object.entries(ret)) out[ctx] = filterStates(states, undefined);
            return out;
        }, `${storeName}.all`);
    }

    on("SortedVoiceStateStore", "countVoiceStatesForChannel", ([a, b], ret) => {
        const n = visibleInCall(b ?? a);
        return typeof n === "number" ? n : ret;
    }, "voiceCount");

    on("VoiceStateStore", "getVoiceState", ([a, b], ret) =>
        ret && isHidden(idOf(ret)) ? null : ret,
        "voiceState");
}

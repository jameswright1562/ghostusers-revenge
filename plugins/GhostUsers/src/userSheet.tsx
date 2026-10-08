// "Hide user (Ghost)" on sheets. DM long-press menus carry only a channelId,
// so the single other recipient is resolved and the sheet module is swapped
// for a patched copy (import() namespaces are frozen — patching in place
// throws). Its rows only exist one render deeper, where the
// ActionSheetRowGroup array finally lives. Profile sheets go through the
// same hook by userId.

import { findByName, findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";
import { showToast } from "@vendetta/ui/toasts";

import { hideUser, isHidden, mark, sawSheet, showUser, UserStore, ChannelStore, store, diag } from "./core";

const { FormRow } = Forms;
const LazyActionSheet = findByProps("openLazy", "hideActionSheet");

/** Registry sheet modules already given an outer patch (installed once — the
    outer hook resolves its user fresh on every render). */
const patchedRegistryModules = new WeakSet<object>();

/** Current DM-sheet user for the shared memo wrapper below. */
let memoUid: string | null = null;
const MEMO_SYM = Symbol.for("GhostUsers.sheetMemo");

/** Mutable registry holder for a sheet component, or null while it is still
    lazy (import() namespaces are frozen and can't be patched in place). */
function tryRegistryHolder(name: string): any | null {
    for (const def of [false, true]) {
        try {
            const m: any = findByName(name, def as unknown as boolean);
            if (m?.default && typeof m.default === "function") return m;
        } catch { /* try next */ }
    }
    return null;
}

/** Last-injection diagnostics, surfaced in Settings (no adb needed). */
let lastAsrShape = "";
let lastGroupsN = -1;
let lastMode = "";
let lastTKind = "";
let lastOutFrozen = "";
let lastBranch = "";

/** Discord's own sheet row component (with .Group and .Icon), resolved lazily.
    Deliberately not cached while missing — early calls happen before the
    module loads, and a cached null would stick forever. */
let asrCache: any = null;
function actionSheetRow() {
    if (!asrCache) {
        try {
            const mod = findByProps("ActionSheetRow") ?? findByProps("ActionSheet");
            asrCache = mod?.ActionSheetRow ?? mod ?? null;
        } catch {
            asrCache = null;
        }
    }
    return asrCache;
}

/** The Ghost row in the sheet's own component family. Falls back to a FormRow
    only when Discord's ActionSheetRow is unavailable on this build. */
function ghostSheetGroup(userId: string) {
    const ASR = actionSheetRow();
    try {
        lastAsrShape = `${typeof ASR}${ASR?.Group ? "+Group" : "-G"}${ASR?.Icon ? "+Icon" : "-I"}:${(ASR as any)?.displayName ?? (ASR as any)?.name ?? ""}`;
    } catch { lastAsrShape = "?"; }
    const hidden = isHidden(userId);
    const name = UserStore?.getUser?.(userId)?.username ?? userId;
    const label = hidden ? "Show user (Ghost)" : "Hide user (Ghost)";
    const onPress = () => {
        try {
            if (hidden) {
                showUser(userId);
                showToast(`${name} — visible again`, getAssetIDByName("ic_eye"));
            } else {
                hideUser(userId, name);
                showToast(`${name} — hidden`, getAssetIDByName("ic_eye_hide"));
            }
        } finally {
            LazyActionSheet?.hideActionSheet?.();
        }
    };
    if (ASR && (ASR.Group || typeof ASR === "function")) {
        const rowProps: any = { label, onPress };
        try {
            if (ASR.Icon)
                rowProps.icon = React.createElement(ASR.Icon, {
                    source: getAssetIDByName(hidden ? "ic_eye" : "ic_eye_hide"),
                });
        } catch { /* icon is decoration only */ }
        const row = React.createElement(ASR, rowProps);
        if (ASR.Group) return React.createElement(ASR.Group, { key: `ghost-${userId}` }, row);
        return row;
    }
    return React.createElement(FormRow, {
        label,
        leading: React.createElement(FormRow.Icon, {
            source: getAssetIDByName(hidden ? "ic_eye" : "ic_eye_hide"),
        }),
        onPress,
    });
}

/** Single other person of a 1:1 DM channel object. Group DMs stay out:
    several people, no single right target. */
function dmUserOfChannel(ch: any): string | undefined {
    try {
        if (!ch || typeof ch !== "object" || ch.type === 3) return undefined;
        const self = UserStore?.getCurrentUser?.()?.id;
        const ids = new Set<string>();
        for (const list of [ch.recipients, ch.rawRecipients, ch.recipientIds]) {
            if (!Array.isArray(list)) continue;
            for (const r of list) {
                const id = typeof r === "string" ? r : r?.userId ?? r?.user?.id ?? r?.id;
                if (id && id !== self) ids.add(String(id));
            }
        }
        const single = ch.recipientId ?? ch.recipient_id;
        if (typeof single === "string" && single !== self) ids.add(single);
        if (ids.size === 1) return [...ids][0];
    } catch { /* fall through */ }
    return undefined;
}

const isRowGroupArray = (n: any) =>
    n?.[0]?.type?.name === "ActionSheetRowGroup"
    || n?.[0]?.type?.displayName === "ActionSheetRowGroup";

/** Shared label/handler for one hidden user. */
function ghostRowSpec(uid: string) {
    const hidden = isHidden(uid);
    const name = UserStore?.getUser?.(uid)?.username ?? uid;
    return {
        hidden,
        label: hidden ? "Show user (Ghost)" : "Hide user (Ghost)",
        onPress: () => {
            try {
                if (hidden) {
                    showUser(uid);
                    showToast(`${name} — visible again`, getAssetIDByName("ic_eye"));
                } else {
                    hideUser(uid, name);
                    showToast(`${name} — hidden`, getAssetIDByName("ic_eye_hide"));
                }
            } finally {
                LazyActionSheet?.hideActionSheet?.();
            }
        },
    };
}

/** One-line shape of a rendered tree for live diagnostics. */
function oShape(o: any): string {
    try {
        if (Array.isArray(o)) return `arr${o.length}`;
        if (o === null || o === undefined) return String(o);
        if (typeof o !== "object") return typeof o;
        const t = o.type;
        const tn = t?.displayName ?? t?.name ?? (typeof t === "string" ? t : "?");
        const pk = o.props && typeof o.props === "object"
            ? Object.keys(o.props).slice(0, 6).join(",") : typeof o.props;
        return `${tn}{${pk}}`.slice(0, 90);
    } catch { return "?"; }
}

/** Overwrite the live segment of the newest sheet entry (called at render
    time, so unlike the one-shot annotation it is never stale). */
function live(text: string) {
    try {
        for (let i = diag.sheets.length - 1; i >= 0; i--) {
            const s = diag.sheets[i];
            if (s.startsWith("ChannelLongPress") || s.startsWith("UserProfile")) {
                diag.sheets[i] = `${s.split("|live:")[0]}|live:${text}`;
                break;
            }
        }
    } catch { /* ignore */ }
}

/** Clone a real sibling row (name-independent: matched by label+onPress props)
    so the component family always matches. Returns null when no row element
    exists in the tree. */
function trySampleClone(tree: any, uid: string): any | null {
    try {
        const sample: any = safeFind(tree, (n: any) =>
            n && typeof n === "object" && typeof n?.props?.label === "string"
            && typeof n?.props?.onPress === "function");
        if (!sample || !sample.type) {
            lastMode = "nosample";
            return null;
        }
        const spec = ghostRowSpec(uid);
        let icon = undefined;
        try {
            if (sample.props?.icon)
                icon = React.cloneElement(sample.props.icon, {
                    source: getAssetIDByName(spec.hidden ? "ic_eye" : "ic_eye_hide"),
                });
        } catch { icon = sample.props?.icon; }
        const { children: _drop, ...rest } = sample.props ?? {};
        lastMode = `sample:${(sample.type as any)?.displayName ?? (sample.type as any)?.name ?? typeof sample.type}`;
        return React.createElement(sample.type as any, {
            ...rest,
            key: `ghost-${uid}`,
            label: spec.label,
            onPress: spec.onPress,
            ...(icon !== undefined ? { icon } : {}),
        });
    } catch (e) {
        console.log("[GhostUsers] ghost sample", e);
        lastMode = "sample-threw";
        return null;
    }
}

/** Insert the Ghost group into a row-groups array — or refresh it when the
    closure carries the newer user (shared memo inners serve every open; last
    write wins). */
function upsertGhost(groups: any[], uid: string) {
    lastGroupsN = groups.length;
    const key = `ghost-${uid}`;
    const row = trySampleClone(groups, uid);
    const gtype = groups[0]?.type;
    const group = row && gtype && row.type !== gtype
        ? React.createElement(gtype, { key }, row)
        : row ?? ghostSheetGroup(uid);
    if (!row) lastMode = "constructed";
    const idx = groups.findIndex((g: any) =>
        g && typeof g.key === "string" && g.key.startsWith("ghost"));
    if (idx >= 0) {
        if (groups[idx].key !== key) groups[idx] = group;
    } else {
        groups.unshift(group);
    }
}

/** Smuggle one sentinel item into a virtualised list (FlashList/FlatList Fed
    by a data array, or a SectionList) and teach its renderItem to draw our
    row for it. Returns true when handled. */
function injectListData(o: any, makeRow: () => any): boolean {
    try {
        const list: any = safeFind(o, (x: any) =>
            x && typeof x === "object" && Array.isArray(x?.props?.data)
            && typeof x?.props?.renderItem === "function");
        if (list) {
            if (!list.props.data.some((d: any) => d?.__ghost)) {
                const orig = list.props.renderItem;
                list.props.data = [{ __ghost: true, key: "__ghost" }, ...list.props.data];
                list.props.renderItem = function (info: any, ...rest: any[]) {
                    try {
                        if (info?.item?.__ghost) return makeRow();
                    } catch { /* fall through */ }
                    return orig.call(this, info, ...rest);
                };
            }
            return true;
        }
        const sec: any = safeFind(o, (x: any) =>
            x && typeof x === "object" && Array.isArray(x?.props?.sections)
            && x.props.sections.some((s: any) => Array.isArray(s?.data)));
        if (sec) {
            const first = sec.props.sections.find((s: any) => Array.isArray(s?.data));
            if (first && !first.data.some((d: any) => d?.__ghost)) {
                const orig = sec.props.renderItem;
                first.data = [{ __ghost: true, key: "__ghost" }, ...first.data];
                if (typeof orig === "function") {
                    sec.props.renderItem = function (info: any, ...rest: any[]) {
                        try {
                            if (info?.item?.__ghost) return makeRow();
                        } catch { /* fall through */ }
                        return orig.call(this, info, ...rest);
                    };
                }
            }
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

/** Cycle-safe tree search. The stock finder recurses blindly and Discord's
    trees contain cyclic data (the channel object), so it stack-overflows and
    every caller silently finds nothing. Seen-set, depth cap, and the channel
    subtree (data, never rows) skipped. */
function safeFind(tree: any, pred: (n: any) => boolean): any {
    const seen = new Set<any>();
    const walk = (v: any, d: number): any => {
        if (!v || typeof v !== "object" || seen.has(v) || d > 8) return null;
        seen.add(v);
        try {
            if (pred(v)) return v;
        } catch { /* ignore predicate errors */ }
        if (Array.isArray(v)) {
            for (const c of v.slice(0, 50)) {
                const r = walk(c, d + 1);
                if (r) return r;
            }
            return null;
        }
        for (const k of Object.keys(v)) {
            if (k === "_owner" || k === "_store" || k === "channel") continue;
            let val: any;
            try { val = v[k]; } catch { continue; }
            const r = walk(val, d + 1);
            if (r) return r;
        }
        return null;
    };
    try {
        return walk(tree, 0);
    } catch {
        return null;
    }
}

/** Shared inner-output handler for both wrappers: groups array, virtualised
    list, else a sample-cloned row prepended to the container's children. */
function handleInnerOutput(o: any, uid: string): any {
    try {
        const g: any = safeFind(o, isRowGroupArray);
        if (Array.isArray(g)) {
            upsertGhost(g, uid);
            live(`groups:${g.length}|mode:${lastMode}`);
            return o;
        }
        if (injectListData(o, () => ghostSheetGroup(uid))) {
            live(`w-list|asr:${lastAsrShape}`);
            return o;
        }
        // The rows live in a plain array (not a named group): put the clone
        // among the real rows so it inherits position and styling.
        const ra: any = safeFind(o, (n: any) => Array.isArray(n) && n.some((c: any) =>
            c && typeof c === "object" && typeof c?.props?.label === "string"
            && typeof c?.props?.onPress === "function"));
        if (Array.isArray(ra)) {
            const row = trySampleClone(o, uid);
            if (row) {
                const key = `ghost-${uid}`;
                const idx = ra.findIndex((g: any) =>
                    g && typeof g.key === "string" && g.key.startsWith("ghost"));
                if (idx >= 0) {
                    if (ra[idx].key !== key) ra[idx] = row;
                } else {
                    ra.unshift(row);
                }
                live(`row-array:${ra.length}|mode:${lastMode}`);
                return o;
            }
        }
        const shape = oShape(o);
        const row = trySampleClone(o, uid);
        const k = o?.props?.children;
        if (row && Array.isArray(k)) {
            live(`kids-clone|o:${shape}`);
            return React.cloneElement(o, o.props, [row, ...k]);
        }
        if (Array.isArray(k)) {
            const r = ghostSheetGroup(uid);
            live(`kids-fallback|asr:${lastAsrShape}|o:${shape}`);
            return React.cloneElement(o, o.props, [r, ...k]);
        }
        if (k && row) {
            live(`kid1-clone|o:${shape}`);
            return React.cloneElement(o, o.props, [row, k]);
        }
        live(`nothing|o:${shape}`);
    } catch { /* keep original output */ }
    return o;
}

/** Wrap a per-render element type so the Ghost group joins its output. */
function makeInnerWrap(Orig: any, uid: string) {
    const W = function (p: any) {
        try { mark("dmSheetInnerLive", true); } catch { /* ignore */ }
        return handleInnerOutput((Orig as any)(p), uid);
    };
    (W as any).displayName = `GhostWrap(${(Orig as any)?.displayName ?? (Orig as any)?.name ?? "?"})`;
    return W;
}

/** Wrap a shared memo/forwardRef inner once; every render feeds it the current
    user through memoUid. */
function ensureMemoWrapped(t: any): boolean {
    try {
        if (t[MEMO_SYM]) return true;
        const Orig = t.type;
        const W = function (p: any) {
            try { mark("dmSheetInnerLive", true); } catch { /* ignore */ }
            const o = (Orig as any)(p);
            try {
                if (memoUid) return handleInnerOutput(o, memoUid);
            } catch { /* keep original output */ }
            return o;
        };
        (W as any).displayName = `GhostWrap(${(Orig as any)?.displayName ?? (Orig as any)?.name ?? "?"})`;
        t.type = W;
        t[MEMO_SYM] = true;
        return true;
    } catch {
        return false;
    }
}

/** Put the Ghost group into an already-rendered sheet tree: groups array when
    present, otherwise the inner component that renders them. Fresh elements
    are safe to touch; shared memo inners go through the once-wrapper. */
function injectIntoSheetTree(out: any, uid: string, rowsMark = "dmSheetRows") {
    memoUid = uid;
    try {
        const t0 = out?.type;
        lastTKind = Array.isArray(out) ? "array" : out === null ? "null"
            : `${typeof out}/${typeof t0}${t0 && typeof t0 === "object" ? (typeof t0.type === "function" ? "/memo-fn" : "/obj") : ""}`;
        try { lastOutFrozen = String(Object.isFrozen(out)); } catch { lastOutFrozen = "?"; }
    } catch { /* ignore */ }
    try {
        const groups: any = safeFind(out, isRowGroupArray);
        if (Array.isArray(groups)) {
            upsertGhost(groups, uid);
            lastBranch = "groups";
            mark(rowsMark, true);
            return;
        }
    } catch { /* fall through to inner wrap */ }
    const t = out?.type;
    try {
        if (t && typeof t === "function") {
            out.type = makeInnerWrap(t, uid);
            lastBranch = "wrap-fn";
            mark(rowsMark, true);
        } else if (t && typeof t === "object" && typeof t.type === "function") {
            if (ensureMemoWrapped(t)) { lastBranch = "memo"; mark(rowsMark, true); }
            else { lastBranch = "memo-frozen"; mark(rowsMark, false, "memo frozen"); }
        } else {
            lastBranch = "unpatchable";
            mark(rowsMark, false, "inner not patchable");
        }
    } catch (e) {
        lastBranch = "threw";
        console.log("[GhostUsers] dmSheet inner", e);
    }
}

/** DM long-press menu, driven by the openLazy hook — no component-name lookup,
    because this build names the sheet module differently. Returns replacement
    args for openLazy (a promise of a patched module copy); undefined keeps the
    original call. Every object touched here is fresh — never the frozen
    import() namespace. */
function handleChannelPress(
    patches: (() => void)[],
    component: any,
    key: any,
    props: any,
    fallbackUid?: string,
): any[] | undefined {
    try {
        if (!store.showHideButton) return undefined;
        if (fallbackUid && fallbackUid === UserStore?.getCurrentUser?.()?.id) return undefined;
        // 1. registry module (loaded by open time) — the exact proven pattern:
        // outer "default", then the row groups one render deeper
        try {
            const holder = tryRegistryHolder("ChannelLongPressActionSheet");
            if (holder) {
                if (!patchedRegistryModules.has(holder)) {
                    patchedRegistryModules.add(holder);
                    patches.push(after("default", holder, (_a: any[], ret: any) => {
                        try {
                            const uid = dmUserOfChannel(ret?.props?.channel) ?? fallbackUid;
                            if (!uid || uid === UserStore?.getCurrentUser?.()?.id) return ret;
                            injectIntoSheetTree(ret, uid);
                        } catch (e) {
                            console.log("[GhostUsers] dmSheet render", e);
                        }
                        return ret;
                    }));
                }
                mark("dmSheet", true);
                return undefined; // keep the original openLazy args
            }
        } catch (e) {
            console.log("[GhostUsers] dmSheet registry", e);
        }
        // 2. fallback: swap in a patched module copy (never the frozen namespace)
        const chained = Promise.resolve(component).then((instance: any) => {
            try {
                const Sheet = instance?.default ?? instance;
                if (!Sheet || (typeof Sheet !== "function" && typeof Sheet !== "object")) {
                    mark("dmSheet", false, "no default");
                    return instance;
                }
                const Orig = typeof Sheet === "function" ? Sheet : instance?.default;
                if (typeof Orig !== "function") {
                    mark("dmSheet", false, "default not function");
                    return instance;
                }
                const Patched = function (p: any) {
                    const out = (Orig as any)(p);
                    try {
                        const uid = dmUserOfChannel(out?.props?.channel) ?? fallbackUid;
                        if (uid && uid !== UserStore?.getCurrentUser?.()?.id) {
                            injectIntoSheetTree(out, uid);
                            for (let i = diag.sheets.length - 1; i >= 0; i--) {
                                const s = diag.sheets[i];
                                if (s.startsWith("ChannelLongPress") && !s.includes("|asr")) {
                                    diag.sheets[i] = `${s}|asr:${lastAsrShape}|groups:${lastGroupsN}|mode:${lastMode}|t:${lastTKind}|frozen:${lastOutFrozen}|br:${lastBranch}`;
                                    break;
                                }
                            }
                        }
                    } catch (e) {
                        console.log("[GhostUsers] dmSheet render", e);
                    }
                    return out;
                };
                (Patched as any).displayName =
                    `GhostSheet(${(Orig as any)?.displayName ?? (Orig as any)?.name ?? "?"})`;
                mark("dmSheet", true);
                return { ...(instance as any), default: Patched };
            } catch (e) {
                console.log("[GhostUsers] dmSheet setup", e);
                return instance;
            }
        });
        return [chained, key, props];
    } catch (e) {
        console.log("[GhostUsers] dmSheet setup", e);
        return undefined;
    }
}

function GhostRow({ userId }: { userId: string }) {
    const hidden = isHidden(userId);
    const name = UserStore?.getUser?.(userId)?.username ?? userId;
    return React.createElement(FormRow, {
        label: hidden ? "Show user (Ghost)" : "Hide user (Ghost)",
        leading: React.createElement(FormRow.Icon, {
            source: getAssetIDByName(hidden ? "ic_eye" : "ic_eye_hide"),
        }),
        onPress: () => {
            if (hidden) {
                showUser(userId);
                showToast(`${name} — visible again`, getAssetIDByName("ic_eye"));
            } else {
                hideUser(userId, name);
                showToast(`${name} — hidden`, getAssetIDByName("ic_eye_hide"));
            }
            LazyActionSheet?.hideActionSheet?.();
        },
    });
}

export function patchUserSheet(patches: (() => void)[]) {
    if (!LazyActionSheet?.openLazy) {
        mark("userSheet", false, "no action sheet module");
        return;
    }

    /** 1:1 DM channel menu has no userId, only a channelId — resolve the single
        other recipient so long-pressing a DM also offers the Ghost row. Group
        DMs stay out: several people, no single right target. */
    const dmRecipient = (props: any): string | undefined => {
        try {
            if (props?.userId ?? props?.user?.id) return undefined;
            const channelId = props?.channelId ?? props?.channel?.id;
            if (!channelId) return undefined;
            const ch = ChannelStore?.getChannel?.(channelId);
            if (!ch || ch.type === 3) return undefined;
            const self = UserStore?.getCurrentUser?.()?.id;
            const ids = new Set<string>();
            for (const list of [ch.recipients, ch.rawRecipients, ch.recipientIds]) {
                if (!Array.isArray(list)) continue;
                for (const r of list) {
                    const id = typeof r === "string" ? r : r?.userId ?? r?.user?.id ?? r?.id;
                    if (id && id !== self) ids.add(String(id));
                }
            }
            const single = ch.recipientId ?? ch.recipient_id;
            if (typeof single === "string" && single !== self) ids.add(single);
            if (ids.size === 1) return [...ids][0];
        } catch { /* fall through */ }
        return undefined;
    };

    patches.push(
        before("openLazy", LazyActionSheet, ([component, key, props]: any[]) => {
            if(!store.showHideButton) return;
            sawSheet(String(key ?? "?"), props);
            // DM long-press menus carry a channelId: swap in a patched module
            // copy (its component name differs per build)
            if (String(key ?? "").startsWith("ChannelLongPress")) {
                const cle = diag.sheets[diag.sheets.length - 1] ?? "";
                if (cle.split(" [")[0] === String(key ?? "?") && !cle.includes("comp=")) {
                    const kind = component && typeof component.then === "function"
                        ? "promise" : Array.isArray(component) ? "array" : typeof component;
                    diag.sheets[diag.sheets.length - 1] = `${cle} comp=${kind}`;
                }
                return handleChannelPress(patches, component, key, props, dmRecipient(props)) as any;
            }
            const userId = props?.userId ?? props?.user?.id ?? props?.user?.userId ?? dmRecipient(props);
            // annotate the stored sheet entry with the resolution result, so the
            // Settings status shows why the row did or didn't appear — no adb needed
            const last = diag.sheets[diag.sheets.length - 1] ?? "";
            if (last.split(" [")[0] === String(key ?? "?") && !last.includes(" => ")) {
                diag.sheets[diag.sheets.length - 1] = `${last} => ${userId ?? "no-user"}`;
            }
            if (!userId) return;
            if (String(key ?? "").includes("Message")) return;
            if (userId === UserStore?.getCurrentUser?.()?.id) return;

            // Prefer the loaded registry module (import() namespaces are frozen)
            if (String(key ?? "").includes("UserProfile")) {
                try {
                    const holder = tryRegistryHolder("UserProfileActionSheet");
                    if (holder) {
                        if (!patchedRegistryModules.has(holder)) {
                            patchedRegistryModules.add(holder);
                            const puid = userId;
                            patches.push(after("default", holder, (_a: any[], ret: any) => {
                                try {
                                    const idNow = ret?.props?.userId ?? ret?.props?.user?.id ?? puid;
                                    if (!idNow || idNow === UserStore?.getCurrentUser?.()?.id) return ret;
                                    injectIntoSheetTree(ret, idNow, "userSheetRows");
                                } catch (e) {
                                    console.log("[GhostUsers] userSheet render", e);
                                }
                                return ret;
                            }));
                        }
                        mark("userSheetByName", true);
                        return;
                    }
                } catch (e) {
                    console.log("[GhostUsers] userSheet registry", e);
                }
            }

            function setupProfile(instance: any) {
                const unpatch = after("default", instance, (_a: any, ret: any) => {
                    React.useEffect(() => () => unpatch(), []);
                    const uid = userId;
                    const ghostEl = () => React.createElement(GhostRow, { userId: uid });
                    const annotate = (how: string) => {
                        try {
                            const tag = String(key ?? "?");
                            const i = diag.sheets.findIndex(s => s.split(" [")[0] === tag);
                            if (i >= 0 && !diag.sheets[i].includes("|")) diag.sheets[i] += how;
                        } catch { /* diagnostics only */ }
                    };
                    // 1. old shape: a literal array of row elements somewhere in the tree
                    const rows =
                        safeFind(ret, (x: any) => Array.isArray(x) && x.some((c: any) => c?.type?.name?.includes?.("Row")))
                        ?? safeFind(ret, (x: any) => Array.isArray(x) && x.length > 1 && x.every((c: any) => c?.props));
                    if (Array.isArray(rows)) {
                        rows.unshift(ghostEl());
                        annotate(`|rows:${rows.length}`);
                        return ret;
                    }
                    // 2. new shape: a virtualised list (FlashList/FlatList) fed by a
                    // data array — smuggle in one sentinel item and teach renderItem
                    try {
                        const list: any = safeFind(ret, (x: any) =>
                            x && typeof x === "object" && Array.isArray(x?.props?.data)
                            && typeof x?.props?.renderItem === "function");
                        if (list) {
                            if (!list.props.data.some((d: any) => d?.__ghost)) {
                                const orig = list.props.renderItem;
                                list.props.data = [{ __ghost: true, key: "__ghost" }, ...list.props.data];
                                list.props.renderItem = function (info: any, ...rest: any[]) {
                                    try {
                                        if (info?.item?.__ghost) return ghostEl();
                                    } catch { /* fall through */ }
                                    return orig.call(this, info, ...rest);
                                };
                            }
                            annotate("|list-data");
                            return ret;
                        }
                        const sec: any = safeFind(ret, (x: any) =>
                            x && typeof x === "object" && Array.isArray(x?.props?.sections)
                            && x.props.sections.some((s: any) => Array.isArray(s?.data)));
                        if (sec) {
                            const first = sec.props.sections.find((s: any) => Array.isArray(s?.data));
                            if (first && !first.data.some((d: any) => d?.__ghost)) {
                                const orig = sec.props.renderItem;
                                first.data = [{ __ghost: true, key: "__ghost" }, ...first.data];
                                if (typeof orig === "function") {
                                    sec.props.renderItem = function (info: any, ...rest: any[]) {
                                        try {
                                            if (info?.item?.__ghost) return ghostEl();
                                        } catch { /* fall through */ }
                                        return orig.call(this, info, ...rest);
                                    };
                                }
                            }
                            annotate("|sections");
                            return ret;
                        }
                    } catch { /* fall through to wrap */ }
                    // 3. rows only materialize inside a child component — use the
                    // shared helpers (memo-safe), same as the DM menu path
                    injectIntoSheetTree(ret, uid);
                    annotate("|profile-fallback");
                    return ret;
                });
            }
            if (component && typeof component.then === "function") component.then(setupProfile);
            else setupProfile(component);
        }),
    );
    mark("userSheet", true);
}

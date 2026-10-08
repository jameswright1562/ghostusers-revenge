// The settings screen. It opens on the one thing that matters — who is hidden —
// with each person's own switches folded away until you ask for them. Everything
// else (defaults, status, what changed) sits below, closed.

import { React, ReactNative as RN } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { Forms, General } from "@vendetta/ui/components";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { diag, hideUser, OPT_KEYS, showUser, store, UserStore } from "./core";
import { CHANGELOG, VERSION } from "./changelog";
import { applyMute } from "./mute";

const { FormSection, FormRow, FormSwitchRow, FormInput, FormDivider, FormText } = Forms;
const { ScrollView, View } = General;

const LABELS: Record<string, [string, string]> = {
    scopeGroups: ["Group DMs", "Hide them in group conversations"],
    scopeServers: ["Servers", "Hide them in servers you share"],
    scopeDMs: ["Direct messages", "Hide your one-on-one chat with them"],
    autoVoiceMute: ["Mute in calls", "Silence them for you when they are in a call"],
    hideMemberList: ["Member & friends lists", "Take them out of member, friends and DM lists"],
    hideMentions: ["Tags & replies", "Also hide messages that tag or reply to them"],
};

const el = React.createElement;

/** Their picture, however this build hands it over — and if the app has never
    heard of them, the address is built the same way Discord builds it. */
function avatarUrl(id: string): string | null {
    const user: any = UserStore?.getUser?.(id);
    for (const attempt of [
        () => user?.getAvatarURL?.(false, 128),
        () => user?.getAvatarURL?.(null, 128, true),
        () => user?.getAvatarURL?.(),
        () => (user?.avatar ? `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.png?size=128` : null),
    ]) {
        try {
            const url = attempt();
            if (typeof url === "string" && url.startsWith("http")) return url;
        } catch { /* try the next shape */ }
    }
    // the picture Discord gives someone with no avatar of their own
    try {
        const index = Number((BigInt(id) >> 22n) % 6n);
        return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
    } catch {
        return null;
    }
}

function Avatar({ id }: { id: string }) {
    const url = avatarUrl(id);
    if (!url) return el(FormRow.Icon, { source: getAssetIDByName("ic_person") });
    return el(RN.Image, {
        source: { uri: url },
        style: { width: 32, height: 32, borderRadius: 16, marginRight: 4 },
    });
}

export default function Settings() {
    useProxy(store);
    const [open, setOpen] = React.useState<string | null>(null);
    const [showMore, setShowMore] = React.useState(false);
    const [openNote, setOpenNote] = React.useState<string | null>(CHANGELOG[0]?.version ?? null);
    const [newId, setNewId] = React.useState("");

    const ids = Object.keys(store.users ?? {});
    const broken = Object.entries(diag.patches).filter(([, v]) => !String(v).startsWith("ok"));

    const person = (id: string) => {
        const rec = store.users[id];
        const name = rec.tag ?? UserStore?.getUser?.(id)?.username ?? id;
        const expanded = open === id;
        const on = OPT_KEYS.filter(k => rec[k] ?? store.defaults[k]).length;

        return el(
            React.Fragment,
            { key: id },
            el(FormRow, {
                label: name,
                subLabel: expanded ? id : `${on} of ${OPT_KEYS.length} switches on`,
                leading: el(Avatar, { id }),
                trailing: el(FormRow.Arrow, null),
                onPress: () => setOpen(expanded ? null : id),
            }),
            ...(expanded
                ? [
                    ...OPT_KEYS.map(key =>
                        el(FormSwitchRow, {
                            key: `${id}-${key}`,
                            label: LABELS[key][0],
                            subLabel: LABELS[key][1],
                            value: rec[key] ?? store.defaults[key],
                            onValueChange: (v: boolean) => {
                                store.users = { ...store.users, [id]: { ...rec, [key]: v } };
                                if (key === "autoVoiceMute") applyMute(id, v);
                            },
                        }),
                    ),
                    el(FormRow, {
                        key: `${id}-remove`,
                        label: `Stop hiding ${name}`,
                        leading: el(FormRow.Icon, { source: getAssetIDByName("ic_eye") }),
                        onPress: () => {
                            showUser(id);
                            setOpen(null);
                            showToast(`${name} is visible again`, getAssetIDByName("ic_eye"));
                        },
                    }),
                ]
                : []),
            el(FormDivider, null),
        );
    };

    return el(
        ScrollView,
        null,
        el(FormSection, 
            {title: "General"},
            el(FormSwitchRow, {
                key: "showHideButton",
                label: "Show \"Hide user (Ghost)\" button",
                subLabel: "Shows a button on the user's profile that lets them hide themselves",
                value: store.showHideButton,
                onValueChange: (v: boolean) => {
                    store.showHideButton = v;
                },
            })
        ),
        el(
            FormSection,
            { title: ids.length ? `Hidden — ${ids.length}` : "Nobody is hidden" },
            ids.length
                ? ids.map(person)
                : el(FormText, { style: { paddingHorizontal: 16, paddingBottom: 12 } },
                    "Open someone's profile and choose \"Hide user (Ghost)\", or paste their user id below. "
                    + "Everything happens on this phone only — they can't tell."),
        ),

        el(
            FormSection,
            { title: "Hide someone by id" },
            el(FormInput, {
                value: newId,
                onChange: (v: string) => setNewId(v),
                placeholder: "123456789012345678",
                title: "USER ID",
            }),
            el(FormRow, {
                label: "Hide them",
                leading: el(FormRow.Icon, { source: getAssetIDByName("ic_eye_hide") }),
                onPress: () => {
                    const id = newId.trim();
                    if (!/^\d{15,}$/.test(id)) return showToast("That is not a user id", getAssetIDByName("Small"));
                    if (store.users?.[id]) return showToast("Already hidden", getAssetIDByName("ic_eye_hide"));
                    hideUser(id, UserStore?.getUser?.(id)?.username);
                    setNewId("");
                    showToast("Hidden", getAssetIDByName("ic_eye_hide"));
                },
            }),
        ),

        el(
            FormSection,
            { title: "Defaults for the next person you hide" },
            ...OPT_KEYS.map(key =>
                el(FormSwitchRow, {
                    key: `def-${key}`,
                    label: LABELS[key][0],
                    subLabel: LABELS[key][1],
                    value: store.defaults[key],
                    onValueChange: (v: boolean) => {
                        store.defaults = { ...store.defaults, [key]: v };
                    },
                }),
            ),
            el(FormRow, {
                label: "Apply these to everyone already hidden",
                leading: el(FormRow.Icon, { source: getAssetIDByName("ic_check") }),
                onPress: () => {
                    const next = { ...store.users };
                    for (const id of Object.keys(next)) next[id] = { ...next[id], ...store.defaults };
                    store.users = next;
                    showToast("Applied to everyone", getAssetIDByName("ic_check"));
                },
            }),
        ),

        el(
            FormSection,
            { title: "About" },
            el(FormRow, {
                label: broken.length ? `${broken.length} feature(s) unavailable` : "Everything is working",
                subLabel: `Version ${VERSION} · nothing leaves this phone`,
                leading: el(FormRow.Icon, {
                    source: getAssetIDByName(broken.length ? "ic_warning_24px" : "ic_check"),
                }),
                trailing: el(FormRow.Arrow, null),
                onPress: () => setShowMore(!showMore),
            }),
            ...(showMore
                ? [
                    el(FormText, { key: "status", style: { paddingHorizontal: 16, paddingVertical: 12 } },
                        [
                            ...Object.entries(diag.stores).map(([k, v]) => `${k}: ${v}`),
                            ...Object.entries(diag.patches).map(([k, v]) => `${k}: ${v}`),
                            `seen: ${diag.events} events · hidden: ${diag.hiddenMsgs} messages · ${diag.rows} rows`,
                            diag.sheets.length ? `sheets: ${diag.sheets.join(", ")}` : "sheets: none yet",
                            ...(diag.notes.length ? [`probes:\n${diag.notes.join("\n")}`] : []),
                        ].join("\n")),
                    el(FormDivider, { key: "d1" }),
                    ...CHANGELOG.map(entry =>
                        el(FormText, {
                            key: entry.version,
                            style: { paddingHorizontal: 16, paddingVertical: 8 },
                        }, `${entry.version}\n• ${entry.lines.join("\n• ")}`),
                    ),
                ]
                : []),
        ),

        el(View, { style: { height: 32 } }),
    );
}

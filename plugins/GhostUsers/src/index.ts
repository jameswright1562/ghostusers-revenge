import { diag, initStorage, mark, restoreAllStashed, store } from "./core";
import { patchDispatcher } from "./dispatcher";
import { patchMessages } from "./messages";
import { patchStores } from "./stores";
import { setUpMute } from "./mute";
import { patchUserSheet } from "./userSheet";
import { clearCallMemory } from "./calls";
import { clearLookupState } from "./reactions";
import { reconnoitre } from "./discover";
import { startSonar } from "./sonar";
import Settings from "./Settings";

let patches: (() => void)[] = [];

export const onLoad = () => {
    initStorage();
    patches = [];
    diag.patches = {};
    diag.notes = [];

    patchDispatcher(patches);
    patchMessages(patches);
    patchStores(patches);
    patchUserSheet(patches);
    setUpMute();

    // Both of these exist to find out what a Discord build calls things. They read
    // the whole app and are far too expensive to carry around in normal use.
    if (store.debug) {
        reconnoitre();
        startSonar(patches);
    }

    const missing = Object.entries(diag.patches).filter(([, v]) => !String(v).startsWith("ok")).map(([k]) => k);
    for (const [id, rec] of Object.entries(store.users ?? {}))
        console.log(`[GhostUsers] scope ${rec.tag ?? id}: groups=${rec.scopeGroups} servers=${rec.scopeServers} dms=${rec.scopeDMs} memberList=${rec.hideMemberList}`);
    console.log(
        `[GhostUsers] loaded, ${Object.keys(store.users ?? {}).length} hidden`
        + (missing.length ? `, unavailable: ${missing.join(", ")}` : ""),
    );
};

export const onUnload = () => {
    // every patch hands back its own undo — none of them may outlive the plugin
    for (const unpatch of patches) {
        try {
            unpatch();
        } catch (e) {
            console.log("[GhostUsers] unpatch", e);
        }
    }
    patches = [];
    clearCallMemory();
    clearLookupState();
    restoreAllStashed();
};

export { Settings as settings };

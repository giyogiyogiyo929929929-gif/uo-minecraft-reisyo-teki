// civs.js
import { world } from "@minecraft/server";

const VIRTUAL_CIVS_PROPERTY = "civ:virtualCivs";
const ACTIVE_CIV_PROPERTY = "civ:activeCivByController";

function getVirtualCivs() {
    const raw = world.getDynamicProperty(VIRTUAL_CIVS_PROPERTY);
    if (typeof raw !== "string") return [];
    try {
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function saveVirtualCivs(list) {
    world.setDynamicProperty(VIRTUAL_CIVS_PROPERTY, JSON.stringify(list));
}

function getActiveCivMap() {
    const raw = world.getDynamicProperty(ACTIVE_CIV_PROPERTY);
    if (typeof raw !== "string") return {};
    try {
        const map = JSON.parse(raw);
        return map && typeof map === "object" ? map : {};
    } catch {
        return {};
    }
}

function saveActiveCivMap(map) {
    world.setDynamicProperty(ACTIVE_CIV_PROPERTY, JSON.stringify(map));
}

export function getVirtualCivById(id) {
    return getVirtualCivs().find(c => c.id === id) ?? null;
}

export function addVirtualCiv(controllerPlayer, name) {
    const civs = getVirtualCivs();
    const id = `npc_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const civName = (name ?? "").trim() || `テスト国家${civs.length + 1}`;
    civs.push({ id, name: civName, controllerId: controllerPlayer.id });
    saveVirtualCivs(civs);
    return { id, name: civName };
}

export function getControllableCivs(realPlayer) {
    const list = [{ id: realPlayer.id, name: realPlayer.name, isVirtual: false }];
    for (const civ of getVirtualCivs()) {
        if (civ.controllerId === realPlayer.id) list.push({ id: civ.id, name: civ.name, isVirtual: true });
    }
    return list;
}

export function getActiveCivId(realPlayer) {
    return getActiveCivMap()[realPlayer.id] ?? realPlayer.id;
}

export function setActiveCivId(realPlayer, civId) {
    if (civId !== realPlayer.id) {
        const civ = getVirtualCivById(civId);
        if (!civ || civ.controllerId !== realPlayer.id) {
            return { ok: false, message: "§cその国家を操作する権限がありません。" };
        }
    }
    const map = getActiveCivMap();
    map[realPlayer.id] = civId;
    saveActiveCivMap(map);
    return { ok: true };
}

export function resolveCivName(civId) {
    for (const p of world.getAllPlayers()) {
        if (p.id === civId) return p.name;
    }
    return getVirtualCivById(civId)?.name ?? null;
}

/**
 * 今この国家を実際に操作できる人間がオンラインかどうかを判定する。
 * ・実プレイヤーの国家なら、本人がオンラインかどうか。
 * ・テスト国家(仮想国家)なら、それを操作している人(controllerId)がオンラインかどうか
 *   (テスト国家自身は実体を持たないため、操作者がいなければ誰も動かせない)。
 * ターンの自動スキップ判定(誰もいない国家の手番を待ち続けてゲームが止まるのを防ぐ)に使う。
 */
export function isCivControllable(civId) {
    if (world.getAllPlayers().some(p => p.id === civId)) return true;
    const civ = getVirtualCivById(civId);
    if (civ) return world.getAllPlayers().some(p => p.id === civ.controllerId);
    return false;
}

export function getCivStorageHandle(civId) {
    const realPlayer = world.getAllPlayers().find(p => p.id === civId);
    if (realPlayer) return realPlayer;

    const civ = getVirtualCivById(civId);
    if (!civ) return null;

    return {
        id: civId,
        name: civ.name,
        getDynamicProperty: (key) => world.getDynamicProperty(`civ:npc:${civId}:${key}`),
        setDynamicProperty: (key, value) => world.setDynamicProperty(`civ:npc:${civId}:${key}`, value),
        sendMessage: (text) => {
            const controller = civ.controllerId ? world.getAllPlayers().find(p => p.id === civ.controllerId) : null;
            controller?.sendMessage(`§7[${civ.name}] §r${text}`);
        },
    };
}

export function getRealPlayer(player) {
    return player?.__realPlayer ?? player;
}

export function getActingPlayer(realPlayer) {
    const activeId = getActiveCivId(realPlayer);
    if (activeId === realPlayer.id) return realPlayer;

    const civ = getVirtualCivById(activeId);
    if (!civ) return realPlayer;

    return new Proxy({}, {
        get(target, prop) {
            if (prop === "id") return civ.id;
            if (prop === "name") return civ.name;
            if (prop === "__realPlayer") return realPlayer;

            if (prop === "getDynamicProperty") {
                return (key) => world.getDynamicProperty(`civ:npc:${civ.id}:${key}`);
            }
            if (prop === "setDynamicProperty") {
                return (key, val) => world.setDynamicProperty(`civ:npc:${civ.id}:${key}`, val);
            }

            const value = Reflect.get(realPlayer, prop);
            if (typeof value === "function") {
                return value.bind(realPlayer);
            }
            return value;
        },
        set(target, prop, value) {
            realPlayer[prop] = value;
            return true;
        },
        has(target, prop) {
            if (prop === "id" || prop === "name" || prop === "__realPlayer") return true;
            return prop in realPlayer;
        }
    });
}
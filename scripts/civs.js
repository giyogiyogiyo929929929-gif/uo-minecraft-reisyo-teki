// civs.js
import { world } from "@minecraft/server";

const VIRTUAL_CIVS_PROPERTY = "civ:virtualCivs";
const ACTIVE_CIV_PROPERTY = "civ:activeCivByController";

// Dynamic Property の読み取りを UI 更新やターン処理のたびに繰り返さないためのキャッシュ。
// world 再読み込み後は最初の取得で保存値から復元する。
let virtualCivsCache = null;
let activeCivMapCache = null;

function getVirtualCivs() {
    if (virtualCivsCache) return virtualCivsCache;

    const raw = world.getDynamicProperty(VIRTUAL_CIVS_PROPERTY);
    if (typeof raw !== "string") {
        virtualCivsCache = [];
        return virtualCivsCache;
    }
    try {
        const list = JSON.parse(raw);
        virtualCivsCache = Array.isArray(list) ? list : [];
    } catch {
        virtualCivsCache = [];
    }
    return virtualCivsCache;
}

function saveVirtualCivs(list) {
    world.setDynamicProperty(VIRTUAL_CIVS_PROPERTY, JSON.stringify(list));
    virtualCivsCache = list;
}

function getActiveCivMap() {
    if (activeCivMapCache) return activeCivMapCache;

    const raw = world.getDynamicProperty(ACTIVE_CIV_PROPERTY);
    if (typeof raw !== "string") {
        activeCivMapCache = {};
        return activeCivMapCache;
    }
    try {
        const map = JSON.parse(raw);
        activeCivMapCache = map && typeof map === "object" ? map : {};
    } catch {
        activeCivMapCache = {};
    }
    return activeCivMapCache;
}

function saveActiveCivMap(map) {
    world.setDynamicProperty(ACTIVE_CIV_PROPERTY, JSON.stringify(map));
    activeCivMapCache = map;
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

/**
 * 実プレイヤーをプロトタイプにした薄いラッパーを返す。
 * ネイティブ Player のメソッドは実体を this として呼び出せるため、
 * Proxy の不変条件違反を避けつつ、仮想国家のID/名前/保存領域だけを差し替える。
 */
export function getActingPlayer(realPlayer) {
    const activeId = getActiveCivId(realPlayer);
    if (activeId === realPlayer.id) return realPlayer;

    const civ = getVirtualCivById(activeId);
    if (!civ) return realPlayer;

    const acting = Object.create(realPlayer);
    Object.defineProperty(acting, "__realPlayer", { value: realPlayer, enumerable: false });
    Object.defineProperty(acting, "id", { value: civ.id, enumerable: true, configurable: true });
    Object.defineProperty(acting, "name", { value: civ.name, enumerable: true, configurable: true });
    acting.getDynamicProperty = (key) => world.getDynamicProperty(`civ:npc:${civ.id}:${key}`);
    acting.setDynamicProperty = (key, value) => world.setDynamicProperty(`civ:npc:${civ.id}:${key}`, value);
    return acting;
}
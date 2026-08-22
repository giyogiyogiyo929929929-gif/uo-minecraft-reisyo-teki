// civs.js
import { world, system } from "@minecraft/server";

const VIRTUAL_CIVS_PROPERTY = "civ:virtualCivs";
const ACTIVE_CIV_PROPERTY = "civ:activeCivByController";

// Dynamic Property の読み取りを UI 更新やターン処理のたびに繰り返さないためのキャッシュ。
// ワールド再読み込み後は最初の取得で保存値から復元する。
let virtualCivsCache = null;
let virtualCivsByIdCache = null;
let activeCivMapCache = null;

// 同一tick内で何度も world.getAllPlayers() を呼ぶと、ターン処理やUI更新で
// 同じオンラインプレイヤー一覧を繰り返し取得することになるため、tick単位で共有する。
// プレイヤーの参加・退出はtick境界をまたいで反映されるため、長時間の古い状態を保持しない。
let onlinePlayersCache = null;
let onlinePlayersCacheTick = -1;
let onlinePlayersByIdCache = null;

function getOnlinePlayers() {
    const currentTick = system.currentTick;
    if (onlinePlayersCache && onlinePlayersCacheTick === currentTick) {
        return onlinePlayersCache;
    }
    onlinePlayersCache = world.getAllPlayers();
    onlinePlayersCacheTick = currentTick;
    onlinePlayersByIdCache = new Map();
    for (const player of onlinePlayersCache) {
        onlinePlayersByIdCache.set(player.id, player);
    }
    return onlinePlayersCache;
}

export function getOnlinePlayerById(id) {
    getOnlinePlayers();
    return onlinePlayersByIdCache?.get(id) ?? null;
}

function rebuildVirtualCivIndex(list) {
    const index = new Map();
    for (const civ of list) {
        if (civ?.id) index.set(civ.id, civ);
    }
    virtualCivsByIdCache = index;
}

function getVirtualCivs() {
    if (virtualCivsCache) return virtualCivsCache;

    const raw = world.getDynamicProperty(VIRTUAL_CIVS_PROPERTY);
    if (typeof raw !== "string") {
        virtualCivsCache = [];
        rebuildVirtualCivIndex(virtualCivsCache);
        return virtualCivsCache;
    }
    try {
        const list = JSON.parse(raw);
        virtualCivsCache = Array.isArray(list) ? list : [];
    } catch {
        virtualCivsCache = [];
    }
    rebuildVirtualCivIndex(virtualCivsCache);
    return virtualCivsCache;
}

function saveVirtualCivs(list) {
    world.setDynamicProperty(VIRTUAL_CIVS_PROPERTY, JSON.stringify(list));
    virtualCivsCache = list;
    rebuildVirtualCivIndex(list);
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
    getVirtualCivs();
    return virtualCivsByIdCache.get(id) ?? null;
}

/**
 * @param {any} controllerPlayer この国家を追加した実プレイヤー(所有者)
 * @param {string} [name] 国家名(省略時は自動採番)
 * @param {{ isBot?: boolean }} [options] isBot:true で自動操作されるBotとして追加する(bots.js参照)
 */
export function addVirtualCiv(controllerPlayer, name, options = {}) {
    const civs = getVirtualCivs();
    const id = `npc_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const civName = (name ?? "").trim() || `テスト国家${civs.length + 1}`;
    civs.push({ id, name: civName, controllerId: controllerPlayer.id, isBot: !!options.isBot });
    saveVirtualCivs(civs);
    return { id, name: civName };
}

export function getControllableCivs(realPlayer) {
    const list = [{ id: realPlayer.id, name: realPlayer.name, isVirtual: false, isBot: false }];
    for (const civ of getVirtualCivs()) {
        if (civ.controllerId === realPlayer.id) list.push({ id: civ.id, name: civ.name, isVirtual: true, isBot: !!civ.isBot });
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
    const player = getOnlinePlayerById(civId);
    if (player) return player.name;
    return getVirtualCivById(civId)?.name ?? null;
}

export function isCivControllable(civId) {
    if (getOnlinePlayerById(civId)) return true;
    const civ = getVirtualCivById(civId);
    if (civ) return civ.isBot || !!getOnlinePlayerById(civ.controllerId);
    return false;
}

export function getCivStorageHandle(civId) {
    const realPlayer = getOnlinePlayerById(civId);
    if (realPlayer) return realPlayer;

    const civ = getVirtualCivById(civId);
    if (!civ) return null;

    return {
        id: civId,
        name: civ.name,
        getDynamicProperty: (key) => world.getDynamicProperty(`civ:npc:${civId}:${key}`),
        setDynamicProperty: (key, value) => world.setDynamicProperty(`civ:npc:${civId}:${key}`, value),
        sendMessage: (text) => {
            const controller = getOnlinePlayerById(civ.controllerId);
            controller?.sendMessage(`§7[${civ.name}] §r${text}`);
        },
    };
}

export function getRealPlayer(player) {
    return player?.__realPlayer ?? player;
}

/**
 * 実プレイヤーをラップした薄いプロキシを返す。仮想国家のID/名前/保存領域だけを差し替え、
 * それ以外(location、dimension、sendMessage など)はすべて実プレイヤー本体に委譲する。
 *
 * 💡 以前は Object.create(realPlayer) で「プロトタイプに実体を置く」方式だったが、
 *    それだと acting.sendMessage(...) や acting.location のようにプロパティへ
 *    "acting" 経由でアクセスした際、ネイティブ側の this / レシーバーが acting のまま
 *    ネイティブハンドルとして認識されず、メソッド呼び出しが失敗したり(sendMessage)
 *    ゲッターが undefined を返したり(location)する不具合があった。
 *    Proxy の get トラップで「関数は実体(target)に bind してから返す」
 *    「ゲッター相当のプロパティは target 自身へのアクセスとして解決させる」ことで、
 *    ネイティブ側には常に本物の realPlayer が this として渡るようにしている。
 */
export function getActingPlayer(realPlayer) {
    const activeId = getActiveCivId(realPlayer);
    if (activeId === realPlayer.id) return realPlayer;

    const civ = getVirtualCivById(activeId);
    if (!civ) return realPlayer;

    const overrides = {
        __realPlayer: realPlayer,
        id: civ.id,
        name: civ.name,
        getDynamicProperty: (key) => world.getDynamicProperty(`civ:npc:${civ.id}:${key}`),
        setDynamicProperty: (key, value) => world.setDynamicProperty(`civ:npc:${civ.id}:${key}`, value),
    };

    return new Proxy(realPlayer, {
        get(target, prop, receiver) {
            if (prop in overrides) return overrides[prop];
            const value = target[prop];
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
// state.js
// world の dynamic property を使ってゲーム全体の状態(マップ・所有権・ターン)を保存します。

import { world } from "@minecraft/server";

const KEY_CONFIG = "civ:mapConfig";
const KEY_TURN = "civ:turn";
const KEY_TILE_ROW_PREFIX = "civ:tiles_row_";
const KEY_MATCH_SETTINGS = "civ:matchSettings";
const KEY_MAP_GEN_SETTINGS = "civ:mapGenSettings";
const KEY_WONDER_CLAIMS = "civ:wonderClaims";

// 💡 試合の設定(産出の倍率、不可侵条約・同盟の有無、Bot同士の手番間隔、など)。マップ/ターン状態
//    とは異なり、OPがゲームリセットを跨いで使い回せるよう resetAll() では消去しない(意図的)。
const DEFAULT_MATCH_SETTINGS = { yieldMultiplier: 2, diplomacyEnabled: true, botTurnDelayTicks: 5, peaceEnabled: true, logsEnabled: true };

// 💡 マップ生成の設定(各バイオームの生成有無・生成しやすさの重み、資源の出現率)。
//    matchSettingsと同様、OPがマップの再生成(/civ:generate)を跨いで使い回せるよう
//    resetAll() では消去しない(生成のたびに設定し直す手間を省くための意図的な設計)。
//    重みの既定値は mapGen.js の TERRAIN_TYPES とそろえてあり、未設定時は従来と同じ生成結果になる。
const DEFAULT_MAP_GEN_SETTINGS = {
    biomes: {
        grassland: { enabled: true, weight: 22 },
        forest: { enabled: true, weight: 16 },
        rainforest: { enabled: true, weight: 10 },
        desert: { enabled: true, weight: 12 },
        cold: { enabled: true, weight: 12 },
        mountain: { enabled: true, weight: 10 },
        river: { enabled: true, weight: 8 },
        sea: { enabled: true, weight: 10 },
    },
    resourceChance: 25,
};

// Dynamic Property の読み書きを毎回繰り返さないためのメモリキャッシュ。
// ワールド再読み込み後は最初の getTiles() で保存データから復元する。
let tilesCache = null;
let tilesCacheConfigKey = null;
let tileRowsCache = null;
let tileRowsRawCache = null;
let mapConfigCache = null;
let mapConfigLoaded = false;
let turnStateCache = null;
let stateVersion = 0;
let matchSettingsCache = null;
let matchSettingsLoaded = false;
let mapGenSettingsCache = null;
let mapGenSettingsLoaded = false;
let wonderClaimsCache = null;
let wonderClaimsLoaded = false;

function makeConfigKey(config) {
    return config ? JSON.stringify({
        originX: config.originX,
        originY: config.originY,
        originZ: config.originZ,
        width: config.width,
        height: config.height,
        tileSize: config.tileSize,
        ySurface: config.ySurface,
    }) : null;
}

/** マップ設定 { originX, originY, originZ, width, height, tileSize } を取得 */
export function getMapConfig() {
    // 0.5秒ごとのUI更新などでDynamic Propertyを毎回読む必要はない。
    if (mapConfigLoaded) return mapConfigCache;

    const raw = world.getDynamicProperty(KEY_CONFIG);
    if (typeof raw !== "string") {
        mapConfigCache = null;
        mapConfigLoaded = true;
        return null;
    }
    try {
        mapConfigCache = JSON.parse(raw);
    } catch {
        mapConfigCache = null;
    }
    mapConfigLoaded = true;
    return mapConfigCache;
}

export function setMapConfig(config) {
    world.setDynamicProperty(KEY_CONFIG, JSON.stringify(config));
    mapConfigCache = config;
    mapConfigLoaded = true;
    tilesCache = null;
    tileRowsCache = null;
    tileRowsRawCache = null;
    tilesCacheConfigKey = makeConfigKey(config);
    stateVersion++;
}

/** 初回だけ Dynamic Property の全行を読み込み、以後はメモリ上のオブジェクトを返す。 */
export function getTiles() {
    const config = getMapConfig();
    if (!config) return {};

    const configKey = makeConfigKey(config);
    if (tilesCache && tilesCacheConfigKey === configKey) return tilesCache;

    const tiles = {};
    const rowCache = new Array(config.height).fill(null);
    const rowRawCache = new Array(config.height).fill(null);

    for (let tz = 0; tz < config.height; tz++) {
        const raw = world.getDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`);
        let rowTiles = {};
        if (typeof raw === "string") {
            rowRawCache[tz] = raw;
            try {
                rowTiles = JSON.parse(raw);
            } catch {
                rowTiles = {};
                rowRawCache[tz] = JSON.stringify(rowTiles);
            }
        } else {
            rowRawCache[tz] = JSON.stringify(rowTiles);
        }
        rowCache[tz] = rowTiles;
        for (const txStr in rowTiles) {
            tiles[`${txStr},${tz}`] = rowTiles[txStr];
        }
    }

    tilesCache = tiles;
    tileRowsCache = rowCache;
    tileRowsRawCache = rowRawCache;
    tilesCacheConfigKey = configKey;
    return tilesCache;
}

/** キャッシュ済みの行と内容が同一なら Dynamic Property の書き込みを省略する。 */
export function setTiles(tiles) {
    const config = getMapConfig();
    if (!config) return;

    const rows = Array.from({ length: config.height }, () => ({}));
    for (const key in tiles) {
        const [txStr, tzStr] = key.split(",");
        const tz = parseInt(tzStr, 10);
        if (!Number.isInteger(tz) || tz < 0 || tz >= config.height) continue;
        rows[tz][txStr] = tiles[key];
    }

    const previousRawRows = tileRowsRawCache;
    const nextRawRows = new Array(config.height);
    let changed = false;
    for (let tz = 0; tz < config.height; tz++) {
        const nextRaw = JSON.stringify(rows[tz]);
        nextRawRows[tz] = nextRaw;
        if (nextRaw !== previousRawRows?.[tz]) {
            world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, nextRaw);
            changed = true;
        }
    }

    // 実際に状態が変わった場合だけ世代を進める。
    // これにより計算キャッシュが不要に全破棄されるのを防ぐ。
    tilesCache = tiles;
    tileRowsCache = rows;
    tileRowsRawCache = nextRawRows;
    tilesCacheConfigKey = makeConfigKey(config);
    if (changed) stateVersion++;
}

/** 単一タイルを取得。全マップの再読み込みは発生しない。 */
export function getTile(tx, tz) {
    return getTiles()[`${tx},${tz}`] ?? null;
}

/** 単一タイルだけを更新し、その行だけ Dynamic Property に保存する。 */
export function setTile(tx, tz, data) {
    const config = getMapConfig();
    if (!config || tz < 0 || tz >= config.height) return;

    const tiles = getTiles();
    const key = `${tx},${tz}`;
    tiles[key] = data;

    if (!tileRowsCache) tileRowsCache = Array.from({ length: config.height }, () => ({}));
    if (!tileRowsRawCache) tileRowsRawCache = Array.from({ length: config.height }, () => null);
    if (!tileRowsCache[tz]) tileRowsCache[tz] = {};
    tileRowsCache[tz][String(tx)] = data;

    const rowRaw = JSON.stringify(tileRowsCache[tz]);
    if (rowRaw !== tileRowsRawCache[tz]) {
        world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, rowRaw);
        tileRowsRawCache[tz] = rowRaw;
        stateVersion++;
    }
    tilesCache = tiles;
    tilesCacheConfigKey = makeConfigKey(config);
}

/** キャッシュの変更世代。将来の計算キャッシュの無効化にも利用できる。 */
export function getStateVersion() {
    return stateVersion;
}

/** ターン情報 { turnNumber, playerOrder: string[], currentIndex, started } */
export function getTurnState() {
    // UI更新やターン判定から何度呼ばれてもDynamic Propertyを読み直さない。
    if (turnStateCache) return turnStateCache;

    const raw = world.getDynamicProperty(KEY_TURN);
    if (typeof raw !== "string") {
        turnStateCache = { turnNumber: 1, playerOrder: [], currentIndex: 0, started: false };
        return turnStateCache;
    }
    try {
        turnStateCache = JSON.parse(raw);
    } catch {
        turnStateCache = { turnNumber: 1, playerOrder: [], currentIndex: 0, started: false };
    }
    return turnStateCache;
}

export function setTurnState(state) {
    world.setDynamicProperty(KEY_TURN, JSON.stringify(state));
    turnStateCache = state;
}

/** 試合の設定 { yieldMultiplier, diplomacyEnabled, botTurnDelayTicks, peaceEnabled } を取得(未設定時は既定値)。 */
export function getMatchSettings() {
    if (matchSettingsLoaded) return matchSettingsCache;

    const raw = world.getDynamicProperty(KEY_MATCH_SETTINGS);
    matchSettingsCache = { ...DEFAULT_MATCH_SETTINGS };
    if (typeof raw === "string") {
        try {
            Object.assign(matchSettingsCache, JSON.parse(raw));
        } catch {
            // 壊れた保存値は既定値のまま扱う。
        }
    }
    matchSettingsLoaded = true;
    return matchSettingsCache;
}

/** 試合の設定を部分更新する(渡したキーだけ上書きし、他は現在値を維持)。更新後の設定を返す。 */
export function setMatchSettings(partial) {
    const merged = { ...getMatchSettings(), ...partial };
    world.setDynamicProperty(KEY_MATCH_SETTINGS, JSON.stringify(merged));
    matchSettingsCache = merged;
    matchSettingsLoaded = true;
    stateVersion++; // 💡 産出倍率の変更を、都市産出量のキャッシュ(stateVersion駆動)に反映させる。
    return merged;
}

/**
 * 世界遺産(新要素)の所有状況 { [wonderId]: civId } を取得する。1ゲームにつき1国家しか
 * 着工できない世界遺産の「早い者勝ち」を判定するための、マップ/ターン状態と同じ
 * ゲームインスタンス単位のデータ(matchSettings/mapGenSettingsとは違い、resetAll()で消去する)。
 */
export function getWonderClaims() {
    if (wonderClaimsLoaded) return wonderClaimsCache;

    const raw = world.getDynamicProperty(KEY_WONDER_CLAIMS);
    wonderClaimsCache = {};
    if (typeof raw === "string") {
        try {
            Object.assign(wonderClaimsCache, JSON.parse(raw));
        } catch {
            // 壊れた保存値は空扱いにする。
        }
    }
    wonderClaimsLoaded = true;
    return wonderClaimsCache;
}

/** claims(getWonderClaimsの複製済みオブジェクト)を保存し、キャッシュを同期する共通処理。 */
function saveWonderClaims(claims) {
    world.setDynamicProperty(KEY_WONDER_CLAIMS, JSON.stringify(claims));
    wonderClaimsCache = claims;
    wonderClaimsLoaded = true;
}

/** 世界遺産を着工した国家として登録する(着工時に呼ぶ。既に他国が保持していても上書きしない)。 */
export function claimWonder(wonderId, civId) {
    const claims = { ...getWonderClaims() };
    if (claims[wonderId]) return;
    claims[wonderId] = civId;
    saveWonderClaims(claims);
}

/** 世界遺産の着工を取り消す(生産中止時のみ呼ぶ。civIdが一致する場合だけ解放する)。 */
export function releaseWonder(wonderId, civId) {
    const claims = { ...getWonderClaims() };
    if (claims[wonderId] !== civId) return;
    delete claims[wonderId];
    saveWonderClaims(claims);
}

/**
 * マップ生成の設定 { biomes: { [id]: { enabled, weight } }, resourceChance } を取得
 * (未設定/未知のバイオームIDは既定値で補う)。
 */
export function getMapGenSettings() {
    if (mapGenSettingsLoaded) return mapGenSettingsCache;

    const biomes = {};
    for (const id in DEFAULT_MAP_GEN_SETTINGS.biomes) biomes[id] = { ...DEFAULT_MAP_GEN_SETTINGS.biomes[id] };
    mapGenSettingsCache = { biomes, resourceChance: DEFAULT_MAP_GEN_SETTINGS.resourceChance };

    const raw = world.getDynamicProperty(KEY_MAP_GEN_SETTINGS);
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            if (parsed.biomes) {
                for (const id in parsed.biomes) {
                    if (mapGenSettingsCache.biomes[id]) Object.assign(mapGenSettingsCache.biomes[id], parsed.biomes[id]);
                }
            }
            if (typeof parsed.resourceChance === "number") mapGenSettingsCache.resourceChance = parsed.resourceChance;
        } catch {
            // 壊れた保存値は既定値のまま扱う。
        }
    }
    mapGenSettingsLoaded = true;
    return mapGenSettingsCache;
}

/**
 * マップ生成の設定を部分更新する。partial.biomes は渡したバイオームIDだけを
 * (enabled/weightのどちらか片方だけでも)上書きし、他のバイオーム・他のキーは現在値を維持する。
 */
export function setMapGenSettings(partial) {
    const current = getMapGenSettings();
    const merged = { ...current, ...partial };
    merged.biomes = { ...current.biomes };
    if (partial.biomes) {
        for (const id in partial.biomes) {
            merged.biomes[id] = { ...current.biomes[id], ...partial.biomes[id] };
        }
    }
    world.setDynamicProperty(KEY_MAP_GEN_SETTINGS, JSON.stringify(merged));
    mapGenSettingsCache = merged;
    mapGenSettingsLoaded = true;
    return merged;
}

/** マップ生成の設定を既定値(DEFAULT_MAP_GEN_SETTINGS)に戻す。更新後の設定を返す。 */
export function resetMapGenSettings() {
    world.setDynamicProperty(KEY_MAP_GEN_SETTINGS, undefined);
    mapGenSettingsCache = null;
    mapGenSettingsLoaded = false;
    return getMapGenSettings();
}

/**
 * 試合の設定(getMatchSettings().logsEnabled)を見て、world.sendMessage() を条件付きで
 * 呼び出す。全員Botの対戦を観戦・放置しているだけの時にチャット欄が行動ログ(領有・生産・
 * 戦闘・外交など)で埋め尽くされるのを防ぐため、OPが試合の設定からログ表示を無効化できる
 * ようにするためのヘルパー。無効化中でも見せたいメッセージ(勝利の告知など)は、
 * このヘルパーを使わず world.sendMessage() を直接呼ぶこと。
 */
export function broadcast(message) {
    if (!getMatchSettings().logsEnabled) return;
    world.sendMessage(message);
}

export function resetAll() {
    const config = getMapConfig();
    if (config) {
        for (let tz = 0; tz < config.height; tz++) {
            world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, undefined);
        }
    }

    world.setDynamicProperty(KEY_CONFIG, undefined);
    world.setDynamicProperty(KEY_TURN, undefined);
    world.setDynamicProperty(KEY_WONDER_CLAIMS, undefined);
    tilesCache = null;
    tileRowsCache = null;
    tileRowsRawCache = null;
    tilesCacheConfigKey = null;
    mapConfigCache = null;
    mapConfigLoaded = true;
    turnStateCache = null;
    wonderClaimsCache = null;
    wonderClaimsLoaded = false;
    stateVersion++;
}

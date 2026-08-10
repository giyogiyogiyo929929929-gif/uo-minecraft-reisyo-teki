// state.js
// world の dynamic property を使ってゲーム全体の状態(マップ・所有権・ターン)を保存します。

import { world } from "@minecraft/server";

const KEY_CONFIG = "civ:mapConfig";
const KEY_TURN = "civ:turn";
const KEY_TILE_ROW_PREFIX = "civ:tiles_row_";

// Dynamic Property の読み書きを毎回繰り返さないためのメモリキャッシュ。
// ワールド再読み込み後は最初の getTiles() で保存データから復元する。
let tilesCache = null;
let tilesCacheConfigKey = null;
let tileRowsCache = null;
let mapConfigCache = null;
let mapConfigLoaded = false;
let stateVersion = 0;

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

    for (let tz = 0; tz < config.height; tz++) {
        const raw = world.getDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`);
        let rowTiles = {};
        if (typeof raw === "string") {
            try {
                rowTiles = JSON.parse(raw);
            } catch {
                rowTiles = {};
            }
        }
        rowCache[tz] = rowTiles;
        for (const txStr in rowTiles) {
            tiles[`${txStr},${tz}`] = rowTiles[txStr];
        }
    }

    tilesCache = tiles;
    tileRowsCache = rowCache;
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

    const previousRows = tileRowsCache;
    let changed = false;
    for (let tz = 0; tz < config.height; tz++) {
        const nextRaw = JSON.stringify(rows[tz]);
        const previousRaw = previousRows?.[tz] == null ? null : JSON.stringify(previousRows[tz]);
        if (nextRaw !== previousRaw) {
            world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, nextRaw);
            changed = true;
        }
    }

    // 実際に状態が変わった場合だけ世代を進める。
    // これにより計算キャッシュが不要に全破棄されるのを防ぐ。
    tilesCache = tiles;
    tileRowsCache = rows;
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
    if (!tileRowsCache[tz]) tileRowsCache[tz] = {};
    tileRowsCache[tz][String(tx)] = data;

    world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, JSON.stringify(tileRowsCache[tz]));
    tilesCache = tiles;
    tilesCacheConfigKey = makeConfigKey(config);
    stateVersion++;
}

/** キャッシュの変更世代。将来の計算キャッシュの無効化にも利用できる。 */
export function getStateVersion() {
    return stateVersion;
}

/** ターン情報 { turnNumber, playerOrder: string[], currentIndex, started } */
export function getTurnState() {
    const raw = world.getDynamicProperty(KEY_TURN);
    if (typeof raw !== "string") {
        return { turnNumber: 1, playerOrder: [], currentIndex: 0, started: false };
    }
    try {
        return JSON.parse(raw);
    } catch {
        return { turnNumber: 1, playerOrder: [], currentIndex: 0, started: false };
    }
}

export function setTurnState(state) {
    world.setDynamicProperty(KEY_TURN, JSON.stringify(state));
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
    tilesCache = null;
    tileRowsCache = null;
    tilesCacheConfigKey = null;
    mapConfigCache = null;
    mapConfigLoaded = true;
    stateVersion++;
}

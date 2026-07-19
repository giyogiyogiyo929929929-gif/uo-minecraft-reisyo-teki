// state.js
// world の dynamic property を使ってゲーム全体の状態(マップ・所有権・ターン)を保存します。

import { world } from "@minecraft/server";

const KEY_CONFIG = "civ:mapConfig";
const KEY_TURN = "civ:turn";
// 💡 分割セーブ用のキーの接頭辞を定義します
const KEY_TILE_ROW_PREFIX = "civ:tiles_row_";

/** マップ設定 { originX, originY, originZ, width, height, tileSize } を取得 */
export function getMapConfig() {
    const raw = world.getDynamicProperty(KEY_CONFIG);
    if (typeof raw !== "string") return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function setMapConfig(config) {
    world.setDynamicProperty(KEY_CONFIG, JSON.stringify(config));
}

/** 
 * タイル情報 { "x,z": { type, ownerId, ownerName } } を取得
 * 💡 各行(Z座標)ごとに保存されているデータを合体させて、1つの大きなオブジェクトとして復元します
 */
export function getTiles() {
    const config = getMapConfig();
    if (!config) return {};
    
    const tiles = {};
    const height = config.height;

    for (let tz = 0; tz < height; tz++) {
        const raw = world.getDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`);
        if (typeof raw === "string") {
            try {
                const rowTiles = JSON.parse(raw); // 例: { "0": { type... }, "1": { type... } }
                for (const txStr in rowTiles) {
                    tiles[`${txStr},${tz}`] = rowTiles[txStr];
                }
            } catch {
                // 破損データは安全に無視
            }
        }
    }
    return tiles;
}

/** 
 * タイル情報を保存
 * 💡 渡された tiles データをZ座標(行)ごとに分解し、それぞれのキーで個別保存して32KB制限を回避します
 */
export function setTiles(tiles) {
    const config = getMapConfig();
    if (!config) return;

    const height = config.height;

    // 行ごとにデータを分類する器を用意
    const rows = Array.from({ length: height }, () => ({}));

    for (const key in tiles) {
        const [txStr, tzStr] = key.split(",");
        const tx = parseInt(txStr, 10);
        const tz = parseInt(tzStr, 10);
        
        if (tz >= 0 && tz < height) {
            rows[tz][tx] = tiles[key];
        }
    }

    // 分類したデータを1行ずつ個別のキーでセーブする
    for (let tz = 0; tz < height; tz++) {
        world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, JSON.stringify(rows[tz]));
    }
}

export function getTile(tx, tz) {
    const tiles = getTiles();
    return tiles[`${tx},${tz}`] ?? null;
}

export function setTile(tx, tz, data) {
    const tiles = getTiles();
    tiles[`${tx},${tz}`] = data;
    setTiles(tiles);
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

// 💡 リセット時に、保存していた全行のデータをきれいにお掃除します
export function resetAll() {
    const config = getMapConfig();
    
    if (config) {
        for (let tz = 0; tz < config.height; tz++) {
            world.setDynamicProperty(`${KEY_TILE_ROW_PREFIX}${tz}`, undefined);
        }
    }

    world.setDynamicProperty(KEY_CONFIG, undefined);
    world.setDynamicProperty(KEY_TURN, undefined);
}
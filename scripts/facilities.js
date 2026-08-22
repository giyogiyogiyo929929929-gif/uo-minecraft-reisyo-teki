// facilities.js
// 🏗️ 施設(facility): 都市の生産キュー(production.js)を使わず、労働者の行動回数を
// 1消費して「空いている領有マス」に即座に設置するタイプの建造物。
//
// 【生産キュー式の建造物(production.js の category:"building")との違い】
//   - 生産キュー式: 都市が毎ターン生産力を蓄積し、完了すると都市のマスに効果が付与される。
//     1都市につき同時に1つしか生産できず、完成までに複数ターンかかる。
//   - 施設: 労働者の行動回数を1消費するだけで即座に設置される。都市のマスではなく、
//     自分が領有している「空いている」マスならどこでも良い。1都市の領有範囲内に
//     複数の施設を(空きマスの数だけ)設置できる。
//
// 【データの持ち方】
//   tile.facility = { id, label, ownerId, ownerName }
//   都市(tile.city)とは別物として、通常の領有マスに直接載る。
//
// 【新しい施設の増やし方】
//   FACILITY_DEFS に1エントリ追加するだけでよい。adjacencyBonuses は production.js の
//   建造物と全く同じ書き方(adjacency.js の matchesTerrain 等)で指定できる。

import { hasCompletedProgress, getDefinition } from "./progression.js";
import { matchesTerrainWeighted, sumAssignedTileYields, sumAssignedTileAdjacencyYields } from "./adjacency.js";
import { RESOURCE_TYPES, isWaterTerrain } from "./mapGen.js";

/**
 * @typedef {Object} FacilityDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {string} [requiresTechnology] 設置に必要な技術ID(technology progression)
 * @property {string} [requiresResource] 設置できるマスの資源を限定する(tile.resourceと一致が必要)
 * @property {boolean} [allowWater] trueの場合のみ水上マス(川・海・池・湖)に設置できる(省略時は不可)
 * @property {Record<string, number>} [flatYields] この施設があるだけで(隣接マスに関係なく)
 *   都市に毎ターン加算される産出量(例: { iron: 2, production: 4 })
 * @property {Array<any>} [adjacencyBonuses] 隣接マスに応じたボーナスのルール一覧(adjacency.js参照)
 * @property {(tile: any, tx: number, tz: number) => string} [installMessage] 設置完了時のメッセージ生成関数
 */
export const FACILITY_DEFS = {
    quarry: {
        label: "採石場",
        icon: "[Quarry]",
        requiresTechnology: "mining",
        // 💡 周囲8マスの「山」1つにつき生産力+1(山脈はその2倍の+2、上限なし)。
        adjacencyBonuses: [
            { id: "quarryMountain", label: "山・山脈からの採石恩恵", match: matchesTerrainWeighted({ mountain: 1, mountainRange: 2 }), yieldPerMatch: { production: 1 } },
        ],
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に採石場を設置しました！(隣接する山1つにつき生産力+1、山脈は+2)`,
    },
    blacksmith: {
        label: "鍛冶場",
        icon: "[Blacksmith]",
        requiresTechnology: "smelting",
        requiresResource: "iron",
        flatYields: { iron: 2, production: 4 },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に鍛冶場を設置しました！(毎ターン鉄+2、生産力+4)`,
    },
};

export function getFacilityDef(id) {
    return FACILITY_DEFS[id] ?? null;
}

export function getFacilityIds() {
    return Object.keys(FACILITY_DEFS);
}

/**
 * 指定マスに施設を設置できるかどうかを判定する。
 * @param {any} tile 対象マスのデータ
 * @param {string} id 施設ID
 * @param {string} playerId 設置しようとしているプレイヤー/国家のID
 * @param {any} [player] 技術取得状況の判定に使うプレイヤー/国家ハンドル(省略時は技術チェックを行わない)
 * @returns {{ ok: boolean, message?: string }}
 */
export function canInstallFacility(tile, id, playerId, player = null) {
    const def = FACILITY_DEFS[id];
    if (!def) return { ok: false, message: "§c不明な施設です。" };
    if (!tile) return { ok: false, message: "§c無効なマスです。" };
    if (tile.ownerId !== playerId) return { ok: false, message: "§cこのマスはあなたの領有地ではありません。" };
    if (tile.city) return { ok: false, message: "§cこのマスには都市があるため施設は設置できません。" };
    if (tile.facility) return { ok: false, message: `§cこのマスには既に施設【${tile.facility.label ?? tile.facility.id}】が存在します。` };
    if (tile.district) return { ok: false, message: `§cこのマスには区域【${tile.district.label ?? tile.district.id}】があるため施設は設置できません。` };
    if (tile.underDistrictConstruction) return { ok: false, message: "§cこのマスは区域を建設中のため施設は設置できません。" };
    if (!def.allowWater && isWaterTerrain(tile.type)) return { ok: false, message: `§c【${def.label}】は水上マスには設置できません。` };
    if (def.requiresResource && tile.resource !== def.requiresResource) {
        const resourceLabel = RESOURCE_TYPES[def.requiresResource]?.label ?? def.requiresResource;
        return { ok: false, message: `§c【${def.label}】は資源【${resourceLabel}】があるマスにのみ設置できます。` };
    }
    if (def.requiresTechnology) {
        const hasTech = !!player && hasCompletedProgress(player, "technology", def.requiresTechnology);
        if (!hasTech) {
            const techDef = getDefinition("technology", def.requiresTechnology);
            return { ok: false, message: `§c【${def.label}】の設置には技術【${techDef?.label ?? def.requiresTechnology}】の取得が必要です。` };
        }
    }
    return { ok: true };
}

/**
 * 施設を設置する。呼び出し側で、労働者の行動回数の消費や領有チェックは済んでいる前提。
 * @returns {any|null} 設置された施設データ(不明な施設IDの場合は null)
 */
export function installFacility(tile, id, ownerId, ownerName) {
    const def = FACILITY_DEFS[id];
    if (!def) return null;
    tile.facility = { id, label: def.label, ownerId, ownerName };
    return tile.facility;
}

/**
 * 都市に帰属するマスの一覧から、施設が設置されているものを見つけ、それぞれの隣接ボーナスを
 * 合算する。production.js の建造物と同様、新しい施設を追加してもここのコードは変更不要。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @param {any} tiles 全タイルデータ
 * @returns {{ [yieldKey: string]: number }}
 */
export function getFacilityAdjacencyYields(assignedTiles, tiles) {
    return sumAssignedTileAdjacencyYields(assignedTiles, tiles, (tile) => tile?.facility, FACILITY_DEFS);
}

/**
 * 都市に帰属するマスの一覧から、施設が設置されているものを見つけ、隣接マスに関係なく
 * その施設があるだけで得られる産出量(flatYields)を合算する。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @returns {{ [yieldKey: string]: number }}
 */
export function getFacilityFlatYields(assignedTiles) {
    return sumAssignedTileYields(assignedTiles, (tile) => tile?.facility, FACILITY_DEFS, "flatYields");
}
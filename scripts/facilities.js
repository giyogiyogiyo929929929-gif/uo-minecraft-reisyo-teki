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
import { matchesTerrain, getAdjacencyBonus } from "./adjacency.js";

/**
 * @typedef {Object} FacilityDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {string} [requiresTechnology] 設置に必要な技術ID(technology progression)
 * @property {Array<any>} [adjacencyBonuses] 隣接マスに応じたボーナスのルール一覧(adjacency.js参照)
 * @property {(tile: any, tx: number, tz: number) => string} [installMessage] 設置完了時のメッセージ生成関数
 */
export const FACILITY_DEFS = {
    quarry: {
        label: "採石場",
        icon: "[Quarry]",
        requiresTechnology: "mining",
        // 💡 周囲8マスの「山」1つにつき生産力+1(上限なし)。
        adjacencyBonuses: [
            { id: "quarryMountain", label: "山からの採石恩恵", match: matchesTerrain("mountain"), yieldPerMatch: { production: 1 } },
        ],
        installMessage: (tile, tx, tz) => `§e🎉 (${tx}, ${tz}) に採石場を設置しました！(隣接する山1つにつき生産力+1)`,
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
    const totals = {};
    if (!Array.isArray(assignedTiles)) return totals;

    for (const t of assignedTiles) {
        const facility = t.tile?.facility;
        if (!facility) continue;
        const def = FACILITY_DEFS[facility.id];
        if (!def?.adjacencyBonuses) continue;

        const bonus = getAdjacencyBonus(t.tx, t.tz, tiles, def.adjacencyBonuses);
        for (const key in bonus) {
            totals[key] = (totals[key] ?? 0) + bonus[key];
        }
    }

    return totals;
}
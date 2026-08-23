// unitLabels.js
// 🏷️ 各マスにいる戦闘ユニット(陸軍/海軍)・宗教ユニットを、ワールド内に浮かぶテキストラベル
// (TextPrimitive)として常時表示するモジュール。
//
// 【仕組み】
// world.primitiveShapesManager は実験的API(minecraft-bedrock-experimental)で、ワールド上の
// 任意の座標にテキストを浮かべて表示できる。マス(tx, tz)ごとに1つのTextPrimitiveを対応させ、
// syncUnitLabels() を定期的に(main.jsの表示更新ループから)呼び出すことで、
//   ・新しく戦闘/宗教ユニットが出現したマス → ラベルを新規追加
//   ・内容(HP・所有者など)が変わったマス → ラベルの表示内容を更新
//   ・戦闘/宗教ユニットが居なくなった(移動・破壊・布教力を使い果たす・マップ再生成など)
//     マス → ラベルを削除
// を自動的に同期する。マップの再生成・ゲームリセットで tiles が丸ごと変わっても、
// 「今のtilesに存在しないキーのラベルを消す」ことで自動的に後始末される。
//
// 【戦闘ユニットと宗教ユニットが同じマスに重なる場合】
// tile.combatUnit と tile.religiousUnit は独立したレイヤーで、同じマスに両方が同時に
// 存在しうる(§13/§11参照)。マスごとに1つのTextPrimitiveしか対応させない設計のため、
// 両方いる場合は buildLabelText() が2ユニットぶんの内容を1つのラベルに連結する
// (別々のラベルを重ねて表示しようとはしない)。
//
// 【注意】
// ・TextPrimitiveは実験的APIのため、ワールド作成時に「ベータAPI」を有効にしていないと
//   world.primitiveShapesManager へのアクセスや addText 呼び出しがエラーになる。
//   このモジュールはその例外を捕まえ、以後は機能全体を静かに無効化する
//   (通常のチャット/アクションバー/フォームUIには一切影響しない)。
// ・world.primitiveShapesManager.maxShapes に総ラベル数の上限があるため、
//   上限に達した場合はそれ以上の新規追加をスキップする(既存のラベルは残す)。

import { world, system, TextPrimitive } from "@minecraft/server";
import { getMapConfig, getTiles, getStateVersion } from "./state.js";
import { getUnitClassLabel } from "./combat.js";

const TILE_SIZE = 5;
const LABEL_HEIGHT_OFFSET = 2.2;
// 💡 毎tick同期すると負荷が大きいため、一定間隔(20tick = 1秒)ごとにのみ同期する。
const SYNC_INTERVAL_TICKS = 20;

// "tx,tz" キー → { primitive: TextPrimitive, signature: string }
const activeLabels = new Map();
let primitiveApiAvailable = true;
let lastSyncTick = -Infinity;
let lastSyncedVersion = -1;

function tileCenterLocation(config, tx, tz, dimension) {
    return {
        x: config.originX + tx * TILE_SIZE + 2.5,
        y: config.ySurface + LABEL_HEIGHT_OFFSET,
        z: config.originZ + tz * TILE_SIZE + 2.5,
        dimension,
    };
}

function buildCombatUnitText(unit) {
    const domainTag = unit.domain === "naval" ? "§b[Naval]" : "§a[Land]";
    const hp = Math.max(0, Math.round(unit.hp ?? 0));
    const maxHp = unit.maxHp ?? 100;
    return `${domainTag} §f${unit.label ?? unit.id ?? "ユニット"} §7(${getUnitClassLabel(unit.unitClass)})\n§7${unit.ownerName ?? "不明"} §cHP:${hp}/${maxHp}`;
}

function buildReligiousUnitText(unit) {
    const hp = Math.max(0, Math.round(unit.hp ?? 0));
    const maxHp = unit.maxHp ?? 100;
    return `§d[Faith] §f${unit.label ?? unit.id ?? "宗教ユニット"}\n§7${unit.ownerName ?? "不明"} §cHP:${hp}/${maxHp}`;
}

/**
 * このマスのラベルに表示する内容を組み立てる。戦闘ユニット・宗教ユニットのどちらか一方、
 * または両方(同じマスに重なっている場合)がありうるが、マスごとに1つのTextPrimitiveしか
 * 対応させないため、両方いる場合は1つのラベルに連結する(呼び出し元は先にどちらかが
 * 存在することを確認済みの前提)。
 */
function buildLabelText(tile) {
    const parts = [];
    if (tile.combatUnit) parts.push(buildCombatUnitText(tile.combatUnit));
    if (tile.religiousUnit) parts.push(buildReligiousUnitText(tile.religiousUnit));
    return parts.join("\n");
}

function removeLabel(key) {
    const entry = activeLabels.get(key);
    if (!entry) return;
    try { entry.primitive.remove(); } catch (e) {}
    activeLabels.delete(key);
}

function syncUnitLabelsInner() {
    const config = getMapConfig();
    const manager = world.primitiveShapesManager;
    if (!config || !manager) return;

    const tiles = getTiles();
    const dimension = world.getDimension("overworld");
    const seenKeys = new Set();

    for (const key in tiles) {
        const tile = tiles[key];
        if (!tile.combatUnit && !tile.religiousUnit) continue;
        seenKeys.add(key);

        const signature = buildLabelText(tile);
        const existing = activeLabels.get(key);

        if (existing) {
            if (existing.signature !== signature) {
                existing.primitive.setText(signature);
                existing.signature = signature;
            }
            continue;
        }

        if (activeLabels.size >= (manager.maxShapes ?? Infinity)) continue;

        const [txStr, tzStr] = key.split(",");
        const tx = Number(txStr), tz = Number(tzStr);
        const primitive = new TextPrimitive(tileCenterLocation(config, tx, tz, dimension), signature);
        manager.addText(primitive, dimension);
        activeLabels.set(key, { primitive, signature });
    }

    // 戦闘/宗教ユニットが居なくなった(移動・破壊・マップ再生成など)マスのラベルを削除する。
    for (const key of activeLabels.keys()) {
        if (!seenKeys.has(key)) removeLabel(key);
    }
}

/**
 * 現在の全タイルを走査し、戦闘/宗教ユニットがいるマスのラベルをワールドに同期する。
 * main.js の定期ループから呼び出す想定。実験的APIが無効な環境では何もしない。
 *
 * 💡 全タイル走査(syncUnitLabelsInner)はマップが大きいほどコストが増えるため、
 *    前回の同期以降にタイル/都市などの状態が何も変わっていなければ(getStateVersion()が
 *    同じなら)スキップする。ユニットの移動・生産・撃破などは必ず setTile/setTiles を
 *    経由してstateVersionを上げるので、それらを取りこぼすことはない。
 */
export function syncUnitLabels() {
    if (!primitiveApiAvailable) return;

    const currentTick = system.currentTick;
    if (currentTick - lastSyncTick < SYNC_INTERVAL_TICKS) return;
    lastSyncTick = currentTick;

    const version = getStateVersion();
    if (version === lastSyncedVersion) return;
    lastSyncedVersion = version;

    try {
        syncUnitLabelsInner();
    } catch (e) {
        // 💡 「ベータAPI」が無効なワールドでは primitiveShapesManager 関連の呼び出しが
        //    例外を投げる。以後は毎回試みてエラーを埋めないよう、機能全体を無効化する。
        primitiveApiAvailable = false;
        activeLabels.clear();
    }
}

/** 全ラベルを即座に削除する。ゲームリセットなどで明示的に片付けたい場合に使う。 */
export function clearAllUnitLabels() {
    if (!primitiveApiAvailable) return;
    try {
        world.primitiveShapesManager?.removeAll();
    } catch (e) {}
    activeLabels.clear();
}

/**
 * 指定したマス(tx, tz)のラベルを、現在のタイル状態に合わせて即座に同期する。ユニットが
 * 戦闘で撃破された直後など、次回の定期同期(最大 SYNC_INTERVAL_TICKS 後)を待たずにその場で
 * 反映したい場合に使う。
 * 💡 戦闘ユニット・宗教ユニットは同じマスに重なりうる(§13/§11参照)ため、単純に
 *    ラベルを削除するのではなく、そのマスの最新状態から作り直す(片方だけ消えた場合は
 *    もう片方の内容だけのラベルに更新し、両方居なくなった場合にラベルごと削除する)。
 */
export function refreshUnitLabelAt(tx, tz) {
    if (!primitiveApiAvailable) return;
    const key = `${tx},${tz}`;
    const tile = getTiles()[key];

    if (!tile || (!tile.combatUnit && !tile.religiousUnit)) {
        removeLabel(key);
        return;
    }

    const config = getMapConfig();
    const manager = world.primitiveShapesManager;
    if (!config || !manager) return;

    const signature = buildLabelText(tile);
    const existing = activeLabels.get(key);
    if (existing) {
        if (existing.signature !== signature) {
            existing.primitive.setText(signature);
            existing.signature = signature;
        }
        return;
    }

    if (activeLabels.size >= (manager.maxShapes ?? Infinity)) return;
    const dimension = world.getDimension("overworld");
    const primitive = new TextPrimitive(tileCenterLocation(config, tx, tz, dimension), signature);
    manager.addText(primitive, dimension);
    activeLabels.set(key, { primitive, signature });
}

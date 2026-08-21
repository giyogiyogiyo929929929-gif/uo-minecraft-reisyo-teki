// unitLabels.js
// 🏷️ 各マスにいる戦闘ユニット(陸軍/海軍)を、ワールド内に浮かぶテキストラベル(TextPrimitive)として
// 常時表示するモジュール。
//
// 【仕組み】
// world.primitiveShapesManager は実験的API(minecraft-bedrock-experimental)で、ワールド上の
// 任意の座標にテキストを浮かべて表示できる。マス(tx, tz)ごとに1つのTextPrimitiveを対応させ、
// syncUnitLabels() を定期的に(main.jsの表示更新ループから)呼び出すことで、
//   ・新しく出現した戦闘ユニットのマス → ラベルを新規追加
//   ・内容(HP・所有者など)が変わったマス → ラベルの表示内容を更新
//   ・戦闘ユニットが居なくなった(移動・破壊・マップ再生成など)マス → ラベルを削除
// を自動的に同期する。マップの再生成・ゲームリセットで tiles が丸ごと変わっても、
// 「今のtilesに存在しないキーのラベルを消す」ことで自動的に後始末される。
//
// 【注意】
// ・TextPrimitiveは実験的APIのため、ワールド作成時に「ベータAPI」を有効にしていないと
//   world.primitiveShapesManager へのアクセスや addText 呼び出しがエラーになる。
//   このモジュールはその例外を捕まえ、以後は機能全体を静かに無効化する
//   (通常のチャット/アクションバー/フォームUIには一切影響しない)。
// ・world.primitiveShapesManager.maxShapes に総ラベル数の上限があるため、
//   上限に達した場合はそれ以上の新規追加をスキップする(既存のラベルは残す)。

import { world, system, TextPrimitive } from "@minecraft/server";
import { getMapConfig, getTiles } from "./state.js";

const TILE_SIZE = 5;
const LABEL_HEIGHT_OFFSET = 2.2;
// 💡 毎tick同期すると負荷が大きいため、一定間隔(20tick = 1秒)ごとにのみ同期する。
const SYNC_INTERVAL_TICKS = 20;

// "tx,tz" キー → { primitive: TextPrimitive, signature: string }
const activeLabels = new Map();
let primitiveApiAvailable = true;
let lastSyncTick = -Infinity;

function tileCenterLocation(config, tx, tz, dimension) {
    return {
        x: config.originX + tx * TILE_SIZE + 2.5,
        y: config.ySurface + LABEL_HEIGHT_OFFSET,
        z: config.originZ + tz * TILE_SIZE + 2.5,
        dimension,
    };
}

function buildLabelText(unit) {
    const domainTag = unit.domain === "naval" ? "§b[Naval]" : "§a[Land]";
    const hp = Math.max(0, Math.round(unit.hp ?? 0));
    const maxHp = unit.maxHp ?? 100;
    return `${domainTag} §f${unit.label ?? unit.id ?? "ユニット"}\n§7${unit.ownerName ?? "不明"} §cHP:${hp}/${maxHp}`;
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
        const unit = tiles[key].combatUnit;
        if (!unit) continue;
        seenKeys.add(key);

        const signature = buildLabelText(unit);
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

    // 戦闘ユニットが居なくなった(移動・破壊・マップ再生成など)マスのラベルを削除する。
    for (const key of activeLabels.keys()) {
        if (!seenKeys.has(key)) removeLabel(key);
    }
}

/**
 * 現在の全タイルを走査し、戦闘ユニットがいるマスのラベルをワールドに同期する。
 * main.js の定期ループから呼び出す想定。実験的APIが無効な環境では何もしない。
 */
export function syncUnitLabels() {
    if (!primitiveApiAvailable) return;

    const currentTick = system.currentTick;
    if (currentTick - lastSyncTick < SYNC_INTERVAL_TICKS) return;
    lastSyncTick = currentTick;

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
 * 指定したマス(tx, tz)のラベルを即座に削除する。ユニットが戦闘で撃破された直後など、
 * 次回の定期同期(最大 SYNC_INTERVAL_TICKS 後)を待たずにその場でラベルを消したい場合に使う。
 */
export function removeUnitLabelAt(tx, tz) {
    if (!primitiveApiAvailable) return;
    removeLabel(`${tx},${tz}`);
}

// airbase.js
// 航空戦(新機能)。航空ユニット(支援偵察・支援防御・戦闘機・戦略爆撃機)は、陸軍/海軍ユニットと
// 違ってマス上を移動せず、都心(常に1枠)・飛行場(区域専用建造物、+8枠)・滑走路(施設、+3枠)に
// "配置"され、そこから直接出撃・略奪・帰投する(Civilization VIの航空基地の考え方を踏襲)。
//
// 【データ構造】
// tile.combatUnit(陸軍/海軍と共有の単一スロット)は使わない。代わりに city.airbase.units が
// 配置中の航空ユニット(複数)を保持する配列(city は都心タイルの tile.city)。これにより
// 「1マスにつきユニット1体まで」という既存の制約を空軍にだけ迂回できる。
//
// 【哨戒・迎撃】
// 戦闘機・支援防御機は patrol フラグを立てることで哨戒状態になり、拠点(都心)から
// AIR_PATROL_INTERCEPT_RADIUS マス以内への敵空爆を迎撃できる(対空砲(antiAir)による
// 確実な撃墜とは違い、迎撃側の戦闘力で一方的にダメージを与えるだけで、撃墜しない限り
// 空爆自体は実行される)。1ターンにつき1ユニット1回まで(interceptedThisTurn)。
// 支援偵察機は自分では哨戒できない(interceptCombatStrengthを持たない)代わりに、
// 同じ拠点に居るだけで他の迎撃ユニットの迎撃戦闘力に補助ボーナスを与える。
//
// 【略奪・回復】commands.js(cmdAirPillage)・turns.js(processPlayerTurnStart)からそれぞれ
// 呼び出される。

import { isAtWar } from "./diplomacy.js";
import { tileDistance } from "./combat.js";

export const AIRBASE_SLOTS_CITY_CENTER = 1;
export const AIRBASE_SLOTS_AIRPORT = 8;
export const AIRBASE_SLOTS_AIRSTRIP = 3;
export const AIR_PATROL_INTERCEPT_RADIUS = 1;
// 💡 支援偵察機が同じ拠点の他ユニットの迎撃に与える補助ボーナス(支援機としての役割)。
export const RECON_INTERCEPT_SUPPORT_BONUS = 10;
// 💡 ターン終了時の回復量。飛行場があれば最大、無ければ基礎値(都心のみ/滑走路のみ問わず一律)。
export const AIR_HEAL_BASE = 20;
export const AIR_HEAL_AIRPORT = 40;
// 略奪(cmdAirPillage)には爆撃機のHPがこの割合以上残っている必要がある。
export const PILLAGE_MIN_HP_RATIO = 0.5;

/** cityKey(都心タイルのキー)における現在の航空基地の総枠数。都心+飛行場+滑走路×基数。 */
export function getAirbaseCapacity(city, cityKey, tiles) {
    let capacity = AIRBASE_SLOTS_CITY_CENTER;
    if (city?.airport) capacity += AIRBASE_SLOTS_AIRPORT;
    for (const key in tiles) {
        const t = tiles[key];
        if (t.facility?.id === "airstrip" && t.belongsToCityKey === cityKey) capacity += AIRBASE_SLOTS_AIRSTRIP;
    }
    return capacity;
}

/** この都市に配置中の航空ユニット一覧(無ければ空配列)。 */
export function getBasedAirUnits(city) {
    return city?.airbase?.units ?? [];
}

/** 航空ユニットをこの都市の航空基地に配置する(呼び出し元で容量チェック済みであること)。 */
export function addBasedAirUnit(city, unit) {
    if (!city.airbase) city.airbase = { units: [] };
    city.airbase.units.push(unit);
}

/** 航空ユニットをこの都市の航空基地から除く(撃墜・出撃元からの移設時に使う)。 */
export function removeBasedAirUnit(city, unit) {
    const units = city?.airbase?.units;
    if (!units) return;
    const idx = units.indexOf(unit);
    if (idx !== -1) units.splice(idx, 1);
}

/**
 * 指定プレイヤーが保有する全ての都市の航空基地に配置中の航空ユニットを1つの配列にまとめて返す。
 * 航空ユニットは tile.combatUnit ではなく city.airbase.units に格納されるため、tiles を
 * combatUnit だけで走査する処理(ゴールド維持費・財政破綻の強制解散・国力評価など)では
 * 拾えない。それらの処理から航空ユニットも対象に含めたい場合はこのヘルパー経由で走査する。
 * @returns {Array<{cityKey: string, city: any, unit: any}>}
 */
export function getAllBasedAirUnitsForPlayer(playerId, tiles) {
    const result = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== playerId || !t.city) continue;
        const units = t.city.airbase?.units;
        if (!units) continue;
        for (const unit of units) result.push({ cityKey: key, city: t.city, unit });
    }
    return result;
}

/** ターン終了時の回復量(飛行場があれば最大、無ければ基礎値)。 */
export function getAirHealAmount(city) {
    return city?.airport ? AIR_HEAL_AIRPORT : AIR_HEAL_BASE;
}

/**
 * この航空ユニットが哨戒(patrol)状態にできるかどうか。commands.js(cmdSetAirPatrol)と
 * ui.js(openAirUnitActionMenu)がそれぞれ別の判定方法(airRoleの列挙 / interceptCombatStrengthの
 * 有無)で独自に実装していたのを1箇所に統一したもの。迎撃戦闘力(interceptCombatStrength)を
 * 持つユニットだけが哨戒できる(支援偵察機は補助役のため持たない。§航空戦参照)。
 */
export function canAirUnitPatrol(unit) {
    return unit?.interceptCombatStrength !== undefined;
}

/**
 * playerId が所有する全都市の航空基地について、ターン開始時の処理をまとめて行う
 * (turns.js の processPlayerTurnStart から、その civ の手番開始時に1回だけ呼ぶ)。
 * ・前ターン行動しなかった(actedThisTurn===false)ユニットは、getAirHealAmount() ぶん回復する
 *   (§航空戦: 戦闘を行わなかった場合にかぎりターン終了時に回復、の実装)。
 * ・actedThisTurn / interceptedThisTurn を新しいターン向けにリセットする(patrolは持ち越す)。
 */
export function resetAndHealBasedAirUnitsForTurn(playerId, tiles) {
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== playerId || !t.city) continue;
        const units = getBasedAirUnits(t.city);
        if (!units.length) continue;
        const healAmount = getAirHealAmount(t.city);
        for (const unit of units) {
            if (!unit.actedThisTurn && (unit.hp ?? 0) > 0) {
                unit.hp = Math.min(unit.maxHp ?? unit.hp, (unit.hp ?? 0) + healAmount);
            }
            unit.actedThisTurn = false;
            unit.interceptedThisTurn = false;
        }
    }
}

/**
 * targetTx,targetTz への空爆を迎撃できる、哨戒中の航空ユニットを探す(対空砲による確実な
 * 迎撃とは別枠。findInterceptingAntiAirCity で見つからなかった場合のみ呼ぶこと)。
 * 迎撃戦闘力(interceptCombatStrength)が最も高いものを優先する(空爆を迎撃できるのは1ユニットのみ)。
 * 同じ拠点に支援偵察機が(哨戒状態でなくとも)配置されていれば、支援ボーナスを bonus として返す。
 * @returns {{ city: any, cityKey: string, unit: any, bonus: number } | null}
 */
export function findInterceptingPatrolUnit(tiles, targetTx, targetTz, attackerOwnerId) {
    let best = null;
    for (const key in tiles) {
        const t = tiles[key];
        if (!t.city || !t.ownerId || t.ownerId === attackerOwnerId) continue;
        if (!isAtWar(attackerOwnerId, t.ownerId)) continue;
        const [ctx, ctz] = key.split(",").map(Number);
        if (tileDistance(ctx, ctz, targetTx, targetTz) > AIR_PATROL_INTERCEPT_RADIUS) continue;

        const units = getBasedAirUnits(t.city);
        if (!units.length) continue;
        const hasRecon = units.some((u) => u.airRole === "recon" && (u.hp ?? 0) > 0);
        for (const unit of units) {
            if (!canAirUnitPatrol(unit)) continue; // 爆撃機・偵察機自身は哨戒不可
            if (!unit.patrol || unit.interceptedThisTurn) continue;
            if ((unit.hp ?? 0) <= 0) continue;
            const strength = unit.interceptCombatStrength ?? 0;
            if (!best || strength > best.strength) {
                best = { city: t.city, cityKey: key, unit, strength, bonus: hasRecon ? RECON_INTERCEPT_SUPPORT_BONUS : 0 };
            }
        }
    }
    return best;
}

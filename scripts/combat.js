// combat.js
// 戦闘ユニット同士の戦闘（攻撃距離の判定・ダメージ計算）を管理するモジュール。
//
// 【陸軍/海軍の区分】
// ・戦闘ユニットは unit.domain で陸軍("land")か海軍("naval")かを区別する(未指定の場合は陸軍扱い)。
// ・陸軍ユニットは陸地マス(isWaterでもimpassableでもないマス)にのみ進入できる。
// ・海軍ユニットは水上マス(isWaterなマス。川・海・池・湖)にのみ進入できる。
// ・山脈マス(impassable)には、陸軍・海軍を問わずどのユニットも進入できない。
//
// 【他国の領土への進入】
// ・「関係なし」(diplomacy.js の getRelation が "none")の相手が所有するマスには進入できない。
//   宣戦布告した相手(war)・不可侵条約(pact)・同盟(alliance)の相手の領土になら進入できる。
//   canUnitEnterTile が地形適性(canUnitEnterTerrain)とこの外交関係(canUnitEnterOwnership)の
//   両方をまとめて判定する。個別の理由でエラーメッセージを出し分けたい呼び出し元
//   (commands.js の cmdMoveCombatUnit)は、2つのサブ関数を直接使う。
//
// 【ルール】
// ・攻撃距離は、そのユニットの移動力(movement)と同じ範囲を使う(attackRange を明示的に
//   持たせている場合はそちらを優先。将来、移動力と攻撃距離が異なるユニットを追加したくなった
//   場合のための逃げ道)。
// ・rangedCombatStrength を明示的に持つユニットは常に「遠距離戦闘ユニット」として扱う。
//   明示的に持たないユニットでも、攻撃距離(attackRange)が2より大きいなら遠距離戦闘ユニットと
//   みなしてよい(遠距離/近距離の戦闘力を明示的に分けていない、攻撃距離の長いユニット用の保険)。
// ・遠距離戦闘ユニットは「遠距離戦闘力(rangedCombatStrength)」と「近距離戦闘力
//   (meleeCombatStrength)」の2つの戦闘力を持つ。近距離戦闘ユニットは combatStrength のみを持つ。
// ・先に攻撃した側(attacker)が先制攻撃を行い、防御側(defender)はそれで倒れなければ反撃する。
//   - 先制攻撃で防御側を撃破した場合、反撃は発生しない。
//   - 攻撃側が「防御側の攻撃範囲の外」から攻撃した場合、反撃は発生しない
//     (例: 弓兵の攻撃範囲外から一方的に狙撃した場合など)。
// ・戦闘力の選び方:
//   - 先制攻撃(攻撃側の攻撃力): 攻撃側が遠距離戦闘ユニットなら遠距離戦闘力を、
//     そうでなければ近距離戦闘力(combatStrength)を用いる。
//   - 反撃(防御側が反撃時に用いる攻撃力): 攻守2ユニットが隣接していない(マス距離が2以上)
//     場合は、防御側の遠距離戦闘力を用いる。隣接している(マス距離が1以下、周囲8マス以内)場合は、
//     攻撃側が近距離戦闘ユニットなら防御側の近距離戦闘力を、攻撃側が遠距離戦闘ユニットなら
//     防御側の遠距離戦闘力を用いてよい。
//   - 防御力(ダメージを受ける側の抵抗力): 先制・反撃のどちらでダメージを受ける場合でも、
//     常にそのユニットの近距離戦闘力(combatStrength)を用いる(遠距離戦闘力は
//     「撃つ側」だけが使う攻撃用の値であり、防御には使わない)。
// ・ダメージ = (24〜36のランダム値) × e^(戦闘力の差 × 0.04)。小数点以下は切り捨てる。
// ・HPが0以下になったユニットは破壊される。
// ・ダメージを受けたユニットは戦闘力が下がる。HPが10減るごとに-1(最大-9)のペナルティ。
//   このペナルティは常に「現在のHP」から算出する派生値であり、combatStrength等の基礎値自体は
//   書き換えない。ダメージを受けた直後の反撃にも即座に反映される。
//
// 【包囲ボーナス(flanking)】
// ・攻撃対象(防御側)に隣接する8マスのうち、攻撃側自身のマスを除いて、攻撃側と同じ国家の
//   戦闘ユニットが存在するマスの数(countFlankingAllies)に応じて、攻撃側の先制攻撃力に
//   ボーナスを与える(getFlankingBonus: 1体につき+FLANKING_BONUS_PER_ALLY、最大
//   FLANKING_MAX_ALLIES体分まで)。複数のユニットで敵を取り囲んでから攻撃すると有利になる、
//   という戦術的な選択を後押しする。反撃側の戦闘力には影響しない(包囲は「攻める側」の
//   有利さであり、囲まれている防御側の反撃の強さ自体は変えない)。呼び出し元
//   (commands.js の cmdAttackCombatUnit)が攻撃実行時の盤面から算出し、resolveCombat に渡す。

import { isWaterTerrain, isImpassableTerrain } from "./mapGen.js";
import { canEnterTerritory } from "./diplomacy.js";

const DAMAGE_MIN = 24;
const DAMAGE_MAX = 36;
const DAMAGE_EXPONENT_SCALE = 0.04;
const HP_PER_STRENGTH_PENALTY = 10;
const MAX_STRENGTH_PENALTY = 9;
// attackRangeがこの値より大きいユニットは、明示的な遠距離戦闘力を持っていなくても
// 遠距離戦闘ユニットとみなしてよい(将来追加されるユニットのための保険的な判定)。
const RANGED_UNIT_ATTACK_RANGE_THRESHOLD = 2;
// 包囲ボーナス: 攻撃対象に隣接する自軍ユニット1体につき与える先制攻撃力ボーナス、およびその上限体数。
const FLANKING_BONUS_PER_ALLY = 3;
const FLANKING_MAX_ALLIES = 4;

/** ユニットの攻撃距離を取得する。明示的な attackRange が無ければ移動力(movement)と同じ範囲を使う。 */
export function getAttackRange(unit) {
    return unit?.attackRange ?? unit?.movement ?? 0;
}

/** このユニットが海軍ユニット(domain: "naval")かどうか。 */
export function isNavalUnit(unit) {
    return unit?.domain === "naval";
}

/** このユニットが陸軍ユニットかどうか(domainが未指定の場合も陸軍として扱う)。 */
export function isLandUnit(unit) {
    return !isNavalUnit(unit);
}

/**
 * 指定した戦闘ユニットが、地形の観点だけで指定したタイルへ進入できるかどうかを判定する
 * (所有者・外交関係は見ない。地形適性のみ)。
 * ・山脈マス(impassable)は陸軍・海軍を問わず進入不可。
 * ・陸軍ユニットは水上マス(isWater)に進入不可、海軍ユニットは水上マス以外に進入不可。
 */
export function canUnitEnterTerrain(unit, tile) {
    if (!tile) return false;
    if (isImpassableTerrain(tile.type)) return false;
    const water = isWaterTerrain(tile.type);
    return isNavalUnit(unit) ? water : !water;
}

/**
 * 指定した戦闘ユニットが、このタイルの所有者との外交関係の観点で進入できるかどうかを判定する
 * (地形は見ない)。「関係なし」の相手の領土には入れない(宣戦布告した相手・不可侵条約・
 * 同盟の相手、および無所属マス・自国の領土には入れる)。
 */
export function canUnitEnterOwnership(unit, tile) {
    if (!tile?.ownerId || tile.ownerId === unit?.ownerId) return true;
    return canEnterTerritory(unit?.ownerId, tile.ownerId);
}

/**
 * 指定した戦闘ユニットが、指定したタイルへ進入できるかどうかを総合判定する
 * (地形適性 + 所有者との外交関係の両方を満たす必要がある)。
 */
export function canUnitEnterTile(unit, tile) {
    return canUnitEnterTerrain(unit, tile) && canUnitEnterOwnership(unit, tile);
}

/**
 * このユニットが「遠距離戦闘ユニット」かどうかを判定する。
 * ・rangedCombatStrength を明示的に持つユニットは常に遠距離戦闘ユニット。
 * ・持たない場合でも、攻撃距離(attackRange)が2より大きいなら遠距離戦闘ユニットとみなしてよい。
 */
export function isRangedUnit(unit) {
    if (!unit) return false;
    if (unit.rangedCombatStrength !== undefined) return true;
    return getAttackRange(unit) > RANGED_UNIT_ATTACK_RANGE_THRESHOLD;
}

/** このユニットの近距離戦闘力の基礎値(明示的な meleeCombatStrength が無ければ combatStrength を使う)。 */
function getBaseMeleeStrength(unit) {
    return unit?.meleeCombatStrength ?? unit?.combatStrength ?? 0;
}

/** このユニットの遠距離戦闘力の基礎値(明示的な rangedCombatStrength が無ければ combatStrength を使う)。 */
function getBaseRangedStrength(unit) {
    return unit?.rangedCombatStrength ?? unit?.combatStrength ?? 0;
}

/**
 * ダメージによる戦闘力低下ペナルティを算出する。
 * HPが10減るごとに-1、最大-9まで。
 */
function getStrengthPenalty(unit) {
    const maxHp = unit?.maxHp ?? 100;
    const hp = unit?.hp ?? maxHp;
    const damageTaken = Math.max(0, maxHp - hp);
    return Math.min(MAX_STRENGTH_PENALTY, Math.floor(damageTaken / HP_PER_STRENGTH_PENALTY));
}

/**
 * ダメージによる減少を反映した「現在の近距離戦闘力」を算出する(基礎値は変化させない)。
 * 💡 互換性のため、既存のAPI名 getEffectiveCombatStrength は近距離戦闘力を返す。
 */
export function getEffectiveCombatStrength(unit) {
    return Math.max(0, getBaseMeleeStrength(unit) - getStrengthPenalty(unit));
}

/** ダメージによる減少を反映した「現在の遠距離戦闘力」を算出する(基礎値は変化させない)。 */
export function getEffectiveRangedStrength(unit) {
    return Math.max(0, getBaseRangedStrength(unit) - getStrengthPenalty(unit));
}

/** 2マス間の距離(移動力・攻撃距離と同じ、マス目の最大差)を算出する。 */
export function tileDistance(fromTx, fromTz, toTx, toTz) {
    return Math.max(Math.abs(toTx - fromTx), Math.abs(toTz - fromTz));
}

/**
 * 防御側(defTx, defTz)に隣接する8マスのうち、攻撃側自身のマス(attackerTx, attackerTz)を除いて、
 * attackerOwnerId と同じ国家の戦闘ユニットが存在するマスの数を数える(包囲ボーナスの算出に使う)。
 */
export function countFlankingAllies(defTx, defTz, attackerOwnerId, attackerTx, attackerTz, tiles) {
    let count = 0;
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const tx = defTx + dx;
            const tz = defTz + dz;
            if (tx === attackerTx && tz === attackerTz) continue;
            if (tiles[`${tx},${tz}`]?.combatUnit?.ownerId === attackerOwnerId) count++;
        }
    }
    return count;
}

/** countFlankingAllies() が返した数を、実際の先制攻撃力ボーナスに変換する(上限あり)。 */
export function getFlankingBonus(flankingAllyCount) {
    return Math.min(flankingAllyCount, FLANKING_MAX_ALLIES) * FLANKING_BONUS_PER_ALLY;
}

/**
 * 指定した戦闘ユニットが今攻撃できる、敵の戦闘ユニットが存在するマスの一覧を返す。
 * hasAgreementFn(playerId, otherOwnerId) が true を返した相手のユニットは対象から除外する。
 * 呼び出し元は「戦争状態でない(=攻撃できない)相手」を除外する述語(例:
 * `(a, b) => !isAtWar(a, b)`)を渡す(commands.js の cmdAttackCombatUnit と同じ判定基準)。
 * @returns {{ tx: number, tz: number, tile: any, unit: any }[]}
 */
export function getAttackableTargets(fromTx, fromTz, playerId, unit, tiles, config, hasAgreementFn) {
    const targets = [];
    const range = getAttackRange(unit);
    if (range <= 0 || !config) return targets;

    for (let dz = -range; dz <= range; dz++) {
        for (let dx = -range; dx <= range; dx++) {
            const distance = Math.max(Math.abs(dx), Math.abs(dz));
            if (distance === 0 || distance > range) continue;

            const tx = fromTx + dx;
            const tz = fromTz + dz;
            if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) continue;

            const tile = tiles[`${tx},${tz}`];
            const enemyUnit = tile?.combatUnit;
            if (!enemyUnit || enemyUnit.ownerId === playerId) continue;
            if (hasAgreementFn?.(playerId, enemyUnit.ownerId)) continue;

            targets.push({ tx, tz, tile, unit: enemyUnit });
        }
    }
    return targets;
}

/**
 * 24〜36のランダム基礎ダメージに、戦闘力の差による指数補正をかけて算出する。
 * 💡 小数点以下は切り捨てる。
 */
function rollDamage(attackerStrength, defenderStrength) {
    const base = DAMAGE_MIN + Math.random() * (DAMAGE_MAX - DAMAGE_MIN);
    const diff = (attackerStrength ?? 0) - (defenderStrength ?? 0);
    return Math.floor(base * Math.exp(diff * DAMAGE_EXPONENT_SCALE));
}

/**
 * 先制攻撃時に攻撃側が用いる戦闘力を算出する。
 * 遠距離戦闘ユニットは常に遠距離戦闘力を、近距離戦闘ユニットは近距離戦闘力(combatStrength)を用いる。
 */
function getFirstStrikeStrength(attacker) {
    return isRangedUnit(attacker) ? getEffectiveRangedStrength(attacker) : getEffectiveCombatStrength(attacker);
}

/**
 * 反撃時に、防御側(反撃を行う側)が用いる戦闘力を算出する。
 * ・攻撃側と防御側が隣接していない(マス距離が2以上、周囲8マスの外)場合
 *     → 防御側の遠距離戦闘力を用いる。
 * ・隣接している場合:
 *     - 攻撃側が近距離戦闘ユニットなら → 防御側の近距離戦闘力を用いる。
 *     - 攻撃側が遠距離戦闘ユニットなら → 防御側の遠距離戦闘力を用いてよい。
 */
function getCounterStrength(defender, attacker, distance) {
    const adjacent = distance <= 1;
    if (!adjacent) return getEffectiveRangedStrength(defender);
    return isRangedUnit(attacker) ? getEffectiveRangedStrength(defender) : getEffectiveCombatStrength(defender);
}

/**
 * 攻撃側が先制攻撃を行い、防御側が生き残っていれば反撃する。
 * attacker / defender オブジェクトの hp プロパティを直接更新する。
 * @param {any} attacker 攻撃側の戦闘ユニット (hp, combatStrength / rangedCombatStrength / meleeCombatStrength 等を持つ)
 * @param {any} defender 防御側の戦闘ユニット (hp, combatStrength / rangedCombatStrength / meleeCombatStrength 等を持つ)
 * @param {number} [distance=1] 攻撃側と防御側の間のマス距離(呼び出し元で tileDistance() を使って算出する)。
 *   省略した場合は隣接(1)とみなす。
 * @param {number} [flankingBonus=0] 先制攻撃力に加算する包囲ボーナス(呼び出し元で
 *   countFlankingAllies() + getFlankingBonus() を使って算出する)。反撃側の戦闘力には影響しない。
 * @returns {{
 *   firstDamage: number,
 *   counterDamage: number,
 *   defenderDestroyed: boolean,
 *   attackerDestroyed: boolean,
 *   counterSkippedReason: "defenderDestroyed" | "outOfDefenderRange" | null
 * }}
 */
export function resolveCombat(attacker, defender, distance = 1, flankingBonus = 0) {
    // 1. 先制攻撃(攻撃側 → 防御側)。
    //    攻撃側の攻撃力は先制攻撃のルールに従って選択し、防御側の抵抗力は常に近距離戦闘力を用いる。
    const firstStrikeStrength = getFirstStrikeStrength(attacker) + flankingBonus;
    const firstDamage = rollDamage(firstStrikeStrength, getEffectiveCombatStrength(defender));
    defender.hp = (defender.hp ?? 0) - firstDamage;
    const defenderDestroyed = defender.hp <= 0;

    let counterDamage = 0;
    let attackerDestroyed = false;
    let counterSkippedReason = null;

    if (defenderDestroyed) {
        // 先制攻撃で防御側を撃破した場合、反撃は発生しない。
        counterSkippedReason = "defenderDestroyed";
    } else if (distance > getAttackRange(defender)) {
        // 攻撃側が「防御側の攻撃範囲の外」から攻撃した場合、反撃は発生しない。
        counterSkippedReason = "outOfDefenderRange";
    } else {
        // 2. 反撃(防御側 → 攻撃側)。
        //    防御側は今受けたばかりのダメージによる戦闘力低下(HP10減少ごとに-1)が反撃にも反映される。
        const counterStrength = getCounterStrength(defender, attacker, distance);
        counterDamage = rollDamage(counterStrength, getEffectiveCombatStrength(attacker));
        attacker.hp = (attacker.hp ?? 0) - counterDamage;
        attackerDestroyed = attacker.hp <= 0;
    }

    return { firstDamage, counterDamage, defenderDestroyed, attackerDestroyed, counterSkippedReason };
}
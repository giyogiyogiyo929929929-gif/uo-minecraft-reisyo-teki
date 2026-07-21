// combat.js
// 戦闘ユニット同士の戦闘（攻撃距離の判定・ダメージ計算）を管理するモジュール。
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

const DAMAGE_MIN = 24;
const DAMAGE_MAX = 36;
const DAMAGE_EXPONENT_SCALE = 0.04;
const HP_PER_STRENGTH_PENALTY = 10;
const MAX_STRENGTH_PENALTY = 9;
// attackRangeがこの値より大きいユニットは、明示的な遠距離戦闘力を持っていなくても
// 遠距離戦闘ユニットとみなしてよい(将来追加されるユニットのための保険的な判定)。
const RANGED_UNIT_ATTACK_RANGE_THRESHOLD = 2;

/** ユニットの攻撃距離を取得する。明示的な attackRange が無ければ移動力(movement)と同じ範囲を使う。 */
export function getAttackRange(unit) {
    return unit?.attackRange ?? unit?.movement ?? 0;
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
 * 指定した戦闘ユニットが今攻撃できる、敵の戦闘ユニットが存在するマスの一覧を返す。
 * 外交協定(不可侵条約・同盟)を結んでいる相手のユニットは対象に含めない。
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
 * @returns {{
 *   firstDamage: number,
 *   counterDamage: number,
 *   defenderDestroyed: boolean,
 *   attackerDestroyed: boolean,
 *   counterSkippedReason: "defenderDestroyed" | "outOfDefenderRange" | null
 * }}
 */
export function resolveCombat(attacker, defender, distance = 1) {
    // 1. 先制攻撃(攻撃側 → 防御側)。
    //    攻撃側の攻撃力は先制攻撃のルールに従って選択し、防御側の抵抗力は常に近距離戦闘力を用いる。
    const firstStrikeStrength = getFirstStrikeStrength(attacker);
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
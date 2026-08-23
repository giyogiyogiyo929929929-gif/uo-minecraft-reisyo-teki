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
// 【移動経路の検証(飛び越え禁止)】
// ・移動力2以上のユニット(軍艦など)が、最終着地マスだけを見て「入れるかどうか」を
//   判定すると、間に挟まる陸地(海軍ユニットの場合)や他国の「関係なし」領土、他ユニットを
//   飛び越えて移動できてしまう(bots.js の Bot だけでなく commands.js の cmdMoveCombatUnit
//   経由でプレイヤーの手動移動も同様)。canTravelPath が、8方向の直進(縦・横・斜め)上の
//   通過点をすべて検証し、途中に障害物があれば経路自体を不可とする(直進で説明できない
//   移動(dx・dzの絶対値が一致しない斜め以外の移動)もそもそも経路が定義できないため不可)。
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
//
// 【兵種(unitClass)とクラス相性ボーナス】
// 陸軍ユニットは production.js の定義・配置される個体データの両方に unitClass
// ("melee"/"antiCavalry"/"cavalry"/"ranged"/"siege"。海軍は"naval")を持つ。
// UNIT_CLASS_COUNTERS に「このクラスは、あのクラス相手なら戦闘力+n」という relationship を
// 定義しておくと、getClassMatchupBonus() がそれを見て自動的にボーナスを算出する
// (例: 対騎兵(spearman)は騎兵(horseman)相手に+10)。このボーナスは「攻撃側/防御側」ではなく
// 「そのユニット自身の戦闘力」に乗るため、対騎兵ユニットが騎兵を攻撃する場合も、逆に騎兵に
// 攻撃された場合(防御・反撃のいずれも)も等しく効く。resolveCombat/canGuaranteeKill の
// 両方に組み込まれており、新しい relationship を UNIT_CLASS_COUNTERS に追加するだけで
// 反映側のコードは変更不要(adjacency.js の隣接ボーナスと同じ設計思想)。

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

// 【都市(都心)の耐久力・防壁】
// 都市自身のマス("都心")は、通常の戦闘ユニットとは別に独自のHP・戦闘力を持つ防衛拠点として
// 機能する(§13参照)。都心のHPが0を超えている間、敵(自国でも同盟・不可侵条約の相手でもない)
// ユニットはそのマスへ進入できない(canUnitEnterCityTile)。
export const CITY_MAX_HP = 200;
export const CITY_HP_REGEN_PER_TURN = 30;
// 都市戦闘力 = 自国最強の近接系ユニットの戦闘力 - このペナルティ、または都市に駐留中の
// ユニットの実効戦闘力、のどちらか大きい方(getCityCombatStrength)。
export const CITY_COMBAT_STRENGTH_PENALTY = 10;
// 防壁が無ければ都市は遠距離攻撃できない。防壁完成後の遠距離攻撃の射程。
export const CITY_RANGED_ATTACK_RANGE = 3;
export const WALL_MAX_HP = 100;
// 💡 防壁があるときの被ダメージ倍率。攻城(siege)ユニットだけは防壁の軽減効果をすり抜ける
//    (Civilization VIの「攻城兵器は城壁の防御を無視する」という考え方を踏襲)。
const WALL_DAMAGE_MULTIPLIERS = { melee: 0.15, antiCavalry: 0.15, cavalry: 0.15, ranged: 0.5, siege: 1 };
// 💡 「近接ユニット」として扱う兵種の集合。都市戦闘力の算出基準(近接系ユニットの中で最強)・
//    都市への反撃の可否(近接系からの攻撃にのみ都市は反撃する)・防壁の被ダメージ倍率の
//    いずれもこの集合を基準にする。
const MELEE_LIKE_CLASSES = new Set(["melee", "antiCavalry", "cavalry"]);

/** unitClass が近接系(melee/antiCavalry/cavalry)かどうか。 */
export function isMeleeUnitClass(unitClass) {
    return MELEE_LIKE_CLASSES.has(unitClass);
}

/** 兵種(unitClass)の表示名。UIやHUDでの表示に使う(未分類のユニットは呼び出し元でフォールバックする)。 */
export const UNIT_CLASS_LABELS = {
    melee: "近接",
    antiCavalry: "対騎兵",
    cavalry: "騎兵",
    ranged: "遠隔",
    siege: "攻城",
    naval: "海軍",
};

/** 兵種の表示名を取得する(未知の値ならそのまま返す)。 */
export function getUnitClassLabel(unitClass) {
    return UNIT_CLASS_LABELS[unitClass] ?? unitClass ?? "不明";
}

// 💡 「このクラスは、あのクラス相手なら戦闘力+n」という一方向の relationship の一覧。
//    対騎兵(スピアマン系)は騎兵の機動力を封じる専門兵科という位置づけで、騎兵と戦う間
//    (攻撃・防御・反撃のいずれでも)+10される。近接ユニットは、対騎兵ユニットの得意分野
//    (騎兵封じ)の裏を返す形で+5される(騎兵ほどではないが、対騎兵は近接戦での取り回しに
//    やや劣るという位置づけ)。新しい relationship を1行足すだけで、
//    resolveCombat/canGuaranteeKillの両方に自動的に反映される。
const UNIT_CLASS_COUNTERS = [
    { attackerClass: "antiCavalry", targetClass: "cavalry", bonus: 10 },
    { attackerClass: "melee", targetClass: "antiCavalry", bonus: 5 },
];

/**
 * unit(の兵種)が opponent(の兵種)を相手にしているとき受け取る戦闘力ボーナスを算出する。
 * 複数の relationship に一致する場合は合算する(現状は1つしか無いが、将来の拡張に備える)。
 */
export function getClassMatchupBonus(unit, opponent) {
    if (!unit?.unitClass || !opponent?.unitClass) return 0;
    let bonus = 0;
    for (const rule of UNIT_CLASS_COUNTERS) {
        if (rule.attackerClass === unit.unitClass && rule.targetClass === opponent.unitClass) bonus += rule.bonus;
    }
    return bonus;
}

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
 * 指定したタイルが他国の都市(都心)で、かつそのHPがまだ0を超えている場合、そのユニットは
 * 進入できない(都心はHPを0にしない限り突破できない防衛拠点として機能する。§13参照)。
 * 自国の都市には常に進入できる。
 */
export function canUnitEnterCityTile(unit, tile) {
    if (!tile?.city || tile.ownerId === unit?.ownerId) return true;
    return (tile.city.hp ?? CITY_MAX_HP) <= 0;
}

/**
 * 指定した戦闘ユニットが、指定したタイルへ進入できるかどうかを総合判定する
 * (地形適性 + 所有者との外交関係 + 都心のHPの3つすべてを満たす必要がある)。
 */
export function canUnitEnterTile(unit, tile) {
    return canUnitEnterTerrain(unit, tile) && canUnitEnterOwnership(unit, tile) && canUnitEnterCityTile(unit, tile);
}

/**
 * fromTx,fromTz から toTx,toTz までの移動経路が、このユニットにとって進入可能かどうかを
 * 判定する(最終着地マス自体の判定は呼び出し元が別途行う想定。ここでは主に「間に挟まる
 * 通過点」を検証する)。
 * ・移動は8方向の直進(縦・横・斜め)のみを想定しており、直進で説明できない移動
 *   (dx・dzの絶対値が一致せず、どちらも0でもない)は経路が定義できないため不可とする。
 * ・通過点(距離1〜distance-1のマス。最終マスは含まない)は、地形・外交関係・他ユニットの
 *   占有の観点ですべて進入可能である必要がある。
 * 移動力2以上のユニット(軍艦など)が、間に挟まる陸地(海軍ユニットの場合)や他国の
 * 「関係なし」領土、他ユニットを飛び越えて移動してしまうのを防ぐための経路検証。
 */
export function canTravelPath(unit, fromTx, fromTz, toTx, toTz, tiles) {
    const dx = toTx - fromTx;
    const dz = toTz - fromTz;
    const distance = Math.max(Math.abs(dx), Math.abs(dz));
    if (distance <= 1) return true;
    if (dx !== 0 && dz !== 0 && Math.abs(dx) !== Math.abs(dz)) return false;

    const stepX = Math.sign(dx);
    const stepZ = Math.sign(dz);
    for (let step = 1; step < distance; step++) {
        const t = tiles[`${fromTx + stepX * step},${fromTz + stepZ * step}`];
        if (!t || t.combatUnit || !canUnitEnterTile(unit, t)) return false;
    }
    return true;
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
 * attacker が defender を今すぐ攻撃した場合、先制攻撃だけで確実に(=ダメージロールが
 * 最低値(DAMAGE_MIN)であっても)撃破できるかどうかを見積もる。実際のダメージは
 * 24〜36のランダム値を使うため、最低値で判定することで「確実に倒せる」場合のみ
 * true を返す安全側の見積もりになる(実際には最低値以上のダメージが出ることが多いため、
 * この判定が false でも運良く倒せることはあるが、逆にtrueなのに倒せないことは無い)。
 * 複数の攻撃対象から確実に仕留められる相手を優先する(pickBestAttackTarget)ために使う。
 * クラス相性ボーナス(getClassMatchupBonus。例: 対騎兵が騎兵を攻撃する場合)も加味する。
 */
export function canGuaranteeKill(attacker, defender, flankingBonus = 0) {
    const attackerStrength = getFirstStrikeStrength(attacker) + getClassMatchupBonus(attacker, defender) + flankingBonus;
    const defenderStrength = getEffectiveCombatStrength(defender) + getClassMatchupBonus(defender, attacker);
    const diff = attackerStrength - defenderStrength;
    const minDamage = Math.floor(DAMAGE_MIN * Math.exp(diff * DAMAGE_EXPONENT_SCALE));
    const hp = defender?.hp ?? defender?.maxHp ?? 0;
    return hp <= minDamage;
}

/**
 * 指定した戦闘ユニットが今攻撃できる、敵の戦闘ユニットが存在するマスの一覧を返す。
 * hasAgreementFn(playerId, otherOwnerId) が true を返した相手のユニットは対象から除外する。
 * 呼び出し元は「戦争状態でない(=攻撃できない)相手」を除外する述語(例:
 * `(a, b) => !isAtWar(a, b)`)を渡す(commands.js の cmdAttackCombatUnit と同じ判定基準)。
 * 💡 都市のマスに駐留するユニットは対象に含めない。都市自身が防衛の主体になる(§13)ため、
 *    直接の攻撃対象は都市そのもの(getAttackableCityTargets)になる。
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
            if (tile?.city) continue;
            const enemyUnit = tile?.combatUnit;
            if (!enemyUnit || enemyUnit.ownerId === playerId) continue;
            if (hasAgreementFn?.(playerId, enemyUnit.ownerId)) continue;

            targets.push({ tx, tz, tile, unit: enemyUnit });
        }
    }
    return targets;
}

/**
 * 指定した戦闘ユニットが今攻撃できる、敵の都市(都心)が存在するマスの一覧を返す。
 * 駐留ユニットの有無に関わらず都市自体を対象として返す(getAttackableTargetsと同じ
 * hasAgreementFnの使い方)。
 * @returns {{ tx: number, tz: number, tile: any, city: any }[]}
 */
export function getAttackableCityTargets(fromTx, fromTz, playerId, unit, tiles, config, hasAgreementFn) {
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
            if (!tile?.city || !tile.ownerId || tile.ownerId === playerId) continue;
            if (hasAgreementFn?.(playerId, tile.ownerId)) continue;

            targets.push({ tx, tz, tile, city: tile.city });
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
    // 💡 クラス相性ボーナス(getClassMatchupBonus。例: 対騎兵は騎兵相手に+10)は、攻撃側/防御側の
    //    役割ではなく「そのユニット自身の戦闘力」に乗る。そのため、攻撃側は先制攻撃(offense)にも
    //    反撃を受ける際の抵抗力(defense)にも同じattackerBonusが、防御側は抵抗力(defense)にも
    //    反撃時の攻撃力(offense)にも同じdefenderBonusが、一貫して加算される。
    const attackerBonus = getClassMatchupBonus(attacker, defender);
    const defenderBonus = getClassMatchupBonus(defender, attacker);

    // 1. 先制攻撃(攻撃側 → 防御側)。
    //    攻撃側の攻撃力は先制攻撃のルールに従って選択し、防御側の抵抗力は常に近距離戦闘力を用いる。
    const firstStrikeStrength = getFirstStrikeStrength(attacker) + attackerBonus + flankingBonus;
    const firstDamage = rollDamage(firstStrikeStrength, getEffectiveCombatStrength(defender) + defenderBonus);
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
        const counterStrength = getCounterStrength(defender, attacker, distance) + defenderBonus;
        counterDamage = rollDamage(counterStrength, getEffectiveCombatStrength(attacker) + attackerBonus);
        attacker.hp = (attacker.hp ?? 0) - counterDamage;
        attackerDestroyed = attacker.hp <= 0;
    }

    return { firstDamage, counterDamage, defenderDestroyed, attackerDestroyed, counterSkippedReason };
}

// 【都市(都心)の攻防】
// 都市自身のマスを直接攻撃できるようにする一連の関数。§13/README参照。

/** civId が保有する近接系(melee/antiCavalry/cavalry)ユニット(海軍除く)の中で最も高い戦闘力(基礎値)。無ければ0。 */
export function getBestMeleeCombatStrength(civId, tiles) {
    let best = 0;
    for (const key in tiles) {
        const unit = tiles[key].combatUnit;
        if (unit?.ownerId !== civId || unit.domain === "naval") continue;
        if (!isMeleeUnitClass(unit.unitClass)) continue;
        best = Math.max(best, unit.combatStrength ?? 0);
    }
    return best;
}

/** civId が保有する遠距離系ユニット(海軍除く)の中で最も高い遠距離戦闘力(基礎値)。無ければ0。 */
export function getBestRangedCombatStrength(civId, tiles) {
    let best = 0;
    for (const key in tiles) {
        const unit = tiles[key].combatUnit;
        if (unit?.ownerId !== civId || unit.domain === "naval") continue;
        if (!isRangedUnit(unit)) continue;
        best = Math.max(best, unit.rangedCombatStrength ?? unit.combatStrength ?? 0);
    }
    return best;
}

/**
 * 都市戦闘力(近接ユニットに攻撃された際、都市が反撃・抵抗に用いる戦闘力)を算出する。
 * = max(自国最強の近接系ユニットの戦闘力 - CITY_COMBAT_STRENGTH_PENALTY, 駐留ユニットの実効戦闘力)
 * 駐留ユニットは「今そのマスに実在する個体」なのでHPによる低下(getEffectiveCombatStrength)を
 * 反映するが、国内最強ユニットの項は「自国の軍事力の目安」という位置づけのため基礎値を使う。
 * @param {string} civId 都市の所有国家ID
 * @param {any} tiles 全タイルデータ
 * @param {any} [garrisonUnit] 都市のマスに駐留中の戦闘ユニット(いなければ省略可)
 */
export function getCityCombatStrength(civId, tiles, garrisonUnit) {
    const nationalBaseline = Math.max(0, getBestMeleeCombatStrength(civId, tiles) - CITY_COMBAT_STRENGTH_PENALTY);
    const garrisonStrength = garrisonUnit ? getEffectiveCombatStrength(garrisonUnit) : 0;
    return Math.max(nationalBaseline, garrisonStrength);
}

/** 防壁があるときの被ダメージ倍率を、攻撃側の兵種から算出する(未分類は軽減なし=1倍、安全側)。 */
export function getWallDamageMultiplier(unitClass) {
    return WALL_DAMAGE_MULTIPLIERS[unitClass] ?? 1;
}

/**
 * 戦闘ユニットが都市(都心)を攻撃した場合のダメージ処理。resolveCombatと似ているが、
 * 防御側が「都市」であるため、戦闘力の算出方法・防壁による軽減・反撃の有無が異なる:
 * ・攻撃側の攻撃力は通常どおり近接/遠距離を自動選択する(getFirstStrikeStrength)。
 *   都市側にはクラス相性ボーナス(対騎兵など)は適用されない(ユニット同士の相性であり、
 *   都市はどのクラスにも属さないため)。
 * ・防壁(city.wall)があれば、算出したダメージに攻撃側の兵種に応じた倍率
 *   (getWallDamageMultiplier。近接系15%/遠隔50%/攻城100%)をかけてから適用し、
 *   まず防壁の残りHP(city.wallHp)を削り、削りきれなかった分だけ都心のHP(city.hp)を削る。
 *   防壁が無ければ倍率をかけず、ダメージはそのまま都心のHPに直接入る。
 * ・都市が反撃するのは近接系(melee/antiCavalry/cavalry)ユニットから攻撃された場合のみ
 *   (遠距離・攻城ユニットからの一方的な攻撃には反撃しない。都市が既に撃破された場合も反撃なし)。
 * city オブジェクトの hp/wallHp/attackedRecently を直接更新する。
 * @param {any} attacker 攻撃側の戦闘ユニット
 * @param {any} city 対象都市のデータ(tile.city)
 * @param {number} cityCombatStrength getCityCombatStrength() で算出した都市の戦闘力
 * @returns {{
 *   damage: number, wallDamage: number, hpDamage: number, cityDestroyed: boolean,
 *   counterDamage: number, attackerDestroyed: boolean,
 *   counterSkippedReason: "cityDestroyed" | "notMelee" | null
 * }}
 */
export function resolveCityAttack(attacker, city, cityCombatStrength) {
    const attackerStrength = getFirstStrikeStrength(attacker);
    const rawDamage = rollDamage(attackerStrength, cityCombatStrength);

    const hasWall = !!city.wall;
    const multiplier = hasWall ? getWallDamageMultiplier(attacker?.unitClass) : 1;
    const damage = Math.max(0, Math.floor(rawDamage * multiplier));

    const wallHpBefore = hasWall ? (city.wallHp ?? WALL_MAX_HP) : 0;
    const wallDamage = Math.min(damage, wallHpBefore);
    const hpDamage = damage - wallDamage;

    if (hasWall) city.wallHp = wallHpBefore - wallDamage;
    city.hp = (city.hp ?? CITY_MAX_HP) - hpDamage;
    // 💡 修理(cmdRepairWall)・回復判定の両方が参照する「最近攻撃を受けた」フラグ。
    //    都市所有者の次の手番開始時(processPlayerTurnStart)にリセットされる。
    city.attackedRecently = true;
    const cityDestroyed = city.hp <= 0;

    let counterDamage = 0;
    let attackerDestroyed = false;
    let counterSkippedReason = null;

    if (cityDestroyed) {
        counterSkippedReason = "cityDestroyed";
    } else if (!isMeleeUnitClass(attacker?.unitClass)) {
        counterSkippedReason = "notMelee";
    } else {
        counterDamage = rollDamage(cityCombatStrength, getEffectiveCombatStrength(attacker));
        attacker.hp = (attacker.hp ?? 0) - counterDamage;
        attackerDestroyed = attacker.hp <= 0;
    }

    return { damage, wallDamage, hpDamage, cityDestroyed, counterDamage, attackerDestroyed, counterSkippedReason };
}

/**
 * 防壁を持つ都市が、遠距離攻撃で敵ユニットを攻撃した場合のダメージを算出する(反撃なし。
 * 都市は動けないため、防御側の攻撃範囲を問わず一方的に攻撃が成立する)。
 * defender オブジェクトの hp を直接更新する。
 * @param {number} cityRangedStrength getBestRangedCombatStrength() で算出した都市の遠距離戦闘力
 * @param {any} defender 攻撃対象の戦闘ユニット
 */
export function resolveCityRangedAttack(cityRangedStrength, defender) {
    const damage = rollDamage(cityRangedStrength, getEffectiveCombatStrength(defender));
    defender.hp = (defender.hp ?? 0) - damage;
    return { damage, defenderDestroyed: defender.hp <= 0 };
}
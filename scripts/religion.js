// religion.js
// ⛪ 宗教システム。
//
// 【全体の流れ】
// 1. 聖地(district)を建設 → 社(district building)を建てると、伝道者を信仰力で購入可能になる。
// 2. 国家全体(全都市合計)の信仰力が100に達し、かつ聖地を1つ以上持っていれば、宗教を創始できる
//    (!civ foundreligion)。1国家につき宗教は1つまで。100信仰力は消費されない(閾値の確認のみ)。
// 3. 聖地のある都市は、自国が宗教を創始していれば、毎ターン自国の宗教の宗教的圧力を+100する。
// 4. 伝道者は隣接する都市に布教でき、布教力を1消費して宗教的圧力を加える。
// 5. 都市の人口 × (その宗教の圧力 / 都市の累積圧力) が、その宗教の信仰者数。
//    信仰者数が人口の過半数を超えた宗教が、その都市の主流宗教になる。
// 6. 国家の過半数の都市が同じ宗教を主流としていれば、それが国家の主流宗教になる。
// 7. 生存している全ての国家の主流宗教が自国の宗教になれば、宗教勝利(turns.jsから判定・付与)。
//
// 【宗教の識別】
// 1国家につき宗教は1つまでなので、宗教IDはそれを創始した国家のID(civId)をそのまま使う。

import { isSacredSiteTile } from "./districts.js";

const RELIGION_FOUND_THRESHOLD = 100; // 国家全体の信仰力合計がこの値に達すると宗教を創始できる
const SACRED_SITE_PRESSURE_PER_TURN = 100; // 聖地のある都市が、自国の宗教に毎ターン与える宗教的圧力
// 💡 宗教ユニットは1回購入するごとに、次回以降の購入コストが(ユニット種別を問わず全体で)
//    この値だけ上昇する(国家ごとに civ:religiousUnitPurchaseCount で回数を記録する)。
const RELIGIOUS_UNIT_COST_STEP = 30;
// 💡 審問官の「都市の領地内で弾圧」の効果量: 対象都市の、自国以外の宗教の圧力を一律この割合だけ減らす。
const SUPPRESSION_REDUCTION_RATIO = 0.8;
// 💡 宗教ユニット同士の攻撃(使徒・審問官のみ、反撃なしの一方的な攻撃)のダメージ式は、
//    combat.js の通常戦闘と同じ「24〜36のランダム値 × e^(戦闘力の差 × 0.04)」を踏襲する。
const RELIGIOUS_DAMAGE_MIN = 24;
const RELIGIOUS_DAMAGE_MAX = 36;
const RELIGIOUS_DAMAGE_EXPONENT_SCALE = 0.04;
// 💡 宗教ユニットが撃破されたとき、勝者の宗教の圧力+1000・敗者の宗教の圧力-1000を与える都市の
//    「圧力スイング」量。あまりに大きいためこの1回で都市の主流宗教が入れ替わることもある
//    (=宗教ユニット同士の決着が持つ意味を大きくする狙いの数値)。
const RELIGIOUS_KILL_PRESSURE_SHIFT = 1000;

const RANDOM_RELIGION_NAMES = [
    "太陽の教え", "大地の信仰", "星辰教", "森羅の道", "光明教団",
    "静寂の教え", "潮流信仰", "灰燼の教え", "黎明教", "深緑の信仰",
    "キリスト教", "イスラム教", "仏教", "フラットアーサー"
];

function pickRandomReligionName() {
    return RANDOM_RELIGION_NAMES[Math.floor(Math.random() * RANDOM_RELIGION_NAMES.length)];
}

/**
 * 宗教ユニットの定義(信仰力で購入する、戦闘ユニットとは別レイヤーのユニット)。
 * @typedef {Object} ReligiousUnitDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {number} cost 基本の購入コスト(信仰力)。実際の購入コストは購入回数に応じて
 *   RELIGIOUS_UNIT_COST_STEP ずつ上昇する(getReligiousUnitCost参照)。
 * @property {number} hp / maxHp
 * @property {number} religiousCombatStrength 宗教戦闘力(布教時の圧力・宗教ユニット同士の攻撃の両方に使う)
 * @property {number} movement 移動力
 * @property {number} evangelismPower 布教力(布教/弾圧1回につき1消費。0になると消滅する)
 * @property {string} [requiresBuilding] 購入に必要な、都市が持つ建造物のフラグ名(例: "shrine")
 * @property {boolean} [requiresInquisitionStarted] trueの場合、その国家が審問を開始済み
 *   (hasStartedInquisition)でなければ購入できない
 * @property {boolean} [canProselytize] false を明示すると布教できない(未指定は布教可能扱い)
 * @property {boolean} [canAttack] trueの場合、隣接する敵の宗教ユニットを攻撃できる(反撃なし)
 * @property {boolean} [canStartInquisition] trueの場合、布教力が満タン(未使用)なら審問を開始できる。
 *   開始すると、その国家は以後ずっと審問済み扱いになり(1度でよい)、このユニット自身は消滅する。
 * @property {boolean} [canSuppress] trueの場合、都市の領地内で布教力を1消費し、自国以外の宗教の
 *   圧力を一律SUPPRESSION_REDUCTION_RATIOだけ削減できる(弾圧)。
 * @property {number} [homeTerritoryCombatBonus] 自国の領有マスに立っているときだけ、宗教ユニット
 *   同士の攻撃/被攻撃(religiousCombatStrength)に加算されるボーナス
 */
export const RELIGIOUS_UNIT_DEFS = {
    missionary: {
        label: "伝道者",
        icon: "[Missionary]",
        cost: 150,
        hp: 100,
        maxHp: 100,
        religiousCombatStrength: 100,
        movement: 4,
        evangelismPower: 3,
        requiresBuilding: "shrine",
    },
    apostle: {
        label: "使徒",
        icon: "[Apostle]",
        cost: 150,
        hp: 100,
        maxHp: 100,
        religiousCombatStrength: 110,
        movement: 5,
        evangelismPower: 4,
        requiresBuilding: "cathedral",
        canAttack: true,
        // 💡 審問の開始: 布教力が満タン(=一度も布教していない)使徒のみが行える一度きりの
        //    特殊能力。開始すると国家全体が以後ずっと審問済み扱いになり、審問官を購入できる
        //    ようになる(cmdStartInquisition参照)。この使徒自身は使命を終えて消滅する。
        canStartInquisition: true,
    },
    inquisitor: {
        label: "審問官",
        icon: "[Inquisitor]",
        cost: 130,
        hp: 100,
        maxHp: 100,
        religiousCombatStrength: 130,
        movement: 4,
        evangelismPower: 3,
        requiresInquisitionStarted: true,
        canProselytize: false,
        canAttack: true,
        canSuppress: true,
        homeTerritoryCombatBonus: 10,
    },
};

export function getReligiousUnitDef(id) {
    return RELIGIOUS_UNIT_DEFS[id] ?? null;
}

export function getReligiousUnitIds() {
    return Object.keys(RELIGIOUS_UNIT_DEFS);
}

/** この国家が宗教を創始済みかどうかを判定する。 */
export function hasFoundedReligion(civHandle) {
    return civHandle?.getDynamicProperty("civ:religionFounded") === true;
}

/** この国家の宗教名を取得する(未創始ならnull)。 */
export function getReligionName(civHandle) {
    if (!hasFoundedReligion(civHandle)) return null;
    return civHandle.getDynamicProperty("civ:religionName") ?? "無名の宗教";
}

/** 宗教名を変更する(創始済みの場合のみ)。 */
export function setReligionName(civHandle, name) {
    if (!hasFoundedReligion(civHandle)) return { ok: false, message: "§cまだ宗教を創始していません。" };
    const trimmed = (name ?? "").trim();
    if (!trimmed) return { ok: false, message: "§c名前を入力してください。" };
    if (trimmed.length > 20) return { ok: false, message: "§c名前は20文字以内にしてください。" };
    civHandle.setDynamicProperty("civ:religionName", trimmed);
    return { ok: true, message: `§a宗教の名前を【${trimmed}】に変更しました。` };
}

/** 国家全体(全都市合計)の信仰力を合計する。playerCitiesは [{key, tile}] 形式。 */
export function getTotalCivFaith(playerCities) {
    let total = 0;
    for (const c of playerCities) total += c.tile.city.faithStorage ?? 0;
    return total;
}

/**
 * 宗教創始が可能かどうかを判定する。
 * ・既に創始済みでないこと。
 * ・少なくとも1つの都市の帰属マスに聖地(district: sacredSite)を持っていること。
 * ・国家全体の信仰力が閾値(100)に達していること(消費はされない)。
 */
export function canFoundReligion(civHandle, civId, playerCities, tiles) {
    if (hasFoundedReligion(civHandle)) return { ok: false, message: "§c既に宗教を創始しています。" };

    const hasSacredSite = Object.values(tiles).some(t => isSacredSiteTile(t, civId));
    if (!hasSacredSite) return { ok: false, message: "§c宗教を創始するには聖地が必要です。" };

    const totalFaith = getTotalCivFaith(playerCities);
    if (totalFaith < RELIGION_FOUND_THRESHOLD) {
        return { ok: false, message: `§c宗教の創始には国家全体で信仰力${RELIGION_FOUND_THRESHOLD}が必要です。(現在: ${Math.floor(totalFaith)})` };
    }
    return { ok: true };
}

/** 宗教を創始する。ランダムな名前が付けられる(後で変更可能)。 */
export function foundReligion(civHandle) {
    civHandle.setDynamicProperty("civ:religionFounded", true);
    const name = pickRandomReligionName();
    civHandle.setDynamicProperty("civ:religionName", name);
    return { name };
}

/** 都市の宗教的圧力に加算する。 */
export function addReligiousPressure(city, religionCivId, amount) {
    if (!religionCivId || !(amount > 0)) return;
    if (!city.religiousPressure) city.religiousPressure = {};
    city.religiousPressure[religionCivId] = (city.religiousPressure[religionCivId] ?? 0) + amount;
}

/** 聖地のある都市が、自国の宗教(religionCivId)に毎ターン与える宗教的圧力(+100)を加算する。 */
export function applySacredSitePressure(city, religionCivId) {
    addReligiousPressure(city, religionCivId, SACRED_SITE_PRESSURE_PER_TURN);
}

/**
 * 都市の各宗教の信仰者数を算出する(人口 × 圧力比)。
 * @returns {{ [civId: string]: number }}
 */
export function getCityFollowers(city) {
    const pressures = city.religiousPressure ?? {};
    const total = Object.values(pressures).reduce((sum, v) => sum + v, 0);
    const population = city.population ?? 0;
    const followers = {};
    if (total <= 0) return followers;
    for (const civId in pressures) {
        followers[civId] = population * (pressures[civId] / total);
    }
    return followers;
}

/** 都市の主流宗教(信仰者数が人口の過半数を超える宗教のID=国家ID)を判定する。無ければnull。 */
export function getCityDominantReligion(city) {
    const followers = getCityFollowers(city);
    const population = city.population ?? 0;
    for (const civId in followers) {
        if (followers[civId] > population / 2) return civId;
    }
    return null;
}

/**
 * 国家の主流宗教(過半数の都市が同じ宗教を主流としていれば、その宗教)を判定する。
 * @param {any[]} playerCities この国家が持つ都市一覧([{key, tile}]形式)
 * @returns {string|null} 主流宗教のID(=それを創始した国家のID)。無ければnull
 */
export function getNationalDominantReligion(playerCities) {
    if (playerCities.length === 0) return null;
    const counts = {};
    for (const c of playerCities) {
        const dominant = getCityDominantReligion(c.tile.city);
        if (dominant) counts[dominant] = (counts[dominant] ?? 0) + 1;
    }
    for (const civId in counts) {
        if (counts[civId] > playerCities.length / 2) return civId;
    }
    return null;
}

/**
 * 伝道者が布教する際、都市に与える宗教的圧力を算出する。
 * = 自分の宗教戦闘力 + (自分の宗教戦闘力 × 自分の残りHP%)
 */
export function calculateProselytizePressure(unit) {
    const strength = unit.religiousCombatStrength ?? 0;
    const hpPercent = Math.max(0, Math.min(1, (unit.hp ?? 0) / (unit.maxHp ?? 100)));
    return strength + strength * hpPercent;
}

/** この国家が今まで宗教ユニットを購入した回数を取得する(コストの上昇量の算出に使う)。 */
export function getReligiousUnitPurchaseCount(civHandle) {
    return civHandle?.getDynamicProperty("civ:religiousUnitPurchaseCount") ?? 0;
}

/**
 * 宗教ユニットの実際の購入コストを算出する。ユニット種別を問わず、この国家が宗教ユニットを
 * 1回購入するたびに、次回以降の(どの種別の)購入コストもRELIGIOUS_UNIT_COST_STEPずつ上昇する。
 */
export function getReligiousUnitCost(civHandle, def) {
    return (def?.cost ?? 0) + getReligiousUnitPurchaseCount(civHandle) * RELIGIOUS_UNIT_COST_STEP;
}

/** 宗教ユニットの購入完了時に呼び、次回以降のコストへ+RELIGIOUS_UNIT_COST_STEPを反映させる。 */
export function incrementReligiousUnitPurchaseCount(civHandle) {
    civHandle.setDynamicProperty("civ:religiousUnitPurchaseCount", getReligiousUnitPurchaseCount(civHandle) + 1);
}

/** この国家が審問(inquisition)を開始済みかどうかを判定する。 */
export function hasStartedInquisition(civHandle) {
    return civHandle?.getDynamicProperty("civ:inquisitionStarted") === true;
}

/** 審問を開始する。一度開始すれば、以後この国家はずっと審問済み扱いになる(再開始は不要)。 */
export function startInquisition(civHandle) {
    civHandle.setDynamicProperty("civ:inquisitionStarted", true);
}

/** 新しいゲーム開始時に呼び、この国家の宗教関連の永続状態(創始・名前・購入回数・審問)を初期化する。 */
export function resetReligion(civHandle) {
    civHandle.setDynamicProperty("civ:religionFounded", false);
    civHandle.setDynamicProperty("civ:religionName", undefined);
    civHandle.setDynamicProperty("civ:religiousUnitPurchaseCount", undefined);
    civHandle.setDynamicProperty("civ:inquisitionStarted", false);
}

/**
 * 都市の、指定した国家(exceptCivId)以外の宗教の圧力を一律SUPPRESSION_REDUCTION_RATIOだけ
 * 削減する(審問官の弾圧)。exceptCivId自身の圧力は変化させない。
 */
export function suppressOtherReligions(city, exceptCivId) {
    if (!city.religiousPressure) return;
    for (const civId in city.religiousPressure) {
        if (civId === exceptCivId) continue;
        city.religiousPressure[civId] *= (1 - SUPPRESSION_REDUCTION_RATIO);
    }
}

/**
 * 使徒・審問官が敵の宗教ユニットを攻撃した際のダメージを算出する(反撃なしの一方的な攻撃)。
 * combat.js の通常戦闘と同じ「24〜36のランダム値 × e^(戦闘力の差 × 0.04)」の式を使う。
 * @param {number} attackerStrength 攻撃側の実効宗教戦闘力(自国領内ボーナス込み)
 * @param {number} defenderStrength 防御側の実効宗教戦闘力(自国領内ボーナス込み)
 */
export function resolveReligiousAttack(attackerStrength, defenderStrength) {
    const base = RELIGIOUS_DAMAGE_MIN + Math.random() * (RELIGIOUS_DAMAGE_MAX - RELIGIOUS_DAMAGE_MIN);
    const diff = (attackerStrength ?? 0) - (defenderStrength ?? 0);
    return Math.floor(base * Math.exp(diff * RELIGIOUS_DAMAGE_EXPONENT_SCALE));
}

/**
 * 宗教ユニットが撃破された地点(tx, tz)に最も近い都市(所有者を問わない)を探し、その都市の
 * 宗教的圧力を、勝者の宗教+RELIGIOUS_KILL_PRESSURE_SHIFT・敗者の宗教-RELIGIOUS_KILL_PRESSURE_SHIFT
 * (0未満にはならない)だけ変動させる。宗教ユニット同士の攻撃(cmdAttackReligiousUnit)だけでなく、
 * 戦闘ユニットによる異教徒の排除(cmdPurgeHeretic)からも呼ばれる共通処理。
 * @param {any} tiles 全タイルデータ(呼び出し元が getTiles() で取得したものをそのまま渡す)
 * @param {number} tx 撃破が発生したマスのx座標
 * @param {number} tz 撃破が発生したマスのz座標
 * @param {string} winnerCivId 撃破した側の宗教(=国家)ID
 * @param {string} loserCivId 撃破された宗教ユニットの宗教(=国家)ID
 * @returns {string|null} 圧力を変動させた都市のマスキー(呼び出し元がsetTileで保存する)。
 *   都市が1つも無ければ null(何も変更しない)。
 */
export function applyReligiousKillPressureShift(tiles, tx, tz, winnerCivId, loserCivId) {
    let nearestKey = null;
    let minDist = Infinity;
    for (const key in tiles) {
        const t = tiles[key];
        if (!t.city) continue;
        const [cx, cz] = key.split(",").map(Number);
        const dist = Math.abs(tx - cx) + Math.abs(tz - cz);
        if (dist < minDist) { minDist = dist; nearestKey = key; }
    }
    if (!nearestKey) return null;

    const city = tiles[nearestKey].city;
    if (!city.religiousPressure) city.religiousPressure = {};
    if (winnerCivId) {
        city.religiousPressure[winnerCivId] = (city.religiousPressure[winnerCivId] ?? 0) + RELIGIOUS_KILL_PRESSURE_SHIFT;
    }
    if (loserCivId) {
        city.religiousPressure[loserCivId] = Math.max(0, (city.religiousPressure[loserCivId] ?? 0) - RELIGIOUS_KILL_PRESSURE_SHIFT);
    }
    return nearestKey;
}
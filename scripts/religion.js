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

const RELIGION_FOUND_THRESHOLD = 100; // 国家全体の信仰力合計がこの値に達すると宗教を創始できる
const SACRED_SITE_PRESSURE_PER_TURN = 100; // 聖地のある都市が、自国の宗教に毎ターン与える宗教的圧力

const RANDOM_RELIGION_NAMES = [
    "太陽の教え", "大地の信仰", "星辰教", "森羅の道", "光明教団",
    "静寂の教え", "潮流信仰", "灰燼の教え", "黎明教", "深緑の信仰",
];

function pickRandomReligionName() {
    return RANDOM_RELIGION_NAMES[Math.floor(Math.random() * RANDOM_RELIGION_NAMES.length)];
}

/**
 * 宗教ユニットの定義(信仰力で購入する、戦闘ユニットとは別レイヤーのユニット)。
 * @typedef {Object} ReligiousUnitDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {number} cost 購入に必要な信仰力(その都市の貯留信仰力から即座に消費される)
 * @property {number} hp / maxHp
 * @property {number} religiousCombatStrength 宗教戦闘力(布教時の宗教的圧力の算出に使う)
 * @property {number} movement 移動力
 * @property {number} evangelismPower 布教力(布教1回につき1消費。0になると消滅する)
 * @property {string} [requiresBuilding] 購入に必要な、都市が持つ建造物のフラグ名(例: "shrine")
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

    const hasSacredSite = Object.values(tiles).some(t => t.ownerId === civId && t.district?.id === "sacredSite");
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
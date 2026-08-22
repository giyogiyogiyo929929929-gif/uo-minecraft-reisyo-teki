// districts.js
// 🏛️ 区域(district): 都市とは別の領有マスに配置する、都市の生産力を使って複数ターンかけて
// 建設するタイプの構造物。
//
// 【他の建造タイプとの違い】
//   - production.js の建造物: 都市自身のマスに効果が付き、都市の生産キュー(city.production)を使う。
//   - facilities.js の施設: 労働者の行動回数を1消費して即座に設置される。
//   - districts.js の区域: 都市とは別の領有マスに配置し、都市の生産力を使って複数ターンかけて
//     建設される。都市の通常の生産キュー(city.production)とは別枠(city.districtConstruction)で
//     並行して進む(＝区域を建設中でもユニットの生産は並行して行える)。
//     ただし、区域を建設中のあいだ、その都市は新しい「建造物」(category:"building")を
//     着工できない(production.js の canStartProduction 側でチェックする)。
//
// 【データの持ち方】
//   city.districtConstruction = { id, progress, cost, tileKey } | null  … 建設中の区域(都市1つにつき1つまで)
//   tile.underDistrictConstruction = true                                … 建設中の対象マスの目印
//   tile.district = { id, label, ownerId, ownerName }                   … 完成した区域
//
// 【新しい区域の増やし方】
//   DISTRICT_DEFS に1エントリ追加するだけでよい。
//   - adjacencyBonuses: 隣接マスに応じたボーナス(adjacency.js と全く同じ書き方)。
//   - perPopulationYields: この区域を持つ都市に、人口1につき追加で加算されるボーナス。

import { hasCompletedProgress, getDefinition } from "./progression.js";
import { matchesTerrainWeighted, matchesFacility, matchesDistrict, matchesAnyCity, sumAssignedTileYields, sumAssignedTileAdjacencyYields, getFlagFlatYields } from "./adjacency.js";

/**
 * @typedef {Object} DistrictDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {number} cost 完成に必要な生産力の合計値
 * @property {string} [requiresTechnology] 配置に必要な技術ID(technology progression)
 * @property {Record<string, number>} [perPopulationYields] この区域を持つ都市に、人口1につき
 *   追加で加算される産出量(例: { faith: 2 })
 * @property {Record<string, number>} [flatYields] この区域があるだけで(隣接マスに関係なく)
 *   都市に毎ターン加算される産出量(例: { production: 3 })
 * @property {Array<any>} [adjacencyBonuses] この区域のマスを基準にした隣接ボーナスのルール一覧
 *   (adjacency.js 参照)
 * @property {(tx: number, tz: number) => string} [completeMessage] 完成時のメッセージ生成関数
 */
export const DISTRICT_DEFS = {
    sacredSite: {
        label: "聖地",
        icon: "[Sacred]",
        cost: 40,
        requiresTechnology: "astrology",
        // 💡 この区域を持つ都市は、人口1につき信仰力+2(通常の人口ぶんの信仰力とは別に追加)。
        perPopulationYields: { faith: 2 },
        // 💡 聖地に隣接する「山」「森林」1マスにつき信仰力+1(山脈はその2倍の+2、上限なし)。
        adjacencyBonuses: [
            { id: "sacredSiteNature", label: "山・山脈・森からの神聖な恩恵", match: matchesTerrainWeighted({ mountain: 1, mountainRange: 2, forest: 1 }), yieldPerMatch: { faith: 1 } },
        ],
        completeMessage: (tx, tz) => `§e[Complete] (${tx}, ${tz}) に聖地が完成しました！`,
    },
    industrialZone: {
        label: "工業地帯",
        icon: "[Industrial]",
        cost: 60,
        requiresTechnology: "apprenticeship",
        // 💡 工業地帯があるだけで、都市の生産力+3(隣接マスに関係なく毎ターン)。
        flatYields: { production: 3 },
        adjacencyBonuses: [
            { id: "industrialQuarry", label: "採石場からの恩恵", match: matchesFacility("quarry"), yieldPerMatch: { production: 1 } },
            { id: "industrialMountain", label: "山・山脈からの恩恵", match: matchesTerrainWeighted({ mountain: 1, mountainRange: 2 }), yieldPerMatch: { production: 1 } },
            { id: "industrialOtherDistrict", label: "他の区域からの恩恵", match: matchesDistrict(), yieldPerMatch: { production: 0.5 } },
            { id: "industrialBlacksmith", label: "鍛冶場からの恩恵", match: matchesFacility("blacksmith"), yieldPerMatch: { production: 2 } },
            { id: "industrialCity", label: "都市からの恩恵", match: matchesAnyCity(), yieldPerMatch: { production: 0.5 } },
        ],
        completeMessage: (tx, tz) => `§e[Complete] (${tx}, ${tz}) に工業地帯が完成しました！`,
    },
};

export function getDistrictDef(id) {
    return DISTRICT_DEFS[id] ?? null;
}

export function getDistrictIds() {
    return Object.keys(DISTRICT_DEFS);
}

/**
 * 指定マスに区域の建設を開始できるかどうかを判定する。
 * @param {any} tile 対象マスのデータ
 * @param {string} id 区域ID
 * @param {string} playerId 建設しようとしているプレイヤー/国家のID
 * @param {any} city 帰属先となる都市のデータ(既に建設中の区域が無いかの判定に使う)
 * @param {any} [player] 技術取得状況の判定に使うプレイヤー/国家ハンドル(省略時は技術チェックを行わない)
 * @returns {{ ok: boolean, message?: string }}
 */
export function canStartDistrict(tile, id, playerId, city, player = null) {
    const def = DISTRICT_DEFS[id];
    if (!def) return { ok: false, message: "§c不明な区域です。" };
    if (!tile) return { ok: false, message: "§c無効なマスです。" };
    if (tile.ownerId !== playerId) return { ok: false, message: "§cこのマスはあなたの領有地ではありません。" };
    if (tile.city) return { ok: false, message: "§cこのマスには都市があるため区域は配置できません。" };
    if (tile.facility) return { ok: false, message: `§cこのマスには施設【${tile.facility.label ?? tile.facility.id}】があるため区域は配置できません。` };
    if (tile.district) return { ok: false, message: `§cこのマスには既に区域【${tile.district.label ?? tile.district.id}】が存在します。` };
    if (tile.underDistrictConstruction) return { ok: false, message: "§cこのマスは既に区域を建設中です。" };
    if (city?.districtConstruction) return { ok: false, message: "§c既にこの都市は別の区域を建設中です(同時に1つまで)。" };
    if (def.requiresTechnology) {
        const hasTech = !!player && hasCompletedProgress(player, "technology", def.requiresTechnology);
        if (!hasTech) {
            const techDef = getDefinition("technology", def.requiresTechnology);
            return { ok: false, message: `§c【${def.label}】の配置には技術【${techDef?.label ?? def.requiresTechnology}】の取得が必要です。` };
        }
    }
    return { ok: true };
}

/** 区域の建設を開始する。呼び出し側で canStartDistrict のチェックは済んでいる前提。 */
export function startDistrictConstruction(city, tile, id, tileKey) {
    const def = DISTRICT_DEFS[id];
    if (!def) return null;
    city.districtConstruction = { kind: "district", id, progress: 0, cost: def.cost, tileKey };
    tile.underDistrictConstruction = true;
    return city.districtConstruction;
}

/**
 * 区域専用の建造物の定義(特定の区域の上にのみ建てられる、都市の生産力を使う建造物)。
 * @typedef {Object} DistrictBuildingDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {number} cost 完成に必要な生産力の合計値
 * @property {string} forDistrict どの区域(DISTRICT_DEFSのID)の上に建てられるか
 * @property {Record<string, number>} [flatYields] この建造物があるだけで(隣接マスに関係なく)
 *   都市に毎ターン加算される産出量(例: { faith: 2 })
 * @property {(city: any, tile: any) => void} onComplete 完成時の効果を適用する関数
 * @property {(tx: number, tz: number) => string} [completeMessage] 完成時のメッセージ生成関数
 */
export const DISTRICT_BUILDING_DEFS = {
    shrine: {
        label: "社",
        icon: "[Shrine]",
        cost: 70,
        forDistrict: "sacredSite",
        // 💡 信仰力+2 は flatYields 経由で getDistrictBuildingFlatYields() が city.shrine を見て
        //    自動的に加算する(turns.js 側に個別の分岐は不要)。
        //    伝道者の購入可否は religion.js の RELIGIOUS_UNIT_DEFS.missionary.requiresBuilding が
        //    "shrine" を指定しており、city.shrine を見て自動的に判定される。
        flatYields: { faith: 2 },
        onComplete: (city) => { city.shrine = true; },
        completeMessage: (tx, tz) => `§e[Complete] (${tx}, ${tz})の聖地に社が完成しました！ (信仰力の産出+2、伝道者を購入可能に)`,
    },
};

/**
 * 指定したマスが、指定した所有者の聖地(district: "sacredSite")かどうかを判定する。
 * 聖地IDの文字列比較を宗教システム側(religion.js/turns.js/ui.js)に散らばらせないための
 * 共有ヘルパー(宗教の創始条件・毎ターンの宗教的圧力付与・宗教メニュー表示のいずれもこれを使う)。
 */
export function isSacredSiteTile(tile, ownerId) {
    return tile?.ownerId === ownerId && tile?.district?.id === "sacredSite";
}

export function getDistrictBuildingDef(id) {
    return DISTRICT_BUILDING_DEFS[id] ?? null;
}

export function getDistrictBuildingIds() {
    return Object.keys(DISTRICT_BUILDING_DEFS);
}

/**
 * 指定マスに区域専用の建造物を建設開始できるかどうかを判定する。
 * @param {any} tile 対象マス(既に対応する区域が完成している必要がある)
 * @param {string} id 区域専用建造物のID
 * @param {string} playerId 建設しようとしているプレイヤー/国家のID
 * @param {any} city 帰属先となる都市のデータ
 * @returns {{ ok: boolean, message?: string }}
 */
export function canStartDistrictBuilding(tile, id, playerId, city) {
    const def = DISTRICT_BUILDING_DEFS[id];
    if (!def) return { ok: false, message: "§c不明な建造物です。" };
    if (!tile) return { ok: false, message: "§c無効なマスです。" };
    if (tile.ownerId !== playerId) return { ok: false, message: "§cこのマスはあなたの領有地ではありません。" };
    if (!tile.district) return { ok: false, message: "§cこのマスには区域がありません。" };
    if (tile.district.id !== def.forDistrict) {
        const requiredDef = DISTRICT_DEFS[def.forDistrict];
        return { ok: false, message: `§c【${def.label}】は【${requiredDef?.label ?? def.forDistrict}】にのみ建設できます。` };
    }
    if (city?.[id]) return { ok: false, message: `§cこの都市には既に【${def.label}】が存在します。` };
    if (city?.districtConstruction) return { ok: false, message: "§c既にこの都市は区域(または区域専用の建造物)を建設中です(同時に1つまで)。" };
    return { ok: true };
}

/** 区域専用の建造物の建設を開始する。呼び出し側で canStartDistrictBuilding のチェックは済んでいる前提。 */
export function startDistrictBuildingConstruction(city, id, tileKey) {
    const def = DISTRICT_BUILDING_DEFS[id];
    if (!def) return null;
    city.districtConstruction = { kind: "building", id, progress: 0, cost: def.cost, tileKey };
    return city.districtConstruction;
}

/**
 * 区域建設の毎ターン進行処理。city.districtConstruction が無ければ何もしない。
 * 建設中に対象マスの所有権が変わった(占領された等)場合は、建設を中止する。
 * @param {any} city 対象の都市データ
 * @param {number} productionAmount このターン、この都市が産出した生産力
 * @param {any} tiles 全タイルデータ
 * @param {string} ownerId この都市の所有者ID(対象マスの所有権チェックに使う)
 * @returns {{ done: boolean, cancelled?: boolean, message: string } | null}
 */
export function tickDistrictConstruction(city, productionAmount, tiles, ownerId) {
    const construction = city.districtConstruction;
    if (!construction) return null;

    const isBuilding = construction.kind === "building";
    const def = isBuilding ? DISTRICT_BUILDING_DEFS[construction.id] : DISTRICT_DEFS[construction.id];
    if (!def) { city.districtConstruction = null; return null; }

    const targetTile = tiles[construction.tileKey];
    // 💡 建設中に対象マスを失った(占領された等)場合は、建設を中止する。
    //    区域専用の建造物の場合は、土台となる区域そのものを失った(占領・別の区域になった等)場合も中止する。
    const lostTile = !targetTile || targetTile.ownerId !== ownerId || (!isBuilding && targetTile.city);
    const lostDistrict = isBuilding && (!targetTile?.district || targetTile.district.id !== def.forDistrict);
    if (lostTile || lostDistrict) {
        city.districtConstruction = null;
        if (targetTile && !isBuilding) delete targetTile.underDistrictConstruction;
        return { done: true, cancelled: true, message: `§c[Warning] 【${def.label}】は建設中に対象を失ったため中止されました。` };
    }

    construction.progress += productionAmount ?? 0;

    if (construction.progress >= construction.cost) {
        if (isBuilding) {
            def.onComplete?.(city, targetTile);
        } else {
            targetTile.district = { id: construction.id, label: def.label, ownerId: targetTile.ownerId, ownerName: targetTile.ownerName };
            delete targetTile.underDistrictConstruction;
        }
        const [txStr, tzStr] = construction.tileKey.split(",");
        const message = def.completeMessage
            ? def.completeMessage(Number(txStr), Number(tzStr))
            : `§e[Complete]【${def.label}】が完成しました！`;
        city.districtConstruction = null;
        return { done: true, message };
    }

    const progressText = Math.floor(construction.progress * 10) / 10;
    const kindLabel = isBuilding ? "建造物" : "区域";
    return { done: false, message: `§7${def.icon} ${kindLabel}【${def.label}】を建設中... (${progressText}/${construction.cost})` };
}

/**
 * 都市が持つ区域(帰属マス一覧の中から)による「人口比例のボーナス」をまとめて計算する。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @param {number} population 都市の人口
 * @returns {{ [yieldKey: string]: number }}
 */
export function getDistrictPopulationYields(assignedTiles, population) {
    return sumAssignedTileYields(assignedTiles, (tile) => tile?.district, DISTRICT_DEFS, "perPopulationYields", population);
}

/**
 * 都市が持つ区域による隣接ボーナスをまとめて計算する(facilities.js の
 * getFacilityAdjacencyYields と同型。区域自身のマスを基準に周囲8マスを判定する)。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @param {any} tiles 全タイルデータ
 * @returns {{ [yieldKey: string]: number }}
 */
export function getDistrictAdjacencyYields(assignedTiles, tiles) {
    return sumAssignedTileAdjacencyYields(assignedTiles, tiles, (tile) => tile?.district, DISTRICT_DEFS);
}

/**
 * 都市が持つ区域から、隣接マスに関係なく「区域があるだけで」得られる産出量(flatYields)を合算する。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @returns {{ [yieldKey: string]: number }}
 */
export function getDistrictFlatYields(assignedTiles) {
    return sumAssignedTileYields(assignedTiles, (tile) => tile?.district, DISTRICT_DEFS, "flatYields");
}

/**
 * 都市が持つ区域専用建造物(city[id]が true のもの)から、flatYieldsを合算する
 * (production.js の建造物における getFlagFlatYields(city, PRODUCTION_DEFS, "building") と同じ形。
 * turns.js の getCityCurrentYields から呼ばれる)。
 * @param {any} city 都市データ
 * @returns {{ [yieldKey: string]: number }}
 */
export function getDistrictBuildingFlatYields(city) {
    return getFlagFlatYields(city, DISTRICT_BUILDING_DEFS);
}
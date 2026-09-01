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
import { matchesTerrainWeighted, sumAssignedTileYields, sumAssignedTileAdjacencyYields } from "./adjacency.js";
import { RESOURCE_TYPES, TERRAIN_TYPES, isWaterTerrain } from "./mapGen.js";
import { AIRBASE_SLOTS_AIRSTRIP } from "./airbase.js";

/**
 * @typedef {Object} FacilityDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン
 * @property {string} [requiresTechnology] 設置に必要な技術ID(technology progression)
 * @property {string} [requiresCivic] 設置に必要な社会制度ID(civic progression)
 * @property {string} [requiresResource] 設置できるマスの資源を限定する(tile.resourceと一致が必要)
 * @property {string[]} [requiresTerrain] 設置できるマスの地形(tile.type)を限定する(いずれかに
 *   一致が必要。requiresResourceが資源を限定するのに対し、こちらは地形そのものを限定する。
 *   例: キャンプは森林・熱帯雨林・寒冷地限定、プランテーションは砂漠・草原限定)
 * @property {boolean} [allowWater] trueの場合のみ水上マス(川・海・池・湖)に設置できる(省略時は不可)
 * @property {Record<string, number>} [flatYields] この施設があるだけで(隣接マスに関係なく)
 *   都市に毎ターン加算される産出量(例: { iron: 2, production: 4 })
 * @property {{resource: string, yields: Record<string, number>}} [resourceYields] flatYieldsと違い、
 *   この施設が設置されているマス自身が指定した資源(resource)を持つ場合にのみ、毎ターン加算される
 *   産出量(例: 牧場は、設置マスに資源「馬」があるときだけ馬+1)。requiresResourceのように設置自体を
 *   制限するのではなく、「どこにでも置けるが、資源があるマスに置くとボーナスが乗る」施設向け。
 * @property {Array<any>} [adjacencyBonuses] 隣接マスに応じたボーナスのルール一覧(adjacency.js参照)
 * @property {(tile: any, tx: number, tz: number) => string} [installMessage] 設置完了時のメッセージ生成関数
 */
export const FACILITY_DEFS = {
    quarry: {
        label: "採石場",
        icon: "[Quarry]",
        requiresTechnology: "mining",
        // 💡 周囲8マスの「山」1つにつき生産力+1(山脈はその2倍の+2、上限なし)。
        adjacencyBonuses: [
            { id: "quarryMountain", label: "山・山脈からの採石恩恵", match: matchesTerrainWeighted({ mountain: 1, mountainRange: 2 }), yieldPerMatch: { production: 1 } },
        ],
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に採石場を設置しました！(隣接する山1つにつき生産力+1、山脈は+2)`,
    },
    blacksmith: {
        label: "鍛冶場",
        icon: "[Blacksmith]",
        requiresTechnology: "smelting",
        requiresResource: "iron",
        flatYields: { iron: 2, production: 4 },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に鍛冶場を設置しました！(毎ターン鉄+2、生産力+4)`,
    },
    // 💡 隕石(meteor)は生成時の基礎生産力+2以外に使い道が無かった唯一の資源だったため、
    //    専用施設を追加した(§2)。前提技術「工学」はカタパルトと同じ投資額のため、
    //    それに見合う特大ボーナスにしている。
    meteorCraterMine: {
        label: "隕石クレーター採掘場",
        icon: "[MeteorMine]",
        requiresTechnology: "engineering",
        requiresResource: "meteor",
        flatYields: { production: 6, science: 2 },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に隕石クレーター採掘場を設置しました！(毎ターン生産力+6、科学力+2)`,
    },
    harbor: {
        label: "港",
        icon: "[Harbor]",
        requiresTechnology: "sailing",
        // 💡 allowWater: 水上マス(海・川・池・湖)にのみ設置できる施設(allowWaterフラグの初使用例)。
        allowWater: true,
        flatYields: { food: 2, production: 1 },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に港を設置しました！(毎ターン食料+2、生産力+1)`,
    },
    pasture: {
        label: "牧場",
        icon: "[Pasture]",
        requiresTechnology: "animalHusbandry",
        // 💡 requiresResourceと違い、設置自体は資源を問わない(どの領有マスにも置ける)が、
        //    設置マスに資源「馬」がある場合のみ resourceYields で馬+1が追加される(下記installMessage参照)。
        flatYields: { food: 1 },
        resourceYields: { resource: "horse", yields: { horse: 1 } },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に牧場を設置しました！(毎ターン食料+1${tile.resource === "horse" ? "、資源「馬」により馬+1" : ""})`,
    },
    camp: {
        label: "キャンプ",
        icon: "[Camp]",
        requiresTechnology: "currency",
        // 💡 森林・熱帯雨林・寒冷地(狩猟に適した地形)限定。requiresTerrainの初使用例。
        requiresTerrain: ["forest", "rainforest", "cold"],
        flatYields: { gold: 3 },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) にキャンプを設置しました！(毎ターンゴールド+3)`,
    },
    plantation: {
        label: "プランテーション",
        icon: "[Plantation]",
        requiresTechnology: "currency",
        // 💡 砂漠・草原(農園に適した地形)限定。
        requiresTerrain: ["desert", "grassland"],
        flatYields: { gold: 3 },
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) にプランテーションを設置しました！(毎ターンゴールド+3)`,
    },
    // 💡 §航空戦。産出量ボーナスは持たず、この都市の航空基地(airbase.js)の空き枠を
    //    +AIRBASE_SLOTS_AIRSTRIP増やすためだけの施設(帰属都市の判定はresolveOwningCityKey/
    //    belongsToCityKey経由。他の施設と同じくtile.facility.idの存在だけでgetAirbaseCapacity
    //    が自動的に数えるため、ここに特別な処理は不要)。
    airstrip: {
        label: "滑走路",
        icon: "[Airstrip]",
        requiresTechnology: "aviation",
        installMessage: (tile, tx, tz) => `§e[Complete] (${tx}, ${tz}) に滑走路を設置しました！(帰属都市の航空基地の空き枠+${AIRBASE_SLOTS_AIRSTRIP})`,
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
    if (tile.district) return { ok: false, message: `§cこのマスには区域【${tile.district.label ?? tile.district.id}】があるため施設は設置できません。` };
    if (tile.underDistrictConstruction) return { ok: false, message: "§cこのマスは区域を建設中のため施設は設置できません。" };
    if (!def.allowWater && isWaterTerrain(tile.type)) return { ok: false, message: `§c【${def.label}】は水上マスには設置できません。` };
    if (def.requiresTerrain && !def.requiresTerrain.includes(tile.type)) {
        const terrainLabels = def.requiresTerrain.map(t => TERRAIN_TYPES[t]?.label ?? t).join("・");
        return { ok: false, message: `§c【${def.label}】は${terrainLabels}にのみ設置できます。` };
    }
    if (def.requiresResource && tile.resource !== def.requiresResource) {
        const resourceLabel = RESOURCE_TYPES[def.requiresResource]?.label ?? def.requiresResource;
        return { ok: false, message: `§c【${def.label}】は資源【${resourceLabel}】があるマスにのみ設置できます。` };
    }
    if (def.requiresTechnology) {
        const hasTech = !!player && hasCompletedProgress(player, "technology", def.requiresTechnology);
        if (!hasTech) {
            const techDef = getDefinition("technology", def.requiresTechnology);
            return { ok: false, message: `§c【${def.label}】の設置には技術【${techDef?.label ?? def.requiresTechnology}】の取得が必要です。` };
        }
    }
    if (def.requiresCivic) {
        const hasCivic = !!player && hasCompletedProgress(player, "civic", def.requiresCivic);
        if (!hasCivic) {
            const civicDef = getDefinition("civic", def.requiresCivic);
            return { ok: false, message: `§c【${def.label}】の設置には社会制度【${civicDef?.label ?? def.requiresCivic}】の取得が必要です。` };
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
    return sumAssignedTileAdjacencyYields(assignedTiles, tiles, (tile) => tile?.facility, FACILITY_DEFS);
}

/**
 * 都市に帰属するマスの一覧から、施設が設置されているものを見つけ、隣接マスに関係なく
 * その施設があるだけで得られる産出量(flatYields)を合算する。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @returns {{ [yieldKey: string]: number }}
 */
export function getFacilityFlatYields(assignedTiles) {
    return sumAssignedTileYields(assignedTiles, (tile) => tile?.facility, FACILITY_DEFS, "flatYields");
}

/**
 * 都市に帰属するマスの一覧から、resourceYieldsを持つ施設が設置されているものを見つけ、
 * その施設のマス自身が指定資源(resourceYields.resource)を持っている場合にのみ産出量を合算する
 * (牧場の「馬がある場合だけ馬+1」のような、設置マス自身の資源に条件付くボーナス用。flatYieldsは
 * 資源の有無を問わず常に加算されるのに対し、こちらは条件を満たさなければ何も加算しない)。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles その都市に帰属するマスの一覧
 * @returns {{ [yieldKey: string]: number }}
 */
export function getFacilityResourceYields(assignedTiles) {
    const totals = {};
    if (!Array.isArray(assignedTiles)) return totals;

    for (const t of assignedTiles) {
        const facility = t.tile?.facility;
        if (!facility) continue;
        const def = FACILITY_DEFS[facility.id];
        const rc = def?.resourceYields;
        if (!rc || t.tile.resource !== rc.resource) continue;

        for (const key in rc.yields) totals[key] = (totals[key] ?? 0) + rc.yields[key];
    }

    return totals;
}
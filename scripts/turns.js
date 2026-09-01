// turns.js
import { world, system, BlockPermutation } from "@minecraft/server";
import { getTurnState, setTurnState, resetAll, getTiles, setTiles, getMapConfig, getStateVersion, getMatchSettings, broadcast, releaseWonder } from "./state.js";
import { PRODUCTION_DEFS, tickProduction, releaseCityCompletedWonders } from "./production.js";
import { grantProgressPoints, resetProgress, hasCompletedProgress, addGreatPersonPoints } from "./progression.js";
import { resetDiplomacy, getRelation, isAtWar } from "./diplomacy.js";
import { CITY_MAX_HP, CITY_HP_REGEN_PER_TURN } from "./combat.js";
import { getCivStorageHandle, resolveCivName, isCivControllable, removeAllBots } from "./civs.js";
import { getBuildingAdjacencyYields, getFlagFlatYields, getAdjacentTileEntries } from "./adjacency.js";
import { getFacilityAdjacencyYields, getFacilityFlatYields, getFacilityResourceYields } from "./facilities.js";
import { getDistrictAdjacencyYields, getDistrictFlatYields, getDistrictPopulationYields, getDistrictBuildingFlatYields, tickDistrictConstruction, isSacredSiteTile, hasCityDistrict, DISTRICT_BUILDING_DEFS } from "./districts.js";
import { hasFoundedReligion, getReligionName, getNationalDominantReligion, applySacredSitePressure, resetReligion } from "./religion.js";
import { clearAllUnitLabels, refreshUnitLabelAt } from "./unitLabels.js";
import { clearAllUnitModels } from "./unitModels.js";
import { RESOURCE_TYPES } from "./mapGen.js";
import { resetAndHealBasedAirUnitsForTurn, getAllBasedAirUnitsForPlayer, removeBasedAirUnit } from "./airbase.js";

export { getTurnState, setTurnState };
const TILE_SIZE = 5;
// 💡 バランス調整: 都市の全ての産出量(食料・生産力・石油・信仰力・鉄・馬・ゴールド。マス固有の基礎産出量、
//    施設/区域/建造物のボーナス、隣接ボーナス、人口比例ボーナスなど getCityCurrentYields が
//    集計するもの全て)に一律の倍率を掛ける。個々のボーナス値を1つずつ書き換える代わりに、
//    集計の最終地点でまとめて掛けることで、新しく増えるボーナスにも自動的に反映される。
//    倍率自体は試合の設定(state.js の getMatchSettings/setMatchSettings)でOPが変更できる。
const DEFAULT_YIELD_MULTIPLIER = 2;
// 💡 scienceは他のキーと違い、getCityCurrentYieldsではキャンパス(区域)由来の分しか集計しない
//    (人口由来の科学力は別枠でprocessPlayerTurnStartがgrantProgressPointsへ直接渡す)。
//    そのためfaithと違って人口分の初期値は持たない(0スタート)。
const YIELD_KEYS = ["food", "production", "oil", "faith", "iron", "science", "horse", "gold", "coal", "uranium"];
// 💡 都市の産出量のうち、都市個別ではなく国家全体の在庫として貯まる戦略資源。
//    ここに1エントリ追加するだけで、蓄積・DynamicPropertyへの保存・ターン報告メッセージが
//    すべて自動的に対応する(processPlayerTurnStart参照)。
const STRATEGIC_RESOURCES = [
    { key: "oil", prop: "strategic_oil", prefix: "§b[Oil] ", label: "石油" },
    { key: "iron", prop: "strategic_iron", prefix: "§7[Iron] ", label: "鉄" },
    { key: "horse", prop: "strategic_horse", prefix: "§6[Horse] ", label: "馬" },
    { key: "gold", prop: "strategic_gold", prefix: "§6[Gold] ", label: "ゴールド" },
    { key: "coal", prop: "strategic_coal", prefix: "§8[Coal] ", label: "石炭" },
    { key: "uranium", prop: "strategic_uranium", prefix: "§a[Uranium] ", label: "ウラン" },
];
// 💡 ゴールド経済(§23): ユニット/建造物/区域の毎ターン維持費、破産時の強制解散。
//    維持費は個別の値を持たせず、既存のcost/フラグから機械的に算出する(calculateGoldUpkeep参照)。
const UNIT_GOLD_UPKEEP_COST_DIVISOR = 40; // ユニット1体の維持費 = max(1, ceil(cost/この値))
const BUILDING_GOLD_UPKEEP = 1; // 建造物(区域専用建造物含む)1つにつき固定
const DISTRICT_GOLD_UPKEEP = 1; // 区域(district)のマス1つにつき固定
const BANKRUPTCY_GOLD_PER_DISBAND = 10; // ゴールドがこの値ぶんマイナスになるごとに1体強制解散
// 💡 (簡素化) getCityCurrentYieldsのgold算出とgetCityGoldBreakdownの内訳計算が同じ値を
//    それぞれ直書きしてズレる事故を防ぐため、共有の名前付き定数として1箇所にまとめる。
const GOLD_BASE_PER_CITY = 3; // 都心の基礎ゴールド産出(§23)
export const GOLD_PER_LUXURY_RESOURCE = 3; // 高級資源のあるマス(労働時)1つあたりのゴールド産出(§23)

/** 資源IDが高級資源(労働時に+GOLD_PER_LUXURY_RESOURCEのゴールドを産出)かどうか。 */
export function isLuxuryResource(resourceId) {
    return RESOURCE_TYPES[resourceId]?.category === "高級";
}
// 💡 CO2による環境ペナルティ(§24)。国家全体のCO2蓄積量(strategic_co2)に応じて、
//    その国家の全都市の食料産出を下げる(CAPで頭打ちにし、都市を詰ませない)。
const CO2_FOOD_PENALTY_PER = 50; // CO2がこの値ぶん貯まるごとに食料産出-1
const CO2_FOOD_PENALTY_CAP = 5; // 食料産出への最大マイナス値
// 💡 原子力発電所の老朽化事故(§24)。老朽化年数1ターンにつき発生率+この%
//    (ui.jsのopenDistrictBuildingMenuで表示しているリスク%の式と統一)。
export const NUCLEAR_MELTDOWN_RISK_PER_TURN = 2;
// 💡 天災イベント。CO2蓄積量がこの値を超えたプレイヤーのみ対象(CO2を出していなければ
//    一切影響しない)。超過分50ごとに発生率+5%、最大30%(CO2_FOOD_PENALTY同様、頭打ちにして
//    詰ませない設計)。
const CLIMATE_DISASTER_CO2_THRESHOLD = 150;
const CLIMATE_DISASTER_CHANCE_PER_50_CO2 = 5;
const CLIMATE_DISASTER_CHANCE_CAP = 30;
const CLIMATE_DISASTER_FOOD_LOSS = 75; // 干ばつ発生時に失う蓄積食料(foodStorageは0未満にはしない)
let cityYieldCacheVersion = -1;
// 💡 (バグ修正) main.jsのcityYieldCache(HUD側)はversion一致に加えてtick単位のTTLも
//    安全弁として持つ(CLAUDE.mdの規約)が、こちら(turns.js内部のcityYieldCache/
//    cityAssignmentCache/cityTradeBonusCache)はversionだけで無効化しており、
//    stateVersionを経由しない範囲外の変更があった場合に古い値が残り続ける穴があった。
//    同じTTLをここにも設ける。
let cityYieldCacheTick = -1;
const TURN_CACHE_TICKS = 20; // 最大1秒。main.jsのCITY_YIELD_CACHE_TICKSと同じ値。
const cityYieldCache = new Map();
const cityAssignmentCache = new Map();
// 💡 交易路(tradingPost.routes)のfood/goldボーナスは、接続元・接続先どちらの都市にも
//    配られる(§交易路)が、ルート自体は接続元都市にしか保存されていない。cityKeyごとの
//    getCityCurrentYields呼び出しのたびに全タイルを再走査するのは無駄なので、
//    stateVersionが変わるたびに1回だけ全タイルを走査してcityKey→{food,gold}の
//    合計を作っておき、以後はO(1)で引く。
const cityTradeBonusCache = new Map();
let cityTradeBonusCacheBuilt = false;
export const PLAYER_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "cyan", "magenta", "light_blue", "lime"];

function invalidateTurnCaches() {
    cityYieldCache.clear();
    cityAssignmentCache.clear();
    cityTradeBonusCache.clear();
    cityTradeBonusCacheBuilt = false;
}

/** cityKeyが交易路(接続元・接続先いずれか)から受け取るfood/goldボーナスの合計を返す。 */
function getCityTradeBonus(cityKey, tiles) {
    syncTurnCaches();
    if (!cityTradeBonusCacheBuilt) {
        for (const key in tiles) {
            const t = tiles[key];
            if (!t.city?.tradingPost?.routes) continue;
            for (const route of t.city.tradingPost.routes) {
                const origin = cityTradeBonusCache.get(key) ?? { food: 0, gold: 0 };
                origin.food += route.bonus ?? 0;
                origin.gold += route.goldBonus ?? 0;
                cityTradeBonusCache.set(key, origin);
                const target = cityTradeBonusCache.get(route.targetKey) ?? { food: 0, gold: 0 };
                target.food += route.bonus ?? 0;
                target.gold += route.goldBonus ?? 0;
                cityTradeBonusCache.set(route.targetKey, target);
            }
        }
        cityTradeBonusCacheBuilt = true;
    }
    return cityTradeBonusCache.get(cityKey) ?? { food: 0, gold: 0 };
}
function syncTurnCaches() {
    const version = getStateVersion();
    const currentTick = system.currentTick;
    if (version !== cityYieldCacheVersion || currentTick - cityYieldCacheTick >= TURN_CACHE_TICKS) {
        invalidateTurnCaches();
        cityYieldCacheVersion = version;
        cityYieldCacheTick = currentTick;
    }
}
export function getPlayerColor(playerId) { return getTurnState().playerColors?.[playerId] ?? "white"; }
function getPlayerNameById(id) { return resolveCivName(id); }

/** 都市(tx,tz)が「包囲」されているか(自身のマス、または隣接8マスに、戦争状態の敵の戦闘ユニットが
 *  いるか)を判定する。§13: 包囲中は都心のHPが自然回復しない(processPlayerTurnStart参照)。
 *  (バグ修正) 以前は自身のマス(0,0)を判定から除外していたため、都心のHPが0になり敵ユニットが
 *  そのマスへ進入した(まだ占領はしていない)状態を「包囲されていない」と誤判定し、占領される
 *  直前まで都心のHPが自然回復し続けてしまっていた。 */
function isCityBesieged(tx, tz, playerId, tiles) {
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            const u = tiles[`${tx + dx},${tz + dz}`]?.combatUnit;
            if (u && u.ownerId !== playerId && isAtWar(playerId, u.ownerId)) return true;
        }
    }
    return false;
}

/** 国家全体のゴールド維持費(§23)を算出する。ユニットはproduction costに応じて、
 *  建造物(区域専用建造物含む)・区域は固定額で計算する(施設(facility)は対象外)。 */
function calculateGoldUpkeep(playerId, tiles) {
    let upkeep = 0;
    for (const key in tiles) {
        const t = tiles[key];
        if (t.combatUnit?.ownerId === playerId) {
            const def = PRODUCTION_DEFS[t.combatUnit.id];
            // 💡 区域専用建造物(goldUpkeep)と同じく、個別に維持費を上書きできる
            //    (「うおｗ」はネタユニットのため維持費0固定)。
            upkeep += def?.goldUpkeep ?? Math.max(1, Math.ceil((def?.cost ?? 20) / UNIT_GOLD_UPKEEP_COST_DIVISOR));
        }
        if (t.ownerId !== playerId) continue;
        if (t.district) upkeep += DISTRICT_GOLD_UPKEEP;
        if (t.city) {
            for (const id in PRODUCTION_DEFS) {
                if (PRODUCTION_DEFS[id].category === "building" && t.city[id]) upkeep += BUILDING_GOLD_UPKEEP;
            }
            for (const id in DISTRICT_BUILDING_DEFS) {
                // 💡 区域専用建造物は個別に維持費を上書きできる(工場2/発電所3種3、既定は工房などと同じ1。§24)。
                if (t.city[id]) upkeep += DISTRICT_BUILDING_DEFS[id].goldUpkeep ?? BUILDING_GOLD_UPKEEP;
            }
        }
    }
    // 💡 (バグ修正) 航空ユニットは tile.combatUnit ではなく city.airbase.units に配置されるため、
    //    上のループでは一切カウントされていなかった(=航空ユニットの維持費が常に0になっていた)。
    for (const { unit } of getAllBasedAirUnitsForPlayer(playerId, tiles)) {
        const def = PRODUCTION_DEFS[unit.id];
        upkeep += def?.goldUpkeep ?? Math.max(1, Math.ceil((def?.cost ?? 20) / UNIT_GOLD_UPKEEP_COST_DIVISOR));
    }
    return upkeep;
}

/** ゴールドが0未満(破産)なら、-10ごとに1体、コストの安いユニットから強制解散する(§23)。
 *  tilesを直接書き換えるため、呼び出し元でsetTilesを呼ぶこと。
 *  @returns {Array<{key:string, unit:any}>} 解散したユニットの一覧(空配列なら解散なし) */
function applyGoldBankruptcy(playerId, gold, tiles) {
    if (gold >= 0) return [];
    const disbandCount = Math.floor(-gold / BANKRUPTCY_GOLD_PER_DISBAND);
    if (disbandCount <= 0) return [];
    const candidates = [];
    for (const key in tiles) {
        const unit = tiles[key].combatUnit;
        if (unit?.ownerId === playerId) candidates.push({ key, unit });
    }
    // 💡 (バグ修正) 航空ユニット(city.airbase.units)は上のtile.combatUnitループでは拾えず、
    //    財政破綻の強制解散対象から漏れていたため、あわせて候補に加える。
    for (const { cityKey, city, unit } of getAllBasedAirUnitsForPlayer(playerId, tiles)) {
        candidates.push({ key: cityKey, unit, air: true, city });
    }
    candidates.sort((a, b) => (PRODUCTION_DEFS[a.unit.id]?.cost ?? 20) - (PRODUCTION_DEFS[b.unit.id]?.cost ?? 20));
    const disbanded = candidates.slice(0, disbandCount);
    for (const c of disbanded) {
        if (c.air) removeBasedAirUnit(c.city, c.unit);
        else tiles[c.key].combatUnit = null;
    }
    return disbanded;
}

/**
 * 自国の工業地帯(区域)にある工場・発電所の効果(§24)を1プレイヤーぶんまとめて処理する。
 * 対象は常に自国の都市のみ(隣接していても他国の都市には一切影響しない)。cityProductionIncomes
 * (このターンの各都市の生産力。tickProduction/tickDistrictConstructionへ渡す直前の値)をその場で
 * 書き換える。燃料消費・CO2蓄積・原子炉の老朽化年数の加算という副作用も持つため、1ターンにつき
 * 1回だけ呼び出すこと(getCityCurrentYieldsのような prevue/表示専用の経路では呼ばない)。
 * 表示用に city.powerReceived(受給電力の合計)・city.powerSources(発電所ごとの内訳、
 * { plantLabel, fromCityName, amount }の配列)も毎回リセットしてから書き込む(ui.js参照)。
 * @returns {number} このプレイヤーの発電所(原子力のownCityBonus)による追加科学力の合計
 */
function applyIndustrialInfrastructure(playerId, player, tiles, playerCities, cityProductionIncomes, summaryReport) {
    // 💡 電力受給量は表示用に city.powerReceived/powerSources へ毎ターン保存し直す(§24)。
    //    まず全都市を0/空配列にリセットしてから、発電所の供給分があれば後段で上書きする
    //    (industrialTilesが無い/発電所が消えた場合にも古い値が残らないようにするため)。
    for (const c of playerCities) { c.tile.city.powerReceived = 0; c.tile.city.powerSources = []; }

    const playerCityKeys = new Set(playerCities.map(c => c.key));
    const industrialTiles = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === playerId && t.district?.id === "industrialZone" && t.belongsToCityKey) {
            const [tx, tz] = key.split(",").map(Number);
            industrialTiles.push({ tx, tz, ownCityKey: t.belongsToCityKey, city: tiles[t.belongsToCityKey]?.city });
        }
    }
    if (!industrialTiles.length) return 0;

    let extraScience = 0;
    const cityPowerReceived = {};
    const cityPowerSources = {};

    // 💡 フェーズ1: 発電所(燃料消費・CO2蓄積・自都市ボーナス・隣接自国都市への電力供給)。
    //    工場のボーナス計算(フェーズ2)が電力量を参照するため、先に全ての発電所を処理しておく。
    for (const it of industrialTiles) {
        const city = it.city;
        if (!city) continue;
        // 💡 老朽化年数は発電の成否に関わらず、原子力発電所が存在するだけで毎ターン進む。
        //    その年数に応じた確率でメルトダウン事故が発生する(§24)。都市を消滅させるほどの
        //    威力にはせず、Math.max(1,...)でHP・人口は必ず1以上残す(致命傷にはしない設計)。
        //    原子炉自体は失われる(再建は満額コストの新規建設)。
        if (city.nuclearPowerPlant) {
            city.nuclearPowerPlantAge = (city.nuclearPowerPlantAge ?? 0) + 1;
            const meltdownRisk = Math.min(100, city.nuclearPowerPlantAge * NUCLEAR_MELTDOWN_RISK_PER_TURN);
            if (Math.random() * 100 < meltdownRisk) {
                city.hp = Math.max(1, (city.hp ?? CITY_MAX_HP) - Math.round(CITY_MAX_HP * 0.5));
                city.population = Math.max(1, city.population - 1);
                city.nuclearPowerPlant = false;
                city.nuclearPowerPlantAge = undefined;
                broadcast(`§4*** [Meltdown] 【${city.name}】で原子炉のメルトダウンが発生しました！ (都心HP半減、人口-1、原子炉は失われました) ***`);
            }
        }

        // 💡 (簡素化) 発電所IDを直書きせず、exclusiveGroup:"powerPlant"を持つ定義から動的に導出する
        //    (districts.jsのtickDistrictConstructionの排他切り替えロジックと同じ導出元を使うことで、
        //    将来4つ目の発電所を追加してもここの修正が不要になる)。
        const plantId = Object.keys(DISTRICT_BUILDING_DEFS).find(id => DISTRICT_BUILDING_DEFS[id].exclusiveGroup === "powerPlant" && city[id]);
        if (!plantId) continue;
        const def = DISTRICT_BUILDING_DEFS[plantId];

        const stock = player?.getDynamicProperty(def.fuelResource) ?? 0;
        if (stock < 1) {
            summaryReport.push(`§7[Power]【${city.name}】の${def.label}は燃料「${def.fuelLabel}」が不足しているため、今ターンは発電されませんでした。`);
            continue;
        }
        player.setDynamicProperty(def.fuelResource, stock - 1);
        player.setDynamicProperty("strategic_co2", (player.getDynamicProperty("strategic_co2") ?? 0) + (def.co2PerTurn ?? 0));

        if (def.ownCityBonus?.production) cityProductionIncomes[it.ownCityKey] = (cityProductionIncomes[it.ownCityKey] ?? 0) + def.ownCityBonus.production;
        if (def.ownCityBonus?.science) extraScience += def.ownCityBonus.science;

        for (const neighbor of getAdjacentTileEntries(it.tx, it.tz, tiles)) {
            const neighborKey = `${neighbor.tx},${neighbor.tz}`;
            if (!playerCityKeys.has(neighborKey)) continue;
            cityPowerReceived[neighborKey] = (cityPowerReceived[neighborKey] ?? 0) + def.powerOutput;
            (cityPowerSources[neighborKey] ??= []).push({ plantLabel: def.label, fromCityName: city.name, amount: def.powerOutput });
        }
    }

    for (const c of playerCities) {
        c.tile.city.powerReceived = cityPowerReceived[c.key] ?? 0;
        c.tile.city.powerSources = cityPowerSources[c.key] ?? [];
    }

    // 💡 フェーズ2: 工場。隣接する自国都市の生産力+3、工場の所属都市が受け取っている電力2ごとに
    //    さらに+3(所属都市自身が工場に隣接していれば、そこにも同じルールでボーナスが乗る)。
    for (const it of industrialTiles) {
        if (!it.city?.factory) continue;
        const power = cityPowerReceived[it.ownCityKey] ?? 0;
        const bonus = 3 + 3 * Math.floor(power / 2);
        for (const neighbor of getAdjacentTileEntries(it.tx, it.tz, tiles)) {
            const neighborKey = `${neighbor.tx},${neighbor.tz}`;
            if (!playerCityKeys.has(neighborKey)) continue;
            cityProductionIncomes[neighborKey] = (cityProductionIncomes[neighborKey] ?? 0) + bonus;
        }
    }

    return extraScience;
}

/**
 * 天災イベント。自国のCO2蓄積量(strategic_co2)が閾値を超えていると、毎ターン一定確率で
 * ランダムな自国の都市に「干ばつ」が発生し、蓄積食料の一部を失う。CO2を出していない
 * プレイヤーには一切影響しない(applyIndustrialInfrastructureと同じ「原因が無ければ
 * 完全に無関係」という設計方針)。都市を詰ませない(foodStorageは0未満にならない)ため、
 * 原子力事故と違い都心HP・人口には影響しない、比較的軽い一回性イベント。
 */
function applyClimateDisasters(playerId, player, playerCities, summaryReport) {
    if (!playerCities.length) return;
    const co2 = player?.getDynamicProperty("strategic_co2") ?? 0;
    if (co2 < CLIMATE_DISASTER_CO2_THRESHOLD) return;

    const chance = Math.min(CLIMATE_DISASTER_CHANCE_CAP, Math.floor((co2 - CLIMATE_DISASTER_CO2_THRESHOLD) / 50) * CLIMATE_DISASTER_CHANCE_PER_50_CO2);
    if (Math.random() * 100 >= chance) return;

    const target = playerCities[Math.floor(Math.random() * playerCities.length)];
    const city = target.tile.city;
    const lost = Math.min(city.foodStorage ?? 0, CLIMATE_DISASTER_FOOD_LOSS);
    city.foodStorage = Math.max(0, (city.foodStorage ?? 0) - CLIMATE_DISASTER_FOOD_LOSS);
    broadcast(`§6*** [Drought] 【${city.name}】で異常気象による干ばつが発生しました！ (CO2蓄積:${co2}、蓄積食料-${lost}) ***`);
    summaryReport.push(`§6[Drought]【${city.name}】干ばつにより蓄積食料が${lost}失われました。`);
}

function countCheatingBlocks(dimension, tiles, tx, tz, config) {
    const tile = tiles[`${tx},${tz}`]; let extraFood = 0, extraProd = 0;
    if (tile?.resource === "wheat" || tile?.resource === "fish") extraFood++;
    if (["iron", "coal", "diamonds", "gold_ore"].includes(tile?.resource)) extraProd++;
    if (!config) return { extraFood, extraProd };
    const baseX = config.originX + tx * TILE_SIZE, baseZ = config.originZ + tz * TILE_SIZE;
    for (let x=0;x<TILE_SIZE;x++) for (let z=0;z<TILE_SIZE;z++) for (let yOffset=0;yOffset<=2;yOffset++) {
        const block=dimension.getBlock({x:baseX+x,y:config.ySurface+yOffset,z:baseZ+z}); if(!block) continue;
        if(block.typeId.includes("wheat")||block.typeId==="minecraft:hay_block") extraFood++;
        if(block.typeId==="minecraft:iron_ore"||block.typeId==="minecraft:gold_ore") extraProd++;
        if(block.typeId==="minecraft:magma") extraProd+=2;
    }
    return {extraFood,extraProd};
}

function getAssignedTilesForPlayer(playerId, tiles) {
    syncTurnCaches();
    const cached = cityAssignmentCache.get(playerId);
    if (cached) return cached;
    const cities=[], owned=[];
    for(const key in tiles){const t=tiles[key];if(t.ownerId!==playerId)continue;const [tx,tz]=key.split(",").map(Number);owned.push({key,tile:t,tx,tz});if(t.city)cities.push({key,tx,tz});}
    const byCity=new Map(cities.map(c=>[c.key,[]]));
    if(cities.length){for(const t of owned){let min=Infinity,nearest=null;for(const c of cities){const d=Math.abs(t.tx-c.tx)+Math.abs(t.tz-c.tz);if(d<min){min=d;nearest=c.key;}}if(nearest)byCity.get(nearest).push(t);}}
    for(const list of byCity.values()) list.sort((a,b)=>(b.tile.foodYield??0)+(b.tile.productionYield??0)-(a.tile.foodYield??0)-(a.tile.productionYield??0));
    cityAssignmentCache.set(playerId,byCity);
    return byCity;
}

export function getCityCurrentYields(cityKey, tiles) {
    syncTurnCaches();
    const cityTile=tiles[cityKey]; if(!cityTile?.city)return{food:0,production:1,oil:0,faith:0,iron:0,science:0,horse:0,gold:0,coal:0,uranium:0};
    const cached=cityYieldCache.get(cityKey); if(cached)return cached;
    const assignedTiles=getAssignedTilesForPlayer(cityTile.ownerId,tiles).get(cityKey)??[];
    const maxWorkers=Math.min(cityTile.city.population,assignedTiles.length);
    let food=0,production=0,oil=0,iron=0,science=0,gold=GOLD_BASE_PER_CITY,coal=0,uranium=0,faith=cityTile.city.population; // 💡 都心は毎ターン基礎ゴールド(§23。キャンプ/プランテーションとは別枠)
    // 💡 石油と同じく、石炭・ウランも専用施設なしで「資源のあるマスが労働されていれば毎ターン自動収入」
    //    (§24。発電所の燃料、ウランはミサイル/対空砲の生産にも消費される)。
    for(let i=0;i<maxWorkers;i++){const wt=assignedTiles[i].tile;food+=wt.foodYield??0;production+=wt.productionYield??0;if(wt.resource==="oil")oil++;if(wt.resource==="coal")coal++;if(wt.resource==="uranium")uranium++;if(isLuxuryResource(wt.resource))gold+=GOLD_PER_LUXURY_RESOURCE;}
    const config=getMapConfig(),dimension=world.getDimension("overworld");
    for(const t of assignedTiles){const c=countCheatingBlocks(dimension,tiles,t.tx,t.tz,config);food+=c.extraFood;production+=c.extraProd;}
    const ownerHandle=getCivStorageHandle(cityTile.ownerId);
    if(ownerHandle&&hasCompletedProgress(ownerHandle,"civic","codeOfLaws"))food++;
    // 💡 CO2による環境ペナルティ(§24)。倍率適用前のfoodから引くことで、他の産出量と同じく
    //    §6の産出倍率が自動的に乗る(個別の特別扱い不要)。
    const co2=ownerHandle?.getDynamicProperty("strategic_co2")??0;
    if(co2>0)food-=Math.min(CO2_FOOD_PENALTY_CAP,Math.floor(co2/CO2_FOOD_PENALTY_PER));
    const [cityTx,cityTz]=cityKey.split(",").map(Number);
    // 💡 施設/区域/建造物/区域専用建造物のflatYields・隣接ボーナス・人口比例ボーナスは、
    //    いずれも { food, production, oil, faith, iron } の一部を返す同じ形なので、まとめてループで合算する
    //    (新しいボーナス源を追加しても、ここに1行足すだけでよい)。
    const facilityFlatYields=getFacilityFlatYields(assignedTiles);
    const sources=[
        getFlagFlatYields(cityTile.city,PRODUCTION_DEFS,"building"),
        getDistrictBuildingFlatYields(cityTile.city),
        getBuildingAdjacencyYields(cityTx,cityTz,tiles,cityTile.city,PRODUCTION_DEFS),
        getFacilityAdjacencyYields(assignedTiles,tiles),
        facilityFlatYields,
        getFacilityResourceYields(assignedTiles),
        getDistrictAdjacencyYields(assignedTiles,tiles),
        getDistrictFlatYields(assignedTiles),
        getDistrictPopulationYields(assignedTiles,cityTile.city.population),
    ];
    const totals={food,production,oil,faith,iron,science,horse:0,gold,coal,uranium};
    for(const src of sources)for(const key of YIELD_KEYS)totals[key]+=src[key]??0;
    const multiplier=getMatchSettings().yieldMultiplier??DEFAULT_YIELD_MULTIPLIER;
    const result={};
    for(const key of YIELD_KEYS)result[key]=(key==="production"?Math.max(1,totals[key]):totals[key])*multiplier;
    // 💡 getCityGoldBreakdownがfacilityGoldの内訳を再計算せずに済むよう、キャッシュされるresultに
    //    直接載せておく(assignedTilesに対するgetFacilityFlatYieldsの再走査を避ける)。
    result._facilityGold=(facilityFlatYields.gold??0)*multiplier;
    // 💡 交易路のfood/goldボーナス(route.bonus/goldBonusは接続時点で既にmultiplier込み)は、
    //    ここで最終結果に直接足す(totalsの時点で足すと上のmultiplierが二重に掛かってしまう)。
    const tradeBonus=getCityTradeBonus(cityKey,tiles);
    result.food+=tradeBonus.food;
    result.gold+=tradeBonus.gold;
    cityYieldCache.set(cityKey,result);return result;
}

/**
 * 表示用: 指定した都市のゴールド産出量(§23)の内訳を返す。getCityCurrentYieldsのgold算出
 * ロジックのうち「都心の基礎+3」「高級資源のあるマス(労働時)+3ずつ」「施設(キャンプ/
 * プランテーション等)のflatYields.gold」を個別に再計算して返す。合計は必ず
 * getCityCurrentYields(cityKey,tiles).gold と一致させ、まだ内訳化していない将来のゴールド
 * 産出源(建造物/区域など)が追加された場合も other に差分として現れるようにする。
 * @returns {{ base: number, luxuryCount: number, luxuryGold: number, facilityGold: number, other: number, total: number }}
 */
export function getCityGoldBreakdown(cityKey, tiles) {
    const yields = getCityCurrentYields(cityKey, tiles);
    const total = yields.gold;
    const cityTile = tiles[cityKey];
    if (!cityTile?.city) return { base: 0, luxuryCount: 0, luxuryGold: 0, facilityGold: 0, other: 0, total: 0 };

    const assignedTiles = getAssignedTilesForPlayer(cityTile.ownerId, tiles).get(cityKey) ?? [];
    const maxWorkers = Math.min(cityTile.city.population, assignedTiles.length);
    let luxuryCount = 0;
    for (let i = 0; i < maxWorkers; i++) {
        if (isLuxuryResource(assignedTiles[i].tile.resource)) luxuryCount++;
    }

    const multiplier = getMatchSettings().yieldMultiplier ?? DEFAULT_YIELD_MULTIPLIER;
    const base = GOLD_BASE_PER_CITY * multiplier;
    const luxuryGold = luxuryCount * GOLD_PER_LUXURY_RESOURCE * multiplier;
    // 💡 getCityCurrentYieldsが既に計算済みのfacilityFlatYieldsをキャッシュ済みresultに
    //    載せて(_facilityGold)いるので、ここでassignedTilesを再走査しない。
    const facilityGold = yields._facilityGold ?? 0;
    const other = total - base - luxuryGold - facilityGold;
    return { base, luxuryCount, luxuryGold, facilityGold, other, total };
}

/** getCityGoldBreakdown()の結果を「都心+3、高級資源x2+6」のような表示用テキストに整形する。 */
export function formatGoldBreakdownText(b) {
    const parts = [`都心+${b.base}`];
    if (b.luxuryGold > 0) parts.push(`高級資源x${b.luxuryCount}+${b.luxuryGold}`);
    if (b.facilityGold > 0) parts.push(`施設+${b.facilityGold}`);
    if (b.other > 0) parts.push(`他+${b.other}`);
    return parts.join("、");
}

export function connectTradeRoutes(ownerKey,city,tiles){const multiplier=getMatchSettings().yieldMultiplier??DEFAULT_YIELD_MULTIPLIER;const originOwnerId=tiles[ownerKey]?.ownerId;const [ox,oz]=ownerKey.split(",").map(Number);let minDist=Infinity,nearest=[];for(const key in tiles){if(key===ownerKey)continue;const t=tiles[key];if(!t.city)continue;const [tx,tz]=key.split(",").map(Number),dist=Math.abs(ox-tx)+Math.abs(oz-tz);if(dist<minDist){minDist=dist;nearest=[key];}else if(dist===minDist)nearest.push(key);}city.tradingPost.routes=[];for(const targetKey of nearest){const targetCity=tiles[targetKey].city;let baseTurns=minDist,bonus=2*multiplier;if(targetCity.tradingPost?.status==="active"){if(baseTurns===1)bonus=4*multiplier;else baseTurns=Math.max(1,Math.floor(baseTurns/2));}
    // 💡 接続先の都市にキャンパス(区域)があれば、この交易路の科学力ボーナスを追加する
    //    (processPlayerTurnStartが route.scienceBonus を読んで技術ポイントに合算する)。
    const scienceBonus=hasCityDistrict(targetKey,"campus",tiles)?1*multiplier:0;
    // 💡 対外交易(接続先が別の国家)は通常の2倍のゴールドボーナス。他国と交易する動機付け。
    const isForeign=tiles[targetKey].ownerId!==originOwnerId;
    const goldBonus=(isForeign?2:1)*multiplier;
    city.tradingPost.routes.push({targetKey,remainingTurns:baseTurns,bonus,scienceBonus,goldBonus});}}

export function calculateCityFoodIncomes(playerId){const tiles=getTiles(),cities=[],owned=[];for(const key in tiles){const tile=tiles[key];if(tile.ownerId!==playerId)continue;const [tx,tz]=key.split(",").map(Number);if(tile.city)cities.push({key,tile,tx,tz,assignedCount:0});owned.push({key,tile,tx,tz,assignedCities:[]});}const incomes={};for(const c of cities)incomes[c.key]=0;if(!cities.length)return incomes;for(const t of owned){let min=Infinity,nearest=[];for(const c of cities){const d=Math.abs(t.tx-c.tx)+Math.abs(t.tz-c.tz);if(d<min){min=d;nearest=[c];}else if(d===min)nearest.push(c);}t.assignedCities=nearest;for(const c of nearest)c.assignedCount++;}for(const t of owned){let left=t.tile.foodYield??1;if(!t.assignedCities.length)continue;t.assignedCities.sort((a,b)=>a.assignedCount-b.assignedCount);let i=0;while(left-->0){const c=t.assignedCities[i++%t.assignedCities.length];incomes[c.key]=(incomes[c.key]??0)+1;}}for(const key in tiles){const t=tiles[key];if(t.city?.tradingPost?.status==="active"&&t.city.tradingPost.routes)for(const route of t.city.tradingPost.routes){if(t.ownerId===playerId)incomes[key]=(incomes[key]??0)+route.bonus;if(tiles[route.targetKey]?.ownerId===playerId)incomes[route.targetKey]=(incomes[route.targetKey]??0)+route.bonus;}}return incomes;}

export function destroyCity(tiles,cityKey,config,dimension){const target=tiles[cityKey];if(!target?.city)return;const playerId=target.ownerId;
    // 💡 世界遺産(新要素): 建設中だった都市が消滅(食料不足/ミサイル)した場合、予約を解放
    //    しないと誰も二度と建設できない遺産になってしまうため、ここで解放する。
    // 💡 (バグ修正) 建設中(city.production)だけでなく完成済みの世界遺産(city.pyramids等)も
    //    この都市が消滅すると同時に永久ロックされてしまっていたため、あわせて解放する。
    const productionId=target.city.production?.id;
    if(productionId&&PRODUCTION_DEFS[productionId]?.isWonder)releaseWonder(productionId,playerId);
    releaseCityCompletedWonders(target.city,playerId);
    const cities=[];for(const key in tiles){const t=tiles[key];if(t.ownerId===playerId&&t.city&&key!==cityKey){const [x,z]=key.split(",").map(Number);cities.push({key,x,z});}}
    // 都市一覧を1回だけ作り、各所有タイルについて「破壊都市への距離が、生存都市も含めた最短距離と
    // 同着(タイあり)かどうか」を判定する。同着なら(生存都市が単独最短でない限り)所有権を失う。
    const [cx,cz]=cityKey.split(",").map(Number);
    for(const key in tiles){const t=tiles[key];if(t.ownerId!==playerId)continue;const [x,z]=key.split(",").map(Number);const targetDist=Math.abs(x-cx)+Math.abs(z-cz);let min=targetDist;for(const c of cities){const d=Math.abs(x-c.x)+Math.abs(z-c.z);if(d<min)min=d;}if(min===targetDist){t.ownerId=null;t.ownerName=null;t.city=null;}}
    if(dimension){const baseX=config.originX+cx*TILE_SIZE+2,baseZ=config.originZ+cz*TILE_SIZE+2;dimension.getBlock({x:baseX,y:config.ySurface+1,z:baseZ})?.setPermutation(BlockPermutation.resolve("minecraft:air"));}
    target.city=null;target.ownerId=null;target.ownerName=null;
}

function getAliveCivIds(turn,tiles){const alive=new Set();for(const key in tiles){const t=tiles[key];if(t.city&&t.ownerId)alive.add(t.ownerId);}return(Array.isArray(turn?.playerOrder)?turn.playerOrder:[]).filter(id=>alive.has(id));}
function hasEverFoundedCapital(civId){const h=getCivStorageHandle(civId);return!!h&&h.getDynamicProperty("civ:hasFoundedCapital")===true;}
function awardVictoryPoints(civIds){for(const id of civIds){const h=getCivStorageHandle(id);if(!h)continue;h.setDynamicProperty("civ:victoryPoints",(h.getDynamicProperty("civ:victoryPoints")??0)+1);}}
// 💡 commands.js のゴールドによる即時購入(cmdRushBuyProduction)がtickProduction呼び出しの
//    ctxを組み立てる際、通常のターン経過による完成(processPlayerTurnStart内)と全く同じ
//    isAllied判定を再利用できるようexportしている。
export function isAlliedOrSameCiv(a,b){if(!a||!b)return false;if(a===b)return true;const h=getCivStorageHandle(a);return!!h&&getRelation(h,b)==="alliance";}
function areAllMutuallyAllied(ids){for(let i=0;i<ids.length;i++){const h=getCivStorageHandle(ids[i]);if(!h)return false;for(let j=0;j<ids.length;j++)if(i!==j&&getRelation(h,ids[j])!=="alliance")return false;}return true;}
function checkReligiousVictory(aliveIds,tiles){const by={};for(const id of aliveIds)by[id]=[];for(const key in tiles){const t=tiles[key];if(t.city&&by[t.ownerId])by[t.ownerId].push({key,tile:t});}const religions={};for(const id of aliveIds)religions[id]=getNationalDominantReligion(by[id]);for(const id of aliveIds){const h=getCivStorageHandle(id);if(h&&hasFoundedReligion(h)&&aliveIds.every(x=>religions[x]===id))return id;}return null;}

export function checkAndAnnounceVictory(tiles){const turn=getTurnState();if(!turn.started||!Array.isArray(turn.playerOrder)||turn.playerOrder.length<2)return false;const allTiles=tiles??getTiles(),aliveIds=getAliveCivIds(turn,allTiles);if(!aliveIds.length)return false;if(turn.playerOrder.some(id=>!hasEverFoundedCapital(id)))return false;if(aliveIds.length===1){const n=resolveCivName(aliveIds[0])??"不明な国家";awardVictoryPoints(aliveIds);world.sendMessage(`§6*** 勝利！ §a【${n}】§6が唯一残った国家となりました！(ソロ勝利、勝利ポイント+1) ***`);resetGameState();return true;}const religiousWinnerId=checkReligiousVictory(aliveIds,allTiles);if(religiousWinnerId){const n=resolveCivName(religiousWinnerId)??"不明な国家",h=getCivStorageHandle(religiousWinnerId),r=getReligionName(h)??"その宗教";awardVictoryPoints([religiousWinnerId]);world.sendMessage(`§6*** 勝利！ §d【${n}】§6の【${r}】が全世界に広まりました！(宗教勝利、勝利ポイント+1) ***`);resetGameState();return true;}if(turn.playerOrder.length>=4&&areAllMutuallyAllied(aliveIds)){const n=aliveIds.map(id=>resolveCivName(id)??"不明な国家").join("、");awardVictoryPoints(aliveIds);world.sendMessage(`§6*** 勝利！ §b【${n}】§6の同盟が、他のすべての国家を退けました！(同盟勝利、勝利ポイント+1) ***`);resetGameState();return true;}return false;}

// 💡 対空砲(city.antiAir)による迎撃判定: 着弾地点/攻撃先地点(自身を含む)からマス距離1以内に、
//    攻撃側と戦争状態にある(=敵対空砲)、今ターンまだ迎撃を使っていない対空砲を持つ都市が
//    あれば撃墜する(爆発演出・都市破壊は発生しない)。見つかった最初の1つを使用済みにして
//    返す(呼び出し元でtilesを保存させる)。ミサイル(resolveMissileImpact、下記)だけでなく、
//    空軍ユニットの攻撃(commands.jsのcmdAttackCombatUnit/cmdAttackCity)からも呼ばれる
//    共通のヘルパー。
// 💡 (バグ修正) attackerOwnerIdとの外交関係(isAtWar)を見ずに「周囲1マス以内の対空砲」を
//    無条件に敵とみなしていたため、自国や無関係な第三国の対空砲にまで攻撃側の空軍ユニットが
//    誤って撃墜されてしまっていた(README§17が明記する「敵対空砲」の条件を満たしていなかった)。
export function findInterceptingAntiAirCity(tiles,targetTx,targetTz,attackerOwnerId){for(const key in tiles){const t=tiles[key];if(!t.city?.antiAir||t.city.antiAirUsedThisTurn)continue;if(!t.ownerId||t.ownerId===attackerOwnerId||!isAtWar(attackerOwnerId,t.ownerId))continue;const[dtx,dtz]=key.split(",").map(Number);if(Math.max(Math.abs(dtx-targetTx),Math.abs(dtz-targetTz))>1)continue;return{key,city:t.city};}return null;}

export function resolveMissileImpact(config,targetTx,targetTz,attackerOwnerId){const tiles=getTiles();const interceptor=findInterceptingAntiAirCity(tiles,targetTx,targetTz,attackerOwnerId);if(interceptor){interceptor.city.antiAirUsedThisTurn=true;setTiles(tiles);return`§b[AntiAir]【${interceptor.city.name}】の対空砲が (${targetTx}, ${targetTz}) へのミサイルを迎撃しました！`;}const dimension=world.getDimension("overworld"),centerX=config.originX+targetTx*TILE_SIZE+2,centerZ=config.originZ+targetTz*TILE_SIZE+2,centerY=config.ySurface+2;try{dimension.spawnParticle("minecraft:huge_explosion_emitter",{x:centerX,y:centerY,z:centerZ});}catch(e){}try{dimension.playSound("random.explode",{x:centerX,y:centerY,z:centerZ},{volume:4,pitch:0.8});}catch(e){}const targetKey=`${targetTx},${targetTz}`,targetTile=tiles[targetKey];if(!targetTile?.city)return`§7[Missile] (${targetTx}, ${targetTz}) に着弾しましたが、そこに都市はありませんでした。`;const cityName=targetTile.city.name,ownerName=targetTile.ownerName??"不明";destroyCity(tiles,targetKey,config,dimension);setTiles(tiles);checkAndAnnounceVictory(tiles);return`§c[Impact] 【${cityName}】(${ownerName})がミサイル攻撃により破壊されました！`;}

// 💡 (バグ修正) 呼び出し元(startGame/endTurn/forceEndTurn)は、advanceToNextControllablePlayerが
//    false(=参加者全員がオフラインで誰も操作できない)を返した場合、この関数を呼んではいけない。
//    getCivStorageHandle(playerId)がnullになり(playerCitiesが非空なら早期returnされないため)、
//    tickProduction経由の資源消費チェック(production.js)がnullのプレイヤーハンドルを在庫0として
//    誤って生産を「資源不足」でキャンセルしてしまう。
function processPlayerTurnStart(playerId){const config=getMapConfig();if(!config)return;const tiles=getTiles();if(checkAndAnnounceVictory(tiles))return;const player=getCivStorageHandle(playerId);const playerCities=[];let movementRefreshed=false;for(const key in tiles){const t=tiles[key],unit=t.combatUnit;if(unit?.ownerId===playerId){unit.movementRemaining=unit.movement??0;movementRefreshed=true;}const religiousUnit=t.religiousUnit;if(religiousUnit?.ownerId===playerId){religiousUnit.movementRemaining=religiousUnit.movement??0;religiousUnit.hasProselytizedThisTurn=false;religiousUnit.hasAttackedThisTurn=false;movementRefreshed=true;}if(t.ownerId===playerId&&t.city){t.city.missileLaunchedThisTurn=false;t.city.antiAirUsedThisTurn=false;t.city.rangedAttackUsedThisTurn=false;const[ctx,ctz]=key.split(",").map(Number);if(!isCityBesieged(ctx,ctz,playerId,tiles)&&(t.city.hp??CITY_MAX_HP)<CITY_MAX_HP)t.city.hp=Math.min(CITY_MAX_HP,(t.city.hp??CITY_MAX_HP)+CITY_HP_REGEN_PER_TURN);t.city.attackedRecently=false;playerCities.push({key,tile:t});}}if(!playerCities.length){if(movementRefreshed)setTiles(tiles);return;}
    // 💡 §航空戦。航空ユニットはtile.combatUnitではなくcity.airbase.unitsに配置されるため、
    //    上のプレイヤー所有タイルのループでは触れられない。専用のヘルパー(airbase.js)で
    //    ターン開始時の回復(前ターン行動しなかったユニットのみ)とactedThisTurn等のリセットを行う。
    resetAndHealBasedAirUnitsForTurn(playerId, tiles);
    const summaryReport=[],dimension=world.getDimension("overworld"),cityFoodIncomes={},cityProductionIncomes={},cityFaithIncomes={};const strategicIncomes={};for(const r of STRATEGIC_RESOURCES)strategicIncomes[r.key]=0;
    // 💡 キャンパス(区域)由来の科学力は、都市の産出量パイプライン(getCityCurrentYields)経由で
    //    計算されるが、他のyieldと違って都市には蓄積されず、人口由来の科学力(totalPop)と
    //    合算して国家全体の技術ポイントとしてgrantProgressPointsへ直接渡す(下記参照)。
    let totalDistrictScience=0;
    for(const c of playerCities){const y=getCityCurrentYields(c.key,tiles);cityFoodIncomes[c.key]=y.food;cityProductionIncomes[c.key]=y.production;cityFaithIncomes[c.key]=y.faith??0;totalDistrictScience+=y.science??0;for(const r of STRATEGIC_RESOURCES)strategicIncomes[r.key]+=y[r.key]??0;c.tile.city.currentTurnProduction=y.production;}
    // 💡 工業地帯の工場・発電所(§24)。cityProductionIncomesをその場で書き換え、燃料消費/CO2蓄積/
    //    原子炉の老朽化も1ターンに1回だけここで処理する(自国の都市にのみ影響)。
    totalDistrictScience+=applyIndustrialInfrastructure(playerId,player,tiles,playerCities,cityProductionIncomes,summaryReport);
    applyClimateDisasters(playerId,player,playerCities,summaryReport);
    // 💡 交易路の食料・ゴールドボーナスは getCityTradeBonus 経由で getCityCurrentYields の
    //    food/goldに既に織り込み済み(上のループのy.food/y.goldが正)なので、ここでは
    //    二重加算しない。科学力だけは都市に蓄積されない国家直属の技術ポイントのため
    //    (getCityCurrentYieldsのscienceには乗らない)、ここで直接合算する。
    //    (バグ修正: 以前はここでも食料・ゴールドを直接加算していたため、HUD/ゴールド内訳
    //    (getCityCurrentYields/getCityGoldBreakdown)には交易収入が一切反映されていなかった)
    let totalTradeScience=0;
    // 💡 remainingTurnsの減算・期限切れ時の再接続(connectTradeRoutes再実行)は、自国の交易所に
    //    ついてのみ行う(t.ownerId===playerId)。他プレイヤーのターン開始時に同じルートが
    //    二重に減算されるのを防ぐため。科学力ボーナス自体は接続元・接続先どちらの所有者にも配られる。
    for(const key in tiles){const t=tiles[key];if(t.city?.tradingPost?.status==="active"&&t.city.tradingPost.routes){for(const route of t.city.tradingPost.routes){if(t.ownerId===playerId)totalTradeScience+=route.scienceBonus??0;if(tiles[route.targetKey]?.ownerId===playerId)totalTradeScience+=route.scienceBonus??0;}
        if(t.ownerId===playerId){for(const route of t.city.tradingPost.routes)route.remainingTurns--;if(t.city.tradingPost.routes.some(r=>r.remainingTurns<=0))connectTradeRoutes(key,t.city,tiles);}
    }}
    for(const c of playerCities){const city=c.tile.city;if(!city.production)continue;const r=tickProduction(city,cityProductionIncomes[c.key]??0,{cityKey:c.key,tiles,connectTradeRoutes,isAllied:isAlliedOrSameCiv,player});if(r)summaryReport.push(r.message);}
    for(const c of playerCities){const city=c.tile.city;if(!city.districtConstruction)continue;const r=tickDistrictConstruction(city,cityProductionIncomes[c.key]??0,tiles,c.tile.ownerId);if(r)summaryReport.push(r.message);}
    for(const c of playerCities){const tile=tiles[c.key],city=tile.city,income=cityFoodIncomes[c.key]??0,faithIncome=cityFaithIncomes[c.key]??0;if(faithIncome){city.faithStorage=(city.faithStorage??0)+faithIncome;summaryReport.push(`§d[Faith]【${city.name}】信仰力+${faithIncome}(累計: ${city.faithStorage})`);}const def=city.production?PRODUCTION_DEFS[city.production.id]:null,consumption=city.population+(def?.extraUpkeep??0);city.foodStorage=(city.foodStorage??0)+income-consumption;let grow=false,blocked=false;if(city.foodStorage<0){city.starvationTurns=(city.starvationTurns??0)+1;city.foodStorage=0;if(city.starvationTurns>=3){city.population--;city.starvationTurns=0;if(city.population<=0){destroyCity(tiles,c.key,config,dimension);summaryReport.push(`§c[Fail]【${city.name}】が食料不足により崩壊しました！`);continue;}summaryReport.push(`§c[Warning]【${city.name}】食料飢餓により人口が ${city.population} に減少！`);}else summaryReport.push(`§c[Warning]【${city.name}】食料不足！(あと ${3-city.starvationTurns} ターンで人口減少)`);}else{city.starvationTurns=0;const threshold=10+(city.population-1)*2;if(city.foodStorage>=threshold){if(city.population<city.housing){city.population++;city.foodStorage-=threshold;grow=true;}else{city.foodStorage=threshold-1;blocked=true;}}let msg=`§7[${city.name}]§f 選択マスからの収穫:+${income} [Food] | 消費:-${consumption} [Food] | 貯留: ${city.foodStorage}/${threshold}`;if(grow)msg+=` [Complete]§a人口が ${city.population} に増加！`;else if(blocked)msg+=` [Warning]§e住宅制限(上限:${city.housing})のため成長停止！`;summaryReport.push(msg);}tiles[c.key]=tile;}
    setTiles(tiles);if(checkAndAnnounceVictory(tiles))return;if(player){if(hasFoundedReligion(player))for(const key in tiles){const t=tiles[key];if(!isSacredSiteTile(t,playerId))continue;const cityTile=t.belongsToCityKey?tiles[t.belongsToCityKey]:null;if(cityTile?.city)applySacredSitePressure(cityTile.city,playerId);}let totalPop=0;for(const c of playerCities)totalPop+=c.tile.city.population;const tr=grantProgressPoints(player,"technology",totalPop+totalDistrictScience+totalTradeScience),cr=grantProgressPoints(player,"civic",totalPop);if(tr)summaryReport.unshift(tr);if(cr)summaryReport.unshift(cr);addGreatPersonPoints(player,totalPop+totalDistrictScience+totalTradeScience,totalPop,Object.values(cityFaithIncomes).reduce((a,b)=>a+b,0));for(const r of STRATEGIC_RESOURCES){const income=strategicIncomes[r.key];if(income>0){const stock=(player.getDynamicProperty(r.prop)??0)+income;player.setDynamicProperty(r.prop,stock);summaryReport.unshift(`${r.prefix}${r.label}収入: +${income} 個を獲得！ (現在の在庫: ${stock} 個)`);}}const goldUpkeep=calculateGoldUpkeep(playerId,tiles);const goldAfterUpkeep=(player.getDynamicProperty("strategic_gold")??0)-goldUpkeep;if(goldUpkeep>0){player.setDynamicProperty("strategic_gold",goldAfterUpkeep);summaryReport.push(`§6[Gold] 維持費: -${goldUpkeep}(残高: ${goldAfterUpkeep})`);}const disbandedUnits=applyGoldBankruptcy(playerId,goldAfterUpkeep,tiles);if(disbandedUnits.length){setTiles(tiles);for(const d of disbandedUnits){const[dtx,dtz]=d.key.split(",").map(Number);refreshUnitLabelAt(dtx,dtz);summaryReport.push(`§4[Bankruptcy]【${d.unit.label??d.unit.id}】が財政破綻(残高: ${goldAfterUpkeep})により強制解散されました！`);}}if(getMatchSettings().logsEnabled){player.sendMessage("§6=== [Report] 都市のターン報告 ===");summaryReport.forEach(m=>player.sendMessage(m));player.sendMessage("§6========================");}}}

export function joinGame(player){const turn=getTurnState();if(turn.started)return{ok:false,message:"§cゲーム進行中です。"};if(turn.playerOrder.includes(player.id))return{ok:false,message:"§c参加済みです。"};turn.playerOrder.push(player.id);setTurnState(turn);return{ok:true,message:`§a${player.name} がゲームに参加しました！`};}
export function startGame(){const turn=getTurnState();if(turn.started)return{ok:false,message:"§c既に開始されています。"};if(!turn.playerOrder.length)return{ok:false,message:"§c参加者がいません。"};turn.started=true;turn.currentIndex=0;turn.turnNumber=1;turn.playerRights={};turn.playerColors={};turn.playerOrder.forEach((id,i)=>turn.playerColors[id]=PLAYER_COLORS[i%PLAYER_COLORS.length]);for(const id of turn.playerOrder){const h=getCivStorageHandle(id);if(!h)continue;resetProgress(h,"technology");resetProgress(h,"civic");resetDiplomacy(h);resetReligion(h);h.setDynamicProperty("civ:hasFoundedCapital",false);for(const r of STRATEGIC_RESOURCES)h.setDynamicProperty(r.prop,undefined);h.setDynamicProperty("strategic_co2",undefined);h.setDynamicProperty("civ:greatPersonPoints",undefined);}setTurnState(turn);const t=getTurnState(),found=advanceToNextControllablePlayer(t);setTurnState(t);const id=t.playerOrder[t.currentIndex];if(found)processPlayerTurnStart(id);const name=getPlayerNameById(id)??"不明(オフライン)";broadcast(found?`§e=== ゲームが開始されました！ 手番: §a${name}§e ===`:`§e=== ゲームが開始されました！ §c参加者全員がオフラインのため待機中 ===`);return{ok:true,message:"ゲーム開始"};}
function advanceToNextControllablePlayer(turn){const total=turn.playerOrder.length;if(!total)return false;for(let i=0;i<total;i++){const id=turn.playerOrder[turn.currentIndex];if(isCivControllable(id))return true;turn.currentIndex=(turn.currentIndex+1)%total;if(turn.currentIndex===0)turn.turnNumber++;}return false;}
export function endTurn(player){const turn=getTurnState();if(!turn.started)return{ok:false,message:"§cゲーム未開始です。"};if(player.id!==turn.playerOrder[turn.currentIndex])return{ok:false,message:"§c手番ではありません。"};turn.currentIndex=(turn.currentIndex+1)%turn.playerOrder.length;if(turn.currentIndex===0)turn.turnNumber++;const found=advanceToNextControllablePlayer(turn);setTurnState(turn);const id=turn.playerOrder[turn.currentIndex];if(found)processPlayerTurnStart(id);const name=getPlayerNameById(id)??"不明(オフライン)";broadcast(found?`§e>>> ターン ${turn.turnNumber}: §a${name}§e のターン <<<`:`§e>>> ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中(復帰次第 §a${name}§c から再開) <<<`);return{ok:true,message:"ターン終了"};}
export function forceEndTurn(){const turn=getTurnState();if(!turn.started)return{ok:false,message:"§cゲーム未開始です。"};if(!turn.playerOrder.length)return{ok:false,message:"§c参加者がいません。"};turn.currentIndex=(turn.currentIndex+1)%turn.playerOrder.length;if(turn.currentIndex===0)turn.turnNumber++;const found=advanceToNextControllablePlayer(turn);setTurnState(turn);const id=turn.playerOrder[turn.currentIndex];if(found)processPlayerTurnStart(id);const name=getPlayerNameById(id)??"不明(オフライン)";broadcast(found?`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §a${name}§e のターン <<<`:`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中 <<<`);return{ok:true,message:"ターンを強制終了しました。"};}
export function isPlayersTurn(player){const turn=getTurnState();return!!turn.started&&player.id===turn.playerOrder[turn.currentIndex];}
export function turnInfoText(){const turn=getTurnState();if(!turn.started)return"§7ゲーム開始前 (待機中...)";return`§eターン: ${turn.turnNumber} | 手番: §a${getPlayerNameById(turn.playerOrder[turn.currentIndex])??"未知"}`;}
/**
 * ゲーム終了(手動リセット・勝利)時の共通後片付け。マップ/ターン状態のリセット・
 * ユニットラベルのクリアに加えて、Bot(isBot:trueの仮想国家)を自動的に削除する
 * (次の対戦のたびにOPが手動でBotを片付ける手間を省くため。手動追加したテスト国家は
 * OPが意図的に残している可能性があるため対象外。civs.jsのremoveAllBots参照)。
 */
function resetGameState() {
    resetAll();
    clearAllUnitLabels();
    clearAllUnitModels();
    removeAllBots();
}

export function endGame(playerName){if(!getTurnState().started)return{ok:false,message:"§c未開始です。"};resetGameState();return{ok:true,message:`§c=== ゲームがリセットされました (実行: ${playerName??"不明"}) ===`};}

/**
 * OP専用デバッグ機能: 通常の勝利条件(唯一生存/宗教/同盟)を一切判定せず、指定した国家を
 * 即座に勝利させる。civIds を1つだけ渡せば単独勝利、複数渡せば同盟勝利として扱う。
 * 動作確認・デモ用のショートカットであり、勝利ポイント付与とゲームリセットは通常の
 * 勝利処理(checkAndAnnounceVictory)と同じ挙動にする。
 */
export function debugForceVictory(civIds){
    const turn=getTurnState();
    if(!turn.started)return{ok:false,message:"§cゲーム未開始です。"};
    const ids=(Array.isArray(civIds)?civIds:[civIds]).filter(id=>turn.playerOrder.includes(id));
    if(!ids.length)return{ok:false,message:"§c有効な国家が指定されていません。"};
    const names=ids.map(id=>resolveCivName(id)??"不明な国家").join("、");
    awardVictoryPoints(ids);
    world.sendMessage(`§6***【デバッグ】§a【${names}】§6が管理者操作により即座に勝利しました！(勝利ポイント+1) ***`);
    resetGameState();
    return{ok:true,message:"§aデバッグ勝利を実行しました。"};
}

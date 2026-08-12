// turns.js
import { world, BlockPermutation } from "@minecraft/server";
import { getTurnState, setTurnState, resetAll, getTiles, setTiles, getMapConfig, setTile, getStateVersion } from "./state.js";
import { PRODUCTION_DEFS, tickProduction } from "./production.js";
import { grantProgressPoints, resetProgress } from "./progression.js";
import { resetDiplomacy, getRelation } from "./diplomacy.js";
import { getCivStorageHandle, resolveCivName, isCivControllable } from "./civs.js";
import { getBuildingAdjacencyYields } from "./adjacency.js";
import { getFacilityAdjacencyYields } from "./facilities.js";
import { getDistrictAdjacencyYields, getDistrictPopulationYields, tickDistrictConstruction } from "./districts.js";
import { hasFoundedReligion, getReligionName, getNationalDominantReligion, applySacredSitePressure } from "./religion.js";

export { getTurnState, setTurnState };

const TILE_SIZE = 5;

// 生産量計算はUI更新などから非常に頻繁に呼ばれるため、状態世代ごとに都市単位でキャッシュする。
// state.js の setTile/setTiles/setMapConfig が状態世代を進めるので、ゲーム状態が変わったら自動的に無効化される。
let cityYieldCacheVersion = -1;
const cityYieldCache = new Map();

// 💡 プレイヤー固有の色。ゲーム開始時(startGame)に一度だけ playerOrder の並び順で確定させ、
//    turn.playerColors に保存する。旗の設置処理では毎回ここから色を読み取るだけにすることで、
//    「1ターン中に旗設置関数を複数回呼ぶと色がずれていく」問題を防ぐ。
export const PLAYER_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "cyan", "magenta", "light_blue", "lime"];

/** ゲーム開始時に確定したプレイヤーの固有色を取得する。未確定の場合は white を返す。 */
export function getPlayerColor(playerId) {
    const turn = getTurnState();
    return turn.playerColors?.[playerId] ?? "white";
}

function getPlayerNameById(id) {
    return resolveCivName(id);
}

/**
 * 💡 【ハイブリッド版】mapGenの資源データ ＋ 手動設置ブロックの両方をカウントする関数
 */
function countCheatingBlocks(dimension, tiles, tx, tz, config) {
    const key = `${tx},${tz}`;
    const tile = tiles[key];
    
    let extraFood = 0;
    let extraProd = 0;

    if (!config) {
        if (tile && tile.resource) {
            if (tile.resource === "wheat" || tile.resource === "fish") extraFood += 1;
            if (["iron", "coal", "diamonds", "gold_ore"].includes(tile.resource)) extraProd += 1;
        }
        return { extraFood, extraProd };
    }

    if (tile && tile.resource) {
        if (tile.resource === "wheat" || tile.resource === "fish") extraFood += 1;
        if (["iron", "coal", "diamonds", "gold_ore"].includes(tile.resource)) extraProd += 1;
    }

    const baseX = config.originX + tx * TILE_SIZE;
    const baseZ = config.originZ + tz * TILE_SIZE;

    for (let x = 0; x < TILE_SIZE; x++) {
        for (let z = 0; z < TILE_SIZE; z++) {
            for (let yOffset = 0; yOffset <= 2; yOffset++) {
                const block = dimension.getBlock({
                    x: baseX + x,
                    y: config.ySurface + yOffset,
                    z: baseZ + z
                });
                if (!block) continue;

                if (block.typeId.includes("wheat") || block.typeId === "minecraft:hay_block") extraFood += 1;
                if (block.typeId === "minecraft:iron_ore" || block.typeId === "minecraft:gold_ore") extraProd += 1;
                if (block.typeId === "minecraft:magma") extraProd += 100;
            }
        }
    }

    return { extraFood, extraProd };
}

export function getCityCurrentYields(cityKey, tiles) {
    const currentVersion = getStateVersion();
    if (currentVersion !== cityYieldCacheVersion) {
        cityYieldCache.clear();
        cityYieldCacheVersion = currentVersion;
    }

    const cityTile = tiles[cityKey];
    if (!cityTile || !cityTile.city) return { food: 0, production: 1, oil: 0, faith: 0 };

    const cached = cityYieldCache.get(cityKey);
    if (cached) return cached;
    
    const playerId = cityTile.ownerId;
    const playerTiles = [];
    const playerCities = [];

    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === playerId) {
            const [tx, tz] = key.split(",").map(Number);
            if (t.city) playerCities.push({ key, tx, tz });
            playerTiles.push({ key, tile: t, tx, tz });
        }
    }

    const assignedTiles = [];
    for (const t of playerTiles) {
        let minDist = Infinity;
        let nearestCityKey = null;
        for (const c of playerCities) {
            const dist = Math.abs(t.tx - c.tx) + Math.abs(t.tz - c.tz);
            if (dist < minDist) { minDist = dist; nearestCityKey = c.key; }
        }
        if (nearestCityKey === cityKey) assignedTiles.push(t);
    }

    assignedTiles.sort((a, b) => {
        const scoreA = (a.tile.foodYield ?? 0) + (a.tile.productionYield ?? 0);
        const scoreB = (b.tile.foodYield ?? 0) + (b.tile.productionYield ?? 0);
        return scoreB - scoreA;
    });

    const maxWorkers = Math.min(cityTile.city.population, assignedTiles.length);
    let food = 0;
    let production = 0;
    let oil = 0;
    let faith = cityTile.city.population;

    for (let i = 0; i < maxWorkers; i++) {
        food += assignedTiles[i].tile.foodYield ?? 0;
        production += assignedTiles[i].tile.productionYield ?? 0;
        if (assignedTiles[i].tile.resource === "oil") oil += 1;
    }

    const config = getMapConfig();
    const dimension = world.getDimension("overworld");

    for (const t of assignedTiles) {
        const cheatIncomes = countCheatingBlocks(dimension, tiles, t.tx, t.tz, config);
        food += cheatIncomes.extraFood;
        production += cheatIncomes.extraProd;
    }

    const ownerHandle = getCivStorageHandle(playerId);
    if (ownerHandle && hasCompletedProgress(ownerHandle, "civic", "codeOfLaws")) food += 1;
    if (cityTile.city.granary) food += 1;
    if (cityTile.city.obelisk) faith += 4;
    if (cityTile.city.shrine) faith += 2;

    const [cityTx, cityTz] = cityKey.split(",").map(Number);
    const adjacencyYields = getBuildingAdjacencyYields(cityTx, cityTz, tiles, cityTile.city, PRODUCTION_DEFS);
    food += adjacencyYields.food ?? 0;
    production += adjacencyYields.production ?? 0;
    oil += adjacencyYields.oil ?? 0;
    faith += adjacencyYields.faith ?? 0;

    const facilityYields = getFacilityAdjacencyYields(assignedTiles, tiles);
    food += facilityYields.food ?? 0;
    production += facilityYields.production ?? 0;
    oil += facilityYields.oil ?? 0;
    faith += facilityYields.faith ?? 0;

    const districtAdjacencyYields = getDistrictAdjacencyYields(assignedTiles, tiles);
    food += districtAdjacencyYields.food ?? 0;
    production += districtAdjacencyYields.production ?? 0;
    oil += districtAdjacencyYields.oil ?? 0;
    faith += districtAdjacencyYields.faith ?? 0;

    const districtPopulationYields = getDistrictPopulationYields(assignedTiles, cityTile.city.population);
    food += districtPopulationYields.food ?? 0;
    production += districtPopulationYields.production ?? 0;
    oil += districtPopulationYields.oil ?? 0;
    faith += districtPopulationYields.faith ?? 0;

    const result = { food, production: Math.max(1, production), oil, faith };
    cityYieldCache.set(cityKey, result);
    return result;
}

// 💡 交易所から最も近い都市（複数あればすべて）へ交易路を伸ばすロジック
export function connectTradeRoutes(ownerKey, city, tiles) {
    const [oxStr, ozStr] = ownerKey.split(",");
    const ox = parseInt(oxStr, 10);
    const oz = parseInt(ozStr, 10);

    let minDist = Infinity;
    let nearestCityKeys = [];

    for (const key in tiles) {
        if (key === ownerKey) continue;
        const t = tiles[key];
        if (t.city) {
            const [txStr, tzStr] = key.split(",");
            const tx = parseInt(txStr, 10);
            const tz = parseInt(tzStr, 10);
            const dist = Math.abs(ox - tx) + Math.abs(oz - tz);

            if (dist < minDist) {
                minDist = dist;
                nearestCityKeys = [key];
            } else if (dist === minDist) {
                nearestCityKeys.push(key);
            }
        }
    }

    city.tradingPost.routes = [];
    if (nearestCityKeys.length === 0) return;

    for (const targetKey of nearestCityKeys) {
        const targetTile = tiles[targetKey];
        const targetCity = targetTile.city;

        let baseTurns = minDist;
        let bonus = 2;
        const targetHasTradingPost = targetCity.tradingPost && targetCity.tradingPost.status === "active";

        if (targetHasTradingPost) {
            if (baseTurns === 1) bonus = 4;
            else baseTurns = Math.max(1, Math.floor(baseTurns / 2));
        }

        city.tradingPost.routes.push({ targetKey: targetKey, remainingTurns: baseTurns, bonus: bonus });
    }
}

export function calculateCityFoodIncomes(playerId) {
    const tiles = getTiles();
    const playerCities = [];
    const playerTiles = [];

    for (const key in tiles) {
        const tile = tiles[key];
        if (tile.ownerId === playerId) {
            const [txStr, tzStr] = key.split(",");
            const tx = parseInt(txStr, 10);
            const tz = parseInt(tzStr, 10);
            if (tile.city) playerCities.push({ key, tile, tx, tz, assignedCount: 0 });
            playerTiles.push({ key, tile, tx, tz, assignedCities: [] });
        }
    }

    const incomes = {};
    for (const c of playerCities) incomes[c.key] = 0;
    if (playerCities.length === 0) return incomes;

    for (const t of playerTiles) {
        let minDist = Infinity;
        let nearest = [];
        for (const c of playerCities) {
            const dist = Math.abs(t.tx - c.tx) + Math.abs(t.tz - c.tz);
            if (dist < minDist) { minDist = dist; nearest = [c]; }
            else if (dist === minDist) nearest.push(c);
        }
        t.assignedCities = nearest;
        for (const c of nearest) c.assignedCount += 1;
    }

    for (const t of playerTiles) {
        let yieldLeft = t.tile.foodYield ?? 1;
        if (t.assignedCities.length === 0) continue;
        t.assignedCities.sort((a, b) => a.assignedCount - b.assignedCount);
        let idx = 0;
        while (yieldLeft > 0) {
            const targetCityItem = t.assignedCities[idx % t.assignedCities.length];
            incomes[targetCityItem.key] = (incomes[targetCityItem.key] ?? 0) + 1;
            idx++;
            yieldLeft--;
        }
    }

    for (const key in tiles) {
        const t = tiles[key];
        if (t.city && t.city.tradingPost && t.city.tradingPost.status === "active" && t.city.tradingPost.routes) {
            for (const route of t.city.tradingPost.routes) {
                if (t.ownerId === playerId) incomes[key] = (incomes[key] ?? 0) + route.bonus;
                if (tiles[route.targetKey] && tiles[route.targetKey].ownerId === playerId) incomes[route.targetKey] = (incomes[route.targetKey] ?? 0) + route.bonus;
            }
        }
    }

    return incomes;
}

export function destroyCity(tiles, cityKey, config, dimension) {
    const [cxStr, czStr] = cityKey.split(",");
    const ctx = parseInt(cxStr, 10);
    const ctz = parseInt(czStr, 10);
    const playerId = tiles[cityKey].ownerId;

    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === playerId) {
            const [txStr, tzStr] = key.split(",");
            const tx = parseInt(txStr, 10);
            const tz = parseInt(tzStr, 10);
            let minDist = Infinity;
            let nearestKeys = [];
            for (const k2 in tiles) {
                if (tiles[k2].ownerId === playerId && tiles[k2].city) {
                    const [cx2, cz2] = k2.split(",");
                    const dist = Math.abs(tx - parseInt(cx2, 10)) + Math.abs(tz - parseInt(cz2, 10));
                    if (dist < minDist) { minDist = dist; nearestKeys = [k2]; }
                    else if (dist === minDist) nearestKeys.push(k2);
                }
            }
            if (nearestKeys.includes(cityKey)) {
                t.ownerId = null; t.ownerName = null; t.city = null;
            }
        }
    }
    if (dimension) {
        const baseX = config.originX + ctx * TILE_SIZE + 2;
        const baseZ = config.originZ + ctz * TILE_SIZE + 2;
        dimension.getBlock({ x: baseX, y: config.ySurface + 1, z: baseZ })?.setPermutation(BlockPermutation.resolve("minecraft:air"));
    }
    tiles[cityKey].city = null; tiles[cityKey].ownerId = null; tiles[cityKey].ownerName = null;
}

function getAliveCivIds(turn, tiles) {
    const order = Array.isArray(turn?.playerOrder) ? turn.playerOrder : [];
    return order.filter(id => Object.values(tiles).some(t => t.ownerId === id && t.city));
}

function hasEverFoundedCapital(civId) {
    const handle = getCivStorageHandle(civId);
    return !!handle && handle.getDynamicProperty("civ:hasFoundedCapital") === true;
}

function awardVictoryPoints(civIds) {
    for (const civId of civIds) {
        const handle = getCivStorageHandle(civId);
        if (!handle) continue;
        const current = handle.getDynamicProperty("civ:victoryPoints") ?? 0;
        handle.setDynamicProperty("civ:victoryPoints", current + 1);
    }
}

function isAlliedOrSameCiv(civIdA, civIdB) {
    if (!civIdA || !civIdB) return false;
    if (civIdA === civIdB) return true;
    const handle = getCivStorageHandle(civIdA);
    if (!handle) return false;
    return getRelation(handle, civIdB) === "alliance";
}

function areAllMutuallyAllied(civIds) {
    for (let i = 0; i < civIds.length; i++) {
        const handle = getCivStorageHandle(civIds[i]);
        if (!handle) return false;
        for (let j = 0; j < civIds.length; j++) {
            if (i === j) continue;
            if (getRelation(handle, civIds[j]) !== "alliance") return false;
        }
    }
    return true;
}

function checkReligiousVictory(aliveIds, tiles) {
    const citiesByCiv = {};
    for (const id of aliveIds) citiesByCiv[id] = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.city && aliveIds.includes(t.ownerId)) citiesByCiv[t.ownerId].push({ key, tile: t });
    }

    const nationalReligion = {};
    for (const id of aliveIds) nationalReligion[id] = getNationalDominantReligion(citiesByCiv[id]);

    for (const candidateId of aliveIds) {
        const handle = getCivStorageHandle(candidateId);
        if (!handle || !hasFoundedReligion(handle)) continue;
        if (aliveIds.every(id => nationalReligion[id] === candidateId)) return candidateId;
    }
    return null;
}

export function checkAndAnnounceVictory(tiles) {
    const turn = getTurnState();
    if (!turn.started || !Array.isArray(turn.playerOrder) || turn.playerOrder.length === 0) return false;
    if (turn.playerOrder.length < 2) return false;

    const allTiles = tiles ?? getTiles();
    const aliveIds = getAliveCivIds(turn, allTiles);
    if (aliveIds.length === 0) return false;

    const notYetStarted = turn.playerOrder.filter(id => !hasEverFoundedCapital(id));
    if (notYetStarted.length > 0) return false;

    if (aliveIds.length === 1) {
        const winnerName = resolveCivName(aliveIds[0]) ?? "不明な国家";
        awardVictoryPoints(aliveIds);
        world.sendMessage(`§6★★★ 勝利！ §a【${winnerName}】§6が唯一残った国家となりました！(ソロ勝利、勝利ポイント+1) ★★★`);
        resetAll();
        return true;
    }

    const religiousWinnerId = checkReligiousVictory(aliveIds, allTiles);
    if (religiousWinnerId) {
        const winnerName = resolveCivName(religiousWinnerId) ?? "不明な国家";
        const winnerHandle = getCivStorageHandle(religiousWinnerId);
        const religionName = getReligionName(winnerHandle) ?? "その宗教";
        awardVictoryPoints([religiousWinnerId]);
        world.sendMessage(`§6★★★ 勝利！ §d【${winnerName}】§6の【${religionName}】が全世界に広まりました！(宗教勝利、勝利ポイント+1) ★★★`);
        resetAll();
        return true;
    }

    if (turn.playerOrder.length >= 4 && areAllMutuallyAllied(aliveIds)) {
        const names = aliveIds.map(id => resolveCivName(id) ?? "不明な国家").join("、");
        awardVictoryPoints(aliveIds);
        world.sendMessage(`§6★★★ 勝利！ §b【${names}】§6の同盟が、他のすべての国家を退けました！(同盟勝利、勝利ポイント+1) ★★★`);
        resetAll();
        return true;
    }

    return false;
}

export function resolveMissileImpact(config, targetTx, targetTz) {
    const dimension = world.getDimension("overworld");
    const centerX = config.originX + targetTx * TILE_SIZE + 2;
    const centerZ = config.originZ + targetTz * TILE_SIZE + 2;
    const centerY = config.ySurface + 2;

    try { dimension.spawnParticle("minecraft:huge_explosion_emitter", { x: centerX, y: centerY, z: centerZ }); } catch (e) {}
    try { dimension.playSound("random.explode", { x: centerX, y: centerY, z: centerZ }, { volume: 4, pitch: 0.8 }); } catch (e) {}

    const tiles = getTiles();
    const targetKey = `${targetTx},${targetTz}`;
    const targetTile = tiles[targetKey];

    if (!targetTile || !targetTile.city) return `§7[Missile] (${targetTx}, ${targetTz}) に着弾しましたが、そこに都市はありませんでした。`;

    const cityName = targetTile.city.name;
    const ownerName = targetTile.ownerName ?? "不明";

    destroyCity(tiles, targetKey, config, dimension);
    setTiles(tiles);
    checkAndAnnounceVictory(tiles);

    return `§c💥 【${cityName}】(${ownerName})がミサイル攻撃により破壊されました！`;
}

function processPlayerTurnStart(playerId) {
    const config = getMapConfig();
    if (!config) return;

    const tiles = getTiles();
    if (checkAndAnnounceVictory(tiles)) return;

    const playerCities = [];
    let movementRefreshed = false;

    for (const key in tiles) {
        const unit = tiles[key].combatUnit;
        if (unit?.ownerId === playerId) {
            unit.movementRemaining = unit.movement ?? 0;
            movementRefreshed = true;
        }
        const religiousUnit = tiles[key].religiousUnit;
        if (religiousUnit?.ownerId === playerId) {
            religiousUnit.movementRemaining = religiousUnit.movement ?? 0;
            religiousUnit.hasProselytizedThisTurn = false;
            movementRefreshed = true;
        }
        if (tiles[key].ownerId === playerId && tiles[key].city) playerCities.push({ key, tile: tiles[key] });
    }
    if (playerCities.length === 0) {
        if (movementRefreshed) setTiles(tiles);
        return;
    }

    const summaryReport = [];
    const dimension = world.getDimension("overworld");

    const cityFoodIncomes = {};
    const cityProductionIncomes = {};
    const cityFaithIncomes = {};
    let totalOilIncome = 0;

    for (const c of playerCities) {
        const yields = getCityCurrentYields(c.key, tiles);
        cityFoodIncomes[c.key] = yields.food;
        cityProductionIncomes[c.key] = yields.production;
        cityFaithIncomes[c.key] = yields.faith ?? 0;
        totalOilIncome += yields.oil ?? 0;
        c.tile.city.currentTurnProduction = yields.production;
    }

    for (const key in tiles) {
        const t = tiles[key];
        if (t.city?.tradingPost?.status === "active" && t.city.tradingPost.routes) {
            for (const route of t.city.tradingPost.routes) {
                if (t.ownerId === playerId) cityFoodIncomes[key] = (cityFoodIncomes[key] ?? 0) + route.bonus;
                if (tiles[route.targetKey]?.ownerId === playerId) cityFoodIncomes[route.targetKey] = (cityFoodIncomes[route.targetKey] ?? 0) + route.bonus;
            }
        }
    }

    for (const c of playerCities) {
        const city = c.tile.city;
        if (!city.production) continue;
        const amount = cityProductionIncomes[c.key] ?? 0;
        const result = tickProduction(city, amount, { cityKey: c.key, tiles, connectTradeRoutes, isAllied: isAlliedOrSameCiv });
        if (result) summaryReport.push(result.message);
    }

    for (const c of playerCities) {
        const city = c.tile.city;
        if (!city.districtConstruction) continue;
        const amount = cityProductionIncomes[c.key] ?? 0;
        const result = tickDistrictConstruction(city, amount, tiles, c.tile.ownerId);
        if (result) summaryReport.push(result.message);
    }

    for (const c of playerCities) {
        const tile = tiles[c.key];
        const city = tile.city;
        const income = cityFoodIncomes[c.key] ?? 0;
        const faithIncome = cityFaithIncomes[c.key] ?? 0;
        if (faithIncome !== 0) {
            city.faithStorage = (city.faithStorage ?? 0) + faithIncome;
            summaryReport.push(`§d🙏【${city.name}】信仰力+${faithIncome}(累計: ${city.faithStorage})`);
        }

        const activeProductionDef = city.production ? PRODUCTION_DEFS[city.production.id] : null;
        const upkeepExtra = activeProductionDef?.extraUpkeep ?? 0;

        city.foodStorage = (city.foodStorage ?? 0) + income;
        const consumption = city.population + upkeepExtra;
        city.foodStorage -= consumption;

        let growSuccess = false;
        let housingBlock = false;

        if (city.foodStorage < 0) {
            city.starvationTurns = (city.starvationTurns ?? 0) + 1;
            city.foodStorage = 0;
            if (city.starvationTurns >= 3) {
                city.population -= 1; city.starvationTurns = 0;
                if (city.population <= 0) {
                    destroyCity(tiles, c.key, config, dimension);
                    summaryReport.push(`§c❌【${city.name}】が食料不足により崩壊しました！`);
                    continue;
                }
                summaryReport.push(`§c⚠️【${city.name}】食料飢餓により人口が ${city.population} に減少！`);
            } else {
                summaryReport.push(`§c⚠️【${city.name}】食料不足！(あと ${3 - city.starvationTurns} ターンで人口減少)`);
            }
        } else {
            city.starvationTurns = 0;
            const growthThreshold = 10 + (city.population - 1) * 2;
            if (city.foodStorage >= growthThreshold) {
                if (city.population < city.housing) {
                    city.population += 1; city.foodStorage -= growthThreshold; growSuccess = true;
                } else {
                    city.foodStorage = growthThreshold - 1; housingBlock = true;
                }
            }
            let msg = `§7[${city.name}]§f 選択マスからの収穫:+${income} [Food] | 消費:-${consumption} 🍖 | 貯留: ${city.foodStorage}/${growthThreshold}`;
            if (growSuccess) msg += ` 🎉§a人口が ${city.population} に増加！`;
            else if (housingBlock) msg += ` ⚠️§e住宅制限(上限:${city.housing})のため成長停止！`;
            summaryReport.push(msg);
        }
        tiles[c.key] = tile;
    }

    setTiles(tiles);

    if (checkAndAnnounceVictory(tiles)) return;

    const player = getCivStorageHandle(playerId);
    if (player) {
        if (hasFoundedReligion(player)) {
            for (const key in tiles) {
                const t = tiles[key];
                if (t.ownerId !== playerId || t.district?.id !== "sacredSite") continue;
                const belongCityKey = t.belongsToCityKey;
                const cityTile = belongCityKey ? tiles[belongCityKey] : null;
                if (cityTile?.city) applySacredSitePressure(cityTile.city, playerId);
            }
        }

        let totalPop = 0;
        for (const c of playerCities) totalPop += c.tile.city.population;

        const technologyResult = grantProgressPoints(player, "technology", totalPop);
        const civicResult = grantProgressPoints(player, "civic", totalPop);
        if (technologyResult) summaryReport.unshift(technologyResult);
        if (civicResult) summaryReport.unshift(civicResult);
        if (totalOilIncome > 0) {
            const currentOil = player.getDynamicProperty("strategic_oil") ?? 0;
            const newOilTotal = currentOil + totalOilIncome;
            player.setDynamicProperty("strategic_oil", newOilTotal);
            summaryReport.unshift(`§b 石油収入: +${totalOilIncome} 個を獲得！ (現在の在庫: ${newOilTotal} 個)`);
        }

        player.sendMessage("§6=== 💡 都市のターン報告 ===");
        summaryReport.forEach(msg => player.sendMessage(msg));
        player.sendMessage("§6========================");
    }
}

export function joinGame(player) {
    const turn = getTurnState();
    if (turn.started) return { ok: false, message: "§cゲーム進行中です。" };
    if (turn.playerOrder.includes(player.id)) return { ok: false, message: "§c参加済みです。" };
    turn.playerOrder.push(player.id);
    setTurnState(turn);
    return { ok: true, message: `§a${player.name} がゲームに参加しました！` };
}

export function startGame() {
    const turn = getTurnState();
    if (turn.started) return { ok: false, message: "§c既に開始されています。" };
    if (turn.playerOrder.length === 0) return { ok: false, message: "§c参加者がいません。" };

    turn.started = true;
    turn.currentIndex = 0;
    turn.turnNumber = 1;
    turn.playerRights = {};

    turn.playerColors = {};
    turn.playerOrder.forEach((playerId, idx) => {
        turn.playerColors[playerId] = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    });

    for (const playerId of turn.playerOrder) {
        const handle = getCivStorageHandle(playerId);
        if (!handle) continue;
        resetProgress(handle, "technology");
        resetProgress(handle, "civic");
        resetDiplomacy(handle);
        handle.setDynamicProperty("civ:hasFoundedCapital", false);
    }

    setTurnState(turn);

    const turnAfterSkip = getTurnState();
    const found = advanceToNextControllablePlayer(turnAfterSkip);
    setTurnState(turnAfterSkip);

    const firstId = turnAfterSkip.playerOrder[turnAfterSkip.currentIndex];
    processPlayerTurnStart(firstId);
    const name = getPlayerNameById(firstId) ?? "不明(オフライン)";
    if (found) world.sendMessage(`§e=== ゲームが開始されました！ 手番: §a${name}§e ===`);
    else world.sendMessage(`§e=== ゲームが開始されました！ §c参加者全員がオフラインのため待機中 ===`);
    return { ok: true, message: "ゲーム開始" };
}

function advanceToNextControllablePlayer(turn) {
    const total = turn.playerOrder.length;
    if (total === 0) return false;

    for (let i = 0; i < total; i++) {
        const civId = turn.playerOrder[turn.currentIndex];
        if (isCivControllable(civId)) return true;

        turn.currentIndex = (turn.currentIndex + 1) % total;
        if (turn.currentIndex === 0) turn.turnNumber += 1;
    }
    return false;
}

export function endTurn(player) {
    const turn = getTurnState();
    if (!turn.started) return { ok: false, message: "§cゲーム未開始です。" };
    if (player.id !== turn.playerOrder[turn.currentIndex]) return { ok: false, message: "§c手番ではありません。" };

    turn.currentIndex = (turn.currentIndex + 1) % turn.playerOrder.length;
    if (turn.currentIndex === 0) turn.turnNumber += 1;

    const found = advanceToNextControllablePlayer(turn);
    setTurnState(turn);

    const nextId = turn.playerOrder[turn.currentIndex];
    processPlayerTurnStart(nextId);

    const nextName = getPlayerNameById(nextId) ?? "不明(オフライン)";
    if (found) world.sendMessage(`§e>>> ターン ${turn.turnNumber}: §a${nextName}§e のターン <<<`);
    else world.sendMessage(`§e>>> ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中(復帰次第 §a${nextName}§c から再開) <<<`);
    return { ok: true, message: "ターン終了" };
}

export function forceEndTurn() {
    const turn = getTurnState();
    if (!turn.started) return { ok: false, message: "§cゲーム未開始です。" };
    if (turn.playerOrder.length === 0) return { ok: false, message: "§c参加者がいません。" };

    turn.currentIndex = (turn.currentIndex + 1) % turn.playerOrder.length;
    if (turn.currentIndex === 0) turn.turnNumber += 1;

    const found = advanceToNextControllablePlayer(turn);
    setTurnState(turn);

    const nextId = turn.playerOrder[turn.currentIndex];
    processPlayerTurnStart(nextId);

    const nextName = getPlayerNameById(nextId) ?? "不明(オフライン)";
    if (found) world.sendMessage(`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §a${nextName}§e のターン <<<`);
    else world.sendMessage(`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中 <<<`);
    return { ok: true, message: "ターンを強制終了しました。" };
}

export function isPlayersTurn(player) {
    const turn = getTurnState();
    if (!turn.started) return false;
    return player.id === turn.playerOrder[turn.currentIndex];
}

export function turnInfoText() {
    const turn = getTurnState();
    if (!turn.started) return "§7ゲーム開始前 (待機中...)";
    const name = getPlayerNameById(turn.playerOrder[turn.currentIndex]) ?? "未知";
    return `§eターン: ${turn.turnNumber} | 手番: §a${name}`;
}

export function endGame() {
    if (!getTurnState().started) return { ok: false, message: "§c未開始です。" };
    resetAll();
    return { ok: true, message: "§c=== ゲームがリセットされました ===" };
}

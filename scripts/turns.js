// turns.js
import { world, BlockPermutation } from "@minecraft/server";
import { getTurnState, setTurnState, resetAll, getTiles, setTiles, getMapConfig, getStateVersion } from "./state.js";
import { PRODUCTION_DEFS, tickProduction } from "./production.js";
import { grantProgressPoints, resetProgress, hasCompletedProgress } from "./progression.js";
import { resetDiplomacy, getRelation } from "./diplomacy.js";
import { getCivStorageHandle, resolveCivName, isCivControllable } from "./civs.js";
import { getBuildingAdjacencyYields } from "./adjacency.js";
import { getFacilityAdjacencyYields, getFacilityFlatYields } from "./facilities.js";
import { getDistrictAdjacencyYields, getDistrictFlatYields, getDistrictPopulationYields, tickDistrictConstruction } from "./districts.js";
import { hasFoundedReligion, getReligionName, getNationalDominantReligion, applySacredSitePressure } from "./religion.js";
import { clearAllUnitLabels } from "./unitLabels.js";

export { getTurnState, setTurnState };
const TILE_SIZE = 5;
// 💡 バランス調整: 都市の全ての産出量(食料・生産力・石油・信仰力・鉄。マス固有の基礎産出量、
//    施設/区域/建造物のボーナス、隣接ボーナス、人口比例ボーナスなど getCityCurrentYields が
//    集計するもの全て)を一律2倍にする。個々のボーナス値を1つずつ書き換える代わりに、
//    集計の最終地点でまとめて掛けることで、新しく増えるボーナスにも自動的に反映される。
const YIELD_MULTIPLIER = 2;
let cityYieldCacheVersion = -1;
const cityYieldCache = new Map();
const cityAssignmentCache = new Map();
export const PLAYER_COLORS = ["red", "blue", "green", "yellow", "purple", "orange", "cyan", "magenta", "light_blue", "lime"];

function invalidateTurnCaches() {
    cityYieldCache.clear();
    cityAssignmentCache.clear();
}
function syncTurnCaches() {
    const version = getStateVersion();
    if (version !== cityYieldCacheVersion) {
        invalidateTurnCaches();
        cityYieldCacheVersion = version;
    }
}
export function getPlayerColor(playerId) { return getTurnState().playerColors?.[playerId] ?? "white"; }
function getPlayerNameById(id) { return resolveCivName(id); }

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
        if(block.typeId==="minecraft:magma") extraProd+=100;
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
    const cityTile=tiles[cityKey]; if(!cityTile?.city)return{food:0,production:1,oil:0,faith:0,iron:0};
    const cached=cityYieldCache.get(cityKey); if(cached)return cached;
    const assignedTiles=getAssignedTilesForPlayer(cityTile.ownerId,tiles).get(cityKey)??[];
    const maxWorkers=Math.min(cityTile.city.population,assignedTiles.length);
    let food=0,production=0,oil=0,iron=0,faith=cityTile.city.population;
    for(let i=0;i<maxWorkers;i++){food+=assignedTiles[i].tile.foodYield??0;production+=assignedTiles[i].tile.productionYield??0;if(assignedTiles[i].tile.resource==="oil")oil++;}
    const config=getMapConfig(),dimension=world.getDimension("overworld");
    for(const t of assignedTiles){const c=countCheatingBlocks(dimension,tiles,t.tx,t.tz,config);food+=c.extraFood;production+=c.extraProd;}
    const ownerHandle=getCivStorageHandle(cityTile.ownerId);
    if(ownerHandle&&hasCompletedProgress(ownerHandle,"civic","codeOfLaws"))food++;
    if(cityTile.city.granary)food++; if(cityTile.city.obelisk)faith+=4;if(cityTile.city.shrine)faith+=2;
    const [cityTx,cityTz]=cityKey.split(",").map(Number);
    const a=getBuildingAdjacencyYields(cityTx,cityTz,tiles,cityTile.city,PRODUCTION_DEFS); food+=a.food??0;production+=a.production??0;oil+=a.oil??0;faith+=a.faith??0;
    const f=getFacilityAdjacencyYields(assignedTiles,tiles);food+=f.food??0;production+=f.production??0;oil+=f.oil??0;faith+=f.faith??0;iron+=f.iron??0;
    const ff=getFacilityFlatYields(assignedTiles);food+=ff.food??0;production+=ff.production??0;oil+=ff.oil??0;faith+=ff.faith??0;iron+=ff.iron??0;
    const d=getDistrictAdjacencyYields(assignedTiles,tiles);food+=d.food??0;production+=d.production??0;oil+=d.oil??0;faith+=d.faith??0;iron+=d.iron??0;
    const df=getDistrictFlatYields(assignedTiles);food+=df.food??0;production+=df.production??0;oil+=df.oil??0;faith+=df.faith??0;iron+=df.iron??0;
    const p=getDistrictPopulationYields(assignedTiles,cityTile.city.population);food+=p.food??0;production+=p.production??0;oil+=p.oil??0;faith+=p.faith??0;iron+=p.iron??0;
    const result={food:food*YIELD_MULTIPLIER,production:Math.max(1,production)*YIELD_MULTIPLIER,oil:oil*YIELD_MULTIPLIER,faith:faith*YIELD_MULTIPLIER,iron:iron*YIELD_MULTIPLIER};cityYieldCache.set(cityKey,result);return result;
}

export function connectTradeRoutes(ownerKey,city,tiles){const [ox,oz]=ownerKey.split(",").map(Number);let minDist=Infinity,nearest=[];for(const key in tiles){if(key===ownerKey)continue;const t=tiles[key];if(!t.city)continue;const [tx,tz]=key.split(",").map(Number),dist=Math.abs(ox-tx)+Math.abs(oz-tz);if(dist<minDist){minDist=dist;nearest=[key];}else if(dist===minDist)nearest.push(key);}city.tradingPost.routes=[];for(const targetKey of nearest){const targetCity=tiles[targetKey].city;let baseTurns=minDist,bonus=2*YIELD_MULTIPLIER;if(targetCity.tradingPost?.status==="active"){if(baseTurns===1)bonus=4*YIELD_MULTIPLIER;else baseTurns=Math.max(1,Math.floor(baseTurns/2));}city.tradingPost.routes.push({targetKey,remainingTurns:baseTurns,bonus});}}

export function calculateCityFoodIncomes(playerId){const tiles=getTiles(),cities=[],owned=[];for(const key in tiles){const tile=tiles[key];if(tile.ownerId!==playerId)continue;const [tx,tz]=key.split(",").map(Number);if(tile.city)cities.push({key,tile,tx,tz,assignedCount:0});owned.push({key,tile,tx,tz,assignedCities:[]});}const incomes={};for(const c of cities)incomes[c.key]=0;if(!cities.length)return incomes;for(const t of owned){let min=Infinity,nearest=[];for(const c of cities){const d=Math.abs(t.tx-c.tx)+Math.abs(t.tz-c.tz);if(d<min){min=d;nearest=[c];}else if(d===min)nearest.push(c);}t.assignedCities=nearest;for(const c of nearest)c.assignedCount++;}for(const t of owned){let left=t.tile.foodYield??1;if(!t.assignedCities.length)continue;t.assignedCities.sort((a,b)=>a.assignedCount-b.assignedCount);let i=0;while(left-->0){const c=t.assignedCities[i++%t.assignedCities.length];incomes[c.key]=(incomes[c.key]??0)+1;}}for(const key in tiles){const t=tiles[key];if(t.city?.tradingPost?.status==="active"&&t.city.tradingPost.routes)for(const route of t.city.tradingPost.routes){if(t.ownerId===playerId)incomes[key]=(incomes[key]??0)+route.bonus;if(tiles[route.targetKey]?.ownerId===playerId)incomes[route.targetKey]=(incomes[route.targetKey]??0)+route.bonus;}}return incomes;}

export function destroyCity(tiles,cityKey,config,dimension){const target=tiles[cityKey];if(!target?.city)return;const playerId=target.ownerId;const cities=[];for(const key in tiles){const t=tiles[key];if(t.ownerId===playerId&&t.city&&key!==cityKey){const [x,z]=key.split(",").map(Number);cities.push({key,x,z});}}
    // 都市一覧を1回だけ作り、各所有タイルから破壊都市への最短距離を判定する。従来はタイルごとに都市一覧を再走査していた。
    for(const key in tiles){const t=tiles[key];if(t.ownerId!==playerId)continue;const [x,z]=key.split(",").map(Number);let min=Infinity,hit=false;for(const c of cities){const d=Math.abs(x-c.x)+Math.abs(z-c.z);if(d<min){min=d;hit=false;}if(d===min&&cityKey!==null){} }
        // 破壊対象も含めた最短距離を1回の都市走査で判定する。
        const [cx,cz]=cityKey.split(",").map(Number);const targetDist=Math.abs(x-cx)+Math.abs(z-cz);min=targetDist;hit=true;
        for(const c of cities){const d=Math.abs(x-c.x)+Math.abs(z-c.z);if(d<min){min=d;hit=false;}else if(d===min)hit=true;}
        if(hit){t.ownerId=null;t.ownerName=null;t.city=null;}
    }
    if(dimension){const [ctx,ctz]=cityKey.split(",").map(Number);const baseX=config.originX+ctx*TILE_SIZE+2,baseZ=config.originZ+ctz*TILE_SIZE+2;dimension.getBlock({x:baseX,y:config.ySurface+1,z:baseZ})?.setPermutation(BlockPermutation.resolve("minecraft:air"));}
    target.city=null;target.ownerId=null;target.ownerName=null;
}

function getAliveCivIds(turn,tiles){const alive=new Set();for(const key in tiles){const t=tiles[key];if(t.city&&t.ownerId)alive.add(t.ownerId);}return(Array.isArray(turn?.playerOrder)?turn.playerOrder:[]).filter(id=>alive.has(id));}
function hasEverFoundedCapital(civId){const h=getCivStorageHandle(civId);return!!h&&h.getDynamicProperty("civ:hasFoundedCapital")===true;}
function awardVictoryPoints(civIds){for(const id of civIds){const h=getCivStorageHandle(id);if(!h)continue;h.setDynamicProperty("civ:victoryPoints",(h.getDynamicProperty("civ:victoryPoints")??0)+1);}}
function isAlliedOrSameCiv(a,b){if(!a||!b)return false;if(a===b)return true;const h=getCivStorageHandle(a);return!!h&&getRelation(h,b)==="alliance";}
function areAllMutuallyAllied(ids){for(let i=0;i<ids.length;i++){const h=getCivStorageHandle(ids[i]);if(!h)return false;for(let j=0;j<ids.length;j++)if(i!==j&&getRelation(h,ids[j])!=="alliance")return false;}return true;}
function checkReligiousVictory(aliveIds,tiles){const by={};for(const id of aliveIds)by[id]=[];for(const key in tiles){const t=tiles[key];if(t.city&&by[t.ownerId])by[t.ownerId].push({key,tile:t});}const religions={};for(const id of aliveIds)religions[id]=getNationalDominantReligion(by[id]);for(const id of aliveIds){const h=getCivStorageHandle(id);if(h&&hasFoundedReligion(h)&&aliveIds.every(x=>religions[x]===id))return id;}return null;}

export function checkAndAnnounceVictory(tiles){const turn=getTurnState();if(!turn.started||!Array.isArray(turn.playerOrder)||turn.playerOrder.length<2)return false;const allTiles=tiles??getTiles(),aliveIds=getAliveCivIds(turn,allTiles);if(!aliveIds.length)return false;if(turn.playerOrder.some(id=>!hasEverFoundedCapital(id)))return false;if(aliveIds.length===1){const n=resolveCivName(aliveIds[0])??"不明な国家";awardVictoryPoints(aliveIds);world.sendMessage(`§6★★★ 勝利！ §a【${n}】§6が唯一残った国家となりました！(ソロ勝利、勝利ポイント+1) ★★★`);resetAll();clearAllUnitLabels();return true;}const religiousWinnerId=checkReligiousVictory(aliveIds,allTiles);if(religiousWinnerId){const n=resolveCivName(religiousWinnerId)??"不明な国家",h=getCivStorageHandle(religiousWinnerId),r=getReligionName(h)??"その宗教";awardVictoryPoints([religiousWinnerId]);world.sendMessage(`§6★★★ 勝利！ §d【${n}】§6の【${r}】が全世界に広まりました！(宗教勝利、勝利ポイント+1) ★★★`);resetAll();clearAllUnitLabels();return true;}if(turn.playerOrder.length>=4&&areAllMutuallyAllied(aliveIds)){const n=aliveIds.map(id=>resolveCivName(id)??"不明な国家").join("、");awardVictoryPoints(aliveIds);world.sendMessage(`§6★★★ 勝利！ §b【${n}】§6の同盟が、他のすべての国家を退けました！(同盟勝利、勝利ポイント+1) ★★★`);resetAll();clearAllUnitLabels();return true;}return false;}

export function resolveMissileImpact(config,targetTx,targetTz){const dimension=world.getDimension("overworld"),centerX=config.originX+targetTx*TILE_SIZE+2,centerZ=config.originZ+targetTz*TILE_SIZE+2,centerY=config.ySurface+2;try{dimension.spawnParticle("minecraft:huge_explosion_emitter",{x:centerX,y:centerY,z:centerZ});}catch(e){}try{dimension.playSound("random.explode",{x:centerX,y:centerY,z:centerZ},{volume:4,pitch:0.8});}catch(e){}const tiles=getTiles(),targetKey=`${targetTx},${targetTz}`,targetTile=tiles[targetKey];if(!targetTile?.city)return`§7[Missile] (${targetTx}, ${targetTz}) に着弾しましたが、そこに都市はありませんでした。`;const cityName=targetTile.city.name,ownerName=targetTile.ownerName??"不明";destroyCity(tiles,targetKey,config,dimension);setTiles(tiles);checkAndAnnounceVictory(tiles);return`§c💥 【${cityName}】(${ownerName})がミサイル攻撃により破壊されました！`;}

function processPlayerTurnStart(playerId){const config=getMapConfig();if(!config)return;const tiles=getTiles();if(checkAndAnnounceVictory(tiles))return;const playerCities=[];let movementRefreshed=false;for(const key in tiles){const t=tiles[key],unit=t.combatUnit;if(unit?.ownerId===playerId){unit.movementRemaining=unit.movement??0;movementRefreshed=true;}const religiousUnit=t.religiousUnit;if(religiousUnit?.ownerId===playerId){religiousUnit.movementRemaining=religiousUnit.movement??0;religiousUnit.hasProselytizedThisTurn=false;movementRefreshed=true;}if(t.ownerId===playerId&&t.city)playerCities.push({key,tile:t});}if(!playerCities.length){if(movementRefreshed)setTiles(tiles);return;}
    const summaryReport=[],dimension=world.getDimension("overworld"),cityFoodIncomes={},cityProductionIncomes={},cityFaithIncomes={};let totalOilIncome=0,totalIronIncome=0;
    for(const c of playerCities){const y=getCityCurrentYields(c.key,tiles);cityFoodIncomes[c.key]=y.food;cityProductionIncomes[c.key]=y.production;cityFaithIncomes[c.key]=y.faith??0;totalOilIncome+=y.oil??0;totalIronIncome+=y.iron??0;c.tile.city.currentTurnProduction=y.production;}
    for(const key in tiles){const t=tiles[key];if(t.city?.tradingPost?.status==="active"&&t.city.tradingPost.routes)for(const route of t.city.tradingPost.routes){if(t.ownerId===playerId)cityFoodIncomes[key]=(cityFoodIncomes[key]??0)+route.bonus;if(tiles[route.targetKey]?.ownerId===playerId)cityFoodIncomes[route.targetKey]=(cityFoodIncomes[route.targetKey]??0)+route.bonus;}}
    for(const c of playerCities){const city=c.tile.city;if(!city.production)continue;const r=tickProduction(city,cityProductionIncomes[c.key]??0,{cityKey:c.key,tiles,connectTradeRoutes,isAllied:isAlliedOrSameCiv});if(r)summaryReport.push(r.message);}
    for(const c of playerCities){const city=c.tile.city;if(!city.districtConstruction)continue;const r=tickDistrictConstruction(city,cityProductionIncomes[c.key]??0,tiles,c.tile.ownerId);if(r)summaryReport.push(r.message);}
    for(const c of playerCities){const tile=tiles[c.key],city=tile.city,income=cityFoodIncomes[c.key]??0,faithIncome=cityFaithIncomes[c.key]??0;if(faithIncome){city.faithStorage=(city.faithStorage??0)+faithIncome;summaryReport.push(`§d🙏【${city.name}】信仰力+${faithIncome}(累計: ${city.faithStorage})`);}const def=city.production?PRODUCTION_DEFS[city.production.id]:null,consumption=city.population+(def?.extraUpkeep??0);city.foodStorage=(city.foodStorage??0)+income-consumption;let grow=false,blocked=false;if(city.foodStorage<0){city.starvationTurns=(city.starvationTurns??0)+1;city.foodStorage=0;if(city.starvationTurns>=3){city.population--;city.starvationTurns=0;if(city.population<=0){destroyCity(tiles,c.key,config,dimension);summaryReport.push(`§c❌【${city.name}】が食料不足により崩壊しました！`);continue;}summaryReport.push(`§c⚠️【${city.name}】食料飢餓により人口が ${city.population} に減少！`);}else summaryReport.push(`§c⚠️【${city.name}】食料不足！(あと ${3-city.starvationTurns} ターンで人口減少)`);}else{city.starvationTurns=0;const threshold=10+(city.population-1)*2;if(city.foodStorage>=threshold){if(city.population<city.housing){city.population++;city.foodStorage-=threshold;grow=true;}else{city.foodStorage=threshold-1;blocked=true;}}let msg=`§7[${city.name}]§f 選択マスからの収穫:+${income} [Food] | 消費:-${consumption} 🍖 | 貯留: ${city.foodStorage}/${threshold}`;if(grow)msg+=` 🎉§a人口が ${city.population} に増加！`;else if(blocked)msg+=` ⚠️§e住宅制限(上限:${city.housing})のため成長停止！`;summaryReport.push(msg);}tiles[c.key]=tile;}
    setTiles(tiles);if(checkAndAnnounceVictory(tiles))return;const player=getCivStorageHandle(playerId);if(player){if(hasFoundedReligion(player))for(const key in tiles){const t=tiles[key];if(t.ownerId!==playerId||t.district?.id!=="sacredSite")continue;const cityTile=t.belongsToCityKey?tiles[t.belongsToCityKey]:null;if(cityTile?.city)applySacredSitePressure(cityTile.city,playerId);}let totalPop=0;for(const c of playerCities)totalPop+=c.tile.city.population;const tr=grantProgressPoints(player,"technology",totalPop),cr=grantProgressPoints(player,"civic",totalPop);if(tr)summaryReport.unshift(tr);if(cr)summaryReport.unshift(cr);if(totalOilIncome>0){const oil=(player.getDynamicProperty("strategic_oil")??0)+totalOilIncome;player.setDynamicProperty("strategic_oil",oil);summaryReport.unshift(`§b 石油収入: +${totalOilIncome} 個を獲得！ (現在の在庫: ${oil} 個)`);}if(totalIronIncome>0){const iron=(player.getDynamicProperty("strategic_iron")??0)+totalIronIncome;player.setDynamicProperty("strategic_iron",iron);summaryReport.unshift(`§7⚒ 鉄収入: +${totalIronIncome} 個を獲得！ (現在の在庫: ${iron} 個)`);}player.sendMessage("§6=== 💡 都市のターン報告 ===");summaryReport.forEach(m=>player.sendMessage(m));player.sendMessage("§6========================");}}

export function joinGame(player){const turn=getTurnState();if(turn.started)return{ok:false,message:"§cゲーム進行中です。"};if(turn.playerOrder.includes(player.id))return{ok:false,message:"§c参加済みです。"};turn.playerOrder.push(player.id);setTurnState(turn);return{ok:true,message:`§a${player.name} がゲームに参加しました！`};}
export function startGame(){const turn=getTurnState();if(turn.started)return{ok:false,message:"§c既に開始されています。"};if(!turn.playerOrder.length)return{ok:false,message:"§c参加者がいません。"};turn.started=true;turn.currentIndex=0;turn.turnNumber=1;turn.playerRights={};turn.playerColors={};turn.playerOrder.forEach((id,i)=>turn.playerColors[id]=PLAYER_COLORS[i%PLAYER_COLORS.length]);for(const id of turn.playerOrder){const h=getCivStorageHandle(id);if(!h)continue;resetProgress(h,"technology");resetProgress(h,"civic");resetDiplomacy(h);h.setDynamicProperty("civ:hasFoundedCapital",false);}setTurnState(turn);const t=getTurnState(),found=advanceToNextControllablePlayer(t);setTurnState(t);const id=t.playerOrder[t.currentIndex];processPlayerTurnStart(id);const name=getPlayerNameById(id)??"不明(オフライン)";world.sendMessage(found?`§e=== ゲームが開始されました！ 手番: §a${name}§e ===`:`§e=== ゲームが開始されました！ §c参加者全員がオフラインのため待機中 ===`);return{ok:true,message:"ゲーム開始"};}
function advanceToNextControllablePlayer(turn){const total=turn.playerOrder.length;if(!total)return false;for(let i=0;i<total;i++){const id=turn.playerOrder[turn.currentIndex];if(isCivControllable(id))return true;turn.currentIndex=(turn.currentIndex+1)%total;if(turn.currentIndex===0)turn.turnNumber++;}return false;}
export function endTurn(player){const turn=getTurnState();if(!turn.started)return{ok:false,message:"§cゲーム未開始です。"};if(player.id!==turn.playerOrder[turn.currentIndex])return{ok:false,message:"§c手番ではありません。"};turn.currentIndex=(turn.currentIndex+1)%turn.playerOrder.length;if(turn.currentIndex===0)turn.turnNumber++;const found=advanceToNextControllablePlayer(turn);setTurnState(turn);const id=turn.playerOrder[turn.currentIndex];processPlayerTurnStart(id);const name=getPlayerNameById(id)??"不明(オフライン)";world.sendMessage(found?`§e>>> ターン ${turn.turnNumber}: §a${name}§e のターン <<<`:`§e>>> ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中(復帰次第 §a${name}§c から再開) <<<`);return{ok:true,message:"ターン終了"};}
export function forceEndTurn(){const turn=getTurnState();if(!turn.started)return{ok:false,message:"§cゲーム未開始です。"};if(!turn.playerOrder.length)return{ok:false,message:"§c参加者がいません。"};turn.currentIndex=(turn.currentIndex+1)%turn.playerOrder.length;if(turn.currentIndex===0)turn.turnNumber++;const found=advanceToNextControllablePlayer(turn);setTurnState(turn);const id=turn.playerOrder[turn.currentIndex];processPlayerTurnStart(id);const name=getPlayerNameById(id)??"不明(オフライン)";world.sendMessage(found?`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §a${name}§e のターン <<<`:`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中 <<<`);return{ok:true,message:"ターンを強制終了しました。"};}
export function isPlayersTurn(player){const turn=getTurnState();return!!turn.started&&player.id===turn.playerOrder[turn.currentIndex];}
export function turnInfoText(){const turn=getTurnState();if(!turn.started)return"§7ゲーム開始前 (待機中...)";return`§eターン: ${turn.turnNumber} | 手番: §a${getPlayerNameById(turn.playerOrder[turn.currentIndex])??"未知"}`;}
export function endGame(){if(!getTurnState().started)return{ok:false,message:"§c未開始です。"};resetAll();clearAllUnitLabels();return{ok:true,message:"§c=== ゲームがリセットされました ==="};}

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
    world.sendMessage(`§6★★★【デバッグ】§a【${names}】§6が管理者操作により即座に勝利しました！(勝利ポイント+1) ★★★`);
    resetAll();
    clearAllUnitLabels();
    return{ok:true,message:"§aデバッグ勝利を実行しました。"};
}

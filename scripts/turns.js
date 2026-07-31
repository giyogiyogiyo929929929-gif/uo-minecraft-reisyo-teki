// turns.js
import { world, BlockPermutation } from "@minecraft/server";
import { getTurnState, setTurnState, resetAll, getTiles, setTiles, getMapConfig, setTile } from "./state.js";
import { PRODUCTION_DEFS, tickProduction } from "./production.js";
import { grantProgressPoints, resetProgress } from "./progression.js";
import { resetDiplomacy, getRelation } from "./diplomacy.js";
import { hasCompletedProgress } from "./progression.js";
import { getCivStorageHandle, resolveCivName, isCivControllable } from "./civs.js";
import { getBuildingAdjacencyYields } from "./adjacency.js";
import { getFacilityAdjacencyYields } from "./facilities.js";
import { getDistrictAdjacencyYields, getDistrictPopulationYields, tickDistrictConstruction } from "./districts.js";
import { hasFoundedReligion, getReligionName, getNationalDominantReligion, applySacredSitePressure } from "./religion.js";

export { getTurnState, setTurnState };

const TILE_SIZE = 5;

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
        const key = `${tx},${tz}`;
        const tile = tiles[key];
        if (tile && tile.resource) {
            if (tile.resource === "wheat" || tile.resource === "fish") extraFood += 1;
            if (["iron", "coal", "diamonds", "gold_ore"].includes(tile.resource)) extraProd += 1;
        }
        return { extraFood, extraProd };
    }

    // -------------------------------------------------------------
    // アプローチ1: mapGen の初期資源データを参照してベース収入を底上げ
    // -------------------------------------------------------------
    if (tile && tile.resource) {
        // 🌾 🐟 マップ自体のボーナス食料資源
        if (tile.resource === "wheat" || tile.resource === "fish") {
            extraFood += 1;
        }
        // 🪙 💎 鉄・石炭・ダイヤ・金などのマップ自体の鉱物資源
        if (
            tile.resource === "iron" || 
            tile.resource === "coal" || 
            tile.resource === "diamonds" || 
            tile.resource === "gold_ore"
        ) {
            extraProd += 1;
        }
    }

    // -------------------------------------------------------------
    // アプローチ2: 実際にプレイヤーが手動で置いたブロックをスキャンして加算
    // -------------------------------------------------------------
    const baseX = config.originX + tx * TILE_SIZE;
    const baseZ = config.originZ + tz * TILE_SIZE;
    const yTarget = config.ySurface + 1; // 地表のすぐ上の空気層

    for (let x = 0; x < TILE_SIZE; x++) {
        for (let z = 0; z < TILE_SIZE; z++) {
            // 💡 地表の「同じ高さ」「1マス上」「2マス上」の3つの高さを調べる
            for (let yOffset = 0; yOffset <= 2; yOffset++) {
                const block = dimension.getBlock({ 
                    x: baseX + x, 
                    y: config.ySurface + yOffset, 
                    z: baseZ + z 
                });
                if (!block) continue;

                if (block.typeId.includes("wheat") || block.typeId === "minecraft:hay_block") {
                    extraFood += 1;
                }
                if (block.typeId === "minecraft:iron_ore" || block.typeId === "minecraft:gold_ore") {
                    extraProd += 1;
                }
                if (block.typeId === "minecraft:magma") {
                    extraProd += 100;
                }
            }
        }
    }

    return { extraFood, extraProd };
}

export function getCityCurrentYields(cityKey, tiles) {
    const cityTile = tiles[cityKey];
    if (!cityTile || !cityTile.city) return { food: 0, production: 1, oil: 0, faith: 0 };
    
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

    // 領有マスの帰属をリアルタイムに一番近い都市へマッピング
    const assignedTiles = [];
    for (const t of playerTiles) {
        let minDist = Infinity;
        let nearestCityKey = null;
        for (const c of playerCities) {
            const dist = Math.abs(t.tx - c.tx) + Math.abs(t.tz - c.tz);
            if (dist < minDist) { minDist = dist; nearestCityKey = c.key; }
        }
        // 💡 修正: 座標(tx, tz)や元のtileを正しく参照できるようにオブジェクトごとプッシュ
        if (nearestCityKey === cityKey) assignedTiles.push(t);
    }

    // [Food]+[Prod] の合計出力が高い優秀なマスから順にソート (市民の自動最適配置)
    assignedTiles.sort((a, b) => {
        const scoreA = (a.tile.foodYield ?? 0) + (a.tile.productionYield ?? 0);
        const scoreB = (b.tile.foodYield ?? 0) + (b.tile.productionYield ?? 0);
        return scoreB - scoreA;
    });

    // 人口の数だけ、都市または帰属マスを選択して合計
    const maxWorkers = Math.min(cityTile.city.population, assignedTiles.length);
    let food = 0;
    let production = 0;
    let oil = 0; // 💡 追加: 石油の毎ターン算出量
    // 💡 信仰力: マスの産出ではなく、都市の人口そのものに応じて算出する(人口1につき+1)。
    let faith = cityTile.city.population;

    for (let i = 0; i < maxWorkers; i++) {
        food += assignedTiles[i].tile.foodYield ?? 0;
        production += assignedTiles[i].tile.productionYield ?? 0;
        
        // 💡 追加: 配置されたマスに石油資源がある場合、毎ターンの油田収入にする
        if (assignedTiles[i].tile.resource === "oil") {
            oil += 1;
        }
    }

    const config = getMapConfig();
    const dimension = world.getDimension("overworld");

    for (const t of assignedTiles) {
        const cheatIncomes = countCheatingBlocks(dimension, tiles, t.tx, t.tz, config);
        food += cheatIncomes.extraFood;
        production += cheatIncomes.extraProd;
    }

    // 法典の効果: 所有するすべての都市の食料生産量を+1。
    const ownerHandle = getCivStorageHandle(playerId);
    if (ownerHandle && hasCompletedProgress(ownerHandle, "civic", "codeOfLaws")) food += 1;

    // 穀物庫の効果: 建設したこの都市の食料生産量を+1。
    if (cityTile.city.granary) food += 1;

    // オベリスクの効果: 建設したこの都市の信仰力の産出を+4。
    if (cityTile.city.obelisk) faith += 4;

    // 社(区域専用建造物)の効果: 建設したこの都市の信仰力の産出を+2。
    if (cityTile.city.shrine) faith += 2;

    // 💡 その他の建造物が持つ「隣接マスに応じたボーナス」をまとめて反映する。
    //    新しい建造物を追加しても、production.js側にルール(adjacencyBonuses)を書くだけで
    //    ここのコードを変更せずに自動反映される(adjacency.js参照)。
    const [cityTx, cityTz] = cityKey.split(",").map(Number);
    const adjacencyYields = getBuildingAdjacencyYields(cityTx, cityTz, tiles, cityTile.city, PRODUCTION_DEFS);
    food += adjacencyYields.food ?? 0;
    production += adjacencyYields.production ?? 0;
    oil += adjacencyYields.oil ?? 0;
    faith += adjacencyYields.faith ?? 0;

    // 💡 この都市の領有範囲(assignedTiles)に設置されている施設の隣接ボーナスも合算する。
    //    労働者の配置(maxWorkers)に関わらず、施設自体は恒久的な設備として無条件に効果を発揮する
    //    (通常のマス産出量のように「働き手が配置されているか」は問わない)。
    const facilityYields = getFacilityAdjacencyYields(assignedTiles, tiles);
    food += facilityYields.food ?? 0;
    production += facilityYields.production ?? 0;
    oil += facilityYields.oil ?? 0;
    faith += facilityYields.faith ?? 0;

    // 💡 区域(district)による隣接ボーナスと、人口比例のボーナスをそれぞれ加算する。
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

    return { food, production: Math.max(1, production), oil, faith }; // 最低生産力は1を保証
}

// 💡 交易所から最も近い都市（複数あればすべて）へ交易路を伸ばすロジック
export function connectTradeRoutes(ownerKey, city, tiles) {
    const [oxStr, ozStr] = ownerKey.split(",");
    const ox = parseInt(oxStr, 10);
    const oz = parseInt(ozStr, 10);

    let minDist = Infinity;
    let nearestCityKeys = [];

    // 自分以外のすべての都市を探索（他プレイヤーの都市も含む）
    for (const key in tiles) {
        if (key === ownerKey) continue;
        const t = tiles[key];
        if (t.city) {
            const [txStr, tzStr] = key.split(",");
            const tx = parseInt(txStr, 10);
            const tz = parseInt(tzStr, 10);
            const dist = Math.abs(ox - tx) + Math.abs(oz - tz); // マンハッタン距離

            if (dist < minDist) {
                minDist = dist;
                nearestCityKeys = [key];
            } else if (dist === minDist) {
                nearestCityKeys.push(key);
            }
        }
    }

    city.tradingPost.routes = [];
    if (nearestCityKeys.length === 0) return; // 他に都市がない場合は接続待機

    for (const targetKey of nearestCityKeys) {
        const targetTile = tiles[targetKey];
        const targetCity = targetTile.city;

        let baseTurns = minDist; // 距離分のターン数
        let bonus = 2;          // 基本食料生産量 +2

        // 相手の都市にも交易所（稼働中）がある場合
        const targetHasTradingPost = targetCity.tradingPost && targetCity.tradingPost.status === "active";

        if (targetHasTradingPost) {
            if (baseTurns === 1) {
                bonus = 4;
            } else {
                baseTurns = Math.max(1, Math.floor(baseTurns / 2));
            }
        }

        city.tradingPost.routes.push({
            targetKey: targetKey,
            remainingTurns: baseTurns,
            bonus: bonus
        });
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
            if (tile.city) {
                playerCities.push({ key, tile, tx, tz, assignedCount: 0 });
            }
            playerTiles.push({ key, tile, tx, tz, assignedCities: [] });
        }
    }

    const incomes = {};
    for (const c of playerCities) { incomes[c.key] = 0; }
    if (playerCities.length === 0) return incomes;

    for (const t of playerTiles) {
        let minDist = Infinity;
        let nearest = [];
        for (const c of playerCities) {
            const dist = Math.abs(t.tx - c.tx) + Math.abs(t.tz - c.tz);
            if (dist < minDist) { minDist = dist; nearest = [c]; }
            else if (dist === minDist) { nearest.push(c); }
        }
        t.assignedCities = nearest;
        for (const c of nearest) { c.assignedCount += 1; }
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

    // アクティブな交易路から発生する食料ボーナス([Food])を都市の収入に加算
    for (const key in tiles) {
        const t = tiles[key];
        if (t.city && t.city.tradingPost && t.city.tradingPost.status === "active" && t.city.tradingPost.routes) {
            for (const route of t.city.tradingPost.routes) {
                if (t.ownerId === playerId) {
                    incomes[key] = (incomes[key] ?? 0) + route.bonus;
                }
                if (tiles[route.targetKey] && tiles[route.targetKey].ownerId === playerId) {
                    incomes[route.targetKey] = (incomes[route.targetKey] ?? 0) + route.bonus;
                }
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
                    else if (dist === minDist) { nearestKeys.push(k2); }
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

/** 生存している(都市を1つ以上持つ)国家IDの一覧を返す。 */
function getAliveCivIds(turn, tiles) {
    const order = Array.isArray(turn?.playerOrder) ? turn.playerOrder : [];
    return order.filter(id => Object.values(tiles).some(t => t.ownerId === id && t.city));
}

/** この国家が(このゲーム開始以降に)一度でも首都を設置したことがあるかどうか。 */
function hasEverFoundedCapital(civId) {
    const handle = getCivStorageHandle(civId);
    return !!handle && handle.getDynamicProperty("civ:hasFoundedCapital") === true;
}

/**
 * ゲームに勝利した国家(たち)へ勝利ポイントを+1する(他ゲームでいうレート的なもの)。
 * 戦闘での勝敗ではなく、ゲームそのものに勝利した場合にのみ付与する。
 * ゲームをまたいで持続する値のため、startGame() 時にもリセットしない。
 */
function awardVictoryPoints(civIds) {
    for (const civId of civIds) {
        const handle = getCivStorageHandle(civId);
        if (!handle) continue;
        const current = handle.getDynamicProperty("civ:victoryPoints") ?? 0;
        handle.setDynamicProperty("civ:victoryPoints", current + 1);
    }
}

/** 2つの国家IDが、同一国家か、または互いに同盟関係にあるかどうかを判定する。 */
function isAlliedOrSameCiv(civIdA, civIdB) {
    if (!civIdA || !civIdB) return false;
    if (civIdA === civIdB) return true;
    const handle = getCivStorageHandle(civIdA);
    if (!handle) return false;
    return getRelation(handle, civIdB) === "alliance";
}

/** 渡された国家ID全員が、互いに同盟関係にあるかどうかを判定する。 */
function areAllMutuallyAllied(civIds) {
    for (let i = 0; i < civIds.length; i++) {
        const handle = getCivStorageHandle(civIds[i]);
        if (!handle) return false; // オフライン等でハンドルが取れない場合は判定不能として同盟勝利にしない
        for (let j = 0; j < civIds.length; j++) {
            if (i === j) continue;
            if (getRelation(handle, civIds[j]) !== "alliance") return false;
        }
    }
    return true;
}

/**
 * 宗教勝利の判定。生存している全ての国家の「国家主流宗教」が、いずれか1国家の
 * 創始した宗教と一致していれば、その国家のIDを返す(誰も条件を満たしていなければnull)。
 */
function checkReligiousVictory(aliveIds, tiles) {
    // 生存している各国家の保有都市一覧を作る([{key, tile}]形式、religion.jsの関数群が要求する形)
    const citiesByCiv = {};
    for (const id of aliveIds) citiesByCiv[id] = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.city && aliveIds.includes(t.ownerId)) {
            citiesByCiv[t.ownerId].push({ key, tile: t });
        }
    }

    // 各国家の「国家主流宗教」を求めておく
    const nationalReligion = {};
    for (const id of aliveIds) {
        nationalReligion[id] = getNationalDominantReligion(citiesByCiv[id]);
    }

    // 宗教を創始している国家それぞれについて、生存者全員が自分の宗教を国家主流としているか確認する
    for (const candidateId of aliveIds) {
        const handle = getCivStorageHandle(candidateId);
        if (!handle || !hasFoundedReligion(handle)) continue;
        if (aliveIds.every(id => nationalReligion[id] === candidateId)) return candidateId;
    }
    return null;
}

/**
 * 🏆 勝利条件の判定。
 * ・生存国家(都市を1つ以上持つ国家)が1つだけになった場合 → その国家のソロ勝利。
 * ・生存国家が2つ以上でも、参加人数が4人以上のゲームにおいて、生存者全員が互いに
 *   同盟関係にある場合 → その同盟グループの同盟勝利。
 * 勝利が確定した場合、結果をワールドにブロードキャストしてゲームをリセットする
 * (以後 !civ join からやり直しになる)。
 * @param {any} [tiles] 既に読み込み済みのタイルデータ(省略時は内部で取得する)
 * @returns {boolean} 勝利が確定してゲームを終了させた場合 true
 */
export function checkAndAnnounceVictory(tiles) {
    const turn = getTurnState();
    if (!turn.started || !Array.isArray(turn.playerOrder) || turn.playerOrder.length === 0) return false;
    // 💡 参加国家が最初から1つしかない(ソロテスト等)場合、「最後の1国」判定に意味が無いため何もしない。
    if (turn.playerOrder.length < 2) return false;

    const allTiles = tiles ?? getTiles();
    const aliveIds = getAliveCivIds(turn, allTiles);

    // 想定外(同時全滅など): 勝者を決められないため何もしない
    if (aliveIds.length === 0) return false;

    // 💡 まだ一度も首都を設置していない(＝参入準備中でしかない)国家が残っている場合、
    //    それは「脱落」ではなく単に「まだ始めていない」だけの可能性があるため、
    //    誤って早期に勝利判定をしないよう見送る。
    const notYetStarted = turn.playerOrder.filter(id => !hasEverFoundedCapital(id));
    if (notYetStarted.length > 0) return false;

    if (aliveIds.length === 1) {
        const winnerName = resolveCivName(aliveIds[0]) ?? "不明な国家";
        awardVictoryPoints(aliveIds);
        world.sendMessage(`§6★★★ 勝利！ §a【${winnerName}】§6が唯一残った国家となりました！(ソロ勝利、勝利ポイント+1) ★★★`);
        resetAll();
        return true;
    }

    // 💡 宗教勝利: 生存している全ての国家の国家主流宗教が、いずれか1国家の宗教と一致していれば、
    //    その国家の勝利(参加人数の制限は無い)。
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

    // 💡 同盟勝利は、そのゲームの参加人数が4人以上の場合のみ判定する。
    if (turn.playerOrder.length >= 4 && areAllMutuallyAllied(aliveIds)) {
        const names = aliveIds.map(id => resolveCivName(id) ?? "不明な国家").join("、");
        awardVictoryPoints(aliveIds);
        world.sendMessage(`§6★★★ 勝利！ §b【${names}】§6の同盟が、他のすべての国家を退けました！(同盟勝利、勝利ポイント+1) ★★★`);
        resetAll();
        return true;
    }

    return false;
}

/**
 * 💡 ミサイルの着弾処理。爆発パーティクル/効果音を再生し、着弾先に都市があれば破壊する。
 * @returns {string|null} world.sendMessage 用の結果メッセージ（都市が無ければ null）
 */
export function resolveMissileImpact(config, targetTx, targetTz) {
    const dimension = world.getDimension("overworld");

    const centerX = config.originX + targetTx * TILE_SIZE + 2;
    const centerZ = config.originZ + targetTz * TILE_SIZE + 2;
    const centerY = config.ySurface + 2;

    // 💥 着弾エフェクト（パーティクル + 効果音）
    try {
        dimension.spawnParticle("minecraft:huge_explosion_emitter", { x: centerX, y: centerY, z: centerZ });
    } catch (e) {}
    try {
        dimension.playSound("random.explode", { x: centerX, y: centerY, z: centerZ }, { volume: 4, pitch: 0.8 });
    } catch (e) {}

    const tiles = getTiles();
    const targetKey = `${targetTx},${targetTz}`;
    const targetTile = tiles[targetKey];

    if (!targetTile || !targetTile.city) {
        return `§7[Missile] (${targetTx}, ${targetTz}) に着弾しましたが、そこに都市はありませんでした。`;
    }

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
    // 💡 このプレイヤーのターン処理を始める前に、既に決着がついていないかを確認する
    //    (直前の占領・ミサイル攻撃などで、生存国家が1つ(または同盟のみ)になっている場合)。
    if (checkAndAnnounceVictory(tiles)) return;

    const playerCities = [];
    let movementRefreshed = false;

    for (const key in tiles) {
        const unit = tiles[key].combatUnit;
        if (unit?.ownerId === playerId) {
            unit.movementRemaining = unit.movement ?? 0;
            movementRefreshed = true;
        }
        // 💡 宗教ユニット(別レイヤー)の移動力・布教可否も、戦闘ユニットと同様に毎ターン回復させる。
        //    布教は全ての伝道者につき1ターン1回までなので、このタイミングでフラグを解除する。
        const religiousUnit = tiles[key].religiousUnit;
        if (religiousUnit?.ownerId === playerId) {
            religiousUnit.movementRemaining = religiousUnit.movement ?? 0;
            religiousUnit.hasProselytizedThisTurn = false;
            movementRefreshed = true;
        }
        if (tiles[key].ownerId === playerId && tiles[key].city) {
            playerCities.push({ key, tile: tiles[key] });
        }
    }
    if (playerCities.length === 0) {
        if (movementRefreshed) setTiles(tiles);
        return;
    }

    const summaryReport = [];
    const dimension = world.getDimension("overworld");

    // 1. 各都市の産出量を市民配置システムで算出
    const cityFoodIncomes = {};
    const cityProductionIncomes = {};
    const cityFaithIncomes = {};
    let totalOilIncome = 0; // 💡 追加: プレイヤーの全都市の石油収入合計

    for (const c of playerCities) {
        const yields = getCityCurrentYields(c.key, tiles);
        cityFoodIncomes[c.key] = yields.food;
        cityProductionIncomes[c.key] = yields.production;
        cityFaithIncomes[c.key] = yields.faith ?? 0;
        totalOilIncome += yields.oil ?? 0; // 💡 石油の産出を合算
        c.tile.city.currentTurnProduction = yields.production; // 建造用に退避
    }

    // 2. 交易所による追加食料ボーナスをアドオン
    for (const key in tiles) {
        const t = tiles[key];
        if (t.city?.tradingPost?.status === "active" && t.city.tradingPost.routes) {
            for (const route of t.city.tradingPost.routes) {
                if (t.ownerId === playerId) cityFoodIncomes[key] = (cityFoodIncomes[key] ?? 0) + route.bonus;
                if (tiles[route.targetKey]?.ownerId === playerId) cityFoodIncomes[route.targetKey] = (cityFoodIncomes[route.targetKey] ?? 0) + route.bonus;
            }
        }
    }

    // 3. 各都市の生産(ユニット/建造物)のターン進行処理
    //    💡 どんな生産物であっても、この1箇所で共通処理する(production.js の tickProduction に委譲)。
    //       新しい生産物を増やしたい場合は production.js の PRODUCTION_DEFS に追加するだけでよい。
    for (const c of playerCities) {
        const city = c.tile.city;
        if (!city.production) continue;

        const amount = cityProductionIncomes[c.key] ?? 0;
        const result = tickProduction(city, amount, { cityKey: c.key, tiles, connectTradeRoutes, isAllied: isAlliedOrSameCiv });
        if (result) summaryReport.push(result.message);
    }

    // 3.5 各都市の区域(district)建設のターン進行処理。
    //     通常の生産(city.production)とは別枠(city.districtConstruction)で並行して進む。
    for (const c of playerCities) {
        const city = c.tile.city;
        if (!city.districtConstruction) continue;

        const amount = cityProductionIncomes[c.key] ?? 0;
        const result = tickDistrictConstruction(city, amount, tiles, c.tile.ownerId);
        if (result) summaryReport.push(result.message);
    }

    // 4. 食料の消費・成長・飢餓の解決
    for (const c of playerCities) {
        const tile = tiles[c.key];
        const city = tile.city;
        const income = cityFoodIncomes[c.key] ?? 0;

        // 💡 信仰力は消費が無いため、産出ぶんをそのまま都市ごとの貯留に加算するだけでよい。
        const faithIncome = cityFaithIncomes[c.key] ?? 0;
        if (faithIncome !== 0) {
            city.faithStorage = (city.faithStorage ?? 0) + faithIncome;
            summaryReport.push(`§d🙏【${city.name}】信仰力+${faithIncome}(累計: ${city.faithStorage})`);
        }

        // 💡 生産中の物によっては食料消費が上乗せされる(例: 交易所建設中は+1)。
        //    PRODUCTION_DEFS 側の extraUpkeep を見るだけなので、新しい生産物を増やしても自動で反映される。
        const activeProductionDef = city.production ? PRODUCTION_DEFS[city.production.id] : null;
        const upkeepExtra = activeProductionDef?.extraUpkeep ?? 0;

        city.foodStorage = (city.foodStorage ?? 0) + income;
        let consumption = city.population + upkeepExtra;
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

    // 💡 このターンの飢餓による都市崩壊などで、生存国家が1つ(または同盟のみ)になっていないかを確認する。
    if (checkAndAnnounceVictory(tiles)) return;

    const player = getCivStorageHandle(playerId);
    if (player) {
        // 💡 聖地(sacredSite)のある都市は、自国が宗教を創始していれば、
        //    毎ターン自国の宗教の宗教的圧力を+100する(帰属都市ごとに、聖地1つにつき)。
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
        for(const c of playerCities) { totalPop += c.tile.city.population; }

        // 人口1ごとに科学力・文化力を1獲得する。進行中の項目がなければ
        // 繰越ポイントとして保存され、開始した研究／制度へ直ちに使われる。
        const technologyResult = grantProgressPoints(player, "technology", totalPop);
        const civicResult = grantProgressPoints(player, "civic", totalPop);
        if (technologyResult) summaryReport.unshift(technologyResult);
        if (civicResult) summaryReport.unshift(civicResult);
        // 💡 石油の収入処理を個人のDynamicPropertyに適用
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

    // 💡 ゲーム開始時に、参加順でプレイヤーごとの固有色を確定させる(以降は変化しない)
    turn.playerColors = {};
    turn.playerOrder.forEach((playerId, idx) => {
        turn.playerColors[playerId] = PLAYER_COLORS[idx % PLAYER_COLORS.length];
    });

    // 前ゲームの研究・制度ポイントを持ち越さない。(実プレイヤー・テスト国家とも)
    // 💡 勝利ポイント(civ:victoryPoints)はレート的な値としてゲームを跨いで持続させるため、
    //    ここではリセットしない。
    for (const playerId of turn.playerOrder) {
        const handle = getCivStorageHandle(playerId);
        if (!handle) continue; // オフラインの実プレイヤーはデータを書き込めないためスキップ
        resetProgress(handle, "technology");
        resetProgress(handle, "civic");
        resetDiplomacy(handle);
        handle.setDynamicProperty("civ:hasFoundedCapital", false); // 新しいゲームでは首都を再び設置できるようにする
    }

    setTurnState(turn);

    // 💡 参加登録した直後にオフラインになっている等、最初の手番が誰も操作できない国家に
    //    ならないよう、ここでも自動スキップを適用する。
    const turnAfterSkip = getTurnState();
    const found = advanceToNextControllablePlayer(turnAfterSkip);
    setTurnState(turnAfterSkip);

    const firstId = turnAfterSkip.playerOrder[turnAfterSkip.currentIndex];
    processPlayerTurnStart(firstId);
    const name = getPlayerNameById(firstId) ?? "不明(オフライン)";
    if (found) {
        world.sendMessage(`§e=== ゲームが開始されました！ 手番: §a${name}§e ===`);
    } else {
        world.sendMessage(`§e=== ゲームが開始されました！ §c参加者全員がオフラインのため待機中 ===`);
    }
    return { ok: true, message: "ゲーム開始" };
}

/**
 * 現在の手番(turn.currentIndex)から、実際に操作できる(オンラインの)国家が見つかるまで
 * 手番を進める。誰かが途中でゲームから抜けても、その国家の手番のままゲームが止まって
 * しまわないようにするための安全策。turn.currentIndex / turn.turnNumber を直接書き換える。
 * @param {any} turn getTurnState()で取得したターン状態
 * @returns {boolean} 操作可能な国家が見つかった場合 true。参加者全員が操作不能だった場合 false
 *   (この場合もcurrentIndexは1周分進んだ状態になるが、それ以上は進めない)
 */
function advanceToNextControllablePlayer(turn) {
    const total = turn.playerOrder.length;
    if (total === 0) return false;

    for (let i = 0; i < total; i++) {
        const civId = turn.playerOrder[turn.currentIndex];
        if (isCivControllable(civId)) return true;

        turn.currentIndex = (turn.currentIndex + 1) % total;
        if (turn.currentIndex === 0) turn.turnNumber += 1;
    }
    return false; // 参加者全員がオフライン等で、1周しても操作可能な国家が見つからなかった
}

export function endTurn(player) {
    const turn = getTurnState();
    if (!turn.started) return { ok: false, message: "§cゲーム未開始です。" };
    if (player.id !== turn.playerOrder[turn.currentIndex]) return { ok: false, message: "§c手番ではありません。" };

    turn.currentIndex = (turn.currentIndex + 1) % turn.playerOrder.length;
    if (turn.currentIndex === 0) turn.turnNumber += 1;

    // 💡 進めた先の国家が誰も操作できない(オフライン)場合、操作できる国家が見つかるまで
    //    自動的にさらに手番を進める(誰かが抜けてゲームが止まってしまうのを防ぐ)。
    const found = advanceToNextControllablePlayer(turn);
    setTurnState(turn);

    const nextId = turn.playerOrder[turn.currentIndex];
    processPlayerTurnStart(nextId);

    const nextName = getPlayerNameById(nextId) ?? "不明(オフライン)";
    if (found) {
        world.sendMessage(`§e>>> ターン ${turn.turnNumber}: §a${nextName}§e のターン <<<`);
    } else {
        world.sendMessage(`§e>>> ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中(復帰次第 §a${nextName}§c から再開) <<<`);
    }
    return { ok: true, message: "ターン終了" };
}

/**
 * 🛠 OP用: 現在の手番を強制的に次へ進める。
 * 通常のendTurn()と違い、呼び出し元がその手番の本人である必要はない
 * (手番のプレイヤーが応答不能・フリーズしている場合などの保険として使う)。
 * プレイヤーが退出した瞬間の自動スキップ処理(main.js)からも呼ばれる。
 */
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
    if (found) {
        world.sendMessage(`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §a${nextName}§e のターン <<<`);
    } else {
        world.sendMessage(`§e>>> (ターンを強制的にスキップ) ターン ${turn.turnNumber}: §c参加者全員がオフラインのため待機中 <<<`);
    }
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
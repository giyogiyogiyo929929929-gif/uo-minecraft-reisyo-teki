// turns.js
import { world, BlockPermutation } from "@minecraft/server";
import { getTurnState, setTurnState, resetAll, getTiles, setTiles, getMapConfig, setTile } from "./state.js";
import { PRODUCTION_DEFS, tickProduction } from "./production.js";
import { grantProgressPoints, resetProgress } from "./progression.js";
import { resetDiplomacy } from "./diplomacy.js";
import { hasCompletedProgress } from "./progression.js";
import { getCivStorageHandle, resolveCivName } from "./civs.js";

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
    if (!cityTile || !cityTile.city) return { food: 0, production: 1, oil: 0 };
    
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

    return { food, production: Math.max(1, production), oil }; // 最低生産力は1を保証
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

    return `§c💥 【${cityName}】(${ownerName})がミサイル攻撃により破壊されました！`;
}

function processPlayerTurnStart(playerId) {
    const config = getMapConfig();
    if (!config) return;

    const tiles = getTiles();
    const playerCities = [];
    let movementRefreshed = false;

    for (const key in tiles) {
        const unit = tiles[key].combatUnit;
        if (unit?.ownerId === playerId) {
            unit.movementRemaining = unit.movement ?? 0;
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
    let totalOilIncome = 0; // 💡 追加: プレイヤーの全都市の石油収入合計

    for (const c of playerCities) {
        const yields = getCityCurrentYields(c.key, tiles);
        cityFoodIncomes[c.key] = yields.food;
        cityProductionIncomes[c.key] = yields.production;
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
        const result = tickProduction(city, amount, { cityKey: c.key, tiles, connectTradeRoutes });
        if (result) summaryReport.push(result.message);
    }

    // 4. 食料の消費・成長・飢餓の解決
    for (const c of playerCities) {
        const tile = tiles[c.key];
        const city = tile.city;
        const income = cityFoodIncomes[c.key] ?? 0;

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

    const player = getCivStorageHandle(playerId);
    if (player) {
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
    for (const playerId of turn.playerOrder) {
        const handle = getCivStorageHandle(playerId);
        if (!handle) continue; // オフラインの実プレイヤーはデータを書き込めないためスキップ
        resetProgress(handle, "technology");
        resetProgress(handle, "civic");
        resetDiplomacy(handle);
    }

    setTurnState(turn);

    processPlayerTurnStart(turn.playerOrder[0]);
    const name = getPlayerNameById(turn.playerOrder[0]) ?? "未知";
    world.sendMessage(`§e=== ゲームが開始されました！ 手番: §a${name}§e ===`);
    return { ok: true, message: "ゲーム開始" };
}

export function endTurn(player) {
    const turn = getTurnState();
    if (!turn.started) return { ok: false, message: "§cゲーム未開始です。" };
    if (player.id !== turn.playerOrder[turn.currentIndex]) return { ok: false, message: "§c手番ではありません。" };

    turn.currentIndex = (turn.currentIndex + 1) % turn.playerOrder.length;
    if (turn.currentIndex === 0) turn.turnNumber += 1;
    setTurnState(turn);

    const nextId = turn.playerOrder[turn.currentIndex];
    processPlayerTurnStart(nextId);

    const nextName = getPlayerNameById(nextId) ?? "未知";
    world.sendMessage(`§e>>> ターン ${turn.turnNumber}: §a${nextName}§e のターン <<<`);
    return { ok: true, message: "ターン終了" };
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
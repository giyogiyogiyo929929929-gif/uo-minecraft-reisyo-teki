// commands.js
import { world, system, BlockPermutation, PlayerPermissionLevel } from "@minecraft/server";
import { generateMapJob, TERRAIN_TYPES, worldToTile, TILE_SIZE, RESOURCE_TYPES } from "./mapGen.js";
import { getMapConfig, setMapConfig, getTile, setTile, resetAll, setTiles, getTiles } from "./state.js";
import { joinGame, startGame, endTurn, turnInfoText, isPlayersTurn, endGame, getTurnState, setTurnState, getCityCurrentYields, resolveMissileImpact, getPlayerColor } from "./turns.js";
import { PRODUCTION_DEFS, canStartProduction, startProduction, cancelProduction } from "./production.js";
import { getDefinition, getKindLabel, startProgress } from "./progression.js";
import { hasDiplomaticAgreement, signAgreement } from "./diplomacy.js";
import { getAttackRange, resolveCombat, tileDistance } from "./combat.js";
import { addVirtualCiv, getControllableCivs, getActiveCivId, setActiveCivId, getActingPlayer } from "./civs.js";
import { openMainMenu } from "./ui.js";

// 💡 都市名の命名プール
const CITY_NAMES_POOL = [
    "ローマ", "カルタゴ", "アレクサンドリア", "アテネ", "バビロン", "スパルタ", 
    "ペルセポリス", "テノチティトラン", "クスコ", "長安", "京都", "ロンドン", 
    "パリ", "ベルリン", "モスクワ", "ワシントン", "イスタンブール", "カイロ",
    "青森"
];

function isOperator(player) {
    return player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

function reply(player, text) { player.sendMessage(text); }

world.beforeEvents.chatSend.subscribe(async (ev) => {
    const { sender: realPlayer, message } = ev;
    const player = getActingPlayer(realPlayer);

    if (message === '.missile') {
        ev.cancel = true;
        await Promise.resolve();
        const tiles = getTiles();
        let capitalKey = null;
        for (const key in tiles) {
            if (tiles[key].ownerId === player.id && tiles[key].city && tiles[key].city.isCapital) { capitalKey = key; break; }
        }
        const capitalTile = tiles[capitalKey];
        const city = capitalTile.city;
        city.missiles = 999;
        const [cx, cz] = capitalKey.split(",");
        setTile(parseInt(cx, 10), parseInt(cz, 10), capitalTile);
        player.sendMessage(`§c[Missile]🎉【${city.name}】ミサイルチート発動！ (在庫: ${city.missiles}発)`);
    }
    if (message === '.nuke') {
        ev.cancel = true;
        await Promise.resolve();
        const config = getMapConfig();
        for (let x = 0; x < config.width; x++) {
            for (let z = 0; z < config.height; z++) {
                resolveMissileImpact(getMapConfig(), x, z);
            }
            
        }
        world.sendMessage(`§cミサイルの嵐！`);
    }
})

function cmdHelp(player) {
    reply(player, [
        "§6--- Civ Tactics コマンド一覧 ---",
        "§e!civ generate <幅> <高さ> §f: マップ生成(OPのみ)",
        "§e!civ join §f: ゲームに参加",
        "§e!civ start §f: ゲーム開始(OPのみ)",
        "§c!civ end §f: ゲームをリセット(OPのみ)",
        "§e!civ endturn §f: 自分のターンを終了",
        "§e!civ claim §f: 周囲の土地を領有 (コスト: 人口1)",
        "§e!civ buyrights §f: 開拓権を獲得 (コスト: 首都人口2)",
        "§e!civ settle §f: 都市を建設 (コスト: 開拓権x1)",
        "§e!civ build <worker|missile|tradingPost> §f: 生産を開始",
        "§c!civ cancelbuild §f: 進行中の生産を中止(蓄積分は次に引き継ぎ)",
        "§e!civ chop §f: 森林を伐採して住宅上限+1",
        "§c!civ launch <x> <z> §f: 指定マスへミサイルを発射",
        "§e!civ info §f: 現在の情報を表示",
        "§e!civ menu §f: メニューを開く",
        "§d!civ addciv [名前] §f: ソロテスト用の国家を追加(OPのみ)",
        "§d!civ switchciv [番号] §f: 操作中の国家を切り替える",
        "§d!civ civs §f: 操作できる国家の一覧を表示",
    ].join("\n"));
}

function cmdEndGame(player) {
    if (!isOperator(player)) { reply(player, "§cこのコマンドはOPのみ実行できます。"); return; }
    world.sendMessage(endGame().message);
}

/** ソロテスト用に、OPが自分で操作できる国家をもう一つ追加する。 */
function cmdAddCiv(realPlayer, name) {
    if (!isOperator(realPlayer)) { reply(realPlayer, "§cこのコマンドはOPのみ実行できます。"); return; }
    const turn = getTurnState();
    if (turn.started) { reply(realPlayer, "§cゲーム開始後は国家を追加できません。ゲーム開始前に追加してください。"); return; }

    const civ = addVirtualCiv(realPlayer, name);
    reply(realPlayer, `§aテスト国家【${civ.name}】を追加しました。§e!civ switchciv§aで操作を切り替え、§e!civ join§aで参加させてください。`);
}

/** 操作中の国家を切り替える(自分自身、または自分が追加したテスト国家のみ)。 */
function cmdSwitchCiv(realPlayer, arg) {
    const civs = getControllableCivs(realPlayer);
    if (civs.length <= 1) { reply(realPlayer, "§c切り替えられる国家がありません。§e!civ addciv§cでテスト国家を追加してください。"); return; }

    let target = null;
    if (arg) {
        const idx = parseInt(arg, 10);
        target = (!isNaN(idx) && civs[idx - 1]) ? civs[idx - 1] : civs.find(c => c.id === arg);
    }

    if (!target) {
        const activeId = getActiveCivId(realPlayer);
        reply(realPlayer, [
            "§e操作中の国家を切り替えます。番号を指定してください(例: !civ switchciv 2):",
            ...civs.map((c, i) => `${i + 1}. ${c.name}${c.id === activeId ? " §a(操作中)" : ""}${c.isVirtual ? " §7(テスト国家)" : ""}`),
        ].join("\n"));
        return;
    }

    const result = setActiveCivId(realPlayer, target.id);
    if (!result.ok) { reply(realPlayer, result.message); return; }
    reply(realPlayer, `§a操作中の国家を【${target.name}】に切り替えました。`);
}

/** 操作できる国家の一覧を表示する。 */
function cmdListCivs(realPlayer) {
    const civs = getControllableCivs(realPlayer);
    const activeId = getActiveCivId(realPlayer);
    reply(realPlayer, [
        "§e--- 操作できる国家一覧 ---",
        ...civs.map((c, i) => `${i + 1}. ${c.name}${c.id === activeId ? " §a(操作中)" : ""}${c.isVirtual ? " §7(テスト国家)" : ""}`),
    ].join("\n"));
}

export function cmdRenameCity(player, tx, tz, newName) {
    const tiles = getTiles();
    const tileKey = `${tx},${tz}`;
    const tile = tiles[tileKey];

    if (!tile || !tile.city) return;
    if (tile.ownerId !== player.id) {
        player.sendMessage("§c❌ 自分の都市の名前しか変更できません。");
        return;
    }

    const oldName = tile.city.name;
    tile.city.name = newName;
    setTile(tx, tz, tile);

    world.sendMessage(`§e📢 【都市改名】${player.name} が【${oldName}】の名前を【${newName}】に変更しました！`);
}

/**
 * @param {boolean} isCapital 首都かどうか。首都の場合、中心にレッドストーンブロックが置かれる分
 *                            旗自体も1マス高い位置(y+1)に設置する。
 */
function placePlayerBannerAtCenter(dimension, tx, tz, config, playerId, isCapital = false) {
    const TILE_SIZE = 5;
    const baseX = config.originX + tx * TILE_SIZE;
    const baseZ = config.originZ + tz * TILE_SIZE;
    
    const centerX = baseX + 2;
    const centerZ = baseZ + 2;
    const ySurface = config.ySurface;
    // 💡 首都はマス中心の y+1 にレッドストーンブロックが埋め込まれるため、旗もその分だけ高く設置する
    const yOffset = isCapital ? 1 : 0;

    // 💡 プレイヤーの色はゲーム開始時(startGame)に確定した固有色を使う。
    //    (以前は world.getAllPlayers() の並び順から都度算出していたため、
    //     1ターン中にこの関数を複数回呼ぶと色がずれていく問題があった)
    const color = getPlayerColor(playerId);

    const targetBlock = dimension.getBlock({ x: centerX, y: ySurface + yOffset, z: centerZ });
    if (!targetBlock) return;

    // 🌊 水マス（川や海）だった場合は、水面をウールで染める（棒が立てられないため）
    if (targetBlock.typeId === "minecraft:water" || targetBlock.typeId === "minecraft:flowing_water") {
        try {
            const woolPerm = BlockPermutation.resolve(`minecraft:${color}_wool`);
            targetBlock.setPermutation(woolPerm);
        } catch (e) {
            targetBlock.setPermutation(BlockPermutation.resolve("minecraft:white_wool"));
        }
    } 
    // 🪵 通常の陸地だった場合：立体的な「のぼり旗」を建築する
    else {
        try {
            // 1. 地面の1マス上に「フェンス（旗の棒）」を立てる
            const poleBlock = dimension.getBlock({ x: centerX, y: ySurface + yOffset + 1, z: centerZ });
            poleBlock?.setPermutation(BlockPermutation.resolve("minecraft:oak_fence"));

            // 2. さらにその上（2マス上）に、プレイヤー色の「羊毛（旗の布部分）」を載せる
            const clothBlock = dimension.getBlock({ x: centerX, y: ySurface + yOffset + 2, z: centerZ });
            const woolPerm = BlockPermutation.resolve(`minecraft:${color}_wool`);
            clothBlock?.setPermutation(woolPerm);
        } catch (e) {
            // エラー時のセーフティ（白いウールを直接置く）
            const fallbackBlock = dimension.getBlock({ x: centerX, y: ySurface + yOffset + 1, z: centerZ });
            fallbackBlock?.setPermutation(BlockPermutation.resolve("minecraft:white_wool"));
        }
    }
}

function cmdGenerate(player, args) {
    if (!isOperator(player)) { reply(player, "§cこのコマンドはOPのみ実行できます。"); return; }
    const width = Math.max(1, Math.min(100, parseInt(args[0] ?? "10", 10) || 10));
    const height = Math.max(1, Math.min(100, parseInt(args[1] ?? "10", 10) || 10));

    const loc = player.location;
    const dimension = player.dimension;
    const originX = Math.floor(loc.x) - Math.floor((width * TILE_SIZE) / 2);
    const originZ = Math.floor(loc.z) - Math.floor((height * TILE_SIZE) / 2);
    const ySurface = Math.floor(loc.y) - 1;

    resetAll();
    const config = { originX, originZ, ySurface, width, height, tileSize: TILE_SIZE };
    setMapConfig(config);

    reply(player, `§aマップ生成を開始します... (${width} x ${height} マス)`);

    const tiles = {};
    const job = generateMapJob(dimension, { ...config, seed: Date.now() }, (tx, tz, type, resource, foodYield, productionYield) => {
        tiles[`${tx},${tz}`] = { type, ownerId: null, ownerName: null, resource: resource ?? null, foodYield, productionYield, city: null, isChopped: false };
    });

    system.runJob((function* () {
        yield* job;
        setTiles(tiles);
        world.sendMessage("§a=== マップ生成が完了しました! ===");
    })());
}

function cmdJoin(player) { reply(player, joinGame(player).message); }
function cmdStart(player) { if (isOperator(player)) startGame(); }
function cmdEndTurn(player) { const result = endTurn(player); if (!result.ok) reply(player, result.message); }

export function cmdBuyRights(player) {
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return; }
    const allTiles = getTiles();
    let capitalKey = null;
    for (const key in allTiles) {
        if (allTiles[key].ownerId === player.id && allTiles[key].city && allTiles[key].city.isCapital) { capitalKey = key; break; }
    }
    if (!capitalKey) { reply(player, "§c首都が存在しません。"); return; }
    const capitalTile = allTiles[capitalKey];
    if (capitalTile.city.population < 3) { reply(player, "§c首都の人口が足りません(人口3以上必要)。"); return; }

    capitalTile.city.population -= 2;
    const [cx, cz] = capitalKey.split(",");
    setTile(parseInt(cx, 10), parseInt(cz, 10), capitalTile);

    const turn = getTurnState();
    if (!turn.playerRights) turn.playerRights = {};
    turn.playerRights[player.id] = (turn.playerRights[player.id] ?? 0) + 1;
    setTurnState(turn);

    reply(player, `§a🎉 首都の人口を2消費し、開拓権を獲得しました！(ストック: ${turn.playerRights[player.id]}回)`);
}

export function cmdClaim(player) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return; }
    if (!isPlayersTurn(player)) { reply(player, "§c手番ではありません。"); return; }
    
    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) { reply(player, "§c範囲外です。"); return; }
    
    const tile = getTile(tx, tz);
    if (!tile) { reply(player, "§cマス情報がありません。"); return; }
    if (tile.ownerId) { reply(player, `§cこのマスは既に ${tile.ownerName} の領地です。`); return; }

    const allTiles = getTiles();
    let hasNeighbor = false;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            const neighbor = allTiles[`${tx + dx},${tz + dz}`];
            if (neighbor && neighbor.ownerId === player.id) { hasNeighbor = true; break; }
        }
        if (hasNeighbor) break;
    }

    if (!hasNeighbor) { reply(player, "§c領有エラー: 自分の都市または領地の周囲8マス以内しか領有できません。"); return; }

    let minDist = Infinity;
    let nearestCityKeys = [];
    for (const key in allTiles) {
        const t = allTiles[key];
        if (t.ownerId === player.id && t.city) {
            const [cxStr, czStr] = key.split(",");
            const dist = Math.abs(tx - parseInt(cxStr, 10)) + Math.abs(tz - parseInt(czStr, 10));
            if (dist < minDist) { minDist = dist; nearestCityKeys = [key]; }
            else if (dist === minDist) { nearestCityKeys.push(key); }
        }
    }

    if (nearestCityKeys.length === 0) { reply(player, "§cコストを支払うための都市が存在しません。"); return; }

    let targetCityKey = nearestCityKeys[0];
    if (nearestCityKeys.length > 1) {
        let minOwned = Infinity;
        for (const ck of nearestCityKeys) {
            let count = 0;
            for (const mk in allTiles) {
                if (allTiles[mk].ownerId === player.id) {
                    const [mx, mz] = mk.split(",");
                    let mMinDist = Infinity;
                    let mNearest = [];
                    for (const ck2 in nearestCityKeys) {
                        const [cx2, cz2] = nearestCityKeys[ck2].split(",");
                        const d = Math.abs(parseInt(mx, 10) - parseInt(cx2, 10)) + Math.abs(parseInt(mz, 10) - parseInt(cz2, 10));
                        if (d < mMinDist) { mMinDist = d; mNearest = [nearestCityKeys[ck2]]; }
                        else if (d === mMinDist) { mNearest.push(nearestCityKeys[ck2]); }
                    }
                    if (mNearest.includes(ck)) count++;
                }
            }
            if (count < minOwned) { minOwned = count; targetCityKey = ck; }
        }
    }

    const sourceCityTile = allTiles[targetCityKey];
    if (sourceCityTile.city.population < 2) {
        reply(player, `§c領有コスト不足: 最寄り都市 の人口が足りません(人口2以上必要)。`);
        return;
    }

    sourceCityTile.city.population -= 1;
    const [scx, scz] = targetCityKey.split(",");
    setTile(parseInt(scx, 10), parseInt(scz, 10), sourceCityTile);

    setTile(tx, tz, { type: tile.type, ownerId: player.id, ownerName: player.name, resource: tile.resource ?? null, foodYield: tile.foodYield ?? 2, productionYield: tile.productionYield ?? 1, city: null, isChopped: tile.isChopped ?? false, belongsToCityKey: targetCityKey });

    player.runCommand(`title @a title §a${player.name}`);
    player.runCommand(`title @a subtitle §fマス (${tx}, ${tz}) を領有！`);

    const dimension = player.dimension;
    const baseX = config.originX + tx * TILE_SIZE;
    const baseZ = config.originZ + tz * TILE_SIZE;
    const y = config.ySurface;
    const markerBlock = BlockPermutation.resolve("minecraft:gold_block");

    [{ x: baseX, y, z: baseZ }, { x: baseX + 4, y, z: baseZ }, { x: baseX, y, z: baseZ + 4 }, { x: baseX + 4, y, z: baseZ + 4 }].forEach(pos => {
        dimension.getBlock(pos)?.setPermutation(markerBlock);
    });
    placePlayerBannerAtCenter(dimension, tx, tz, config, player.id);

    player.runCommand(`playsound random.levelup @a ${player.location.x} ${player.location.y} ${player.location.z}`);
    world.sendMessage(`§a${player.name} が (${tx}, ${tz}) を領有！ [最寄り都市(${sourceCityTile.city.name})の人口を1消費]`);
}

/**
 * 💡 汎用生産開始コマンド。
 * どの生産物(労働者・ミサイル・交易所…)であっても、この1つの関数だけで処理する。
 * 新しい生産物を増やす場合は production.js の PRODUCTION_DEFS に追加するだけでよく、
 * このコマンド自体は変更不要。
 *
 * @param {string} productionId production.js の PRODUCTION_DEFS のキー(例: "worker", "missile", "tradingPost")
 */
export function cmdStartProduction(player, productionId) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const def = PRODUCTION_DEFS[productionId];
    if (!def) { reply(player, "§c不明な生産物です。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    const tile = getTile(tx, tz);
    if (!tile || !tile.city) { reply(player, "§cここにあなたの都市はありません。"); return { ok: false }; }
    if (tile.ownerId !== player.id) { reply(player, "§cこの都市の所有権がありません。"); return { ok: false }; }

    const check = canStartProduction(tile.city, productionId, tile);
    if (!check.ok) { reply(player, check.message); return { ok: false }; }

    startProduction(tile.city, productionId);
    setTile(tx, tz, tile);

    const { production } = getCityCurrentYields(`${tx},${tz}`, getTiles());
    const remaining = Math.max(0, tile.city.production.cost - tile.city.production.progress);
    const estTurns = production > 0 ? Math.ceil(remaining / production) : "∞";

    world.sendMessage(
        `§e${def.icon} ${player.name} が都市【${tile.city.name}】で【${def.label}】の生産を開始しました！` +
        ` (必要生産力: ${tile.city.production.cost}、現在の生産力: [Prod]x${production}、予測: 約${estTurns}ターン)`
    );
    return { ok: true };
}

/**
 * 💡 生産中止コマンド。蓄積していた生産力は消滅せず、次の生産に引き継がれる。
 */
export function cmdCancelProduction(player) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    const tile = getTile(tx, tz);
    if (!tile || !tile.city) { reply(player, "§cここにあなたの都市はありません。"); return { ok: false }; }
    if (tile.ownerId !== player.id) { reply(player, "§cこの都市の所有権がありません。"); return { ok: false }; }

    const cancelled = cancelProduction(tile.city);
    if (!cancelled) { reply(player, "§c現在、生産中の物がありません。"); return { ok: false }; }

    setTile(tx, tz, tile);

    const def = PRODUCTION_DEFS[cancelled.id];
    const label = def?.label ?? cancelled.id;
    world.sendMessage(`§7🛑 ${player.name} が都市【${tile.city.name}】の【${label}】の生産を中止しました。(蓄積生産力 ${cancelled.progress} は次の生産へ引き継がれます)`);
    return { ok: true };
}

// 💡 新機能: ミサイル発射コマンド。targetTx/targetTzはマス座標(tx, tz)を指定する。
export function cmdLaunchMissile(player, targetTx, targetTz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    const tile = getTile(tx, tz);
    if (!tile || !tile.city) { reply(player, "§cここにあなたの都市はありません。"); return { ok: false }; }
    if (tile.ownerId !== player.id) { reply(player, "§cこの都市の所有権がありません。"); return { ok: false }; }
    if (!tile.city.missiles || tile.city.missiles <= 0) { reply(player, "§c[Missile] 発射可能なミサイルがありません。"); return { ok: false }; }

    const ttx = Math.floor(targetTx);
    const ttz = Math.floor(targetTz);
    if (isNaN(ttx) || isNaN(ttz) || ttx < 0 || ttz < 0 || ttx >= config.width || ttz >= config.height) {
        reply(player, "§c座標がマップ範囲外、または不正な値です。");
        return { ok: false };
    }

    tile.city.missiles -= 1;
    setTile(tx, tz, tile);

    world.sendMessage(`§c[Missile] ${player.name} の都市【${tile.city.name}】から (${ttx}, ${ttz}) へミサイルが発射されました！`);
    player.runCommand(`playsound random.bow @a ${player.location.x} ${player.location.y} ${player.location.z}`);

    // 💡 演出用に少し間を置いてから着弾させる（2秒後）
    system.runTimeout(() => {
        const impactMessage = resolveMissileImpact(config, ttx, ttz);
        if (impactMessage) world.sendMessage(impactMessage);
    }, 40);

    return { ok: true };
}

export function cmdSettle(player) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return; }
    if (!isPlayersTurn(player)) { reply(player, "§c手番ではありません。"); return; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) { reply(player, "§c範囲外です。"); return; }

    const tile = getTile(tx, tz);
    if (!tile) { reply(player, "§cマス情報がありません。"); return; }
    if (tile.ownerId && tile.ownerId !== player.id) { reply(player, "§c他領地には建設できません。"); return; }
    if (tile.city) { reply(player, "§c既に都市が存在します。"); return; }

    const allTiles = getTiles();
    let hasAnyCity = false;
    for (const key in allTiles) {
        if (allTiles[key].ownerId === player.id && allTiles[key].city) { hasAnyCity = true; break; }
    }

    const turn = getTurnState();
    if (!turn.playerRights) turn.playerRights = {};
    const rights = turn.playerRights[player.id] ?? 0;

    if (hasAnyCity && rights <= 0) {
        reply(player, "§c開拓する権利がありません。首都で !civ buyrights を実行してください。");
        return;
    }

    const isCapital = !hasAnyCity;

    const initPopulation = isCapital ? 2 : 1;
    const initWorkers = isCapital ? 1 : 0;

    let hasRiver = false;
    let hasSea = false;
    const adjDirections = [{ x: tx + 1, z: tz }, { x: tx - 1, z: tz }, { x: tx, z: tz + 1 }, { x: tx, z: tz - 1 }];
    for (const dir of adjDirections) {
        const adj = allTiles[`${dir.x},${dir.z}`];
        if (adj) {
            if (adj.type === "river" || adj.type === "pond" || adj.type === "lake") hasRiver = true;
            if (adj.type === "sea") hasSea = true;
        }
    }

    let housing = 2;
    let waterText = "淡水なし";
    if (hasRiver) { housing = 5; waterText = "淡水隣接"; }
    else if (hasSea) { housing = 3; waterText = "海水隣接"; }

    let hasEnemyNeighbor = false;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            const neighbor = allTiles[`${tx + dx},${tz + dz}`];
            if (neighbor && neighbor.ownerId && neighbor.ownerId !== player.id && !hasDiplomaticAgreement(player.id, neighbor.ownerId)) {
                hasEnemyNeighbor = true;
                break;
            }
        }
        if (hasEnemyNeighbor) break;
    }

    if (hasEnemyNeighbor) {
        housing = Math.max(0, housing - 1);
        waterText += " ＆ §c国境隣接ペナルティ住宅-1";
    }

    // 💡 新機能: ランダムに選んだ都市名に座標を添えてユニーク命名
    const pickedBaseName = CITY_NAMES_POOL[Math.floor(Math.random() * CITY_NAMES_POOL.length)];
    const cityUniqueName = `${pickedBaseName}・市`;

    tile.city = {
        name: cityUniqueName, // 👈 名前をセット
        population: initPopulation,
        workers: initWorkers,
        housing: housing,
        foodStorage: 0,
        starvationTurns: 0,
        isCapital: isCapital,
        tradingPost: null,     // 交易所データ用の初期スロット(完成すると { status: "active", routes: [] } になる)
        production: null,      // 💡 進行中の生産 { id, progress, cost } | null (production.js で管理)
        productionCarry: 0     // 💡 中断/完了時に余った生産力(次の生産に引き継ぐ)
    };
    tile.ownerId = player.id;
    tile.ownerName = player.name;
    setTile(tx, tz, tile);

    if (!isCapital) {
        turn.playerRights[player.id] -= 1;
        setTurnState(turn);
    }

    const dimension = player.dimension;
    const cx = config.originX + tx * TILE_SIZE + 2;
    const cz = config.originZ + tz * TILE_SIZE + 2;
    const y = config.ySurface;
    const air = BlockPermutation.resolve("minecraft:air");

    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            for (let dy = 1; dy <= 3; dy++) {
                dimension.getBlock({ x: cx + dx, y: y + dy, z: cz + dz })?.setPermutation(air);
            }
        }
    }
    const blockId = isCapital ? "minecraft:redstone_block" : "minecraft:iron_block";
    dimension.getBlock({ x: cx, y: y + 1, z: cz })?.setPermutation(BlockPermutation.resolve(blockId));

    const labelName = isCapital ? "首都" : "都市";
    placePlayerBannerAtCenter(dimension, tx, tz, config, player.id, isCapital);
    player.runCommand(`title @a title §6${labelName}【${cityUniqueName}】建設！`);
    world.sendMessage(`§6★ ${player.name} が (${tx}, ${tz}) に${labelName}【${cityUniqueName}】を創設！ (${waterText}, 住宅上限: ${housing})`);
}

// 💡 交易所の建設も、労働者・ミサイルと同じ汎用生産コマンド cmdStartProduction("tradingPost") で行う。
//    (以前はここに専用の cmdBuildTradingPost 関数があったが、生産システム統合により不要になった)

export function cmdChop(player) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) { reply(player, "§c範囲外です。"); return { ok: false }; }

    const tile = getTile(tx, tz);
    if (!tile || tile.ownerId !== player.id) { reply(player, "§cあなたの領地ではありません。"); return { ok: false }; }
    if (tile.type !== "forest" && tile.type !== "rainforest") { reply(player, "§c森林マスではありません。"); return { ok: false }; }
    if (tile.isChopped) { reply(player, "§c既に伐採済みです。"); return { ok: false }; }

    // 💡 労働者の所属・帰属先都市を決定する
    let cityKey = tile.city ? `${tx},${tz}` : tile.belongsToCityKey;

    // 古いデータや例外用のフォールバック（帰属がなければその場で最寄りを探す）
    if (!cityKey) {
        const allTiles = getTiles();
        let minDist = Infinity;
        for (const key in allTiles) {
            const t = allTiles[key];
            if (t.ownerId === player.id && t.city) {
                const [cx, cz] = key.split(",");
                const dist = Math.abs(tx - parseInt(cx, 10)) + Math.abs(tz - parseInt(cz, 10));
                if (dist < minDist) { minDist = dist; cityKey = key; }
            }
        }
        if (cityKey) { tile.belongsToCityKey = cityKey; setTile(tx, tz, tile); }
    }

    if (!cityKey) { reply(player, "§c作業エラー: このマスが帰属する都市が存在しません。"); return { ok: false }; }

    const allTiles = getTiles();
    const cityTile = allTiles[cityKey];
    if (!cityTile || !cityTile.city) { reply(player, "§c帰属先の都市が見つかりません。"); return { ok: false }; }

    // 💡 労働者数のチェック
    const currentWorkers = cityTile.city.workers ?? 0;
    if (currentWorkers <= 0) {
        reply(player, `§c❌ 労働者が足りません！この作業には帰属都市【${cityTile.city.name}】の労働者が必要です。`);
        return { ok: false };
    }

    // 💡 労働者を-1し、伐採効果（住宅上限+1）をその帰属都市に付与
    cityTile.city.workers = currentWorkers - 1;
    cityTile.city.housing += 1;
    
    const [cxStr, czStr] = cityKey.split(",");
    setTile(parseInt(cxStr, 10), parseInt(czStr, 10), cityTile);

    tile.isChopped = true;
    setTile(tx, tz, tile);

    // (演出ブロック消去処理)
    const dimension = player.dimension;
    const blockCx = config.originX + tx * TILE_SIZE + 2;
    const blockCz = config.originZ + tz * TILE_SIZE + 2;
    const y = config.ySurface;
    const air = BlockPermutation.resolve("minecraft:air");

    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            for (let dy = 1; dy <= 8; dy++) {
                const block = dimension.getBlock({ x: blockCx + dx, y: y + dy, z: blockCz + dz });
                if (block && (block.typeId.includes("log") || block.typeId.includes("leaves"))) { block.setPermutation(air); }
            }
        }
    }

    player.runCommand(`playsound dig.wood @a ${player.location.x} ${player.location.y} ${player.location.z}`);
    world.sendMessage(`§d🪓 ${player.name} が (${tx}, ${tz}) の森を伐採！【${cityTile.city.name}】の労働者を1消費し、同都市の住宅上限が +1！`);
    return { ok: true };
}

function cmdInfo(player) {
    const config = getMapConfig(); reply(player, turnInfoText()); if (!config) return;
    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    const tile = getTile(tx, tz);
    if (tile) {
        const chopStatus = tile.isChopped ? " (伐採済)" : "";
        reply(player, `§b現在地 (${tx}, ${tz}) : [${TERRAIN_TYPES[tile.type]?.label ?? tile.type}${chopStatus}]`);
        if (tile.city) {
            reply(player, `  - §6【${tile.city.name}】人口: ${tile.city.population}/${tile.city.housing}`);
        }
    }
}

export function registerScriptCommands() {
    system.afterEvents.scriptEventReceive.subscribe((eventData) => {
        if (eventData.id !== "civ:cmd") return;
        const realPlayer = eventData.sourceEntity;
        if (!realPlayer || realPlayer.typeId !== "minecraft:player") return;

        const args = (eventData.message ? eventData.message.trim() : "").split(/\s+/);
        const sub = (args.shift() ?? "help").toLowerCase();

        system.run(() => {
            // 💡 国家の追加・切替・一覧は「実プレイヤー」自身の操作。現在操作中の国家に関係なく、
            //    常に実プレイヤー本人の権限・所有物として処理する。
            if (sub === "addciv") { cmdAddCiv(realPlayer, args.join(" ")); return; }
            if (sub === "switchciv") { cmdSwitchCiv(realPlayer, args[0]); return; }
            if (sub === "civs") { cmdListCivs(realPlayer); return; }

            const player = getActingPlayer(realPlayer); // 💡 現在操作中の国家として振る舞う
            switch (sub) {
                case "generate": cmdGenerate(player, args); break;
                case "join": cmdJoin(player); break;
                case "start": cmdStart(player); break;
                case "end": cmdEndGame(player); break;
                case "endturn": cmdEndTurn(player); break;
                case "claim": cmdClaim(player); break;
                case "buyrights": cmdBuyRights(player); break;
                case "settle": cmdSettle(player); break;
                case "chop": cmdChop(player); break;
                case "info": cmdInfo(player); break;
                case "menu": openMainMenu(player); break;
                // 💡 生産コマンドは統一: !civ build <worker|missile|tradingPost>
                case "build": cmdStartProduction(player, args[0]); break;
                case "buildworker": cmdStartProduction(player, "worker"); break; // 互換用エイリアス
                case "buildmissile": cmdStartProduction(player, "missile"); break; // 互換用エイリアス
                case "buildtp": cmdStartProduction(player, "tradingPost"); break; // 互換用エイリアス
                case "cancelbuild": cmdCancelProduction(player); break;
                case "research": cmdStartProgress(player, "technology", args[0]); break;
                case "civic": cmdStartProgress(player, "civic", args[0]); break;
                case "launch": {
                    const ltx = parseInt(args[0], 10);
                    const ltz = parseInt(args[1], 10);
                    if (isNaN(ltx) || isNaN(ltz)) { reply(player, "§c使用法: !civ launch <x> <z>"); break; }
                    cmdLaunchMissile(player, ltx, ltz);
                    break;
                }
                default: cmdHelp(player);
            }
        });
    });
}

/** 研究・社会制度は都市ではなくプレイヤー全体に属する。 */
export function cmdStartProgress(player, kind, id) {
    if (!isPlayersTurn(player)) {
        reply(player, "§cあなたのターンではありません。");
        return { ok: false };
    }
    if (!getDefinition(kind, id)) {
        reply(player, `§c不明な${getKindLabel(kind) || "項目"}です。`);
        return { ok: false };
    }
    const result = startProgress(player, kind, id);
    reply(player, result.message);
    return result;
}

export function cmdSignAgreement(player, type, targetId) {
    if (!isPlayersTurn(player)) {
        reply(player, "§cあなたのターンではありません。");
        return { ok: false };
    }
    const result = signAgreement(player, type, targetId);
    if (result.ok) world.sendMessage(result.message);
    else reply(player, result.message);
    return result;
}

/** 戦闘ユニットをマス間で移動する。戦闘・都市占領はここでは扱わない。 */
export function cmdMoveCombatUnit(player, fromTx, fromTz, toTx, toTz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const source = getTile(fromTx, fromTz);
    const target = getTile(toTx, toTz);
    const unit = source?.combatUnit;
    if (!unit || unit.ownerId !== player.id) { reply(player, "§cこのマスに移動可能なあなたの戦闘ユニットはいません。"); return { ok: false }; }
    if (!target) { reply(player, "§c移動先がマップ外です。"); return { ok: false }; }
    if (target.combatUnit) { reply(player, "§c移動先にはすでに戦闘ユニットが存在します。"); return { ok: false }; }

    const distance = Math.max(Math.abs(toTx - fromTx), Math.abs(toTz - fromTz));
    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    if (distance < 1 || distance > remaining) { reply(player, "§cそのマスへ移動するには移動力が足りません。"); return { ok: false }; }

    source.combatUnit = null;
    unit.movementRemaining = remaining - distance;
    target.combatUnit = unit;
    setTile(fromTx, fromTz, source);
    setTile(toTx, toTz, target);
    world.sendMessage(`§e[Warrior] ${player.name} の${unit.label ?? "戦闘ユニット"}が (${fromTx}, ${fromTz}) から (${toTx}, ${toTz}) へ移動しました。 (残り移動力: ${unit.movementRemaining})`);
    return { ok: true };
}

/**
 * 戦闘ユニットで隣接(攻撃距離内)の敵ユニットを攻撃する。
 * 先制攻撃(攻撃側→防御側) → 生存していれば反撃(防御側→攻撃側)、の順で解決する。
 * 攻撃を行うと、そのユニットは今ターンの残り移動力を使い切る(以後の移動・再攻撃は不可)。
 */
export function cmdAttackCombatUnit(player, fromTx, fromTz, toTx, toTz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const source = getTile(fromTx, fromTz);
    const target = getTile(toTx, toTz);
    const attacker = source?.combatUnit;
    if (!attacker || attacker.ownerId !== player.id) { reply(player, "§cこのマスに攻撃可能なあなたの戦闘ユニットはいません。"); return { ok: false }; }
    if (!target) { reply(player, "§c攻撃先がマップ外です。"); return { ok: false }; }

    const defender = target.combatUnit;
    if (!defender) { reply(player, "§c攻撃先に戦闘ユニットが存在しません。"); return { ok: false }; }
    if (defender.ownerId === player.id) { reply(player, "§c自分のユニットは攻撃できません。"); return { ok: false }; }
    if (hasDiplomaticAgreement(player.id, defender.ownerId)) { reply(player, "§c外交協定を結んでいる相手のユニットは攻撃できません。"); return { ok: false }; }

    const remaining = attacker.movementRemaining ?? attacker.movement ?? 0;
    if (remaining <= 0) { reply(player, "§c移動力が残っていないため攻撃できません。"); return { ok: false }; }

    const range = getAttackRange(attacker);
    const distance = tileDistance(fromTx, fromTz, toTx, toTz);
    if (distance < 1 || distance > range) { reply(player, "§cそのマスは攻撃距離外です。"); return { ok: false }; }

    const attackerLabel = attacker.label ?? "戦闘ユニット";
    const defenderLabel = defender.label ?? "戦闘ユニット";

    // 💡 攻撃側と防御側の間のマス距離を算出し、反撃の可否・反撃時の戦闘力選択に用いる。
    const result = resolveCombat(attacker, defender, distance);
    // 攻撃を行うと、このユニットは今ターンの行動を終える(以後の移動・再攻撃は不可)。
    attacker.movementRemaining = 0;

    source.combatUnit = attacker;
    target.combatUnit = defender;

    const lines = [];
    lines.push(`§c⚔ ${player.name} の${attackerLabel} (${fromTx}, ${fromTz}) が ${defenderLabel} (${toTx}, ${toTz}) を攻撃！`);
    lines.push(`§7先制ダメージ: ${result.firstDamage}`);

    if (result.defenderDestroyed) {
        lines.push(`§c💀 ${defenderLabel}は撃破されました！`);
        target.combatUnit = null;
    } else {
        lines.push(`§7 └ ${defenderLabel} 残りHP: ${Math.max(0, Math.round(defender.hp))}/${defender.maxHp ?? 100}`);
        if (result.counterSkippedReason === "outOfDefenderRange") {
            lines.push(`§7${defenderLabel}の攻撃範囲外からの攻撃のため、反撃はありません。`);
        } else {
            lines.push(`§7反撃ダメージ: ${result.counterDamage}`);
            if (result.attackerDestroyed) {
                lines.push(`§c💀 ${attackerLabel}は反撃により撃破されました！`);
                source.combatUnit = null;
            } else {
                lines.push(`§7 └ ${attackerLabel} 残りHP: ${Math.max(0, Math.round(attacker.hp))}/${attacker.maxHp ?? 100}`);
            }
        }
    }

    setTile(fromTx, fromTz, source);
    setTile(toTx, toTz, target);
    world.sendMessage(lines.join("\n"));
    return { ok: true, result };
}

/**
 * 都市に自分の戦闘ユニットが存在し、かつそのユニットの移動力が最大値のまま(今ターン未行動)
 * であれば、その都市を占領してオーナーを自分に切り替える。
 * この都市に帰属していた領有マス(belongsToCityKey が一致するマス)も同時に占領する。
 */
export function cmdCaptureCity(player, tx, tz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const cityKey = `${tx},${tz}`;
    const tiles = getTiles();
    const tile = tiles[cityKey];
    if (!tile || !tile.city) { reply(player, "§cこのマスに都市がありません。"); return { ok: false }; }
    if (!tile.ownerId || tile.ownerId === player.id) { reply(player, "§cこの都市はすでにあなたのものです。"); return { ok: false }; }

    const unit = tile.combatUnit;
    if (!unit || unit.ownerId !== player.id) { reply(player, "§cこの都市にあなたの戦闘ユニットがいません。"); return { ok: false }; }

    const maxMovement = unit.movement ?? 0;
    const remaining = unit.movementRemaining ?? maxMovement;
    if (remaining < maxMovement) { reply(player, "§c占領するには移動力が最大値残っている必要があります。(今ターンは既に行動済みです)"); return { ok: false }; }

    const previousOwnerId = tile.ownerId;
    const previousOwnerName = tile.ownerName ?? "不明";
    const cityName = tile.city.name;

    tile.ownerId = player.id;
    tile.ownerName = player.name;
    unit.movementRemaining = 0;
    tile.combatUnit = unit;

    // 💡 この都市に帰属していた領有マス(belongsToCityKey が一致するマス)も同時に占領する
    let capturedTileCount = 0;
    for (const key in tiles) {
        if (key === cityKey) continue;
        const t = tiles[key];
        if (t.ownerId === previousOwnerId && t.belongsToCityKey === cityKey) {
            t.ownerId = player.id;
            t.ownerName = player.name;
            capturedTileCount++;
        }
    }

    setTiles(tiles);

    const extraText = capturedTileCount > 0 ? ` (帰属していた領有マス${capturedTileCount}マスも同時に占領)` : "";
    world.sendMessage(`§6🏳 ${player.name} が ${previousOwnerName} の【${cityName}】を占領しました！${extraText}`);
    return { ok: true };
}
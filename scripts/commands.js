// commands.js
import { world, system, BlockPermutation, PlayerPermissionLevel, CustomCommandStatus, CustomCommandParamType, CommandPermissionLevel } from "@minecraft/server";
import { generateMap, TERRAIN_TYPES, worldToTile, TILE_SIZE, RESOURCE_TYPES, ASSUMED_SIMULATION_RANGE_BLOCKS, isImpassableTerrain, isWaterTerrain } from "./mapGen.js";
import { getMapConfig, setMapConfig, getTile, setTile, resetAll, setTiles, getTiles } from "./state.js";
import { joinGame, turnInfoText, isPlayersTurn, endGame, getTurnState, setTurnState, getCityCurrentYields, resolveMissileImpact, getPlayerColor, checkAndAnnounceVictory } from "./turns.js";
import { PRODUCTION_DEFS, canStartProduction, startProduction, cancelProduction, addWorkers, consumeWorkerAction, hasAvailableWorkerAction, getProductionIds } from "./production.js";
import { getDefinition, getKindLabel, startProgress, getDefinitions } from "./progression.js";
import { hasDiplomaticAgreement, signAgreement, isAtWar } from "./diplomacy.js";
import { getAttackRange, resolveCombat, tileDistance, canUnitEnterTerrain, canUnitEnterOwnership, countFlankingAllies, getFlankingBonus } from "./combat.js";
import { addVirtualCiv, getControllableCivs, getActiveCivId, setActiveCivId, getActingPlayer, getOnlinePlayerById } from "./civs.js";
import { getFacilityDef, canInstallFacility, installFacility, getFacilityIds } from "./facilities.js";
import { resolveOwningCityKey } from "./adjacency.js";
import { getDistrictDef, canStartDistrict, startDistrictConstruction, getDistrictBuildingDef, canStartDistrictBuilding, startDistrictBuildingConstruction, getDistrictIds, getDistrictBuildingIds } from "./districts.js";
import {
    getReligiousUnitDef, hasFoundedReligion, getReligionName, setReligionName,
    canFoundReligion, foundReligion, calculateProselytizePressure, addReligiousPressure,
    getReligiousUnitIds,
} from "./religion.js";
import { openMainMenu } from "./ui.js";
import { removeUnitLabelAt, clearAllUnitLabels } from "./unitLabels.js";
// 💡 bots.js は cmdClaim/cmdSettle/cmdBuyRights/cmdStartProduction をBotの行動再現に使うため
//    このファイルを import する(相互import)。実際の呼び出しは関数本体の中でのみ行われるため
//    (モジュール評価順に依存しない)ESモジュールとして安全に解決される。詳細は bots.js を参照。
import { startGameAuto, endTurnAuto, forceEndTurnAuto, addBot } from "./bots.js";

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
        player.sendMessage(`§c[Missile][Complete]【${city.name}】ミサイルチート発動！ (在庫: ${city.missiles}発)`);
    }
    if (message === '.nuke') {
        ev.cancel = true;
        await Promise.resolve();
        const config = getMapConfig();
        for (let i = 0; i < config.width; i++) {
            for (let z = 0; z < config.height; z++) {
                cmdLaunchMissile(player, i, z);
            }
            
        }
        world.sendMessage(`§cミサイルの嵐！`);
    }
})

function cmdHelp(player) {
    reply(player, [
        "§6--- Civ Tactics コマンド一覧 ---",
        "§7(スラッシュコマンド入力時、コマンド名・引数はタブ補完/候補表示が効きます)",
        "§e/civ:generate <幅> <高さ> §f: マップ生成(OPのみ)",
        "§e/civ:join §f: ゲームに参加",
        "§d/civ:joinall §f: ワールドにいる全プレイヤーを一括で参加待機状態にする(OPのみ)",
        "§e/civ:start §f: ゲーム開始(OPのみ)",
        "§c/civ:end §f: ゲームをリセット(OPのみ)",
        "§e/civ:endturn §f: 自分のターンを終了",
        "§e/civ:forceendturn §f: (OP専用) 手番を強制的にスキップする(応答不能なプレイヤー対策)",
        "§e/civ:claim §f: 周囲の土地を領有 (コスト: 人口1)",
        "§e/civ:buyrights §f: 開拓権を獲得 (コスト: 首都人口2)",
        "§e/civ:settle §f: 都市を建設 (コスト: 開拓権x1)",
        "§e/civ:build <worker|warrior|archer|battleship|missile|tradingPost|granary|obelisk|antiAir|capital> §f: 生産を開始",
        "§c/civ:cancelbuild §f: 進行中の生産を中止(蓄積分は次に引き継ぎ)",
        "§e/civ:chop §f: 森林を伐採して住宅上限+1",
        "§e/civ:install <quarry|blacksmith> §f: 足元の空き領有マスに施設を設置(労働者の行動回数を1消費)",
        "§e/civ:district <sacredSite|industrialZone> §f: 足元の空き領有マスに区域の建設を開始(帰属都市の生産力を使用)",
        "§e/civ:districtbuilding <shrine> §f: 足元の区域に専用の建造物を建設開始(帰属都市の生産力を使用)",
        "§e/civ:foundreligion §f: 宗教を創始する(国家全体の信仰力100以上、かつ聖地が必要)",
        "§e/civ:renamereligion <名前> §f: 創始した宗教の名前を変更する",
        "§e/civ:buyreligious <missionary> §f: 都市の信仰力を使って宗教ユニットを購入(社が必要)",
        "§c/civ:launch <x> <z> §f: 指定マスへミサイルを発射",
        "§e/civ:info §f: 現在の情報を表示",
        "§e/civ:menu §f: メニューを開く",
        "§d/civ:addciv [名前] §f: ソロテスト用の国家を追加(OPのみ)",
        "§d/civ:addbot [名前] §f: Botを追加し、ゲーム開始前であれば即座に参加させる(OPのみ)",
        "§d/civ:switchciv [番号] §f: 操作中の国家を切り替える",
        "§d/civ:civs §f: 操作できる国家の一覧を表示",
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
    reply(realPlayer, `§aテスト国家【${civ.name}】を追加しました。§e/civ:switchciv§aで操作を切り替え、§e/civ:join§aで参加させてください。`);
}

/** 🛠 OP用: Botを追加し、ゲーム開始前であれば即座に参加させる。 */
function cmdAddBot(realPlayer, name) {
    if (!isOperator(realPlayer)) { reply(realPlayer, "§cこのコマンドはOPのみ実行できます。"); return; }
    const result = addBot(realPlayer, name);
    reply(realPlayer, result.message);
}

/** 操作中の国家を切り替える(自分自身、または自分が追加したテスト国家のみ)。 */
function cmdSwitchCiv(realPlayer, arg) {
    const civs = getControllableCivs(realPlayer);
    if (civs.length <= 1) { reply(realPlayer, "§c切り替えられる国家がありません。§e/civ:addciv§cでテスト国家を追加してください。"); return; }

    let target = null;
    if (arg) {
        const idx = parseInt(arg, 10);
        target = (!isNaN(idx) && civs[idx - 1]) ? civs[idx - 1] : civs.find(c => c.id === arg);
    }

    if (!target) {
        const activeId = getActiveCivId(realPlayer);
        reply(realPlayer, [
            "§e操作中の国家を切り替えます。番号を指定してください(例: /civ:switchciv 2):",
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
        player.sendMessage("§c[Fail] 自分の都市の名前しか変更できません。");
        return;
    }

    const oldName = tile.city.name;
    tile.city.name = newName;
    setTile(tx, tz, tile);

    world.sendMessage(`§e[Rename] 【都市改名】${player.name} が【${oldName}】の名前を【${newName}】に変更しました！`);
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
    clearAllUnitLabels();
    const config = { originX, originZ, ySurface, width, height, tileSize: TILE_SIZE };
    setMapConfig(config);

    // 💡 マップの生成範囲(4隅のうち最も遠い点)が、プレイヤーを中心としたシミュレーション範囲
    //    (読み込まれるチャンクの範囲)を超えるかどうかを判定する。超える場合のみ、生成中に
    //    小さく分割したtickingareaを一時的に使う(超えないなら、既に読み込まれているはずなので
    //    不要にtickingareaを使わない)。
    const mapMaxX = originX + width * TILE_SIZE - 1;
    const mapMaxZ = originZ + height * TILE_SIZE - 1;
    const farthestBlocks = Math.max(
        Math.abs(originX - loc.x), Math.abs(mapMaxX - loc.x),
        Math.abs(originZ - loc.z), Math.abs(mapMaxZ - loc.z)
    );
    const useTickingArea = farthestBlocks > ASSUMED_SIMULATION_RANGE_BLOCKS;

    reply(player, `§aマップ生成を開始します... (${width} x ${height} マス)${useTickingArea ? " §7(シミュレーション範囲外のため、生成中のみ一時的にtickingareaを使用します。安定性重視のため通常より時間がかかります)" : ""}`);

    const tiles = {};
    generateMap(dimension, { ...config, seed: Date.now(), useTickingArea }, (tx, tz, type, resource, foodYield, productionYield) => {
        tiles[`${tx},${tz}`] = { type, ownerId: null, ownerName: null, resource: resource ?? null, foodYield, productionYield, city: null, isChopped: false };
    }).then((result) => {
        setTiles(tiles);
        const failedTiles = result?.failedTiles ?? [];
        if (failedTiles.length > 0) {
            const coordText = failedTiles.slice(0, 10).map(f => `(${f.tx},${f.tz})`).join(", ");
            const moreText = failedTiles.length > 10 ? ` 他${failedTiles.length - 10}箇所` : "";
            world.sendMessage(`§eマップ生成が完了しました(ただし${failedTiles.length}箇所で地形ブロックの反映を確認できませんでした: ${coordText}${moreText})。データ上は登録済みなので、見た目が気になる場合は該当マスを手動で修正してください。`);
        } else {
            world.sendMessage("§a=== マップ生成が完了しました! ===");
        }
    }).catch((e) => {
        // 💡 生成中に想定外のエラーが起きても、それまでに出来ているタイルは保存しておく
        setTiles(tiles);
        world.sendMessage(`§cマップ生成中にエラーが発生しました。生成済みの範囲まで保存しています: ${e}`);
    });
}

function cmdJoin(player) { reply(player, joinGame(player).message); }

/** 🛠 OP用: ワールドに今いる全プレイヤーを一括で参加待機状態にする(各自が /civ:join する手間を省く)。 */
export function cmdJoinAll(player) {
    if (!isOperator(player)) { reply(player, "§cこのコマンドはOPのみ実行できます。"); return; }
    const turn = getTurnState();
    if (turn.started) { reply(player, "§cゲーム進行中です。ゲームをリセットしてから実行してください。"); return; }

    let joined = 0, alreadyJoined = 0;
    for (const p of world.getAllPlayers()) {
        const result = joinGame(p);
        if (result.ok) joined++; else alreadyJoined++;
    }
    world.sendMessage(`§a[Civ Tactics] ワールドにいる${joined}人のプレイヤーを参加待機状態にしました。§7(既に参加済み: ${alreadyJoined}人)`);
}

// 💡 ゲーム開始・ターン終了・強制ターン終了は、いずれもbots.jsのAuto版(startGameAuto等)を
//    経由する。手番がBotに回ってきたときに自動で行動→次の手番へ進めるための共通フックが
//    そこに入っているため、turns.js の素の関数を直接呼ばないようにする。
function cmdStart(player) { if (isOperator(player)) startGameAuto(); }
function cmdEndTurn(player) { const result = endTurnAuto(player); if (!result.ok) reply(player, result.message); }

/** 🛠 OP用: 現在の手番を強制的にスキップする(手番のプレイヤーが応答不能な場合の保険)。 */
function cmdForceEndTurn(player) {
    if (!isOperator(player)) { reply(player, "§cこのコマンドはOPのみ実行できます。"); return; }
    const result = forceEndTurnAuto();
    if (!result.ok) reply(player, result.message);
}

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

    reply(player, `§a[Complete] 首都の人口を2消費し、開拓権を獲得しました！(ストック: ${turn.playerRights[player.id]}回)`);
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

    const check = canStartProduction(tile.city, productionId, tile, player);
    if (!check.ok) { reply(player, check.message); return { ok: false }; }

    startProduction(tile.city, productionId);
    setTile(tx, tz, tile);

    const { production } = getCityCurrentYields(`${tx},${tz}`, getTiles());
    const remaining = Math.max(0, tile.city.production.cost - tile.city.production.progress);
    const estTurns = production > 0 ? Math.ceil(remaining / production) : "--";

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
    world.sendMessage(`§7[Stop] ${player.name} が都市【${tile.city.name}】の【${label}】の生産を中止しました。(蓄積生産力 ${cancelled.progress} は次の生産へ引き継がれます)`);
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
    if (tile.city.missileLaunchedThisTurn) { reply(player, "§c[Missile] この都市からは、このターンすでにミサイルを発射済みです。(1ターンに1発まで)"); return { ok: false }; }

    const ttx = Math.floor(targetTx);
    const ttz = Math.floor(targetTz);
    if (isNaN(ttx) || isNaN(ttz) || ttx < 0 || ttz < 0 || ttx >= config.width || ttz >= config.height) {
        reply(player, "§c座標がマップ範囲外、または不正な値です。");
        return { ok: false };
    }

    // 💡 着弾地点に他国の都市がある場合、宣戦布告済み(戦争状態)の相手にしか発射できない
    //    (攻撃・都市占領と同じ制約。無所属マス・空きマスへの発射は制限しない)。
    const targetTile = getTile(ttx, ttz);
    if (targetTile?.city && targetTile.ownerId && targetTile.ownerId !== player.id && !isAtWar(player.id, targetTile.ownerId)) {
        reply(player, "§c宣戦布告していない相手の都市にはミサイルを発射できません。外交メニューから宣戦布告してください。");
        return { ok: false };
    }

    tile.city.missiles -= 1;
    tile.city.missileLaunchedThisTurn = true;
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
    if (isImpassableTerrain(tile.type)) { reply(player, "§c山脈マスには都市を建設できません。"); return; }
    if (isWaterTerrain(tile.type)) { reply(player, "§c水上マスには都市を建設できません。"); return; }

    const allTiles = getTiles();
    let hasAnyCity = false;
    for (const key in allTiles) {
        if (allTiles[key].ownerId === player.id && allTiles[key].city) { hasAnyCity = true; break; }
    }

    // 💡 首都は生涯で1度だけ自動設置される。一度でも首都を持ったことがあるプレイヤーは、
    //    (占領やミサイル攻撃で首都を失い、都市を1つも持っていない状態になったとしても)
    //    /civ:settle で新しい首都が自動的に立つことはない。以後、首都を取り戻すには
    //    既存の都市で「遷都」を生産する必要がある(cmdSettleでは常に通常の都市になる)。
    const hasFoundedCapitalBefore = player.getDynamicProperty("civ:hasFoundedCapital") === true;
    const isCapital = !hasAnyCity && !hasFoundedCapitalBefore;

    const turn = getTurnState();
    if (!turn.playerRights) turn.playerRights = {};
    const rights = turn.playerRights[player.id] ?? 0;

    // 💡 「初めての首都」だけが無料。都市を全て失って hasAnyCity が false になっていても、
    //    既に一度首都を持っていた(=isCapitalがfalseになる)場合は、通常の都市と同様に
    //    開拓の権利を消費する(無料で無制限に再入植できてしまう抜け穴の修正)。
    if (!isCapital && rights <= 0) {
        reply(player, "§c開拓する権利がありません。首都で /civ:buyrights を実行してください。");
        return;
    }

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

    // 💡 首都は必ず一定水準以上のマス産出量を持つようにする。ランダム生成の結果、
    //    首都を建てたマスの基礎産出量(食料・生産力それぞれ)が2以下だった場合は3まで引き上げる
    //    (弱い立地に首都を建ててしまい詰むのを防ぐための最低保証。他の通常マスはそのまま)。
    if (isCapital) {
        if ((tile.foodYield ?? 0) <= 2) tile.foodYield = 3;
        if ((tile.productionYield ?? 0) <= 2) tile.productionYield = 3;
    }

    // 💡 新機能: ランダムに選んだ都市名に座標を添えてユニーク命名
    const pickedBaseName = CITY_NAMES_POOL[Math.floor(Math.random() * CITY_NAMES_POOL.length)];
    const cityUniqueName = `${pickedBaseName}・市`;

    tile.city = {
        name: cityUniqueName, // 👈 名前をセット
        population: initPopulation,
        workers: 0,
        workerUnits: [],       // 💡 各労働者の残り行動回数(addWorkersで付与する)
        housing: housing,
        foodStorage: 0,
        starvationTurns: 0,
        isCapital: isCapital,
        tradingPost: null,     // 交易所データ用の初期スロット(完成すると { status: "active", routes: [] } になる)
        production: null,      // 💡 進行中の生産 { id, progress, cost } | null (production.js で管理)
        productionCarry: 0     // 💡 中断/完了時に余った生産力(次の生産に引き継ぐ)
    };
    if (initWorkers > 0) addWorkers(tile.city, initWorkers);
    if (isCapital) player.setDynamicProperty("civ:hasFoundedCapital", true);
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
    world.sendMessage(`§6[New City] ${player.name} が (${tx}, ${tz}) に${labelName}【${cityUniqueName}】を創設！ (${waterText}, 住宅上限: ${housing})`);
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

    // 💡 労働者の行動回数チェック(労働者1人あたり行動回数WORKER_ACTIONS_PER_UNIT。1消費するごとに-1)
    if (!hasAvailableWorkerAction(cityTile.city)) {
        reply(player, `§c[Fail] 労働者が足りません！この作業には帰属都市【${cityTile.city.name}】の労働者が必要です。`);
        return { ok: false };
    }

    // 💡 労働者の行動回数を1消費し、伐採効果（住宅上限+1）をその帰属都市に付与
    consumeWorkerAction(cityTile.city);
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
    world.sendMessage(`§d[Chop] ${player.name} が (${tx}, ${tz}) の森を伐採！【${cityTile.city.name}】の労働者の行動回数を1消費し、同都市の住宅上限が +1！`);
    return { ok: true };
}

/**
 * 施設をこのプレイヤーの足元のマスに設置する。
 * ・対象マスは自分の領有マスで、都市も施設も無い空きマスである必要がある。
 * ・設置には、帰属都市の労働者の行動回数を1消費する(cmdChopと同じ考え方)。
 */
export function cmdInstallFacility(player, facilityId) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) { reply(player, "§c範囲外です。"); return { ok: false }; }

    const tile = getTile(tx, tz);
    const check = canInstallFacility(tile, facilityId, player.id, player);
    if (!check.ok) { reply(player, check.message); return { ok: false }; }

    // 💡 労働者の所属・帰属先都市を決定する(cmdChopと同じロジック)
    const allTiles = getTiles();
    const cityKey = resolveOwningCityKey(tx, tz, tile, player.id, allTiles);
    if (!cityKey) { reply(player, "§c作業エラー: このマスが帰属する都市が存在しません。"); return { ok: false }; }
    if (!tile.belongsToCityKey) tile.belongsToCityKey = cityKey;

    const cityTile = allTiles[cityKey];
    if (!cityTile || !cityTile.city) { reply(player, "§c帰属先の都市が見つかりません。"); return { ok: false }; }

    // 💡 労働者の行動回数チェック(伐採と同じ、労働者1人あたり行動回数WORKER_ACTIONS_PER_UNIT)
    if (!hasAvailableWorkerAction(cityTile.city)) {
        reply(player, `§c[Fail] 労働者が足りません！この作業には帰属都市【${cityTile.city.name}】の労働者が必要です。`);
        return { ok: false };
    }

    // 💡 労働者の行動回数を1消費してから設置する
    consumeWorkerAction(cityTile.city);
    const [cxStr, czStr] = cityKey.split(",");
    setTile(parseInt(cxStr, 10), parseInt(czStr, 10), cityTile);

    installFacility(tile, facilityId, player.id, player.name);
    setTile(tx, tz, tile);

    const def = getFacilityDef(facilityId);
    const message = def?.installMessage?.(tile, tx, tz) ?? `§e[Complete] ${player.name} が (${tx}, ${tz}) に${def?.label ?? facilityId}を設置しました！`;
    world.sendMessage(message);
    return { ok: true };
}

/**
 * 区域の建設をこのプレイヤーの足元のマスに開始する。
 * ・対象マスは自分の領有マスで、都市も区域も無い空きマスである必要がある。
 * ・建設には、帰属都市の生産力を複数ターンかけて使う(施設の即時設置とは異なる)。
 * ・区域を建設中のあいだ、その都市は新しい建造物を着工できない(ユニットは着工できる)。
 */
export function cmdStartDistrict(player, districtId) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) { reply(player, "§c範囲外です。"); return { ok: false }; }

    const tileKey = `${tx},${tz}`;
    const tile = getTile(tx, tz);

    // 💡 帰属先都市を決定する(cmdChop/cmdInstallFacilityと同じロジック)
    const allTiles = getTiles();
    const cityKey = resolveOwningCityKey(tx, tz, tile, player.id, allTiles);
    if (!cityKey) { reply(player, "§c作業エラー: このマスが帰属する都市が存在しません。"); return { ok: false }; }

    const cityTile = allTiles[cityKey];
    if (!cityTile || !cityTile.city) { reply(player, "§c帰属先の都市が見つかりません。"); return { ok: false }; }

    const check = canStartDistrict(tile, districtId, player.id, cityTile.city, player, allTiles, cityKey);
    if (!check.ok) { reply(player, check.message); return { ok: false }; }

    if (!tile.belongsToCityKey) tile.belongsToCityKey = cityKey;
    startDistrictConstruction(cityTile.city, tile, districtId, tileKey);
    setTile(tx, tz, tile);
    const [cxStr, czStr] = cityKey.split(",");
    setTile(parseInt(cxStr, 10), parseInt(czStr, 10), cityTile);

    const def = getDistrictDef(districtId);
    world.sendMessage(`§e[District] ${player.name} が (${tx}, ${tz}) に、【${cityTile.city.name}】の生産力を使って${def?.label ?? districtId}の建設を開始しました！ (コスト: ${def?.cost ?? "?"})`);
    return { ok: true };
}

/**
 * 区域専用の建造物(社など)の建設を、このプレイヤーの足元にある区域のマスで開始する。
 * ・区域の建設(cmdStartDistrict)と同じ仕組み(都市の生産力・city.districtConstruction)を使う。
 */
export function cmdStartDistrictBuilding(player, buildingId) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) { reply(player, "§c範囲外です。"); return { ok: false }; }

    const tileKey = `${tx},${tz}`;
    const tile = getTile(tx, tz);

    const allTiles = getTiles();
    const cityKey = resolveOwningCityKey(tx, tz, tile, player.id, allTiles);
    if (!cityKey) { reply(player, "§c作業エラー: このマスが帰属する都市が存在しません。"); return { ok: false }; }

    const cityTile = allTiles[cityKey];
    if (!cityTile || !cityTile.city) { reply(player, "§c帰属先の都市が見つかりません。"); return { ok: false }; }

    const check = canStartDistrictBuilding(tile, buildingId, player.id, cityTile.city);
    if (!check.ok) { reply(player, check.message); return { ok: false }; }

    if (!tile.belongsToCityKey) tile.belongsToCityKey = cityKey;
    startDistrictBuildingConstruction(cityTile.city, buildingId, tileKey);
    const [cxStr, czStr] = cityKey.split(",");
    setTile(parseInt(cxStr, 10), parseInt(czStr, 10), cityTile);

    const def = getDistrictBuildingDef(buildingId);
    world.sendMessage(`§e[District] ${player.name} が (${tx}, ${tz}) に、【${cityTile.city.name}】の生産力を使って${def?.label ?? buildingId}の建設を開始しました！ (コスト: ${def?.cost ?? "?"})`);
    return { ok: true };
}

/** 宗教を創始する(国家全体の信仰力が100に達し、聖地を持っている場合のみ)。 */
export function cmdFoundReligion(player) {
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const allTiles = getTiles();
    const playerCities = [];
    for (const key in allTiles) {
        if (allTiles[key].ownerId === player.id && allTiles[key].city) {
            playerCities.push({ key, tile: allTiles[key] });
        }
    }

    const check = canFoundReligion(player, player.id, playerCities, allTiles);
    if (!check.ok) { reply(player, check.message); return { ok: false }; }

    const { name } = foundReligion(player);
    world.sendMessage(`§d[Religion] ${player.name} の国家が宗教【${name}】を創始しました！`);
    return { ok: true };
}

/** 宗教の名前を変更する(創始済みの場合のみ)。 */
export function cmdRenameReligion(player, newName) {
    const result = setReligionName(player, (newName ?? []).join ? newName.join(" ") : newName);
    reply(player, result.message);
    return result;
}

/**
 * 宗教ユニットを、都市の貯留信仰力を使って足元のマスに購入する。
 * ・購入した都市自身のマスに配置する(そのマスに既に宗教ユニットが無いことが条件)。
 */
export function cmdBuyReligiousUnit(player, unitId) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }
    if (!hasFoundedReligion(player)) { reply(player, "§c宗教を創始していないと宗教ユニットは購入できません。"); return { ok: false }; }

    const def = getReligiousUnitDef(unitId);
    if (!def) { reply(player, "§c不明な宗教ユニットです。"); return { ok: false }; }

    const { tx, tz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
    const tile = getTile(tx, tz);
    if (!tile?.city || tile.ownerId !== player.id) { reply(player, "§cあなたの都市の上でのみ購入できます。"); return { ok: false }; }
    if (def.requiresBuilding && !tile.city[def.requiresBuilding]) {
        reply(player, `§cこの都市には【${def.label}】の購入に必要な建造物がありません。`);
        return { ok: false };
    }
    if (tile.religiousUnit) { reply(player, "§cこのマスには既に宗教ユニットが存在します。"); return { ok: false }; }
    if ((tile.city.faithStorage ?? 0) < def.cost) {
        reply(player, `§c信仰力が足りません。(必要: ${def.cost}、現在: ${Math.floor(tile.city.faithStorage ?? 0)})`);
        return { ok: false };
    }

    tile.city.faithStorage -= def.cost;
    tile.religiousUnit = {
        id: unitId, label: def.label, ownerId: player.id, ownerName: player.name,
        hp: def.hp, maxHp: def.maxHp, movement: def.movement, movementRemaining: def.movement,
        religiousCombatStrength: def.religiousCombatStrength, evangelismPower: def.evangelismPower,
        hasProselytizedThisTurn: false,
    };
    setTile(tx, tz, tile);

    world.sendMessage(`§d[Faith] ${player.name} が【${tile.city.name}】の信仰力${def.cost}を使って${def.label}を購入しました！`);
    return { ok: true };
}

/** 宗教ユニットを移動する(戦闘ユニットとは別レイヤー。移動先に他の制約はない)。 */
export function cmdMoveReligiousUnit(player, fromTx, fromTz, toTx, toTz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const source = getTile(fromTx, fromTz);
    const target = getTile(toTx, toTz);
    const unit = source?.religiousUnit;
    if (!unit || unit.ownerId !== player.id) { reply(player, "§cこのマスに移動可能なあなたの宗教ユニットはいません。"); return { ok: false }; }
    if (!target) { reply(player, "§c移動先がマップ外です。"); return { ok: false }; }
    if (target.religiousUnit) { reply(player, "§c移動先には既に宗教ユニットが存在します。"); return { ok: false }; }

    const distance = Math.max(Math.abs(toTx - fromTx), Math.abs(toTz - fromTz));
    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    if (distance < 1 || distance > remaining) { reply(player, "§cそのマスへ移動するには移動力が足りません。"); return { ok: false }; }

    source.religiousUnit = null;
    unit.movementRemaining = remaining - distance;
    target.religiousUnit = unit;
    setTile(fromTx, fromTz, source);
    setTile(toTx, toTz, target);
    world.sendMessage(`§d[Missionary] ${player.name} の${unit.label ?? "宗教ユニット"}が (${fromTx}, ${fromTz}) から (${toTx}, ${toTz}) へ移動しました。 (残り移動力: ${unit.movementRemaining})`);
    return { ok: true };
}

/** 隣接する都市に布教する(布教力を1消費し、宗教的圧力を加える。布教力が0になると消滅する)。 */
export function cmdProselytize(player, fromTx, fromTz, targetTx, targetTz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const source = getTile(fromTx, fromTz);
    const unit = source?.religiousUnit;
    if (!unit || unit.ownerId !== player.id) { reply(player, "§cこのマスにあなたの宗教ユニットはいません。"); return { ok: false }; }
    if (unit.hasProselytizedThisTurn) { reply(player, "§cこの宗教ユニットは今ターン既に布教しました。(1ターン1回まで)"); return { ok: false }; }

    const distance = Math.max(Math.abs(targetTx - fromTx), Math.abs(targetTz - fromTz));
    if (distance !== 1) { reply(player, "§c布教は隣接する都市に対してのみ行えます。"); return { ok: false }; }

    const targetTile = getTile(targetTx, targetTz);
    if (!targetTile?.city) { reply(player, "§cそのマスには都市がありません。"); return { ok: false }; }
    if ((unit.evangelismPower ?? 0) <= 0) { reply(player, "§c布教力が残っていません。"); return { ok: false }; }

    const pressure = calculateProselytizePressure(unit);
    addReligiousPressure(targetTile.city, player.id, pressure);
    unit.evangelismPower -= 1;
    unit.hasProselytizedThisTurn = true;

    const religionName = getReligionName(player) ?? "自国の宗教";
    let message = `§d[Faith] ${player.name} の${unit.label ?? "宗教ユニット"}が【${targetTile.city.name}】で布教し、【${religionName}】の宗教的圧力+${Math.floor(pressure)}！ (残り布教力: ${unit.evangelismPower})`;

    if (unit.evangelismPower <= 0) {
        source.religiousUnit = null;
        message += ` §7(布教力を使い果たし、${unit.label ?? "宗教ユニット"}は解散しました)`;
    }
    setTile(fromTx, fromTz, source);
    setTile(targetTx, targetTz, targetTile);
    world.sendMessage(message);
    return { ok: true };
}

/**
 * 戦闘ユニットで、同じマスにいる敵の宗教ユニットを排除する(異教徒の排除)。
 * ・戦闘ユニットの移動力が満タンである必要があり、実行すると移動力を全て消費する。
 * ・宗教ユニットとは無条件で「戦闘」にはならず、一方的に消滅させる。
 * ・同盟関係にある国家の宗教ユニットは排除できない。
 */
export function cmdPurgeHeretic(player, tx, tz) {
    const config = getMapConfig();
    if (!config) { reply(player, "§cマップ未生成です。"); return { ok: false }; }
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const tile = getTile(tx, tz);
    const combatUnit = tile?.combatUnit;
    const religiousUnit = tile?.religiousUnit;
    if (!combatUnit || combatUnit.ownerId !== player.id) { reply(player, "§cこのマスにあなたの戦闘ユニットはいません。"); return { ok: false }; }
    if (!religiousUnit) { reply(player, "§cこのマスに宗教ユニットはいません。"); return { ok: false }; }
    if (religiousUnit.ownerId === player.id) { reply(player, "§c自分の宗教ユニットは排除できません。"); return { ok: false }; }
    if (hasDiplomaticAgreement(player.id, religiousUnit.ownerId)) {
        reply(player, "§c不可侵条約・同盟を結んでいる国家の宗教ユニットは排除できません。");
        return { ok: false };
    }

    const remaining = combatUnit.movementRemaining ?? combatUnit.movement ?? 0;
    const full = combatUnit.movement ?? 0;
    if (remaining < full) { reply(player, "§c移動力が満タンでないと異教徒を排除できません。(今ターンは既に行動済みです)"); return { ok: false }; }

    const removedLabel = religiousUnit.label ?? "宗教ユニット";
    const removedOwnerName = religiousUnit.ownerName ?? "不明な国家";
    tile.religiousUnit = null;
    combatUnit.movementRemaining = 0;
    setTile(tx, tz, tile);

    world.sendMessage(`§c[Combat] ${player.name} の${combatUnit.label ?? "戦闘ユニット"}が、(${tx}, ${tz}) にいた${removedOwnerName}の${removedLabel}を排除しました！(異教徒の排除)`);
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
            if (sub === "addbot") { cmdAddBot(realPlayer, args.join(" ")); return; }
            if (sub === "switchciv") { cmdSwitchCiv(realPlayer, args[0]); return; }
            if (sub === "civs") { cmdListCivs(realPlayer); return; }

            const player = getActingPlayer(realPlayer); // 💡 現在操作中の国家として振る舞う
            switch (sub) {
                case "generate": cmdGenerate(player, args); break;
                case "join": cmdJoin(player); break;
                case "joinall": cmdJoinAll(player); break;
                case "start": cmdStart(player); break;
                case "end": cmdEndGame(player); break;
                case "endturn": cmdEndTurn(player); break;
                case "forceendturn": cmdForceEndTurn(player); break;
                case "claim": cmdClaim(player); break;
                case "buyrights": cmdBuyRights(player); break;
                case "settle": cmdSettle(player); break;
                case "chop": cmdChop(player); break;
                case "install": cmdInstallFacility(player, args[0]); break;
                case "district": cmdStartDistrict(player, args[0]); break;
                case "districtbuilding": cmdStartDistrictBuilding(player, args[0]); break;
                case "foundreligion": cmdFoundReligion(player); break;
                case "renamereligion": cmdRenameReligion(player, args); break;
                case "buyreligious": cmdBuyReligiousUnit(player, args[0]); break;
                case "info": cmdInfo(player); break;
                case "menu": openMainMenu(player); break;
                // 💡 生産コマンドは統一: /civ:build <worker|missile|tradingPost>
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
                    if (isNaN(ltx) || isNaN(ltz)) { reply(player, "§c使用法: /civ:launch <x> <z>"); break; }
                    cmdLaunchMissile(player, ltx, ltz);
                    break;
                }
                default: cmdHelp(player);
            }
        });
    });
}

/**
 * 本物のカスタムスラッシュコマンド(例: /civ:settle、/civ:build worker)を登録する。
 * registerScriptCommands() の /scriptevent civ:cmd ... 経由の呼び出しとは独立した、
 * 追加の入り口。コマンド名の入力補完・引数候補が効くバニラのコマンドUIをそのまま使える。
 *
 * 【登録タイミングの制約】
 * カスタムコマンドは system.beforeEvents.startup イベント内でのみ登録できるため、
 * このイベントの購読自体は他のイベントに依存せず、スクリプト読み込み時に直接呼ぶ必要がある
 * (main.js が読み込み時に同期的に呼び出す)。
 *
 * 【権限について】
 * permissionLevel は全コマンドで Any にし、OPのみ実行可能かどうかの判定は既存の
 * 各cmd*関数の内部にある isOperator(player) チェックにそのまま任せる(コマンド一覧に
 * 出るが実行時にメッセージで弾かれる、という従来と同じ挙動を保つ)。
 *
 * 【reload時の制約について】
 * カスタムコマンドの登録内容(引数の型など)は、一度ワールドが読み込まれると
 * 「/reload」だけでは更新できない(既存コマンドの再登録が
 * "cannot change parameters for '<id>' during reload" で失敗する、既知のエンジン側の制約)。
 * この失敗を無視して先に進めないと、1つのコマンドの登録失敗で以降すべてのコマンドが
 * 登録されなくなってしまうため、コマンド/列挙型の登録は1つずつ try/catch で独立させている。
 * 定義を変えた場合は、/reload ではなくワールドを一度抜けて入り直す(またはワールド新規作成)
 * ことで反映される。
 */
export function registerCustomCommands() {
    system.beforeEvents.startup.subscribe((init) => {
        const registry = init.customCommandRegistry;

        const registerEnumSafe = (name, values) => {
            try {
                registry.registerEnum(name, values);
            } catch (e) {
                console.warn?.(`[civ] 列挙型 ${name} の登録に失敗しました(reload時は正常な場合があります。ワールドを一度抜けて入り直してください): ${e}`);
            }
        };

        // 💡 <id|...> のように選べる引数は、PRODUCTION_DEFS などの定義から自動生成する。
        //    新しい生産物/施設/区域などを増やしても、ここのコードは変更不要。
        registerEnumSafe("civ:productionId", getProductionIds());
        registerEnumSafe("civ:facilityId", getFacilityIds());
        registerEnumSafe("civ:districtId", getDistrictIds());
        registerEnumSafe("civ:districtBuildingId", getDistrictBuildingIds());
        registerEnumSafe("civ:religiousUnitId", getReligiousUnitIds());
        registerEnumSafe("civ:technologyId", Object.keys(getDefinitions("technology")));
        registerEnumSafe("civ:civicId", Object.keys(getDefinitions("civic")));

        /**
         * コマンド実行者が実プレイヤーであることを確認し、実際の処理を呼び出す。
         * fn には (realPlayer, player) が渡される。player は「現在操作中の国家」(civs.js)。
         *
         * 💡 scriptEventReceive版とは異なり、ここでは system.run() で次tickに遅延させない。
         *    カスタムコマンドのコールバックは通常のコマンド実行と同じ書き込み可能な文脈で
         *    同期的に呼ばれるため遅延は不要。
         * 💡 origin.sourceEntity をそのまま使うと、Player::sendMessage が
         *    "object bound to prototype does not exist" で失敗することがある
         *    (カスタムコマンド用の一時的なハンドルであり、getActingPlayer() の
         *    Object.create() による委譲パターンと相性が悪いとみられる)。
         *    world.getAllPlayers() から同じIDの「本物の」Playerハンドルを取り直すことで回避する。
         */
        function runCivCommand(origin, fn) {
            const sourceEntity = origin?.sourceEntity;
            if (!sourceEntity || sourceEntity.typeId !== "minecraft:player") {
                return { status: CustomCommandStatus.Failure, message: "§cこのコマンドはプレイヤーからのみ実行できます。" };
            }
            const realPlayer = getOnlinePlayerById(sourceEntity.id) ?? sourceEntity;
            fn(realPlayer, getActingPlayer(realPlayer));
            return { status: CustomCommandStatus.Success };
        }

        const cmd = (name, description, params, callback) => {
            try {
                registry.registerCommand(
                    { name: `civ:${name}`, description, permissionLevel: CommandPermissionLevel.Any, ...params },
                    callback,
                );
            } catch (e) {
                // 💡 1つの登録失敗で以降のコマンドが軒並み登録されなくなるのを防ぐため、
                //    ここで握りつぶして次のコマンドの登録に進む(詳細は関数コメント参照)。
                console.warn?.(`[civ] コマンド civ:${name} の登録に失敗しました(reload時は正常な場合があります。ワールドを一度抜けて入り直してください): ${e}`);
            }
        };

        cmd("generate", "マップを生成する(OPのみ)", {
            mandatoryParameters: [
                { name: "width", type: CustomCommandParamType.Integer },
                { name: "height", type: CustomCommandParamType.Integer },
            ],
        }, (origin, width, height) => runCivCommand(origin, (r, player) => cmdGenerate(player, [String(width), String(height)])));

        cmd("join", "ゲームに参加する", {}, (origin) => runCivCommand(origin, (r, player) => cmdJoin(player)));
        cmd("joinall", "ワールドにいる全プレイヤーを一括で参加待機状態にする(OPのみ)", {}, (origin) => runCivCommand(origin, (r, player) => cmdJoinAll(player)));
        cmd("start", "ゲームを開始する(OPのみ)", {}, (origin) => runCivCommand(origin, (r, player) => cmdStart(player)));
        cmd("end", "ゲームをリセットする(OPのみ)", {}, (origin) => runCivCommand(origin, (r, player) => cmdEndGame(player)));
        cmd("endturn", "自分のターンを終了する", {}, (origin) => runCivCommand(origin, (r, player) => cmdEndTurn(player)));
        cmd("forceendturn", "手番を強制的にスキップする(OPのみ)", {}, (origin) => runCivCommand(origin, (r, player) => cmdForceEndTurn(player)));
        cmd("claim", "周囲の土地を領有する(コスト: 人口1)", {}, (origin) => runCivCommand(origin, (r, player) => cmdClaim(player)));
        cmd("buyrights", "開拓権を獲得する(コスト: 首都人口2)", {}, (origin) => runCivCommand(origin, (r, player) => cmdBuyRights(player)));
        cmd("settle", "都市を建設する(コスト: 開拓権x1)", {}, (origin) => runCivCommand(origin, (r, player) => cmdSettle(player)));
        cmd("chop", "足元の森林を伐採して住宅上限+1する", {}, (origin) => runCivCommand(origin, (r, player) => cmdChop(player)));

        cmd("install", "足元の空き領有マスに施設を設置する", {
            mandatoryParameters: [{ name: "civ:facilityId", type: CustomCommandParamType.Enum }],
        }, (origin, facilityId) => runCivCommand(origin, (r, player) => cmdInstallFacility(player, facilityId)));

        cmd("district", "足元の空き領有マスで区域の建設を開始する", {
            mandatoryParameters: [{ name: "civ:districtId", type: CustomCommandParamType.Enum }],
        }, (origin, districtId) => runCivCommand(origin, (r, player) => cmdStartDistrict(player, districtId)));

        cmd("districtbuilding", "足元の区域に専用の建造物の建設を開始する", {
            mandatoryParameters: [{ name: "civ:districtBuildingId", type: CustomCommandParamType.Enum }],
        }, (origin, buildingId) => runCivCommand(origin, (r, player) => cmdStartDistrictBuilding(player, buildingId)));

        cmd("foundreligion", "宗教を創始する", {}, (origin) => runCivCommand(origin, (r, player) => cmdFoundReligion(player)));

        cmd("renamereligion", "創始した宗教の名前を変更する", {
            mandatoryParameters: [{ name: "name", type: CustomCommandParamType.String }],
        }, (origin, name) => runCivCommand(origin, (r, player) => cmdRenameReligion(player, name)));

        cmd("buyreligious", "都市の信仰力を使って宗教ユニットを購入する", {
            mandatoryParameters: [{ name: "civ:religiousUnitId", type: CustomCommandParamType.Enum }],
        }, (origin, unitId) => runCivCommand(origin, (r, player) => cmdBuyReligiousUnit(player, unitId)));

        cmd("info", "現在の情報を表示する", {}, (origin) => runCivCommand(origin, (r, player) => cmdInfo(player)));
        cmd("menu", "メインメニューを開く", {}, (origin) => runCivCommand(origin, (r, player) => openMainMenu(player)));

        cmd("build", "生産(ユニット/建造物)を開始する", {
            mandatoryParameters: [{ name: "civ:productionId", type: CustomCommandParamType.Enum }],
        }, (origin, productionId) => runCivCommand(origin, (r, player) => cmdStartProduction(player, productionId)));

        cmd("cancelbuild", "進行中の生産を中止する(蓄積分は次に引き継ぎ)", {}, (origin) => runCivCommand(origin, (r, player) => cmdCancelProduction(player)));

        cmd("research", "技術の研究を開始する", {
            mandatoryParameters: [{ name: "civ:technologyId", type: CustomCommandParamType.Enum }],
        }, (origin, techId) => runCivCommand(origin, (r, player) => cmdStartProgress(player, "technology", techId)));

        cmd("civic", "社会制度の研究を開始する", {
            mandatoryParameters: [{ name: "civ:civicId", type: CustomCommandParamType.Enum }],
        }, (origin, civicId) => runCivCommand(origin, (r, player) => cmdStartProgress(player, "civic", civicId)));

        cmd("launch", "指定マスへミサイルを発射する", {
            mandatoryParameters: [
                { name: "x", type: CustomCommandParamType.Integer },
                { name: "z", type: CustomCommandParamType.Integer },
            ],
        }, (origin, x, z) => runCivCommand(origin, (r, player) => cmdLaunchMissile(player, x, z)));

        // 💡 国家の追加・切替・一覧は「実プレイヤー」自身の操作(現在操作中の国家に関係なく常に本人扱い)。
        cmd("addciv", "ソロテスト用の国家を追加する(OPのみ)", {
            optionalParameters: [{ name: "name", type: CustomCommandParamType.String }],
        }, (origin, name) => runCivCommand(origin, (realPlayer) => cmdAddCiv(realPlayer, name)));

        cmd("addbot", "Botを追加し、ゲーム開始前であれば即座に参加させる(OPのみ)", {
            optionalParameters: [{ name: "name", type: CustomCommandParamType.String }],
        }, (origin, name) => runCivCommand(origin, (realPlayer) => cmdAddBot(realPlayer, name)));

        cmd("switchciv", "操作中の国家を切り替える", {
            optionalParameters: [{ name: "index", type: CustomCommandParamType.Integer }],
        }, (origin, index) => runCivCommand(origin, (realPlayer) => cmdSwitchCiv(realPlayer, index !== undefined ? String(index) : undefined)));

        cmd("civs", "操作できる国家の一覧を表示する", {}, (origin) => runCivCommand(origin, (realPlayer) => cmdListCivs(realPlayer)));

        cmd("help", "コマンド一覧を表示する", {}, (origin) => runCivCommand(origin, (r, player) => cmdHelp(player)));
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
    if (!canUnitEnterTerrain(unit, target)) {
        reply(player, unit.domain === "naval" ? "§c海軍ユニットは水上マス(海・川・池・湖)にしか移動できません。" : "§c陸軍ユニットは陸地マスにしか移動できません(水上・山脈マスには移動できません)。");
        return { ok: false };
    }
    if (!canUnitEnterOwnership(unit, target)) {
        reply(player, "§c「関係なし」の相手の領土には移動できません。宣戦布告するか、不可侵条約/同盟を結んでください。");
        return { ok: false };
    }

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
    if (!isAtWar(player.id, defender.ownerId)) { reply(player, "§c宣戦布告していない相手のユニットは攻撃できません。外交メニューから宣戦布告してください。"); return { ok: false }; }

    const remaining = attacker.movementRemaining ?? attacker.movement ?? 0;
    if (remaining <= 0) { reply(player, "§c移動力が残っていないため攻撃できません。"); return { ok: false }; }

    const range = getAttackRange(attacker);
    const distance = tileDistance(fromTx, fromTz, toTx, toTz);
    if (distance < 1 || distance > range) { reply(player, "§cそのマスは攻撃距離外です。"); return { ok: false }; }

    const attackerLabel = attacker.label ?? "戦闘ユニット";
    const defenderLabel = defender.label ?? "戦闘ユニット";

    // 💡 防御側に隣接する自軍ユニット(攻撃側自身を除く)の数に応じた包囲ボーナスを算出する。
    const flankingAllies = countFlankingAllies(toTx, toTz, player.id, fromTx, fromTz, getTiles());
    const flankingBonus = getFlankingBonus(flankingAllies);
    // 💡 攻撃側と防御側の間のマス距離を算出し、反撃の可否・反撃時の戦闘力選択に用いる。
    const result = resolveCombat(attacker, defender, distance, flankingBonus);
    // 攻撃を行うと、このユニットは今ターンの行動を終える(以後の移動・再攻撃は不可)。
    attacker.movementRemaining = 0;

    source.combatUnit = attacker;
    target.combatUnit = defender;

    const lines = [];
    lines.push(`§c[Combat] ${player.name} の${attackerLabel} (${fromTx}, ${fromTz}) が ${defenderLabel} (${toTx}, ${toTz}) を攻撃！`);
    if (flankingBonus > 0) lines.push(`§7[包囲] 隣接する味方ユニット${flankingAllies}体分のボーナス: 先制攻撃力+${flankingBonus}`);
    lines.push(`§7先制ダメージ: ${result.firstDamage}`);

    if (result.defenderDestroyed) {
        lines.push(`§c[Defeated] ${defenderLabel}は撃破されました！`);
        target.combatUnit = null;
        removeUnitLabelAt(toTx, toTz);
    } else {
        lines.push(`§7  -> ${defenderLabel} 残りHP: ${Math.max(0, Math.round(defender.hp))}/${defender.maxHp ?? 100}`);
        if (result.counterSkippedReason === "outOfDefenderRange") {
            lines.push(`§7${defenderLabel}の攻撃範囲外からの攻撃のため、反撃はありません。`);
        } else {
            lines.push(`§7反撃ダメージ: ${result.counterDamage}`);
            if (result.attackerDestroyed) {
                lines.push(`§c[Defeated] ${attackerLabel}は反撃により撃破されました！`);
                source.combatUnit = null;
                removeUnitLabelAt(fromTx, fromTz);
            } else {
                lines.push(`§7  -> ${attackerLabel} 残りHP: ${Math.max(0, Math.round(attacker.hp))}/${attacker.maxHp ?? 100}`);
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
    if (!isAtWar(player.id, tile.ownerId)) { reply(player, "§c宣戦布告していない相手の都市は占領できません。外交メニューから宣戦布告してください。"); return { ok: false }; }

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

    // 💡 占領した都市はそのまま自分の首都にはならない(通常の都市として扱う)。
    //    首都を占領しても占領側にそのまま首都権が移ってしまうバグの修正。
    //    占領側がここを首都にしたい場合は、改めて「遷都」を生産する必要がある。
    const capturedCapital = !!tile.city.isCapital;
    if (capturedCapital) {
        tile.city.isCapital = false;
    }

    // 💡 この都市に帰属していた領有マス(belongsToCityKey が一致するマス)も同時に占領する
    let capturedTileCount = 0;
    let capturedFacilityCount = 0;
    let capturedDistrictCount = 0;
    const capturedTileKeys = [];
    for (const key in tiles) {
        if (key === cityKey) continue;
        const t = tiles[key];
        if (t.ownerId === previousOwnerId && t.belongsToCityKey === cityKey) {
            t.ownerId = player.id;
            t.ownerName = player.name;
            // 💡 このマスに施設があれば、所有者情報もタイルと一緒に占領側へ引き継ぐ
            //    (施設そのものは破壊されず、新しいオーナーの資産として残る)
            if (t.facility) {
                t.facility.ownerId = player.id;
                t.facility.ownerName = player.name;
                capturedFacilityCount++;
            }
            // 💡 完成済みの区域も、施設と同様にそのまま占領側の資産として引き継ぐ。
            //    (建設中の区域は turns.js の tickDistrictConstruction が、次ターンの
            //     処理時に所有者の一致を見て自動的に継続/中止を判定する)
            if (t.district) {
                t.district.ownerId = player.id;
                t.district.ownerName = player.name;
                capturedDistrictCount++;
            }
            capturedTileCount++;
            capturedTileKeys.push(key);
        }
    }

    setTiles(tiles);

    // 💡 占領した都市・帰属マスの旗(banner)を、占領した自分の色に塗り替える。
    //    placePlayerBannerAtCenter は新規領有(cmdClaim/cmdSettle)時にしか呼ばれないため、
    //    占領時にここで呼び直さないと旧オーナーの色のまま残ってしまう。
    //    都市タイルの isCapital には、既に false へ書き換えた後の値(capturedCapital取得前)
    //    ではなく capturedCapital(占領前の実際の首都フラグ)を渡す。物理的な旗の高さは
    //    設置時に置いたレッドストーン/鉄ブロックの位置に合わせる必要があり、占領しても
    //    そのブロック自体は動かない(「占領した都市は首都にならない」というゲーム上の
    //    ルールとは別に、ワールド上の見た目の整合性のための調整)。
    const dimension = player.dimension;
    placePlayerBannerAtCenter(dimension, tx, tz, config, player.id, capturedCapital);
    for (const key of capturedTileKeys) {
        const [ctx, ctz] = key.split(",").map(Number);
        placePlayerBannerAtCenter(dimension, ctx, ctz, config, player.id);
    }

    const captureDetails = [];
    if (capturedFacilityCount > 0) captureDetails.push(`施設${capturedFacilityCount}個`);
    if (capturedDistrictCount > 0) captureDetails.push(`区域${capturedDistrictCount}個`);
    const extraText = capturedTileCount > 0
        ? ` (帰属していた領有マス${capturedTileCount}マスも同時に占領${captureDetails.length > 0 ? `、うち${captureDetails.join("・")}を接収` : ""})`
        : "";
    const capitalText = capturedCapital ? " §c(相手の首都を陥落させました！)" : "";
    world.sendMessage(`§6[Capture] ${player.name} が ${previousOwnerName} の【${cityName}】を占領しました！${extraText}${capitalText}`);
    checkAndAnnounceVictory(tiles);
    return { ok: true };
}

// 💡 行動力を消費して回復する際、最大HPに対して回復する割合。
const HEAL_ACTION_HP_RATIO = 0.3;

/**
 * 戦闘ユニットが今ターンの行動力を全て消費して、その場で休息しHPを回復する。
 * 今ターンまだ一度も行動していない(移動力が最大値のまま)ユニットにしか使えない
 * (cmdCaptureCityの「占領には移動力が最大値である必要がある」制約と同じ考え方)。
 */
export function cmdHealCombatUnit(player, tx, tz) {
    if (!isPlayersTurn(player)) { reply(player, "§cあなたのターンではありません。"); return { ok: false }; }

    const tile = getTile(tx, tz);
    const unit = tile?.combatUnit;
    if (!unit || unit.ownerId !== player.id) { reply(player, "§cこのマスに回復可能なあなたの戦闘ユニットはいません。"); return { ok: false }; }

    const maxMovement = unit.movement ?? 0;
    const remaining = unit.movementRemaining ?? maxMovement;
    if (remaining < maxMovement) { reply(player, "§c今ターン既に行動したユニットは回復できません。(移動力が最大値の時のみ回復できます)"); return { ok: false }; }

    const maxHp = unit.maxHp ?? 100;
    if ((unit.hp ?? maxHp) >= maxHp) { reply(player, "§cこのユニットのHPは既に満タンです。"); return { ok: false }; }

    const healAmount = maxHp * HEAL_ACTION_HP_RATIO;
    unit.hp = Math.min(maxHp, (unit.hp ?? maxHp) + healAmount);
    unit.movementRemaining = 0;
    tile.combatUnit = unit;
    setTile(tx, tz, tile);

    world.sendMessage(`§a[Heal] ${player.name} の${unit.label ?? "戦闘ユニット"} (${tx}, ${tz}) が休息し、HPが${Math.round(healAmount)}回復しました。 (HP: ${Math.max(0, Math.round(unit.hp))}/${maxHp})`);
    return { ok: true };
}
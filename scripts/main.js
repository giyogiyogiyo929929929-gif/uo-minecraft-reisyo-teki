// main.js
// アドオンのエントリポイント。

import { world, system, ItemStack } from "@minecraft/server";
import { registerScriptCommands } from "./commands.js";
import { openMainMenu } from "./ui.js";
import { getTurnState, getTiles, getMapConfig, getStateVersion } from "./state.js";
import { worldToTile, TERRAIN_TYPES, RESOURCE_TYPES } from "./mapGen.js";
import { getCityCurrentYields, forceEndTurn } from "./turns.js";
import { PRODUCTION_DEFS } from "./production.js";
import { getDistrictDef } from "./districts.js";
import { getEffectiveCombatStrength, getEffectiveRangedStrength, isRangedUnit } from "./combat.js";
import { getActingPlayer, resolveCivName } from "./civs.js";

const MENU_ITEM_ID = "minecraft:compass";

// 都市産出量は0.5秒ごとに同じ計算を繰り返す必要がないため短時間キャッシュする。
// stateVersion が変化した場合は即座に無効化し、マップ状態の変更を反映する。
const cityYieldCache = new Map();
let cityYieldCacheVersion = -1;
let cityYieldCacheTick = -1;
const CITY_YIELD_CACHE_TICKS = 20; // 最大1秒。手動ブロック変更なども長時間古くならないようにする。

function getCachedCityCurrentYields(cityKey, tiles) {
    const version = getStateVersion();
    const currentTick = system.currentTick;

    if (cityYieldCacheVersion !== version || currentTick - cityYieldCacheTick >= CITY_YIELD_CACHE_TICKS) {
        cityYieldCache.clear();
        cityYieldCacheVersion = version;
        cityYieldCacheTick = currentTick;
    }

    const cached = cityYieldCache.get(cityKey);
    if (cached) return cached;

    const yields = getCityCurrentYields(cityKey, tiles);
    cityYieldCache.set(cityKey, yields);
    return yields;
}

/** キャッシュを明示的に破棄する。 */
function clearCityYieldCache() {
    cityYieldCache.clear();
    cityYieldCacheVersion = -1;
    cityYieldCacheTick = -1;
}

// 修正①：イベント登録は worldLoad に入れず、最初から直接実行する
registerScriptCommands();

/**
 * 💡 プレイヤーIDから現在のプレイヤー名を取得するヘルパー関数
 */
function getPlayerNameById(id) {
    return resolveCivName(id) ?? "オフライン";
}

/**
 * 💡 戦闘ユニットの戦闘力表示テキストを組み立てる。
 * 遠距離戦闘ユニットは「遠距離/近距離」の両方を、近距離戦闘ユニットは単一の値を表示する。
 */
function formatCombatStrengthText(unit) {
    if (isRangedUnit(unit)) {
        const rangedBase = unit.rangedCombatStrength ?? unit.combatStrength ?? 0;
        const meleeBase = unit.meleeCombatStrength ?? unit.combatStrength ?? 0;
        return `遠距離${getEffectiveRangedStrength(unit)}(基本${rangedBase})/近距離${getEffectiveCombatStrength(unit)}(基本${meleeBase})`;
    }
    return `${getEffectiveCombatStrength(unit)}(基本${unit.combatStrength ?? 0})`;
}

// アイテム使用でメニューを開く(コンパスを使用)
world.afterEvents.itemUse.subscribe((eventData) => {
    if (eventData.itemStack?.typeId === MENU_ITEM_ID) {
        openMainMenu(getActingPlayer(eventData.source));
    }
});

// プレイヤー参加時にメニュー用アイテムを渡す
world.afterEvents.playerSpawn.subscribe((eventData) => {
    if (!eventData.initialSpawn) return;
    const player = eventData.player;
    
    // 修正②：プレイヤーが入ってきたときに、アドオン読み込みメッセージを表示する
    player.sendMessage("§6[Civ Tactics] §aアドオンを読み込みました。 !civ help でコマンド一覧を表示します。");

    system.run(() => {
        try {
            const inv = player.getComponent("minecraft:inventory")?.container;
            if (inv) {
                // すでに持っているか確認（インベントリがコンパスで埋まるのを防ぐ）
                const hasCompass = Array.from({ length: inv.size }).some((_, i) => inv.getItem(i)?.typeId === MENU_ITEM_ID);
                
                if (!hasCompass) {
                    const compass = new ItemStack(MENU_ITEM_ID, 1);
                    compass.nameTag = "§bCiv Menu";
                    inv.addItem(compass);
                }
            }
        } catch (e) {
            // インベントリ操作に失敗しても致命的ではないため無視する
        }
    });
});

// 💡 プレイヤーが退出した瞬間、それがちょうどそのプレイヤーの手番だった場合は
//    自動的にターンをスキップする(誰も !civ endturn を呼べる人がいなくなり、
//    ゲームの進行が止まってしまう事故を防ぐ)。
world.afterEvents.playerLeave.subscribe((eventData) => {
    const { playerId, playerName } = eventData;
    const turn = getTurnState();
    if (!turn?.started || !Array.isArray(turn.playerOrder)) return;
    if (turn.playerOrder[turn.currentIndex] !== playerId) return;

    system.run(() => {
        const result = forceEndTurn();
        if (result.ok) {
            clearCityYieldCache();
            world.sendMessage(`§7(${playerName} が退出したため、自動的にターンをスキップしました)`);
        }
    });
});

// ⏳ 0.5秒（10 ticks）ごとに全プレイヤーの画面表示を更新
system.runInterval(() => {
    const turn = getTurnState();
    const config = getMapConfig();
    const tiles = getTiles();

    for (const player of world.getAllPlayers()) {
        // ==========================================
        // 1. ゲーム開始前：参加者の名前を一覧表示
        // ==========================================
        if (!turn || !turn.started) {
            if (turn && turn.playerOrder && turn.playerOrder.length > 0) {
                const names = turn.playerOrder.map(id => getPlayerNameById(id)).join(", ");
                player.onScreenDisplay.setActionBar(`§e[Pop] 待機中プレイヤー: §f[ ${names} ]`);
            } else {
                player.onScreenDisplay.setActionBar("§7[Pop] 参加者がいません。メニューから参加してください。");
            }
            continue; // 次のプレイヤーの処理へ
        }

        // ==========================================
        // 2. ゲーム中：足元のマスの詳細情報を表示
        // ==========================================
        if (!config || !tiles) {
            player.onScreenDisplay.setActionBar("§c⚠ マップデータが読み込めません");
            continue;
        }

        // プレイヤーの現在地からマスの座標（tx, tz）を算出
        const pos = player.location;
        const { tx, tz } = worldToTile(config, pos.x, pos.z);
        const key = `${tx},${tz}`;
        const tile = tiles[key];

        if (tile) {
            // 地形ラベルの取得
            const terrainLabel = TERRAIN_TYPES[tile.type]?.label ?? "未知の地形";
            
            // 資源ラベルの取得（石油も含めて表示）
            let resourceLabel = "なし";
            if (tile.resource && RESOURCE_TYPES[tile.resource]) {
                const res = RESOURCE_TYPES[tile.resource];
                const icon = tile.resource === "oil" ? "🛢️ " : "";
                resourceLabel = `${icon}${res.label} (${res.category})`;
            }

            // 領有プレイヤー名と都市名の整形
            const ownerText = tile.ownerName ? `§a${tile.ownerName}` : "§7中立";
            const cityText = tile.city ? ` §e[🎪都市: ${tile.city.name} ([Pop]x${tile.city.population})]` : "";
            const facilityText = tile.facility ? ` §7[🏗️施設: ${tile.facility.label ?? tile.facility.id}]` : "";
            const districtText = tile.district
                ? ` §5[🏛️区域: ${tile.district.label ?? tile.district.id}]`
                : (tile.underDistrictConstruction ? " §5[🏛️区域: 建設中...]" : "");
            const combatUnit = tile.combatUnit;
            const combatUnitText = combatUnit
                ? `§c[Warrior] ${combatUnit.label ?? combatUnit.id} | HP: ${combatUnit.hp ?? 0}/${combatUnit.maxHp ?? 100} | 戦闘力: ${formatCombatStrengthText(combatUnit)} | 移動力: ${combatUnit.movementRemaining ?? combatUnit.movement ?? 0}/${combatUnit.movement ?? 0} | 攻撃距離: ${combatUnit.attackRange ?? combatUnit.movement ?? 0}`
                : "§7戦闘ユニット: なし";
            const religiousUnit = tile.religiousUnit;
            const religiousUnitText = religiousUnit
                ? `\n§d[Missionary] ${religiousUnit.label ?? religiousUnit.id} | HP: ${religiousUnit.hp ?? 0}/${religiousUnit.maxHp ?? 100} | 布教力: ${religiousUnit.evangelismPower ?? 0} | 移動力: ${religiousUnit.movementRemaining ?? religiousUnit.movement ?? 0}/${religiousUnit.movement ?? 0}${religiousUnit.hasProselytizedThisTurn ? " | §7(今ターン布教済み)" : ""}`
                : "";
            
            // 算出量の可視化 ([Food]食料 / [Prod]生産) ※マス自体が持つベース値
            const yieldText = `§a[Food]x${tile.foodYield ?? 0} §7| §6[Prod]x${tile.productionYield ?? 0}`;

            // 💡 このマスが帰属している都市（都市そのもの、または帰属先の都市）を特定
            const cityKey = tile.city ? key : tile.belongsToCityKey;
            const cityTile = cityKey ? tiles[cityKey] : null;

            let currentYieldLine = "";
            let cityInfoLine = "";

            if (cityTile && cityTile.city) {
                // 💡 市民配置ロジックを考慮した「今」実際に出ている産出量
                const yields = getCachedCityCurrentYields(cityKey, tiles);
                const oilText = yields.oil > 0 ? ` §7| §b🛢️x${yields.oil}` : "";
                const faithText = (yields.faith ?? 0) > 0 ? ` §7| §d🙏x${yields.faith}` : "";
                currentYieldLine = `\n§f今の産出(都市全体): §a[Food]x${yields.food} §7| §6[Prod]x${yields.production}${oilText}${faithText}`;

                // 💡 帰属都市そのものの詳細情報
                const c = cityTile.city;

                // 💡 進行中の生産(ユニット/建造物)を汎用的に表示。新しい生産物が増えても自動で対応。
                let productionText = "";
                if (c.production) {
                    const def = PRODUCTION_DEFS[c.production.id];
                    if (def) {
                        const progressText = Math.floor(c.production.progress * 10) / 10;
                        productionText = ` §7| ${def.icon}${def.label}生産中(${progressText}/${def.cost})`;
                    }
                }

                const tpText = c.tradingPost?.status === "active" ? " §7| §a[Trade]交易所稼働中" : "";
                const missileText = (c.missiles ?? 0) > 0 ? ` §7| §c[Missile]x${c.missiles}` : "";
                const faithStorageText = (c.faithStorage ?? 0) > 0 ? ` §7| §d🙏信仰力${c.faithStorage}` : "";
                let districtProductionText = "";
                if (c.districtConstruction) {
                    const districtDef = getDistrictDef(c.districtConstruction.id);
                    const districtProgressText = Math.floor(c.districtConstruction.progress * 10) / 10;
                    districtProductionText = ` §7| §5${districtDef?.icon ?? "[Sacred]"}${districtDef?.label ?? c.districtConstruction.id}区域建設中(${districtProgressText}/${c.districtConstruction.cost})`;
                }
                cityInfoLine = `\n§6【${c.isCapital ? "首都" : "都市"}: ${c.name}】§f 人口:§a${c.population}§f/§e${c.housing} §f| [Worker]${c.workers ?? 0}人 §f| [Food]貯留${c.foodStorage ?? 0} §f| §c飢餓${c.starvationTurns ?? 0}/3${productionText}${tpText}${missileText}${faithStorageText}${districtProductionText}`;
            }

            // アクションバーへ出力
            player.onScreenDisplay.setActionBar(
                `§b🗺️ 補正座標: [${tx}, ${tz}] §7| §f地形: §b${terrainLabel} §7| §f資源: §e${resourceLabel}\n` +
                `§f領有: ${ownerText}${cityText}${facilityText}${districtText}\n` +
                `§fベース産出: ${yieldText}\n${combatUnitText}${religiousUnitText}` +
                currentYieldLine +
                cityInfoLine
            );
        } else {
            // 生成されたグリッドの範囲外にプレイヤーがいる場合
            player.onScreenDisplay.setActionBar("§7❌ 国境線の外（未開の地）にいます");
        }
    }
}, 10);
// main.js
// アドオンのエントリポイント。

import { world, system, ItemStack } from "@minecraft/server";
import { registerScriptCommands } from "./commands.js";
import { openMainMenu } from "./ui.js";
import { getTurnState, getTiles, getMapConfig } from "./state.js";
import { worldToTile, TERRAIN_TYPES, RESOURCE_TYPES } from "./mapGen.js";
import { getCityCurrentYields } from "./turns.js";
import { PRODUCTION_DEFS } from "./production.js";

const MENU_ITEM_ID = "minecraft:compass";

// 修正①：イベント登録は worldLoad に入れず、最初から直接実行する
registerScriptCommands();

/**
 * 💡 プレイヤーIDから現在のプレイヤー名を取得するヘルパー関数
 */
function getPlayerNameById(id) {
    for (const p of world.getAllPlayers()) {
        if (p.id === id) return p.name;
    }
    return "オフライン";
}

// アイテム使用でメニューを開く(コンパスを使用)
world.afterEvents.itemUse.subscribe((eventData) => {
    if (eventData.itemStack?.typeId === MENU_ITEM_ID) {
        openMainMenu(eventData.source);
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
                player.onScreenDisplay.setActionBar(`§e👥 待機中プレイヤー: §f[ ${names} ]`);
            } else {
                player.onScreenDisplay.setActionBar("§7👥 参加者がいません。メニューから参加してください。");
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
            const cityText = tile.city ? ` §e[🎪都市: ${tile.city.name} (👥x${tile.city.population})]` : "";
            
            // 算出量の可視化 (🍏食料 / 🛠️生産) ※マス自体が持つベース値
            const yieldText = `§a🍏x${tile.foodYield ?? 0} §7| §6🛠️x${tile.productionYield ?? 0}`;

            // 💡 このマスが帰属している都市（都市そのもの、または帰属先の都市）を特定
            const cityKey = tile.city ? key : tile.belongsToCityKey;
            const cityTile = cityKey ? tiles[cityKey] : null;

            let currentYieldLine = "";
            let cityInfoLine = "";

            if (cityTile && cityTile.city) {
                // 💡 市民配置ロジックを考慮した「今」実際に出ている産出量
                const yields = getCityCurrentYields(cityKey, tiles);
                const oilText = yields.oil > 0 ? ` §7| §b🛢️x${yields.oil}` : "";
                currentYieldLine = `\n§f今の産出(都市全体): §a🍏x${yields.food} §7| §6🛠️x${yields.production}${oilText}`;

                // 💡 帰属都市そのものの詳細情報
                const c = cityTile.city;

                // 💡 進行中の生産(ユニット/建造物)を汎用的に表示。新しい生産物が増えても自動で対応。
                let productionText = "";
                if (c.production) {
                    const def = PRODUCTION_DEFS[c.production.id];
                    if (def) {
                        const progressText = Math.floor(c.production.progress * 10) / 10;
                        productionText = ` §7| ${def.icon}${def.label}生産中(${progressText}/${c.production.cost})`;
                    }
                }

                const tpText = c.tradingPost?.status === "active" ? " §7| §a🏛️交易所稼働中" : "";
                const missileText = (c.missiles ?? 0) > 0 ? ` §7| §c🚀x${c.missiles}` : "";
                cityInfoLine = `\n§6【${c.isCapital ? "首都" : "都市"}: ${c.name}】§f 人口:§a${c.population}§f/§e${c.housing} §f| 👷${c.workers ?? 0}人 §f| 🍏貯留${c.foodStorage ?? 0} §f| §c飢餓${c.starvationTurns ?? 0}/3${productionText}${tpText}${missileText}`;
            }

            // アクションバーへ出力
            player.onScreenDisplay.setActionBar(
                `§b🗺️ 補正座標: [${tx}, ${tz}] §7| §f地形: §b${terrainLabel} §7| §f資源: §e${resourceLabel}\n` +
                `§f領有: ${ownerText}${cityText}\n` +
                `§fベース産出: ${yieldText}` +
                currentYieldLine +
                cityInfoLine
            );
        } else {
            // 生成されたグリッドの範囲外にプレイヤーがいる場合
            player.onScreenDisplay.setActionBar("§7❌ 国境線の外（未開の地）にいます");
        }
    }
}, 10);
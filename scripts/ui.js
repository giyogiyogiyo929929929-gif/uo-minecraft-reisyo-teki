import { world, Player, PlayerPermissionLevel } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { getMapConfig, getTile, getTiles } from "./state.js";
import { worldToTile, TERRAIN_TYPES, RESOURCE_TYPES } from "./mapGen.js"
import { turnInfoText, endTurn, isPlayersTurn, joinGame, endGame, getTurnState, calculateCityFoodIncomes, getCityCurrentYields } from "./turns.js";
import { PRODUCTION_DEFS, canStartProduction } from "./production.js";

function isOperator(player) {
    return player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

/**
 * @param {Player} player
 */
export async function openMainMenu(player) {
    const config = getMapConfig();
    const body = [turnInfoText()];

    const turn = getTurnState();
    const rights = (turn && turn.playerRights) ? (turn.playerRights[player.id] ?? 0) : 0;
    body.push(`§e保有中の開拓権: ${rights} 回`);

    // 💡 新機能: プレイヤーの石油保有量をDynamicPropertyから取得してUIに表示
    const oil = player.getDynamicProperty("strategic_oil") ?? 0;
    body.push(`§b保有中の石油: 🛢️ ${oil} 個`);

    let currentTile = null;
    let hasAnyCity = false;
    let capitalPopulation = 0;
    let tileLabel = null;
    let tx = 0;
    let tz = 0;

    const incomes = config ? calculateCityFoodIncomes(player.id) : {};
    const allTiles = config ? getTiles() : {};

    if (config) {
        for (const k in allTiles) {
            if (allTiles[k].ownerId === player.id && allTiles[k].city) {
                hasAnyCity = true;
                if (allTiles[k].city.isCapital) { capitalPopulation = allTiles[k].city.population; }
            }
        }

        const tilePos = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
        tx = tilePos.tx;
        tz = tilePos.tz;
        currentTile = getTile(tx, tz);
        
        if (currentTile) {
            const chopText = currentTile.isChopped ? "§d(伐採済)§b" : "";
            tileLabel = `[${tx},${tz}] ${TERRAIN_TYPES[currentTile.type]?.label ?? currentTile.type}${chopText}`;
            
            let resLabel = "なし";
            if (currentTile.resource && RESOURCE_TYPES[currentTile.resource]) {
                resLabel = `§e${RESOURCE_TYPES[currentTile.resource].label}§b`;
            }

            body.push(`\n§b現在地: ${tileLabel} | 資源: ${resLabel}`);
            body.push(`§bマス固有食料産出: §6🍏x${currentTile.foodYield ?? 1} §b| 生産力: §e🛠️x${currentTile.productionYield ?? 1}`);
            body.push(`§b所有者: ${currentTile.ownerName ? "§f" + currentTile.ownerName : "§7未所有"}`);

            if (currentTile.city) {
                const city = currentTile.city;
                const threshold = 10 + (city.population - 1) * 2;
                const totalIncome = incomes[`${tx},${tz}`] ?? 0;

                const currentYields = getCityCurrentYields(`${tx},${tz}`, allTiles);

                body.push(`\n§6【${city.isCapital ? "首都" : "地方都市"}: ${city.name}】`);
                body.push(`§f  - 人口: §a${city.population} §f/ 住宅上限: §e${city.housing} §f| 👷 労働者: §b${city.workers ?? 0} 人`);
                body.push(`§f  - ⚖️ 現市民の選択総出力: §6🍏x${currentYields.food} §f/ §e🛠️x${currentYields.production}`);
                
                // 💡 進行中の生産(ユニット/建造物)を汎用的に表示。新しい生産物を増やしても自動で対応する。
                if (city.production) {
                    const def = PRODUCTION_DEFS[city.production.id];
                    if (def) {
                        const progressText = Math.floor(city.production.progress * 10) / 10;
                        body.push(`§f  - ${def.icon} ${def.label}: §7生産中 (${progressText}/${city.production.cost})`);
                    }
                } else {
                    body.push(`§f  - §7現在生産中の物はありません`);
                }

                if (city.tradingPost?.status === "active") {
                    body.push(`§f  - 🏛️ 交易所: §a稼働中`);
                    if (city.tradingPost.routes && city.tradingPost.routes.length > 0) {
                        for (const r of city.tradingPost.routes) {
                            const targetName = allTiles[r.targetKey]?.city?.name ?? `未知の都市(${r.targetKey})`;
                            body.push(`    §7➔ 🤝 【${targetName}】残:${r.remainingTurns}T (食料 §a+${r.bonus}§7)`);
                        }
                    } else {
                        body.push(`    §7➔ 🤝 交易路: 接続対象(他の都市)なし`);
                    }
                } else {
                    body.push(`§f  - 🏛️ 交易所: §7未建設`);
                }

                body.push(`§f  - 貯留食料: 🍏 ${city.foodStorage ?? 0} / 成長まで: ${threshold}`);
                body.push(`§f  - 不足飢餓: §c${city.starvationTurns ?? 0} / 3 ターン`);

                if ((city.missiles ?? 0) > 0) {
                    body.push(`§f  - 🚀 保有ミサイル: §c${city.missiles} 発`);
                }
            } else {
                if (currentTile.ownerId === player.id && currentTile.belongsToCityKey) {
                    const belongsCityTile = allTiles[currentTile.belongsToCityKey];
                    if (belongsCityTile && belongsCityTile.city) {
                        body.push(`\n§b帰属都市: 【${belongsCityTile.city.name}】`);
                        body.push(`§7(この領地で稼働できる労働者: 👷x${belongsCityTile.city.workers ?? 0})`);
                    }
                }
            }
        }
    }

    const buttons = [];
    buttons.push({ text: "ゲームに参加する", action: "join" });
    
    if (currentTile && !currentTile.ownerId) {
        buttons.push({ text: "このマスを領有する (人口1消費)", action: "claim" });
    }
    if (hasAnyCity && capitalPopulation >= 3) {
        buttons.push({ text: `§a開拓権を獲得する (首都人口-2)`, action: "buyrights" });
    }
    if (currentTile && !currentTile.city && (!currentTile.ownerId || currentTile.ownerId === player.id)) {
        const label = !hasAnyCity ? "最初の都市(首都)を建てる" : "新都市を建設 (開拓権x1消費)";
        buttons.push({ text: `§6${label}`, action: "settle" });
    }

    // 💡 新機能: 今立っているマスが自分の都市なら「名前変更ボタン」を表示
    if (currentTile && currentTile.city && currentTile.ownerId === player.id) {
        buttons.push({ text: "✍️ 都市の名前を変更する", action: "renamecity" });
    }

    // 💡 新機能: 生産(ユニット/建造物)をまとめたサブメニューへの入口
    if (currentTile && currentTile.city && currentTile.ownerId === player.id) {
        buttons.push({ text: "§b🏭 生産メニューを開く", action: "production" });

        if ((currentTile.city.missiles ?? 0) > 0) {
            buttons.push({ text: `§c🚀 ミサイルを発射する (在庫:${currentTile.city.missiles})`, action: "launchmissile" });
        }
    }

    if (currentTile && currentTile.ownerId === player.id && (currentTile.type === "forest" || currentTile.type === "rainforest") && !currentTile.isChopped) {
        buttons.push({ text: "§d🪓 このマスの森林を伐採する (住宅上限+1)", action: "chop" });
    }
    
    buttons.push({ text: "ターンを終了する", action: "endturn" });
    const isOp = isOperator(player);
    if (isOp) buttons.push({ text: "§c【管理者】ゲームをリセット", action: "endgame" });
    buttons.push({ text: "閉じる", action: "close" });

    const form = new ActionFormData().title("Civ Tactics メニュー").body(body.join("\n"));
    for (const btn of buttons) form.button(btn.text);

    const response = await form.show(player);
    if (response.canceled) return;
    const selection = response.selection;
    if (selection === undefined || selection < 0 || selection >= buttons.length) return;
    const selectedAction = buttons[selection].action;

    switch (selectedAction) {
        case "join": player.sendMessage(joinGame(player).message); break;
        case "claim": (await import("./commands.js")).cmdClaim(player); break;
        case "buyrights": (await import("./commands.js")).cmdBuyRights(player); break;
        case "settle": (await import("./commands.js")).cmdSettle(player); break;
        case "chop": (await import("./commands.js")).cmdChop(player); break;

        // 💡 新機能: 生産メニュー(ユニット/建造物)を開く
        case "production":
            if (!currentTile || !currentTile.city) break;
            await openProductionMenu(player, tx, tz);
            break;

        // 💡 新機能: ミサイル発射(座標入力フォーム)を開く
        case "launchmissile":
            if (!currentTile || !currentTile.city) break;
            await openMissileLaunchMenu(player, tx, tz);
            break;

        
        // 💡 新機能: 名前変更アクションの処理（ModalFormをポップアップさせてコマンドへ送る）
        case "renamecity":
            if (!currentTile || !currentTile.city) break;
            const renameForm = new ModalFormData()
                .title("都市名の変更")
                .textField("都市の名前", "名前を入力", { defaultValue: "" })

            const renameRes = await renameForm.show(player);
            if (renameRes.canceled) break;

            const newName = renameRes.formValues[0];
            if (newName && newName.trim() !== "") {
                (await import("./commands.js")).cmdRenameCity(player, tx, tz, newName.trim());
            }
            break;

        case "endturn":
            if (!isPlayersTurn(player)) { player.sendMessage("§c手番ではありません。"); break; }
            const result = endTurn(player);
            if (!result.ok) player.sendMessage(result.message);
            break;
        case "endgame": if (isOp) world.sendMessage(endGame().message); break;
        default: break;
    }
}

/**
 * 💡 生産メニュー(トップ) — ユニット / 建造物 のカテゴリ選択。
 *    カテゴリ内のボタンは全て PRODUCTION_DEFS から自動生成するため、
 *    新しい生産物を増やしてもこのファイルは変更不要。
 */
async function openProductionMenu(player, tx, tz) {
    const form = new ActionFormData()
        .title("🏭 生産メニュー")
        .body("生産する種類のカテゴリを選択してください。")
        .button("§b👷 ユニット生産")
        .button("§e🏛️ 建造物生産")
        .button("閉じる");

    const res = await form.show(player);
    if (res.canceled || res.selection === undefined) return;

    if (res.selection === 0) await openProductionCategoryMenu(player, tx, tz, "unit");
    else if (res.selection === 1) await openProductionCategoryMenu(player, tx, tz, "building");
}

/**
 * 💡 汎用の生産カテゴリメニュー。
 * PRODUCTION_DEFS の中から該当カテゴリ(unit / building)を走査してボタンを自動生成する。
 * 都市は同時に1つの生産しか進行できないため、既に何か生産中の場合は
 * その進捗表示と「中止」ボタンのみを出す。
 */
async function openProductionCategoryMenu(player, tx, tz, category) {
    const tile = getTile(tx, tz);
    if (!tile || !tile.city) return;
    const city = tile.city;

    const allTiles = getTiles();
    const { production } = getCityCurrentYields(`${tx},${tz}`, allTiles);

    const body = [];
    body.push(`§f現在の生産力: §6🛠️x${production}`);
    if ((city.missiles ?? 0) > 0) body.push(`§f保有ミサイル: §c🚀x${city.missiles}`);

    const buttons = [];
    const activeDef = city.production ? PRODUCTION_DEFS[city.production.id] : null;

    if (activeDef) {
        const progressText = Math.floor(city.production.progress * 10) / 10;
        if (activeDef.category === category) {
            body.push(`\n${activeDef.icon} §7${activeDef.label}: 生産中 (${progressText}/${city.production.cost})`);
            buttons.push({ text: `§c🛑 ${activeDef.label}の生産を中止する`, action: "cancel" });
        } else {
            body.push(`\n§7(他の生産【${activeDef.icon}${activeDef.label}】が進行中のため、この都市は今生産を開始できません)`);
        }
    }

    // 💡 このカテゴリに属する生産物を列挙し、開始可能な物だけボタンを出す
    if (!city.production) {
        for (const id of Object.keys(PRODUCTION_DEFS)) {
            const def = PRODUCTION_DEFS[id];
            if (def.category !== category) continue;

            const check = canStartProduction(city, id);
            if (!check.ok) {
                if (def.uniquePerCity && def.hasBuilt?.(city)) {
                    body.push(`§7${def.icon} ${def.label}: 建設済み`);
                }
                continue;
            }

            const estTurns = production > 0 ? Math.ceil(def.cost / production) : "∞";
            buttons.push({ text: `${def.icon} ${def.label}を生産する (必要生産力:${def.cost}、予測:約${estTurns}T)`, action: `start:${id}` });
        }
    }

    buttons.push({ text: "« 戻る", action: "back" });
    buttons.push({ text: "閉じる", action: "close" });

    const title = category === "unit" ? "👷 ユニット生産" : "🏛️ 建造物生産";
    const form = new ActionFormData().title(title).body(body.join("\n"));
    for (const b of buttons) form.button(b.text);

    const res = await form.show(player);
    if (res.canceled || res.selection === undefined) return;
    const action = buttons[res.selection].action;

    if (action === "cancel") {
        (await import("./commands.js")).cmdCancelProduction(player);
    } else if (action?.startsWith("start:")) {
        const id = action.slice("start:".length);
        (await import("./commands.js")).cmdStartProduction(player, id);
    } else if (action === "back") {
        await openProductionMenu(player, tx, tz);
    }
}

/**
 * 💡 新機能: ミサイル発射先の座標(マス座標 tx, tz)を入力するフォーム
 */
async function openMissileLaunchMenu(player, tx, tz) {
    const tile = getTile(tx, tz);
    if (!tile || !tile.city) return;

    if (!tile.city.missiles || tile.city.missiles <= 0) {
        player.sendMessage("§c🚀 発射可能なミサイルがありません。");
        return;
    }

    const config = getMapConfig();
    const form = new ModalFormData()
        .title("🚀 ミサイル発射 - 目標マス座標")
        .textField(`目標マスのX座標 (0〜${config.width - 1})`, "例: 5", { defaultValue: "" })
        .textField(`目標マスのZ座標 (0〜${config.height - 1})`, "例: 5", { defaultValue: "" });

    const res = await form.show(player);
    if (res.canceled) return;

    const targetTx = parseInt(res.formValues[0], 10);
    const targetTz = parseInt(res.formValues[1], 10);

    if (isNaN(targetTx) || isNaN(targetTz)) {
        player.sendMessage("§c座標は数値で入力してください。");
        return;
    }

    (await import("./commands.js")).cmdLaunchMissile(player, targetTx, targetTz);
}
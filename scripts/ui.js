import { world, Player, PlayerPermissionLevel } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { getMapConfig, getTile, getTiles } from "./state.js";
import { worldToTile, TERRAIN_TYPES, RESOURCE_TYPES } from "./mapGen.js"
import { turnInfoText, endTurn, isPlayersTurn, joinGame, endGame, getTurnState, calculateCityFoodIncomes, getCityCurrentYields, startGame } from "./turns.js";
import { PRODUCTION_DEFS, canStartProduction } from "./production.js";
import { getDefinitions, getKindLabel, getPointsLabel, getProgressState, hasCompletedProgress } from "./progression.js";
import { getRelation, sendRequest, getRequestsFor, acceptRequest, rejectRequest, breakRelation, hasDiplomaticAgreement } from "./diplomacy.js";
import { getAttackRange, getAttackableTargets, getEffectiveCombatStrength } from "./combat.js";
import { getRealPlayer, getControllableCivs, getActiveCivId, setActiveCivId, addVirtualCiv, getCivStorageHandle } from "./civs.js";

function isOperator(player) {
    return player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

/**
 * @param {Player} player
 */
export async function openMainMenu(player) {
    const config = getMapConfig();
    const body = [turnInfoText()];
    const isOp = isOperator(player);
    // 💡 操作できる国家が複数ある(=テスト国家を追加済みの)OPには、今どちらを操作中か明示する。
    if (getControllableCivs(getRealPlayer(player)).length > 1) {
        body.push(`§d🎭 操作中の国家: ${player.name}`);
    }
    const turn = getTurnState();
    const rights = (turn && turn.playerRights) ? (turn.playerRights[player.id] ?? 0) : 0;
    body.push(`§e保有中の開拓権: ${rights} 回`);
    const science = player.getDynamicProperty("science") ?? 0;
    const culture = player.getDynamicProperty("culture") ?? 0;
    body.push(`§a科学力: ${science} | §d文化力: ${culture}`);

    const technologyState = getProgressState(player, "technology");
    const civicState = getProgressState(player, "civic");
    const technologyDef = technologyState.activeId ? getDefinitions("technology")[technologyState.activeId] : null;
    const civicDef = civicState.activeId ? getDefinitions("civic")[civicState.activeId] : null;
    body.push(`§a研究: ${technologyDef ? `${technologyDef.label} (${technologyState.progress}/${technologyDef.cost})` : "未選択"} | §d社会制度: ${civicDef ? `${civicDef.label} (${civicState.progress}/${civicDef.cost})` : "未選択"}`);

    // 💡 新機能: プレイヤーの石油保有量をDynamicPropertyから取得してUIに表示
    const oil = player.getDynamicProperty("strategic_oil") ?? 0;
    body.push(`§b保有中の石油: ${oil} 個`);

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
            body.push(`§bマス固有食料産出: §6[Food]x${currentTile.foodYield ?? 1} §b| 生産力: §e[Prod]x${currentTile.productionYield ?? 1}`);
            body.push(`§b所有者: ${currentTile.ownerName ? "§f" + currentTile.ownerName : "§7未所有"}`);

            if (currentTile.city) {
                const city = currentTile.city;
                const threshold = 10 + (city.population - 1) * 2;
                const totalIncome = incomes[`${tx},${tz}`] ?? 0;

                const currentYields = getCityCurrentYields(`${tx},${tz}`, allTiles);

                body.push(`\n§6【${city.isCapital ? "首都" : "地方都市"}: ${city.name}】`);
                body.push(`§f  - 人口: §a${city.population} §f/ 住宅上限: §e${city.housing} §f| [Worker] 労働者: §b${city.workers ?? 0} 人`);
                body.push(`§f  - ⚖️ 現市民の選択総出力: §6[Food]x${currentYields.food} §f/ §e[Prod]x${currentYields.production}`);
                
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
                    body.push(`§f  - [Trade] 交易所: §a稼働中`);
                    if (city.tradingPost.routes && city.tradingPost.routes.length > 0) {
                        for (const r of city.tradingPost.routes) {
                            const targetName = allTiles[r.targetKey]?.city?.name ?? `未知の都市(${r.targetKey})`;
                            body.push(`    §7➔ 🤝 【${targetName}】残:${r.remainingTurns}T (食料 §a+${r.bonus}§7)`);
                        }
                    } else {
                        body.push(`    §7➔ 🤝 交易路: 接続対象(他の都市)なし`);
                    }
                } else {
                    body.push(`§f  - [Trade] 交易所: §7未建設`);
                }

                body.push(`§f  - 貯留食料: [Food] ${city.foodStorage ?? 0} / 成長まで: ${threshold}`);
                body.push(`§f  - 不足飢餓: §c${city.starvationTurns ?? 0} / 3 ターン`);

                if ((city.missiles ?? 0) > 0) {
                    body.push(`§f  - [Missile] 保有ミサイル: §c${city.missiles} 発`);
                }
            } else {
                if (currentTile.ownerId === player.id && currentTile.belongsToCityKey) {
                    const belongsCityTile = allTiles[currentTile.belongsToCityKey];
                    if (belongsCityTile && belongsCityTile.city) {
                        body.push(`\n§b帰属都市: 【${belongsCityTile.city.name}】`);
                        body.push(`§7(この領地で稼働できる労働者: [Worker]x${belongsCityTile.city.workers ?? 0})`);
                    }
                }
            }
        }
    }

    const buttons = [];
    if (!turn.started) { 
        if (isOp) { buttons.push({ text: "ゲームを開始する", action: "start" });  }
        buttons.push({ text: "ゲームに参加する", action: "join" }); 
    } else {
        buttons.push({ text: "§a🔬 研究ツリー", action: "technology" });
        buttons.push({ text: "§d📜 社会制度ツリー", action: "civic" });
    }
    // 💡 外交メニューはゲーム中(ターン制開始後)ならいつでも開けるようにする。
    //    ("使節団"civicの完了を条件にしていたが、ゲーム参加者との関係確認自体は常にできてよいため撤廃)
    if (turn.started) {
        buttons.push({ text: "§b🤝 外交メニュー", action: "diplomacy" });
    }
    
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
            buttons.push({ text: `§c[Missile] ミサイルを発射する (在庫:${currentTile.city.missiles})`, action: "launchmissile" });
        }
    }

    if (currentTile && currentTile.ownerId === player.id && (currentTile.type === "forest" || currentTile.type === "rainforest") && !currentTile.isChopped) {
        buttons.push({ text: "§d🪓 このマスの森林を伐採する (住宅上限+1)", action: "chop" });
    }
    if (currentTile?.combatUnit?.ownerId === player.id) {
        buttons.push({ text: "§f ユニットの移動", action: "moveunit" });
        buttons.push({ text: "§c⚔ ユニットの攻撃", action: "attackunit" });

        // 💡 都市に自分のユニットが存在し、移動力が最大値のまま(今ターン未行動)なら占領可能。
        const unit = currentTile.combatUnit;
        const isFullMovement = (unit.movementRemaining ?? unit.movement ?? 0) === (unit.movement ?? 0);
        if (currentTile.city && currentTile.ownerId && currentTile.ownerId !== player.id && isFullMovement) {
            buttons.push({ text: `§6🏳 【${currentTile.city.name}】を占領する`, action: "capturecity" });
        }
    }
    if (turn.started) { buttons.push({ text: "ターンを終了する", action: "endturn" }); }
    if (isOp) buttons.push({ text: "§c【管理者】ゲームをリセット", action: "endgame" });
    if (isOp) buttons.push({ text: "§d🎭 国家管理(ソロテスト用)", action: "civmanage" });
    buttons.push({ text: "閉じる", action: "close" });

    const form = new ActionFormData().title("Civ Tactics メニュー").body(body.join("\n"));
    for (const btn of buttons) form.button(btn.text);

    const response = await form.show(getRealPlayer(player));
    if (response.canceled) return;
    const selection = response.selection;
    if (selection === undefined || selection < 0 || selection >= buttons.length) return;
    const selectedAction = buttons[selection].action;

    switch (selectedAction) {
        case "start": startGame(); break;
        case "join": player.sendMessage(joinGame(player).message); break;
        case "claim": (await import("./commands.js")).cmdClaim(player); break;
        case "buyrights": (await import("./commands.js")).cmdBuyRights(player); break;
        case "settle": (await import("./commands.js")).cmdSettle(player); break;
        case "chop": (await import("./commands.js")).cmdChop(player); break;
        case "technology": await openProgressMenu(player, "technology"); break;
        case "civic": await openProgressMenu(player, "civic"); break;
        case "diplomacy": await openDiplomacyMenu(player); break;
        case "moveunit":
            if (currentTile?.combatUnit?.ownerId === player.id) await openCombatUnitMoveMenu(player, tx, tz);
            break;
        case "attackunit":
            if (currentTile?.combatUnit?.ownerId === player.id) await openCombatUnitAttackMenu(player, tx, tz);
            break;
        case "capturecity":
            if (currentTile?.combatUnit?.ownerId === player.id) (await import("./commands.js")).cmdCaptureCity(player, tx, tz);
            break;

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

            const renameRes = await renameForm.show(getRealPlayer(player));
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
        case "civmanage": if (isOp) await openCivManagementMenu(getRealPlayer(player)); break;
        default: break;
    }
}

/**
 * OP専用: ソロでもテストプレイできるよう、自分で操作できる国家(テスト国家)を追加したり、
 * 操作中の国家を切り替えたりするメニュー。常に「実プレイヤー」を受け取り、実プレイヤー本人の
 * 権限で国家一覧を操作する(操作中の国家に関係なく、常に自分自身の所有物として扱う)。
 */
async function openCivManagementMenu(realPlayer) {
    const civs = getControllableCivs(realPlayer);
    const activeId = getActiveCivId(realPlayer);

    const body = [
        "§7ソロでもテストプレイできるよう、自分で操作できる国家を追加・切替できます。",
        "§7テスト国家として行動したいマスには、実際に歩いて移動してから操作してください。",
    ];
    const buttons = civs.map(c => ({
        text: `${c.id === activeId ? "§a▶ " : "§f"}${c.name}${c.isVirtual ? " §7(テスト国家)" : " §7(あなた自身)"}`,
        action: { type: "switch", civId: c.id },
    }));
    buttons.push({ text: "§b➕ テスト国家を追加する", action: { type: "add" } });
    buttons.push({ text: "戻る", action: { type: "back" } });

    const form = new ActionFormData().title("🎭 国家管理(ソロテスト用)").body(body.join("\n"));
    for (const button of buttons) form.button(button.text);
    const result = await form.show(realPlayer);
    if (result.canceled || result.selection === undefined) return;
    const action = buttons[result.selection]?.action;
    if (!action || action.type === "back") {
        await openMainMenu(realPlayer);
        return;
    }

    if (action.type === "switch") {
        const switchResult = setActiveCivId(realPlayer, action.civId);
        if (!switchResult.ok) { realPlayer.sendMessage(switchResult.message); await openCivManagementMenu(realPlayer); return; }
        const civ = civs.find(c => c.id === action.civId);
        realPlayer.sendMessage(`§a操作中の国家を【${civ?.name}】に切り替えました。`);
        await openMainMenu(realPlayer);
        return;
    }

    if (action.type === "add") {
        const turn = getTurnState();
        if (turn.started) {
            realPlayer.sendMessage("§cゲーム開始後は国家を追加できません。次のゲームリセット後に追加してください。");
            await openCivManagementMenu(realPlayer);
            return;
        }

        const nameForm = new ModalFormData().title("テスト国家を追加").textField("国家名", "例: テスト国家2");
        const nameResult = await nameForm.show(realPlayer);
        if (nameResult.canceled) { await openCivManagementMenu(realPlayer); return; }

        const civ = addVirtualCiv(realPlayer, nameResult.formValues?.[0]);
        realPlayer.sendMessage(`§aテスト国家【${civ.name}】を追加しました。§e!civ join§aで参加させてください。`);
        await openCivManagementMenu(realPlayer);
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
        .button("§b[Worker] ユニット生産")
        .button("§e[Trade] 建造物生産")
        .button("閉じる");

    const res = await form.show(getRealPlayer(player));
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
    body.push(`§f現在の生産力: §6[Prod]x${production}`);
    if ((city.missiles ?? 0) > 0) body.push(`§f保有ミサイル: §c[Missile]x${city.missiles}`);

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

            const check = canStartProduction(city, id, tile);
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

    const title = category === "unit" ? "[Worker] ユニット生産" : "[Trade] 建造物生産";
    const form = new ActionFormData().title(title).body(body.join("\n"));
    for (const b of buttons) form.button(b.text);

    const res = await form.show(getRealPlayer(player));
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
        player.sendMessage("§c[Missile] 発射可能なミサイルがありません。");
        return;
    }

    const config = getMapConfig();
    const form = new ModalFormData()
        .title("[Missile] ミサイル発射 - 目標マス座標")
        .textField(`目標マスのX座標 (0〜${config.width - 1})`, "例: 5", { defaultValue: "" })
        .textField(`目標マスのZ座標 (0〜${config.height - 1})`, "例: 5", { defaultValue: "" });

    const res = await form.show(getRealPlayer(player));
    if (res.canceled) return;

    const targetTx = parseInt(res.formValues[0], 10);
    const targetTz = parseInt(res.formValues[1], 10);

    if (isNaN(targetTx) || isNaN(targetTz)) {
        player.sendMessage("§c座標は数値で入力してください。");
        return;
    }

    (await import("./commands.js")).cmdLaunchMissile(player, targetTx, targetTz);
}

/** 研究ツリー／社会制度ツリーの共通選択画面。 */
async function openProgressMenu(player, kind) {
    const state = getProgressState(player, kind);
    const defs = getDefinitions(kind);
    const activeDef = state.activeId ? defs[state.activeId] : null;
    const body = [];

    if (activeDef) {
        body.push(`§e進行中: ${activeDef.label} (${state.progress}/${activeDef.cost} ${getPointsLabel(kind)})`);
    } else {
        body.push(`§7進行中の${getKindLabel(kind)}はありません。繰越${getPointsLabel(kind)}: ${state.carry}`);
    }
    body.push("§7効果は取得完了時から適用されます。");

    const buttons = [];
    for (const id of Object.keys(defs)) {
        const def = defs[id];
        if (state.completed.includes(id)) {
            buttons.push({ text: `§a✓ ${def.label} (取得済み)${def.effect ? ` - ${def.effect}` : ""}`, action: null });
        } else if (state.activeId === id) {
            buttons.push({ text: `§e⌛ ${def.label} (${state.progress}/${def.cost})`, action: null });
        } else {
            const locked = !(def.prerequisites ?? []).every(prerequisite => state.completed.includes(prerequisite));
            buttons.push({
                text: locked ? `§8🔒 ${def.label}` : `§f${def.label} (必要${getPointsLabel(kind)}: ${def.cost})${def.effect ? ` - ${def.effect}` : ""}`,
                action: locked ? null : id,
            });
        }
    }

    buttons.push({ text: "戻る", action: "back" });

    const form = new ActionFormData().title(`${getKindLabel(kind)}ツリー`).body(body.join("\n"));
    for (const button of buttons) form.button(button.text);
    const result = await form.show(getRealPlayer(player));
    if (result.canceled || result.selection === undefined) return;

    const action = buttons[result.selection]?.action;
    if (action === "back") {
        await openMainMenu(player);
    } else if (action) {
        (await import("./commands.js")).cmdStartProgress(player, kind, action);
    }
}

/**
 * ゲームに参加済み(turn.playerOrder に含まれる)国家の、外交データ読み書き用ハンドル一覧を取得する。
 * 💡 まだ「!civ join / ゲームに参加する」をしていないプレイヤーは、ワールドに入っているだけでは
 *    外交の対象に含めない(不可侵条約・同盟をゲーム未参加者と締結できてしまう不具合の修正)。
 * 💡 オフラインの実プレイヤーは外交データを読み書きできないため、一覧からは除外される
 *    (civs.js の getCivStorageHandle の制約による)。
 */
function getJoinedCivHandles(excludeId) {
    const turn = getTurnState();
    const ids = Array.isArray(turn?.playerOrder) ? turn.playerOrder : [];
    const handles = [];
    for (const id of ids) {
        if (id === excludeId) continue;
        const handle = getCivStorageHandle(id);
        if (handle) handles.push(handle);
    }
    return handles;
}

/**
 * 🌐 外交メインメニュー
 */
export function openDiplomacyMenu(player, allCivs) {
    const realPlayer = getRealPlayer(player);
    const myCiv = player;
    const requests = getRequestsFor(myCiv);

    // 💡 allCivs が渡されなかった場合は、実際にゲームへ参加済みの国家だけを対象にする。
    //    (ワールドに入っているだけの未参加プレイヤーは対象に含めない)
    const civList = Array.isArray(allCivs) && allCivs.length > 0
        ? allCivs
        : getJoinedCivHandles(myCiv.id);

    const form = new ActionFormData()
        .title("🌐 外交メニュー")
        .body(`自国: ${myCiv.name}\n届いている外交提案: ${requests.length} 件`);

    // 1. 届いた提案の確認ボタン
    if (requests.length > 0) {
        form.button(`📩 届いた提案を確認する (${requests.length}件)`);
    } else {
        form.button("📩 届いた提案はありません (0)");
    }

    // 2. 自分以外の他国一覧ボタン
    const otherCivs = civList.filter(c => c && c.id !== myCiv.id);
    otherCivs.forEach(civ => {
        const rel = getRelation(myCiv, civ.id);
        let statusTag = "【関係なし】";
        if (rel === "pact") statusTag = "【🤝 不可侵条約】";
        if (rel === "alliance") statusTag = "【👑 同盟】";

        form.button(`${civ.name}\n${statusTag}`);
    });

    form.show(realPlayer).then(res => {
        if (res.canceled) return;

        if (res.selection === 0) {
            openIncomingRequestsMenu(player, civList);
        } else {
            const targetCiv = otherCivs[res.selection - 1];
            openCivDiplomacyDetail(player, targetCiv, civList);
        }
    });
}

/**
 * 📩 届いた提案の確認・承認・拒否UI
 */
function openIncomingRequestsMenu(player, allCivs) {
    const realPlayer = getRealPlayer(player);
    const myCiv = player;
    const requests = getRequestsFor(myCiv);

    if (requests.length === 0) {
        player.sendMessage("§7届いている外交提案はありません。");
        return;
    }

    const form = new ActionFormData()
        .title("📩 届いた外交提案")
        .body("対応する提案を選択してください。");

    requests.forEach(r => {
        const typeLabel = r.type === "pact" ? "不可侵条約" : "同盟";
        form.button(`【${r.fromName}】からの${typeLabel}の提案`);
    });

    form.show(realPlayer).then(res => {
        if (res.canceled) return;
        const selectedReq = requests[res.selection];

        const typeLabel = selectedReq.type === "pact" ? "不可侵条約" : "同盟";
        new MessageFormData()
            .title(`提案の確認: ${selectedReq.fromName}`)
            .body(`【${selectedReq.fromName}】から【${typeLabel}】の提案が届いています。\n承認しますか？`)
            .button1("承認する")
            .button2("拒否する")
            .show(realPlayer)
            .then(actionRes => {
                if (actionRes.canceled) return;

                const fromCiv = allCivs.find(c => c.id === selectedReq.fromId) ?? getCivStorageHandle(selectedReq.fromId) ?? { id: selectedReq.fromId };

                if (actionRes.selection === 1) { // 承認
                    const result = acceptRequest(myCiv, fromCiv, selectedReq.id);
                    player.sendMessage(result.message);
                } else { // 拒否
                    const result = rejectRequest(myCiv, selectedReq.id);
                    player.sendMessage(result.message);
                }
            });
    });
}

/**
 * 🏳️ 個別国家との外交詳細UI（提案・解消）
 */
function openCivDiplomacyDetail(player, targetCiv, allCivs) {
    const realPlayer = getRealPlayer(player);
    const myCiv = player;
    const currentRel = getRelation(myCiv, targetCiv.id);

    // 💡 不可侵条約には「使節団」、同盟には「外交」civicの取得が必要。
    const canProposePact = hasCompletedProgress(player, "civic", "emissaries");
    const canProposeAlliance = hasCompletedProgress(player, "civic", "diplomacy");

    let relText = "関係なし";
    if (currentRel === "pact") relText = "不可侵条約 締結中";
    if (currentRel === "alliance") relText = "同盟 締結中";

    const body = [`対象国: ${targetCiv.name}`, `現在の関係: ${relText}`];
    if (!canProposePact) body.push("§7※不可侵条約の提案には社会制度「使節団」の取得が必要です");
    if (!canProposeAlliance) body.push("§7※同盟の提案には社会制度「外交」の取得が必要です");

    const buttons = [];
    if (currentRel === "none") {
        if (canProposePact) buttons.push({ text: "📜 不可侵条約を提案する", action: "proposePact" });
        if (canProposeAlliance) buttons.push({ text: "👑 同盟を提案する", action: "proposeAlliance" });
    } else if (currentRel === "pact") {
        if (canProposeAlliance) buttons.push({ text: "👑 同盟を提案する", action: "proposeAlliance" });
        buttons.push({ text: "❌ 不可侵条約を破棄する", action: "break" });
    } else if (currentRel === "alliance") {
        buttons.push({ text: "❌ 同盟を解消する", action: "break" });
    }
    if (buttons.length === 0) buttons.push({ text: "閉じる", action: "close" });

    const form = new ActionFormData()
        .title(`外交: ${targetCiv.name}`)
        .body(body.join("\n"));
    for (const btn of buttons) form.button(btn.text);

    form.show(realPlayer).then(res => {
        if (res.canceled) return;
        const selected = buttons[res.selection]?.action;

        if (selected === "proposePact") sendDiplomaticProposal(player, targetCiv, "pact");
        if (selected === "proposeAlliance") sendDiplomaticProposal(player, targetCiv, "alliance");
        if (selected === "break") confirmBreakRelation(player, targetCiv);
    });
}

/** 提案の送信処理。不可侵条約は「使節団」、同盟は「外交」civicの取得を条件とする。 */
function sendDiplomaticProposal(player, targetCiv, type) {
    if (type === "pact" && !hasCompletedProgress(player, "civic", "emissaries")) {
        player.sendMessage("§c不可侵条約を提案するには社会制度「使節団」の取得が必要です。");
        return;
    }
    if (type === "alliance" && !hasCompletedProgress(player, "civic", "diplomacy")) {
        player.sendMessage("§c同盟を提案するには社会制度「外交」の取得が必要です。");
        return;
    }
    const res = sendRequest(player, targetCiv, type);
    player.sendMessage(res.message);
}

/** 関係破棄の確認ダイアログ */
function confirmBreakRelation(player, targetCiv) {
    const realPlayer = getRealPlayer(player);
    const currentRel = getRelation(player, targetCiv.id);
    const typeLabel = currentRel === "pact" ? "不可侵条約" : "同盟";

    new MessageFormData()
        .title(`確認: ${typeLabel}の解消`)
        .body(`本当に【${targetCiv.name}】との【${typeLabel}】を解消・破棄しますか？\nこの操作は即座に反映されます。`)
        .button1("破棄する")
        .button2("キャンセル")
        .show(realPlayer)
        .then(res => {
            if (res.selection === 1) {
                const result = breakRelation(player, targetCiv);
                player.sendMessage(result.message);
            }
        });
}

/** 現在位置の戦闘ユニットが移動できるマスを一覧表示する。 */
async function openCombatUnitMoveMenu(player, fromTx, fromTz) {
    const source = getTile(fromTx, fromTz);
    const unit = source?.combatUnit;
    if (!unit || unit.ownerId !== player.id) return;

    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    const buttons = [];
    const body = [`${unit.label ?? "戦闘ユニット"}  HP: ${unit.hp ?? 0}/${unit.maxHp ?? 100}  戦闘力: ${getEffectiveCombatStrength(unit)}(基本${unit.combatStrength ?? 0})`, `残り移動力: ${remaining}`];
    const config = getMapConfig();
    const tiles = getTiles();

    if (remaining > 0 && config) {
        for (let dz = -remaining; dz <= remaining; dz++) {
            for (let dx = -remaining; dx <= remaining; dx++) {
                const distance = Math.max(Math.abs(dx), Math.abs(dz));
                if (distance === 0 || distance > remaining) continue;
                const tx = fromTx + dx;
                const tz = fromTz + dz;
                if (tx < 0 || tz < 0 || tx >= config.width || tz >= config.height) continue;

                const tile = tiles[`${tx},${tz}`];
                if (!tile || tile.combatUnit) continue;
                const unitText = tile.combatUnit ? `戦闘ユニット: ${tile.combatUnit.label ?? tile.combatUnit.id}` : "戦闘ユニット: なし";
                const cityText = tile.city
                    ? ` | 都市: ${tile.city.name} (人口:${tile.city.population}/${tile.city.housing})`
                    : "";
                buttons.push({ text: `(${tx}, ${tz}) | ${unitText}${cityText}`, action: { tx, tz } });
            }
        }
    } else {
        body.push("§7移動力が残っていません。次の自分のターン開始時に回復します。");
    }

    if (buttons.length === 0 && remaining > 0) body.push("§7移動可能なマスがありません。");
    buttons.push({ text: "戻る", action: null });

    const form = new ActionFormData().title("[Warrior] 移動").body(body.join("\n"));
    for (const button of buttons) form.button(button.text);
    const result = await form.show(getRealPlayer(player));
    if (result.canceled || result.selection === undefined) return;
    const action = buttons[result.selection]?.action;
    if (!action) {
        await openMainMenu(player);
        return;
    }
    (await import("./commands.js")).cmdMoveCombatUnit(player, fromTx, fromTz, action.tx, action.tz);
}

/**
 * 現在位置の戦闘ユニットが攻撃できるマス(攻撃距離内に敵ユニットがいるマス)だけを一覧表示する。
 * 攻撃距離は移動タブと同じ考え方(マス目の最大差)で、移動力(または明示的な攻撃距離)ぶんの範囲。
 */
async function openCombatUnitAttackMenu(player, fromTx, fromTz) {
    const source = getTile(fromTx, fromTz);
    const unit = source?.combatUnit;
    if (!unit || unit.ownerId !== player.id) return;

    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    const range = getAttackRange(unit);
    const buttons = [];
    const body = [
        `${unit.label ?? "戦闘ユニット"}  HP: ${unit.hp ?? 0}/${unit.maxHp ?? 100}  戦闘力: ${getEffectiveCombatStrength(unit)}(基本${unit.combatStrength ?? 0})`,
        `攻撃距離: ${range} | 残り移動力: ${remaining}`,
    ];
    const config = getMapConfig();
    const tiles = getTiles();

    if (remaining > 0) {
        const attackTargets = getAttackableTargets(fromTx, fromTz, player.id, unit, tiles, config, hasDiplomaticAgreement);
        for (const t of attackTargets) {
            const enemyUnit = t.unit;
            const cityText = t.tile.city ? ` | 都市: ${t.tile.city.name}` : "";
            buttons.push({
                text: `⚔ (${t.tx}, ${t.tz}) | ${enemyUnit.label ?? enemyUnit.id} HP:${Math.max(0, Math.round(enemyUnit.hp ?? 0))}/${enemyUnit.maxHp ?? 100} 戦闘力:${getEffectiveCombatStrength(enemyUnit)}${cityText}`,
                action: { tx: t.tx, tz: t.tz },
            });
        }
    } else {
        body.push("§7移動力が残っていないため攻撃できません。次の自分のターン開始時に回復します。");
    }

    if (buttons.length === 0 && remaining > 0) body.push("§7攻撃可能な対象(攻撃距離内の敵ユニット)がありません。");
    buttons.push({ text: "戻る", action: null });

    const form = new ActionFormData().title("[Warrior] 攻撃").body(body.join("\n"));
    for (const button of buttons) form.button(button.text);
    const result = await form.show(getRealPlayer(player));
    if (result.canceled || result.selection === undefined) return;
    const action = buttons[result.selection]?.action;
    if (!action) {
        await openMainMenu(player);
        return;
    }
    (await import("./commands.js")).cmdAttackCombatUnit(player, fromTx, fromTz, action.tx, action.tz);
}
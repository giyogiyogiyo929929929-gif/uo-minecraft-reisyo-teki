import { world, Player, PlayerPermissionLevel } from "@minecraft/server";
import { ActionFormData, ModalFormData, MessageFormData } from "@minecraft/server-ui";
import { ChestFormData } from "./chestForms.js";
import { getMapConfig, getTile, getTiles, setTiles, getMatchSettings, setMatchSettings, getMapGenSettings, setMapGenSettings, resetMapGenSettings, broadcast } from "./state.js";
import { worldToTile, TERRAIN_TYPES, RESOURCE_TYPES } from "./mapGen.js"
import { turnInfoText, isPlayersTurn, joinGame, endGame, getTurnState, setTurnState, calculateCityFoodIncomes, getCityCurrentYields, debugForceVictory, connectTradeRoutes, getPlayerColor } from "./turns.js";
import { PRODUCTION_DEFS, canStartProduction, getTotalWorkerActionsRemaining, WORKER_ACTIONS_PER_UNIT, getWorkerCount } from "./production.js";
import { getFacilityIds, getFacilityDef, canInstallFacility } from "./facilities.js";
import { getDistrictIds, getDistrictDef, canStartDistrict, getDistrictBuildingIds, getDistrictBuildingDef, canStartDistrictBuilding, isSacredSiteTile, hasCityDistrict } from "./districts.js";
import {
    getReligiousUnitIds, getReligiousUnitDef, hasFoundedReligion, getReligionName,
    canFoundReligion, getTotalCivFaith, getNationalDominantReligion,
    getCityFollowers, getCityDominantReligion, getReligiousUnitCost, hasStartedInquisition,
} from "./religion.js";
import { getDefinitions, getKindLabel, getPointsLabel, getProgressState, hasCompletedProgress, getDefinition } from "./progression.js";
import { getRelation, sendRequest, getRequestsFor, acceptRequest, rejectRequest, breakRelation, declareWar, isAtWar, hasDiplomaticAgreement } from "./diplomacy.js";
import { getAttackRange, getAttackableTargets, getEffectiveCombatStrength, isRangedUnit, getEffectiveRangedStrength, canUnitEnterTile, canTravelPath } from "./combat.js";
import { resolveOwningCityKey, getAdjacentTileEntries } from "./adjacency.js";
import { getRealPlayer, getControllableCivs, getActiveCivId, setActiveCivId, addVirtualCiv, removeVirtualCiv, getCivStorageHandle, resolveCivName, getVirtualCivById } from "./civs.js";
import { refreshUnitLabelAt } from "./unitLabels.js";

function isOperator(player) {
    return player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

// 💡 メニューの見た目(通常のフォーム / チェストUI)は試合の設定ではなく、プレイヤー個人の
//    表示上の好みなので、player自身のDynamic Propertyに保存する(試合をまたいでも保持される)。
//    必ず実プレイヤー(getRealPlayer)に対して読み書きすること。テスト国家/Botの擬似プレイヤーは
//    実体が無い(Dynamic Propertyを持たない)ため。
const MENU_STYLE_KEY = "civ:menuStyle";

function getMenuStyle(realPlayer) {
    return realPlayer.getDynamicProperty(MENU_STYLE_KEY) === "chest" ? "chest" : "form";
}

function setMenuStyle(realPlayer, style) {
    realPlayer.setDynamicProperty(MENU_STYLE_KEY, style);
}

// 💡 チェストUIでメインメニューの各ボタンに付けるアイコン(バニラのアイテム/ブロックの
//    typeId。chestForms.js の ChestFormData.button 参照)。ここに無いactionは
//    MAIN_MENU_DEFAULT_ICON にフォールバックする。見た目の分かりやすさのための対応付けであり、
//    ゲームロジックには影響しない。
const MAIN_MENU_DEFAULT_ICON = "minecraft:paper";
const MAIN_MENU_ACTION_ICONS = {
    help: "minecraft:book",
    start: "minecraft:bell",
    join: "minecraft:name_tag",
    joinall: "minecraft:name_tag",
    claim: "minecraft:grass_block",
    buyrights: "minecraft:emerald",
    settle: "minecraft:brick",
    chop: "minecraft:iron_axe",
    installfacility: "minecraft:crafting_table",
    startdistrict: "minecraft:brick",
    startdistrictbuilding: "minecraft:brick",
    buyreligious: "minecraft:nether_star",
    movereligious: "minecraft:nether_star",
    proselytize: "minecraft:nether_star",
    technology: "minecraft:iron_ingot",
    civic: "minecraft:writable_book",
    diplomacy: "minecraft:white_banner",
    myunits: "minecraft:iron_sword",
    religion: "minecraft:nether_star",
    moveunit: "minecraft:arrow",
    attackunit: "minecraft:iron_sword",
    capturecity: "minecraft:white_banner",
    purgeheretic: "minecraft:barrier",
    healunit: "minecraft:golden_apple",
    production: "minecraft:furnace",
    launchmissile: "minecraft:tnt",
    renamecity: "minecraft:name_tag",
    endturn: "minecraft:clock",
    forceendturn: "minecraft:clock",
    endgame: "minecraft:barrier",
    matchsettings: "minecraft:redstone",
    mapgensettings: "minecraft:oak_sapling",
    debugvictory: "minecraft:totem_of_undying",
    debugtile: "minecraft:command_block",
    debugallcivs: "minecraft:spyglass",
    civmanage: "minecraft:player_head",
    togglemenustyle: "minecraft:compass",
    mapview: "minecraft:filled_map",
    close: "minecraft:barrier",
};

/**
 * メインメニューをチェストUI(development_resource_packs/testapia_ui、§18参照)風に表示する。
 * buttons配列のインデックスとチェストのスロット番号を1:1に対応させるため、選ばれたスロット
 * 番号がそのまま buttons のインデックスとして使える。ChestFormDataにはActionFormDataの
 * ようなbody欄が無いため、スロットに余裕があれば最後の1マスに「現在の状況」枠を置いて
 * body[](ターン情報・都市情報など)をそこへ載せる(選んでも buttons の範囲外なので何も
 * 起きず、メニューが閉じるだけ)。このリソースパックがワールド側で有効になっていない場合、
 * マーカー文字列が付いた普通のフォームとして表示されてしまう(見た目が崩れるだけで、
 * 動作自体は壊れない)。
 * @returns {Promise<number|undefined>} 選ばれたスロット番号(=buttonsのインデックス)。
 *   キャンセルされた場合は undefined。
 */
async function showMainMenuChest(realPlayer, body, buttons) {
    const chest = new ChestFormData("large").title("Civ Tactics");
    const capacity = chest.slotCount;
    for (let i = 0; i < buttons.length && i < capacity; i++) {
        const icon = MAIN_MENU_ACTION_ICONS[buttons[i].action] ?? MAIN_MENU_DEFAULT_ICON;
        chest.button(i, buttons[i].text, null, icon);
    }
    if (buttons.length < capacity) {
        chest.button(capacity - 1, "§e現在の状況", body, "minecraft:writable_book");
    }
    const res = await chest.show(realPlayer);
    return res.canceled ? undefined : res.selection;
}

// 💡 マップビューア(§18参照)。チェストUI(9×6マス)のうち、下段1行(9マス)は
//    上下左右移動・閉じるなどの操作専用に固定し、残り5行(9×5=45マス)を実際のマップ表示に使う。
const MAP_VIEW_WIDTH = 9;
const MAP_VIEW_HEIGHT = 5;

// 💡 未所有・都市無しのマスに表示する、地形ごとのアイコン(バニラのアイテム/ブロックのtypeId)。
//    実際に地形生成(mapGen.js)で使っているブロックとできるだけ揃え、見た目から地形が
//    推測しやすいようにしている。
const MAP_VIEW_TERRAIN_ICONS = {
    grassland: "minecraft:grass_block",
    forest: "minecraft:oak_leaves",
    rainforest: "minecraft:jungle_leaves",
    desert: "minecraft:sand",
    mountain: "minecraft:stone",
    mountainRange: "minecraft:obsidian",
    cold: "minecraft:packed_ice",
    sea: "minecraft:prismarine",
    river: "minecraft:water_bucket",
    pond: "minecraft:ice",
    lake: "minecraft:blue_ice",
};
const MAP_VIEW_DEFAULT_TERRAIN_ICON = "minecraft:grass_block";

/**
 * 1マス分のタイルを、マップビューアのチェストスロット1つの見た目(アイコン・名前・説明文)に
 * 変換する。見やすさのため、意味のある情報ほど優先してアイコンに反映する:
 * 都市があれば所有者の色の旗(一目で「誰の都市か」がわかる) > 所有マスなら所有者の色の羊毛
 * (国境線・領土がひと目で色分けされる、Risk風の見た目を狙っている) > それ以外は地形そのものの
 * アイコン(資源の有無ではアイコンを変えない。資源はどのバイオームにも乗り得るため、
 * バイオームのアイコンを優先して地形の見分けやすさを保つ)。座標・地形・基礎産出量
 * (foodYield/productionYield)・資源・所有者・**戦闘ユニット/宗教ユニットの有無**は、
 * アイテムの説明欄(lore)に文字情報として必ず残すため、カーソルを合わせれば正確な情報を
 * 確認できる(ユニットの有無ではアイコンは変えない。地形/所有者の色分けの見分けやすさを
 * 優先するため)。
 */
function describeMapViewTile(tx, tz, tile) {
    const terrainLabel = TERRAIN_TYPES[tile.type]?.label ?? tile.type;
    const lore = [
        `§7座標: (${tx}, ${tz})`,
        `§7地形: ${terrainLabel}`,
        `§6[Food]x${tile.foodYield ?? 0} §e[Prod]x${tile.productionYield ?? 0}`,
    ];
    if (tile.resource) lore.push(`§6資源: ${RESOURCE_TYPES[tile.resource]?.label ?? tile.resource}`);
    if (tile.ownerId) lore.push(`§b所有: ${resolveCivName(tile.ownerId) ?? "?"}`);
    if (tile.combatUnit) {
        const u = tile.combatUnit;
        lore.push(`§c[Unit] ${resolveCivName(u.ownerId) ?? "?"}の${u.label ?? u.id ?? "戦闘ユニット"} (HP ${u.hp ?? u.maxHp ?? 0}/${u.maxHp ?? 0})`);
    }
    if (tile.religiousUnit) {
        const u = tile.religiousUnit;
        lore.push(`§d[Missionary] ${resolveCivName(u.ownerId) ?? "?"}の${u.label ?? "宗教ユニット"} (HP ${u.hp ?? u.maxHp ?? 0}/${u.maxHp ?? 0})`);
    }

    if (tile.city) {
        const color = tile.ownerId ? getPlayerColor(tile.ownerId) : "white";
        return {
            icon: `minecraft:${color}_banner`,
            name: `§e[City] ${tile.city.name ?? "都市"}${tile.city.isCapital ? " §6(首都)" : ""}`,
            lore,
        };
    }
    if (tile.ownerId) {
        const color = getPlayerColor(tile.ownerId);
        return { icon: `minecraft:${color}_wool`, name: `§f${terrainLabel}`, lore };
    }
    return { icon: MAP_VIEW_TERRAIN_ICONS[tile.type] ?? MAP_VIEW_DEFAULT_TERRAIN_ICON, name: `§8${terrainLabel}`, lore };
}

/**
 * OP専用(テスト機能): マップ全体をチェストUIで一覧できるビューア。マップ全体は54マスの
 * チェストに収まりきらないことが多いため、一度に9×5マス分だけを表示し、下段1行(9マス)の
 * 上下左右ボタンで表示範囲を1画面分ずつ(横9マス/縦5マス)動かしながら見ていく。
 * チェストUI専用の画面(§18参照。グリッド状の情報は通常のフォームでは表現しづらいため、
 * 通常フォーム版は用意していない)であり、補助リソースパックが無効な状態で開くと
 * 崩れた見た目になる(壊れはしない)。
 * @param {number} [viewX] 表示範囲の左上のタイルX座標(省略時はマップ中央)
 * @param {number} [viewZ] 表示範囲の左上のタイルZ座標(省略時はマップ中央)
 */
async function openMapViewMenu(realPlayer, viewX, viewZ) {
    const config = getMapConfig();
    if (!config) {
        realPlayer.sendMessage("§cマップがまだ生成されていません。");
        await openMainMenu(realPlayer);
        return;
    }

    const maxX = Math.max(0, config.width - MAP_VIEW_WIDTH);
    const maxZ = Math.max(0, config.height - MAP_VIEW_HEIGHT);
    const x = Math.max(0, Math.min(viewX ?? Math.floor((config.width - MAP_VIEW_WIDTH) / 2), maxX));
    const z = Math.max(0, Math.min(viewZ ?? Math.floor((config.height - MAP_VIEW_HEIGHT) / 2), maxZ));

    const tiles = getTiles();
    const chest = new ChestFormData("large").title("Civ Tactics マップ");
    for (let row = 0; row < MAP_VIEW_HEIGHT; row++) {
        const tz = z + row;
        if (tz >= config.height) continue;
        for (let col = 0; col < MAP_VIEW_WIDTH; col++) {
            const tx = x + col;
            if (tx >= config.width) continue;
            const tile = tiles[`${tx},${tz}`];
            if (!tile) continue;
            const { icon, name, lore } = describeMapViewTile(tx, tz, tile);
            chest.button(row * MAP_VIEW_WIDTH + col, name, lore, icon);
        }
    }

    // 💡 下段(スロット45〜53)は操作専用。十字型に配置する(西=46, 北=48, 現在地=49,
    //    南=50, 東=52)。47・51は意図的に空白のままにして、方向ボタンの押し間違いを防ぐ。
    const controlRow = MAP_VIEW_HEIGHT * MAP_VIEW_WIDTH;
    chest.button(controlRow + 0, "§e使い方", [
        "§7下段のボタンで表示範囲を移動できます。",
        "§7マスの色は所有者(領土)、旗は都市を表します。",
    ], "minecraft:book");
    chest.button(controlRow + 1, "§b◀ 西へ移動", null, "minecraft:arrow");
    chest.button(controlRow + 3, "§b▲ 北へ移動", null, "minecraft:arrow");
    chest.button(controlRow + 4, "§a現在地", [
        `§7X: ${x} 〜 ${Math.min(config.width, x + MAP_VIEW_WIDTH) - 1}`,
        `§7Z: ${z} 〜 ${Math.min(config.height, z + MAP_VIEW_HEIGHT) - 1}`,
    ], "minecraft:compass");
    chest.button(controlRow + 5, "§b▼ 南へ移動", null, "minecraft:arrow");
    chest.button(controlRow + 7, "§b▶ 東へ移動", null, "minecraft:arrow");
    chest.button(controlRow + 8, "§c閉じる", null, "minecraft:barrier");

    const res = await chest.show(realPlayer);
    if (res.canceled || res.selection === undefined) return;

    switch (res.selection) {
        case controlRow + 1: await openMapViewMenu(realPlayer, x - MAP_VIEW_WIDTH, z); return;
        case controlRow + 3: await openMapViewMenu(realPlayer, x, z - MAP_VIEW_HEIGHT); return;
        case controlRow + 5: await openMapViewMenu(realPlayer, x, z + MAP_VIEW_HEIGHT); return;
        case controlRow + 7: await openMapViewMenu(realPlayer, x + MAP_VIEW_WIDTH, z); return;
        case controlRow + 8: return; // 閉じる
        default: await openMapViewMenu(realPlayer, x, z); return; // マスや情報欄をタップした場合は同じ範囲を再表示
    }
}

/**
 * @param {Player} player
 */
export async function openMainMenu(player) {
    const config = getMapConfig();
    const body = [turnInfoText()];
    const isOp = isOperator(player);
    const matchSettings = getMatchSettings();
    body.push(`§7[Settings] 産出倍率: x${matchSettings.yieldMultiplier} | 不可侵条約・同盟: ${matchSettings.diplomacyEnabled ? "有効" : "無効"}`);
    // 💡 操作できる国家が複数ある(=テスト国家を追加済みの)OPには、今どちらを操作中か明示する。
    if (getControllableCivs(getRealPlayer(player)).length > 1) {
        body.push(`§d[Acting] 操作中の国家: ${player.name}`);
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
    const iron = player.getDynamicProperty("strategic_iron") ?? 0;
    body.push(`§7保有中の鉄: ${iron} 個`);

    // 💡 戦闘勝利ポイント(他ゲームでいうレート的なもの。ゲームを跨いで持続する)
    const victoryPoints = player.getDynamicProperty("civ:victoryPoints") ?? 0;
    body.push(`§6[Victory] 勝利ポイント: ${victoryPoints}`);

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

            // 💡 このマスにいる戦闘ユニットの情報(自分のものでも、他国のものでも表示する)
            if (currentTile.combatUnit) {
                const unit = currentTile.combatUnit;
                const unitOwnerText = unit.ownerId === player.id ? "§a自分" : `§c${unit.ownerName ?? "不明"}`;
                const unitStrengthText = isRangedUnit(unit)
                    ? `遠距離${getEffectiveRangedStrength(unit)}/近距離${getEffectiveCombatStrength(unit)}`
                    : `${getEffectiveCombatStrength(unit)}`;
                const unitRemaining = unit.movementRemaining ?? unit.movement ?? 0;
                body.push(`§b戦闘ユニット: §f${unit.label ?? unit.id} §7(所有:${unitOwnerText}§7) HP:${Math.max(0, Math.round(unit.hp ?? 0))}/${unit.maxHp ?? 100} §f戦闘力:${unitStrengthText} §f移動:${unitRemaining}/${unit.movement ?? 0} §f攻撃距離:${getAttackRange(unit)}`);
            } else {
                body.push(`§7戦闘ユニット: なし`);
            }

            // 💡 このマスに施設が設置されている場合、その情報も表示する
            if (currentTile.facility) {
                const facilityOwnerText = currentTile.facility.ownerId === player.id ? "§a自分" : `§c${currentTile.facility.ownerName ?? "不明"}`;
                body.push(`§b施設: §f${currentTile.facility.label ?? currentTile.facility.id} §7(所有:${facilityOwnerText}§7)`);
            }

            // 💡 このマスに区域が設置(または建設中)の場合、その情報も表示する
            if (currentTile.district) {
                const districtOwnerText = currentTile.district.ownerId === player.id ? "§a自分" : `§c${currentTile.district.ownerName ?? "不明"}`;
                body.push(`§b区域: §f${currentTile.district.label ?? currentTile.district.id} §7(所有:${districtOwnerText}§7)`);
            } else if (currentTile.underDistrictConstruction) {
                body.push(`§b区域: §7建設中...`);
            }

            // 💡 このマスに宗教ユニットがいる場合、その情報も表示する(戦闘ユニットとは別レイヤー)
            if (currentTile.religiousUnit) {
                const ru = currentTile.religiousUnit;
                const ruOwnerText = ru.ownerId === player.id ? "§a自分" : `§c${ru.ownerName ?? "不明"}`;
                body.push(`§b宗教ユニット: §f${ru.label ?? ru.id} §7(所有:${ruOwnerText}§7) HP:${Math.max(0, Math.round(ru.hp ?? 0))}/${ru.maxHp ?? 100} 布教力:${ru.evangelismPower ?? 0} 移動:${ru.movementRemaining ?? ru.movement ?? 0}/${ru.movement ?? 0}`);
            }

            if (currentTile.city) {
                const city = currentTile.city;
                // 💡 自国・同盟国以外の都市は、偵察による有利化を防ぐため詳細情報(人口・生産・
                //    備蓄・区域建設・交易路・宗教的圧力の内訳・ミサイル在庫等)を表示しない
                //    (存在・所有者・都市名までは他の箇所の表示で分かるが、それ以上は隠す)。
                //    ただし、このゲームに参加していない(turn.playerOrderに含まれない)純粋な
                //    観戦者には、偵察による有利不利が生じ得ないためこの制限を適用しない。
                const viewerIsParticipant = Array.isArray(turn.playerOrder) && turn.playerOrder.includes(player.id);
                const isFriendlyCity = !viewerIsParticipant
                    || currentTile.ownerId === player.id
                    || hasDiplomaticAgreement(player.id, currentTile.ownerId);

                if (!isFriendlyCity) {
                    body.push(`\n§6【${city.isCapital ? "首都" : "地方都市"}: ${city.name}】 §7(他国の都市のため詳細情報は非表示)`);
                } else {
                const threshold = 10 + (city.population - 1) * 2;
                const totalIncome = incomes[`${tx},${tz}`] ?? 0;

                const currentYields = getCityCurrentYields(`${tx},${tz}`, allTiles);

                body.push(`\n§6【${city.isCapital ? "首都" : "地方都市"}: ${city.name}】`);
                body.push(`§f  - 人口: §a${city.population} §f/ 住宅上限: §e${city.housing} §f| [Worker] 労働者: §b${getWorkerCount(city)} 人 §7(残り行動:${getTotalWorkerActionsRemaining(city)})`);
                body.push(`§f  - [Yield] 現市民の選択総出力: §6[Food]x${currentYields.food} §f/ §e[Prod]x${currentYields.production} §f/ §d[Faith]x${currentYields.faith ?? 0} §f/ §7[Iron]x${currentYields.iron ?? 0}${currentYields.science ? ` §f/ §b[Science]x${currentYields.science}` : ""}`);

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

                // 💡 進行中の区域建設(city.production とは別枠)も表示する。
                if (city.districtConstruction) {
                    const districtDef = getDistrictDef(city.districtConstruction.id);
                    const districtProgressText = Math.floor(city.districtConstruction.progress * 10) / 10;
                    body.push(`§f  - ${districtDef?.icon ?? "[Sacred]"} ${districtDef?.label ?? city.districtConstruction.id}: §7区域建設中 (${districtProgressText}/${city.districtConstruction.cost})`);
                }

                if (city.tradingPost?.status === "active") {
                    body.push(`§f  - [Trade] 交易所: §a稼働中`);
                    if (city.tradingPost.routes && city.tradingPost.routes.length > 0) {
                        for (const r of city.tradingPost.routes) {
                            const targetName = allTiles[r.targetKey]?.city?.name ?? `未知の都市(${r.targetKey})`;
                            const scienceText = r.scienceBonus > 0 ? ` §b科学力+${r.scienceBonus}§7` : "";
                            body.push(`    §7-> [Link] 【${targetName}】残:${r.remainingTurns}T (食料 §a+${r.bonus}§7${scienceText})`);
                        }
                    } else {
                        body.push(`    §7-> [Link] 交易路: 接続対象(他の都市)なし`);
                    }
                } else {
                    body.push(`§f  - [Trade] 交易所: §7未建設`);
                }

                body.push(`§f  - 貯留食料: [Food] ${city.foodStorage ?? 0} / 成長まで: ${threshold}`);
                body.push(`§f  - 貯留信仰力: §d[Faith] ${city.faithStorage ?? 0}`);

                // 💡 新機能: この都市の宗教的圧力の内訳(どの宗教が何%、信仰者は何人か)を表示する。
                const pressures = city.religiousPressure ?? {};
                const totalPressure = Object.values(pressures).reduce((sum, v) => sum + v, 0);
                if (totalPressure > 0) {
                    const dominantCivId = getCityDominantReligion(city);
                    const followers = getCityFollowers(city);
                    body.push(`§f  - §d[Religion] 宗教的圧力の内訳 (合計: ${Math.floor(totalPressure)}):`);
                    const sortedCivIds = Object.keys(pressures).sort((a, b) => (pressures[b] ?? 0) - (pressures[a] ?? 0));
                    for (const civId of sortedCivIds) {
                        const pressure = pressures[civId] ?? 0;
                        if (pressure <= 0) continue;
                        const civName = resolveCivName(civId) ?? "不明な国家";
                        const religionName = getReligionName(getCivStorageHandle(civId)) ?? "無名の宗教";
                        const percent = (pressure / totalPressure) * 100;
                        const followerCount = Math.floor(followers[civId] ?? 0);
                        const dominantMark = civId === dominantCivId ? "§a[Dominant]§7 " : "";
                        body.push(`    §7-> ${dominantMark}【${religionName}】§7(${civName}) 圧力:${Math.floor(pressure)} (${percent.toFixed(1)}%) 信仰者:${followerCount}人`);
                    }
                } else {
                    body.push(`§f  - §d[Religion] 宗教的圧力: §7なし`);
                }

                body.push(`§f  - 不足飢餓: §c${city.starvationTurns ?? 0} / 3 ターン`);

                if ((city.missiles ?? 0) > 0) {
                    body.push(`§f  - [Missile] 保有ミサイル: §c${city.missiles} 発`);
                }
                }
            } else {
                if (currentTile.ownerId === player.id && currentTile.belongsToCityKey) {
                    const belongsCityTile = allTiles[currentTile.belongsToCityKey];
                    if (belongsCityTile && belongsCityTile.city) {
                        body.push(`\n§b帰属都市: 【${belongsCityTile.city.name}】`);
                        body.push(`§7(この領地で稼働できる労働者: [Worker]x${getWorkerCount(belongsCityTile.city)}、残り行動:${getTotalWorkerActionsRemaining(belongsCityTile.city)})`);
                    }
                }
            }
        }
    }

    const buttons = [];
    buttons.push({ text: "§b[Help] ルール説明を見る", action: "help" });
    if (!turn.started) {
        if (isOp) { buttons.push({ text: "ゲームを開始する", action: "start" });  }
        buttons.push({ text: "ゲームに参加する", action: "join" });
        if (isOp) buttons.push({ text: "§d[Join] 【管理者】全プレイヤーを参加待機状態にする", action: "joinall" });
    } else {
        buttons.push({ text: "§a[Tech] 研究ツリー", action: "technology" });
        buttons.push({ text: "§d[Civic] 社会制度ツリー", action: "civic" });
    }
    // 💡 外交メニューはゲーム中(ターン制開始後)ならいつでも開けるようにする。
    //    ("使節団"civicの完了を条件にしていたが、ゲーム参加者との関係確認自体は常にできてよいため撤廃)
    if (turn.started) {
        buttons.push({ text: "§b[Diplomacy] 外交メニュー", action: "diplomacy" });
        buttons.push({ text: "§f[Combat] 自分の戦闘ユニット一覧", action: "myunits" });
        buttons.push({ text: "§d[Religion] 宗教", action: "religion" });
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
        buttons.push({ text: "[Rename] 都市の名前を変更する", action: "renamecity" });
    }

    // 💡 新機能: 生産(ユニット/建造物)をまとめたサブメニューへの入口
    if (currentTile && currentTile.city && currentTile.ownerId === player.id) {
        buttons.push({ text: "§b[Production] 生産メニューを開く", action: "production" });

        if ((currentTile.city.missiles ?? 0) > 0) {
            buttons.push({ text: `§c[Missile] ミサイルを発射する (在庫:${currentTile.city.missiles})`, action: "launchmissile" });
        }
    }

    if (currentTile && currentTile.ownerId === player.id && (currentTile.type === "forest" || currentTile.type === "rainforest") && !currentTile.isChopped) {
        buttons.push({ text: "§d[Chop] このマスの森林を伐採する (住宅上限+1)", action: "chop" });
    }
    if (currentTile && currentTile.ownerId === player.id && !currentTile.city && !currentTile.facility) {
        buttons.push({ text: "§7[Facility] 施設を設置する", action: "installfacility" });
    }
    if (currentTile && currentTile.ownerId === player.id && !currentTile.city && !currentTile.district && !currentTile.underDistrictConstruction) {
        buttons.push({ text: "§5[District] 区域を配置する", action: "startdistrict" });
    }
    if (currentTile && currentTile.ownerId === player.id && currentTile.district) {
        buttons.push({ text: "§5[District] 区域専用の建造物を建設する", action: "startdistrictbuilding" });
    }
    if (currentTile && currentTile.city && currentTile.ownerId === player.id && hasFoundedReligion(player)) {
        buttons.push({ text: "§d[Faith] 宗教ユニットを購入する", action: "buyreligious" });
    }
    if (currentTile?.combatUnit?.ownerId === player.id) {
        buttons.push({ text: "§f ユニットの移動", action: "moveunit" });
        buttons.push({ text: "§c[Combat] ユニットの攻撃", action: "attackunit" });

        // 💡 都市に自分のユニットが存在し、移動力が最大値のまま(今ターン未行動)なら占領可能。
        const unit = currentTile.combatUnit;
        const isFullMovement = (unit.movementRemaining ?? unit.movement ?? 0) === (unit.movement ?? 0);
        if (currentTile.city && currentTile.ownerId && currentTile.ownerId !== player.id && isFullMovement) {
            buttons.push({ text: `§6[Capture] 【${currentTile.city.name}】を占領する`, action: "capturecity" });
        }
        // 💡 同じマスに他国の宗教ユニットがいれば、移動力が最大値のときに排除できる(異教徒の排除)。
        if (currentTile.religiousUnit && currentTile.religiousUnit.ownerId !== player.id && isFullMovement) {
            buttons.push({ text: `§c[Purge] 異教徒(${currentTile.religiousUnit.label ?? "宗教ユニット"})を排除する`, action: "purgeheretic" });
        }
        // 💡 今ターンまだ行動していない(移動力が最大値のまま)、HPが減っているユニットは、
        //    行動力を全て消費してその場で休息し、最大HPの30%分回復できる。
        if (isFullMovement && (unit.hp ?? unit.maxHp ?? 100) < (unit.maxHp ?? 100)) {
            buttons.push({ text: `§a[Heal] このユニットを休息させて回復する (最大HPの30%)`, action: "healunit" });
        }
    }
    if (currentTile?.religiousUnit?.ownerId === player.id) {
        const ownUnit = currentTile.religiousUnit;
        const ownDef = getReligiousUnitDef(ownUnit.id);
        buttons.push({ text: "§d[Missionary] 宗教ユニットの移動", action: "movereligious" });
        if (ownDef?.canProselytize !== false) {
            buttons.push({ text: "§d[Faith] 隣接する都市に布教する", action: "proselytize" });
        }
        if (ownDef?.canAttack && !ownUnit.hasAttackedThisTurn) {
            buttons.push({ text: "§4[Faith][Combat] 敵の宗教ユニットを攻撃する", action: "attackreligious" });
        }
        // 💡 審問の開始は「布教力が満タン(=一度も布教していない)使徒のみ」行える一度きりの能力。
        if (ownDef?.canStartInquisition && !hasStartedInquisition(player)
            && (ownUnit.evangelismPower ?? 0) >= (ownDef.evangelismPower ?? 0)) {
            buttons.push({ text: "§4[Inquisition] 審問を開始する", action: "startinquisition" });
        }
        if (ownDef?.canSuppress && (ownUnit.evangelismPower ?? 0) > 0) {
            buttons.push({ text: "§4[Inquisition] この都市で弾圧を行う", action: "inquisitorsuppress" });
        }
    }
    if (turn.started) { buttons.push({ text: "ターンを終了する", action: "endturn" }); }
    if (isOp && turn.started) buttons.push({ text: "§6【管理者】手番を強制スキップ", action: "forceendturn" });
    if (isOp) buttons.push({ text: "§c【管理者】ゲームをリセット", action: "endgame" });
    if (isOp) buttons.push({ text: "§e[Settings] 試合の設定(産出倍率・外交の有無)", action: "matchsettings" });
    if (isOp) buttons.push({ text: "§e[Settings] マップ生成の設定(バイオーム・資源)", action: "mapgensettings" });
    if (isOp && turn.started) buttons.push({ text: "§c[Debug]【デバッグ】指定した国家を即座に勝利させる", action: "debugvictory" });
    if (isOp && currentTile) buttons.push({ text: "§c[Debug]【デバッグ】このマスを編集する", action: "debugtile" });
    if (isOp && turn.started) buttons.push({ text: "§b[Intel]【デバッグ】全国家の情報を閲覧する", action: "debugallcivs" });
    if (isOp) buttons.push({ text: "§d[Civs] 国家管理(ソロテスト用)", action: "civmanage" });
    if (isOp && config) buttons.push({ text: "§b[Test] マップを見る(チェストUI)", action: "mapview" });
    const realPlayer = getRealPlayer(player);
    const menuStyle = getMenuStyle(realPlayer);
    buttons.push({
        text: menuStyle === "chest" ? "§b[UI] 通常のメニューに切り替える" : "§b[UI] チェストUIに切り替える",
        action: "togglemenustyle",
    });
    buttons.push({ text: "閉じる", action: "close" });

    let selection;
    if (menuStyle === "chest") {
        selection = await showMainMenuChest(realPlayer, body, buttons);
    } else {
        const form = new ActionFormData().title("Civ Tactics メニュー").body(body.join("\n"));
        for (const btn of buttons) form.button(btn.text);
        const response = await form.show(realPlayer);
        selection = response.canceled ? undefined : response.selection;
    }
    if (selection === undefined || selection < 0 || selection >= buttons.length) return;
    const selectedAction = buttons[selection].action;

    switch (selectedAction) {
        case "togglemenustyle":
            setMenuStyle(realPlayer, menuStyle === "chest" ? "form" : "chest");
            await openMainMenu(player);
            break;
        case "help": await openHelpMenu(player); break;
        case "start": (await import("./bots.js")).startGameAuto(); break;
        case "join": player.sendMessage(joinGame(player).message); break;
        case "joinall": if (isOp) (await import("./commands.js")).cmdJoinAll(player); break;
        case "claim": (await import("./commands.js")).cmdClaim(player); break;
        case "buyrights": (await import("./commands.js")).cmdBuyRights(player); break;
        case "settle": (await import("./commands.js")).cmdSettle(player); break;
        case "chop": (await import("./commands.js")).cmdChop(player); break;
        case "installfacility": await openFacilityInstallMenu(player, tx, tz); break;
        case "startdistrict": await openDistrictStartMenu(player, tx, tz); break;
        case "startdistrictbuilding": await openDistrictBuildingMenu(player, tx, tz); break;
        case "buyreligious": await openBuyReligiousUnitMenu(player, tx, tz); break;
        case "movereligious": await openReligiousUnitMoveMenu(player, tx, tz); break;
        case "proselytize": await openProselytizeMenu(player, tx, tz); break;
        case "technology": await openProgressMenu(player, "technology"); break;
        case "civic": await openProgressMenu(player, "civic"); break;
        case "diplomacy": await openDiplomacyMenu(player); break;
        case "myunits": await openMyUnitsMenu(player); break;
        case "religion": await openReligionMenu(player); break;
        case "moveunit":
            if (currentTile?.combatUnit?.ownerId === player.id) await openCombatUnitMoveMenu(player, tx, tz);
            break;
        case "attackunit":
            if (currentTile?.combatUnit?.ownerId === player.id) await openCombatUnitAttackMenu(player, tx, tz);
            break;
        case "capturecity":
            if (currentTile?.combatUnit?.ownerId === player.id) (await import("./commands.js")).cmdCaptureCity(player, tx, tz);
            break;
        case "purgeheretic":
            if (currentTile?.combatUnit?.ownerId === player.id) (await import("./commands.js")).cmdPurgeHeretic(player, tx, tz);
            break;
        case "attackreligious":
            if (currentTile?.religiousUnit?.ownerId === player.id) await openReligiousUnitAttackMenu(player, tx, tz);
            break;
        case "startinquisition":
            if (currentTile?.religiousUnit?.ownerId === player.id) (await import("./commands.js")).cmdStartInquisition(player, tx, tz);
            break;
        case "inquisitorsuppress":
            if (currentTile?.religiousUnit?.ownerId === player.id) (await import("./commands.js")).cmdInquisitorSuppress(player, tx, tz);
            break;
        case "healunit":
            if (currentTile?.combatUnit?.ownerId === player.id) (await import("./commands.js")).cmdHealCombatUnit(player, tx, tz);
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

        case "endturn": {
            if (!isPlayersTurn(player)) { player.sendMessage("§c手番ではありません。"); break; }
            const result = (await import("./bots.js")).endTurnAuto(player);
            if (!result.ok) player.sendMessage(result.message);
            break;
        }
        // 💡 ゲームリセットは勝利メッセージ同様、行動ログの表示設定(logsEnabled)に関わらず
        //    常に表示する(broadcast()を使わずworld.sendMessage()を直接呼ぶ)。
        case "endgame": if (isOp) world.sendMessage(endGame(getRealPlayer(player).name).message); break;
        case "forceendturn": if (isOp) { const r = (await import("./bots.js")).forceEndTurnAuto(); if (!r.ok) player.sendMessage(r.message); } break;
        case "debugvictory": if (isOp) await openDebugVictoryMenu(getRealPlayer(player)); break;
        case "debugtile": if (isOp && currentTile) await openDebugTileMenu(getRealPlayer(player), tx, tz); break;
        case "debugallcivs": if (isOp) await openDebugAllCivsMenu(getRealPlayer(player)); break;
        case "matchsettings": if (isOp) await openMatchSettingsMenu(getRealPlayer(player)); break;
        case "mapgensettings": if (isOp) await openMapGenSettingsMenu(getRealPlayer(player)); break;
        case "civmanage": if (isOp) await openCivManagementMenu(getRealPlayer(player)); break;
        case "mapview": if (isOp) await openMapViewMenu(getRealPlayer(player)); break;
        default: break;
    }
}

/**
 * ゲーム内メニューから読める簡単なルール説明。README.md の要約(全項目ではなく、
 * 初めて触る人がまず知りたい要点のみ)。新しいシステムを追加した場合、ここも
 * 必要に応じて更新することが望ましい(ただし完全な同期は必須ではない、あくまで簡易説明)。
 */
const HELP_TOPICS = [
    {
        title: "基本の流れ",
        body: [
            "・ゲームは参加者が順番に手番を行うターン制です。",
            "・自分の手番中に、領有・都市建設・生産・研究・戦闘・外交などの行動を行えます。",
            "・最初は「最初の都市(首都)を建てる」ボタンで首都を建設してください。",
            "・自分の都市/領地に隣接する未所有マスは「領有」できます(コスト: 最寄り都市の人口-1)。",
            "・新しい都市を建てるには「開拓権」が必要です(首都の人口を消費して取得できます)。",
            "・行動が終わったら「ターンを終了する」ボタンを押して次の国家に手番を渡してください。",
        ],
    },
    {
        title: "生産と経済",
        body: [
            "・都市は労働者・戦士・弓兵などのユニットや、穀物庫・交易所などの建造物を1つずつ生産できます。",
            "・人口の多い都市ほど、食料・生産力などの産出量が増えます。",
            "・食料が不足すると飢餓が進み、3ターン連続で不足が続くと人口が1減ります。",
            "・食料が十分に貯まると、一定量ごとに人口が1増えます(住宅上限まで)。",
            "・「施設」はマスを消費して即座に設置できる建造物、「区域」は別のマスを使って複数ターンかけて建てる大型施設です。",
        ],
    },
    {
        title: "戦闘",
        body: [
            "・ユニットの攻撃や都市の占領は、相手に「宣戦布告」して戦争状態にしてからでないと行えません。",
            "・「関係なし」の相手が所有するマスには、ユニットが進入すらできません。",
            "・複数のユニットで敵ユニットを取り囲んでから攻撃すると、包囲ボーナスで有利にダメージを与えられます。",
            "・今ターンまだ行動していないユニットは、その場で休息してHPを回復できます。",
            "・戦争は外交メニューの「講和する」でいつでも終了できます(試合の設定で無効化されていない場合)。",
        ],
    },
    {
        title: "外交",
        body: [
            "・国家同士の関係は「関係なし」「不可侵条約」「同盟」「戦争」の4種類です。",
            "・不可侵条約・同盟は、外交メニューから提案し、相手が承認すると成立します(それぞれ専用の社会制度が必要)。",
            "・宣戦布告は相手の承諾なしに、選んだ瞬間に一方的に成立します。",
            "・不可侵条約・同盟を結んでいる相手には攻撃できません。",
        ],
    },
    {
        title: "勝利条件",
        body: [
            "・都市を持つ国家が1つだけになれば、その国家の勝利です。",
            "・生存している全ての国家が同じ宗教を信仰していれば、その宗教を創始した国家の勝利になります。",
            "・参加人数が4人以上のとき、生存者全員が互いに同盟していれば、その同盟グループ全体の勝利になります。",
            "・ミサイルで破壊されたり、飢餓で人口が0になった都市は消滅します。",
        ],
    },
];

/** ルール説明メニュー(項目一覧)。 */
async function openHelpMenu(player) {
    const realPlayer = getRealPlayer(player);
    const body = [
        "§7Civ Tactics の簡単なルール説明です。気になる項目を選んでください。",
        "§7チャットで /civ:help と入力すると、コマンド一覧も確認できます。",
    ];
    const buttons = HELP_TOPICS.map((topic, i) => ({ text: `§b${topic.title}`, action: i }));
    buttons.push({ text: "戻る", action: null });

    const form = new ActionFormData().title("[Help] ルール説明").body(body.join("\n"));
    for (const btn of buttons) form.button(btn.text);
    const result = await form.show(realPlayer);
    if (result.canceled || result.selection === undefined) return;
    const action = buttons[result.selection]?.action;

    if (typeof action === "number") await openHelpTopicMenu(player, action);
    else await openMainMenu(player);
}

/** ルール説明メニュー(個別項目の詳細)。「戻る」で項目一覧へ戻る。 */
async function openHelpTopicMenu(player, topicIndex) {
    const realPlayer = getRealPlayer(player);
    const topic = HELP_TOPICS[topicIndex];
    if (!topic) { await openHelpMenu(player); return; }

    const form = new ActionFormData().title(`[Help] ${topic.title}`).body(topic.body.join("\n"));
    form.button("戻る");
    await form.show(realPlayer);
    await openHelpMenu(player);
}

/**
 * OP専用: 試合全体に関わるルール設定を変更する。ゲームリセットを跨いでも保持される
 * (state.js の getMatchSettings/setMatchSettings、resetAllでは消去されない)ため、
 * 繰り返しテストプレイする際に毎回設定し直す必要が無い。
 * - 産出の倍率: turns.js の getCityCurrentYields が集計する全産出量に掛ける倍率。
 * - 不可侵条約・同盟の有無: 無効にすると、新規の提案送信・承認ができなくなる
 *   (diplomacy.js の sendRequest/acceptRequest がここを見て拒否する。既に成立している
 *   関係はそのまま残る)。
 * - 講和の有無: 無効にすると、一度始まった戦争(war)を breakRelation で終了できなくなる
 *   (diplomacy.js の breakRelation がここを見て拒否する。不可侵条約・同盟の解消は
 *   この設定の影響を受けない)。無効にすると、Bot側の劣勢時の自動講和(bots.js)も行われない。
 * - Botの手番間隔: 全員Botの対戦で、Botの手番から次のBotの手番へ移るまでの間隔(tick)。
 *   bots.js の advanceUntilHuman がここを見て system.runTimeout の遅延に使う。
 * - 行動ログの表示: 無効にすると、領有・生産・戦闘・外交などの行動ログ(world.sendMessage
 *   による全員への通知)が一切表示されなくなる(state.js の broadcast() がここを見て
 *   world.sendMessage() の呼び出し自体を省略する)。同じ設定で、領有・都市建設・伐採・
 *   ミサイル発射に伴う title/playsound(commands.js の broadcastEffect())も無効化される
 *   ため、OP自身やスペクテイターが操作した場合の画面演出・効果音も含めて誰にも見えなく/
 *   聞こえなくできる(Botの行動自体はもともとこれらの演出を出さない)。**勝利メッセージ
 *   (ソロ/宗教/同盟勝利、デバッグ即時勝利)、および「ゲームがリセットされました」
 *   メッセージ(実行者名入り)はこの設定に関わらず常に表示される**
 *   (broadcast()を使わずworld.sendMessage()を直接呼んでいるため)。全員Botの対戦を
 *   放置観戦・高速進行させたいときに、チャット欄・画面演出が埋め尽くされるのを防ぐための設定。
 */
// 💡 slider(label, minimumValue, maximumValue, sliderOptions?) 自体の呼び出し方は正しかったが、
//    minimumValue/valueStepに小数(0.5)を渡すと、環境によって触った瞬間に0扱いになる不具合が
//    確認された。そのため産出倍率のスライダーは整数(1〜10, 1刻み)で動かし、実際の倍率
//    (x0.5〜x5, 0.5刻み)には YIELD_MULTIPLIER_STEP を掛けて変換する
//    (スライダーの表示は「1〜10段階」になる)。Botの手番間隔はもともと整数(tick)なので
//    この変換は不要で、そのままスライダーの値を使う。
const YIELD_MULTIPLIER_STEP = 0.5;
const YIELD_SLIDER_MAX_STEPS = 10; // x0.5 * 10 = x5 が上限
const BOT_TURN_DELAY_TICKS_MIN = 1;
const BOT_TURN_DELAY_TICKS_MAX = 100; // 100tick = 5秒

async function openMatchSettingsMenu(realPlayer) {
    const settings = getMatchSettings();
    const defaultSliderValue = Math.round(settings.yieldMultiplier / YIELD_MULTIPLIER_STEP);
    const defaultBotDelay = Math.min(BOT_TURN_DELAY_TICKS_MAX, Math.max(BOT_TURN_DELAY_TICKS_MIN, settings.botTurnDelayTicks));
    const form = new ModalFormData()
        .title("[Settings] 試合の設定")
        .slider(
            `産出の倍率(1段階=x${YIELD_MULTIPLIER_STEP}。食料・生産力・信仰力・鉄などの全産出量に掛ける倍率)`,
            1,
            YIELD_SLIDER_MAX_STEPS,
            { valueStep: 1, defaultValue: Math.min(YIELD_SLIDER_MAX_STEPS, Math.max(1, defaultSliderValue)) },
        )
        .toggle("不可侵条約・同盟を有効にする", { defaultValue: settings.diplomacyEnabled })
        .toggle("講和(戦争状態の解消)を有効にする", { defaultValue: settings.peaceEnabled })
        .slider(
            "Botの手番間隔(tick。20tick=1秒。全員Botの対戦を見やすくする速度調整)",
            BOT_TURN_DELAY_TICKS_MIN,
            BOT_TURN_DELAY_TICKS_MAX,
            { valueStep: 1, defaultValue: defaultBotDelay },
        )
        .toggle("行動ログを表示する(領有・生産・戦闘・外交などの通知。勝利/リセットは常に表示)", { defaultValue: settings.logsEnabled });

    const res = await form.show(realPlayer);
    if (res.canceled) { await openMainMenu(realPlayer); return; }

    const [sliderValue, diplomacyEnabled, peaceEnabled, botTurnDelayTicks, logsEnabled] = res.formValues;
    const yieldMultiplier = sliderValue * YIELD_MULTIPLIER_STEP;
    setMatchSettings({ yieldMultiplier, diplomacyEnabled, peaceEnabled, botTurnDelayTicks, logsEnabled });
    realPlayer.sendMessage(`§a試合の設定を更新しました。 §7(産出の倍率: x${yieldMultiplier} / 不可侵条約・同盟: ${diplomacyEnabled ? "有効" : "無効"} / 講和: ${peaceEnabled ? "有効" : "無効"} / Bot手番間隔: ${botTurnDelayTicks}tick / 行動ログ: ${logsEnabled ? "表示" : "非表示"})`);
    await openMainMenu(realPlayer);
}

// 💡 マップ生成の設定メニューに表示するバイオームの並び順(陸地系→水域系)。
//    river/sea は mapGen.js の専用アルゴリズムで配置されるため、ここでの重みは
//    「既定密度に対する倍率」として扱われる。pond/lake/mountainRangeはriver/mountainから
//    自動的に派生する地形のため個別設定項目には含めない。
const MAP_GEN_BIOME_ORDER = ["grassland", "forest", "rainforest", "desert", "cold", "mountain", "river", "sea"];
const MAP_GEN_WEIGHT_MAX = 50;

/**
 * OP専用: マップ生成の設定メニューの入口。「編集する」「初期値に戻す」を選ぶハブ画面
 * (ModalFormDataにはボタンを置けないため、編集本体は別画面 openMapGenSettingsEditMenu に分ける)。
 */
async function openMapGenSettingsMenu(realPlayer) {
    const form = new ActionFormData()
        .title("[Settings] マップ生成の設定")
        .body("§7各バイオームの生成有無・生成しやすさ(重み)、資源の出現率を設定します。\n§7設定してもマップは自動で再生成されません。反映するには改めて /civ:generate を実行してください。");
    form.button("§a設定を編集する");
    form.button("§c初期値に戻す");
    form.button("戻る");

    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined || res.selection === 2) { await openMainMenu(realPlayer); return; }

    if (res.selection === 0) { await openMapGenSettingsEditMenu(realPlayer); return; }

    // res.selection === 1: 初期値に戻す(確認ダイアログを挟む)。
    new MessageFormData()
        .title("確認: マップ生成の設定を初期値に戻す")
        .body("本当にマップ生成の設定(各バイオームの生成有無・重み、資源の出現率)を初期値に戻しますか？\nこの操作は即座に反映されます。")
        .button1("キャンセル")
        .button2("初期値に戻す")
        .show(realPlayer)
        .then(async (confirmRes) => {
            if (confirmRes.selection === 1) {
                resetMapGenSettings();
                realPlayer.sendMessage("§aマップ生成の設定を初期値に戻しました。");
            }
            await openMapGenSettingsMenu(realPlayer);
        });
}

/**
 * OP専用: マップ生成(/civ:generate)で使う各バイオームの生成有無・生成しやすさ(重み)、
 * および資源の出現率を設定する。試合の設定と同様、ゲームリセット/マップの再生成を跨いでも
 * 保持される(state.js の getMapGenSettings/setMapGenSettings)。設定してもマップは
 * 自動で再生成されないため、反映させるには改めて /civ:generate を実行する必要がある。
 */
async function openMapGenSettingsEditMenu(realPlayer) {
    const settings = getMapGenSettings();
    const form = new ModalFormData().title("[Settings] マップ生成の設定");
    for (const id of MAP_GEN_BIOME_ORDER) {
        const label = TERRAIN_TYPES[id]?.label ?? id;
        const biome = settings.biomes[id] ?? { enabled: true, weight: TERRAIN_TYPES[id]?.weight ?? 10 };
        form.toggle(`${label}を生成する`, { defaultValue: biome.enabled });
        form.slider(
            `${label}の生成しやすさ(重みが大きいほど出現しやすい)`,
            0, MAP_GEN_WEIGHT_MAX,
            { valueStep: 1, defaultValue: Math.max(0, Math.min(MAP_GEN_WEIGHT_MAX, biome.weight)) },
        );
    }
    form.slider(
        "資源の出現率(%。各マスに戦略・高級・ボーナス資源のいずれかが生成される確率)",
        0, 100,
        { valueStep: 5, defaultValue: Math.max(0, Math.min(100, settings.resourceChance)) },
    );

    const res = await form.show(realPlayer);
    if (res.canceled) { await openMapGenSettingsMenu(realPlayer); return; }

    const values = res.formValues;
    const biomesPartial = {};
    const summaryParts = [];
    for (let i = 0; i < MAP_GEN_BIOME_ORDER.length; i++) {
        const id = MAP_GEN_BIOME_ORDER[i];
        const enabled = values[i * 2];
        const weight = values[i * 2 + 1];
        biomesPartial[id] = { enabled, weight };
        summaryParts.push(`${TERRAIN_TYPES[id]?.label ?? id}: ${enabled ? `有効(重み${weight})` : "無効"}`);
    }
    const resourceChance = values[MAP_GEN_BIOME_ORDER.length * 2];
    setMapGenSettings({ biomes: biomesPartial, resourceChance });
    realPlayer.sendMessage(`§aマップ生成の設定を更新しました。次回の /civ:generate から反映されます。 §7(${summaryParts.join(" / ")} / 資源出現率: ${resourceChance}%)`);
    await openMapGenSettingsMenu(realPlayer);
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
        text: `${c.id === activeId ? "§a> " : "§f"}${c.name}${c.isBot ? " §7(Bot)" : c.isVirtual ? " §7(テスト国家)" : " §7(あなた自身)"}`,
        action: { type: "switch", civId: c.id },
    }));
    buttons.push({ text: "§b[Add] テスト国家を追加する", action: { type: "add" } });
    buttons.push({ text: "§b[Add] Botを追加する(自動でゲームに参加)", action: { type: "addbot" } });
    if (civs.some(c => c.isVirtual)) {
        buttons.push({ text: "§c[Remove] 国家を削除する", action: { type: "remove" } });
    }
    buttons.push({ text: "戻る", action: { type: "back" } });

    const form = new ActionFormData().title("[Civs] 国家管理(ソロテスト用)").body(body.join("\n"));
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
        realPlayer.sendMessage(`§aテスト国家【${civ.name}】を追加しました。§e/civ:join§aで参加させてください。`);
        await openCivManagementMenu(realPlayer);
        return;
    }

    if (action.type === "addbot") {
        const turn = getTurnState();
        if (turn.started) {
            realPlayer.sendMessage("§cゲーム開始後はBotを追加できません。次のゲームリセット後に追加してください。");
            await openCivManagementMenu(realPlayer);
            return;
        }

        const nameForm = new ModalFormData().title("Botを追加").textField("Bot名", "例: Bot1");
        const nameResult = await nameForm.show(realPlayer);
        if (nameResult.canceled) { await openCivManagementMenu(realPlayer); return; }

        const result = (await import("./bots.js")).addBot(realPlayer, nameResult.formValues?.[0]);
        realPlayer.sendMessage(result.message);
        await openCivManagementMenu(realPlayer);
        return;
    }

    if (action.type === "remove") {
        await openCivRemoveMenu(realPlayer);
    }
}

/**
 * OP専用: 自分が追加したテスト国家/Botを削除する。トグルで複数選んで一括削除できる
 * (「全て選択」相当は全トグルをONにすればよい)。ゲーム開始後は削除できない
 * (所有マス・都市などゲーム内状態に取り残しが発生するのを防ぐため、追加時と同じ制約)。
 * 削除前に確認ダイアログを挟む(取り消せない操作のため)。
 */
async function openCivRemoveMenu(realPlayer) {
    const removable = getControllableCivs(realPlayer).filter(c => c.isVirtual);
    if (removable.length === 0) {
        realPlayer.sendMessage("§c削除できる国家がありません。");
        await openCivManagementMenu(realPlayer);
        return;
    }

    const form = new ModalFormData().title("[Civs] 国家を削除(複数選択可)");
    for (const c of removable) {
        form.toggle(`${c.name}${c.isBot ? " §7(Bot)" : " §7(テスト国家)"}`, { defaultValue: false });
    }

    const result = await form.show(realPlayer);
    if (result.canceled) { await openCivManagementMenu(realPlayer); return; }

    const targets = removable.filter((_, i) => result.formValues[i] === true);
    if (targets.length === 0) {
        realPlayer.sendMessage("§c削除する国家が選択されていません。");
        await openCivManagementMenu(realPlayer);
        return;
    }

    const turn = getTurnState();
    if (turn.started) {
        realPlayer.sendMessage("§cゲーム開始後は国家を削除できません。次のゲームリセット後に削除してください。");
        await openCivManagementMenu(realPlayer);
        return;
    }

    new MessageFormData()
        .title("確認: 国家の削除")
        .body(`本当に次の${targets.length}件を削除しますか？\n${targets.map(t => `・${t.name}`).join("\n")}\nこの操作は取り消せません。`)
        .button1("キャンセル")
        .button2(`削除する(${targets.length}件)`)
        .show(realPlayer)
        .then(async (confirmRes) => {
            if (confirmRes.selection === 1) {
                // 💡 ゲーム開始前に /civ:join 済みだった場合、待機列(playerOrder)にも
                //    idが残ってしまうため、ここで一緒に取り除く(ゲーム未開始が確定している
                //    ため、開始後の手番進行中に触るケースを心配する必要は無い)。
                const latestTurn = getTurnState();
                let playerOrderChanged = false;
                const removedNames = [];
                for (const target of targets) {
                    const removeResult = removeVirtualCiv(target.id);
                    if (!removeResult.ok) continue;
                    removedNames.push(removeResult.name);
                    if (Array.isArray(latestTurn.playerOrder) && latestTurn.playerOrder.includes(target.id)) {
                        latestTurn.playerOrder = latestTurn.playerOrder.filter(id => id !== target.id);
                        playerOrderChanged = true;
                    }
                }
                if (playerOrderChanged) setTurnState(latestTurn);
                realPlayer.sendMessage(`§a${removedNames.length}件の国家を削除しました。§7(${removedNames.join("、")})`);
            }
            await openCivManagementMenu(realPlayer);
        });
}

/**
 * OP専用デバッグ機能: 通常の勝利条件を一切判定せず、選んだ国家を即座に勝利させる。
 * トグルを1つだけONにすれば単独勝利、複数ONにすれば同盟勝利として扱われる
 * (動作確認・デモ用のショートカット。実際の判定は turns.js の debugForceVictory が行う)。
 */
async function openDebugVictoryMenu(realPlayer) {
    const turn = getTurnState();
    if (!turn.started || !turn.playerOrder.length) {
        realPlayer.sendMessage("§cゲームが開始されていないため、デバッグ勝利を実行できません。");
        await openMainMenu(realPlayer);
        return;
    }

    const form = new ModalFormData().title("§c[Debug] デバッグ: 即座に勝利させる");
    for (const civId of turn.playerOrder) {
        form.toggle(resolveCivName(civId) ?? civId, { defaultValue: false });
    }

    const res = await form.show(realPlayer);
    if (res.canceled) { await openMainMenu(realPlayer); return; }

    const selectedIds = turn.playerOrder.filter((_, i) => res.formValues[i] === true);
    if (!selectedIds.length) {
        realPlayer.sendMessage("§c国家が選択されていません。1つ以上トグルをONにしてください。");
        await openMainMenu(realPlayer);
        return;
    }

    const result = debugForceVictory(selectedIds);
    realPlayer.sendMessage(result.message);
}

/**
 * OP専用デバッグ機能: 試合中の全国家(参加済みの人間・テスト国家・Bot全て)の一覧から
 * 1つを選び、その国家の詳細情報(資源・都市・ユニット・外交関係など)を閲覧する入口メニュー。
 * 一覧が多くなりうるため showPaginatedMenu を使う。
 */
async function openDebugAllCivsMenu(realPlayer) {
    const turn = getTurnState();
    const civIds = Array.isArray(turn?.playerOrder) ? turn.playerOrder : [];
    if (civIds.length === 0) {
        realPlayer.sendMessage("§7参加している国家がいません。");
        await openMainMenu(realPlayer);
        return;
    }

    const items = civIds.map((civId) => {
        const virtualCiv = getVirtualCivById(civId);
        const typeTag = virtualCiv?.isBot ? "§7(Bot)" : virtualCiv ? "§7(テスト国家)" : "§7(プレイヤー)";
        return { text: `${resolveCivName(civId) ?? civId} ${typeTag}`, action: civId };
    });

    await showPaginatedMenu(
        realPlayer,
        "[Intel] 全国家の情報閲覧",
        "§7情報を見る国家を選択してください。(OP専用のデバッグ機能です)",
        items,
        async (civId) => await openDebugCivDetailMenu(realPlayer, civId),
        async () => await openMainMenu(realPlayer),
    );
}

/**
 * OP専用デバッグ機能: 指定した1国家の詳細情報を表示する。
 * 資源(石油・鉄・勝利ポイント・開拓権)、研究/社会制度の進行状況、保有する都市(人口・住宅・
 * 産出量・生産中の物・区域建設状況・**都市ごとの宗教的圧力の内訳**)、保有する戦闘ユニット
 * (位置・HP・戦闘力・移動力)、宗教の創始状況、他の全国家との外交関係(不可侵条約/同盟/
 * 関係なし)をまとめて表示する。
 */
async function openDebugCivDetailMenu(realPlayer, civId) {
    const handle = getCivStorageHandle(civId);
    if (!handle) {
        realPlayer.sendMessage("§cこの国家の情報を取得できませんでした。(オフラインの人間プレイヤーの可能性があります)");
        await openDebugAllCivsMenu(realPlayer);
        return;
    }

    const virtualCiv = getVirtualCivById(civId);
    const typeLabel = virtualCiv?.isBot ? "Bot" : virtualCiv ? "テスト国家" : "プレイヤー";
    const turn = getTurnState();
    const tiles = getTiles();

    const lines = [`§6=== 【${handle.name}】(${typeLabel}) ===`];

    // 資源・開拓権
    const oil = handle.getDynamicProperty?.("strategic_oil") ?? 0;
    const iron = handle.getDynamicProperty?.("strategic_iron") ?? 0;
    const victoryPoints = handle.getDynamicProperty?.("civ:victoryPoints") ?? 0;
    const rights = turn?.playerRights?.[civId] ?? 0;
    lines.push(`§b[Resource] 石油: ${oil} §f| 鉄: ${iron} §f| 開拓権: ${rights} §f| §6勝利ポイント: ${victoryPoints}`);

    // 研究・社会制度
    const techState = getProgressState(handle, "technology");
    const civicState = getProgressState(handle, "civic");
    const techDef = techState.activeId ? getDefinition("technology", techState.activeId) : null;
    const civicDef = civicState.activeId ? getDefinition("civic", civicState.activeId) : null;
    lines.push(`§a研究: ${techDef ? `${techDef.label} (${Math.floor(techState.progress)}/${techDef.cost})` : "未選択"} §f| §d社会制度: ${civicDef ? `${civicDef.label} (${Math.floor(civicState.progress)}/${civicDef.cost})` : "未選択"}`);
    const completedTech = techState.completed.map((id) => getDefinition("technology", id)?.label ?? id);
    const completedCivic = civicState.completed.map((id) => getDefinition("civic", id)?.label ?? id);
    lines.push(`§7  取得済み技術: ${completedTech.length ? completedTech.join("、") : "なし"}`);
    lines.push(`§7  取得済み社会制度: ${completedCivic.length ? completedCivic.join("、") : "なし"}`);

    // 都市(先に集計しておき、宗教セクションの総信仰力計算にも使う)
    const cityEntries = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId && t.city) cityEntries.push({ key, tile: t });
    }

    // 宗教
    if (hasFoundedReligion(handle)) {
        lines.push(`§d[Religion] 創始した宗教: 【${getReligionName(handle)}】 §f(総信仰力: ${Math.floor(getTotalCivFaith(cityEntries))})`);
    } else {
        lines.push(`§7宗教: 未創始`);
    }

    // 都市
    lines.push(`\n§6[City] 都市 (${cityEntries.length}件):`);
    if (cityEntries.length === 0) {
        lines.push("§7  なし");
    } else {
        for (const { key, tile } of cityEntries) {
            const city = tile.city;
            const yields = getCityCurrentYields(key, tiles);
            const prodText = city.production
                ? `${PRODUCTION_DEFS[city.production.id]?.label ?? city.production.id} (${Math.floor(city.production.progress)}/${city.production.cost})`
                : "なし";
            const districtText = city.districtConstruction
                ? `${getDistrictDef(city.districtConstruction.id)?.label ?? city.districtConstruction.id} (${Math.floor(city.districtConstruction.progress)}/${city.districtConstruction.cost})`
                : "なし";
            lines.push(`§f  ${city.isCapital ? "[首都]" : "[都市]"} ${city.name} (${key}) §7- 人口:${city.population}/住宅:${city.housing}`);
            lines.push(`§7    産出: [Food]${yields.food} [Prod]${yields.production} [Faith]${yields.faith ?? 0} [Iron]${yields.iron ?? 0} [Science]${yields.science ?? 0} §7| 生産中: ${prodText} §7| 区域建設中: ${districtText}`);

            // 💡 この都市の宗教的圧力の内訳(通常のメニューの都市詳細と同じ表示。§18参照)。
            const pressures = city.religiousPressure ?? {};
            const totalPressure = Object.values(pressures).reduce((sum, v) => sum + v, 0);
            if (totalPressure > 0) {
                const dominantCivId = getCityDominantReligion(city);
                const followers = getCityFollowers(city);
                const sortedCivIds = Object.keys(pressures).sort((a, b) => (pressures[b] ?? 0) - (pressures[a] ?? 0));
                for (const pressureCivId of sortedCivIds) {
                    const pressure = pressures[pressureCivId] ?? 0;
                    if (pressure <= 0) continue;
                    const religionName = getReligionName(getCivStorageHandle(pressureCivId)) ?? "無名の宗教";
                    const percent = (pressure / totalPressure) * 100;
                    const followerCount = Math.floor(followers[pressureCivId] ?? 0);
                    const dominantMark = pressureCivId === dominantCivId ? "§a[Dominant]§7 " : "";
                    lines.push(`§7    宗教的圧力: ${dominantMark}【${religionName}】(${resolveCivName(pressureCivId) ?? pressureCivId}) 圧力:${Math.floor(pressure)} (${percent.toFixed(1)}%) 信仰者:${followerCount}人`);
                }
            } else {
                lines.push(`§7    宗教的圧力: なし`);
            }
        }
    }

    // 戦闘ユニット
    const unitEntries = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.combatUnit?.ownerId === civId) unitEntries.push({ key, unit: t.combatUnit });
    }
    lines.push(`\n§6[Combat] 戦闘ユニット (${unitEntries.length}件):`);
    if (unitEntries.length === 0) {
        lines.push("§7  なし");
    } else {
        for (const { key, unit } of unitEntries) {
            const strengthText = isRangedUnit(unit)
                ? `遠距離${getEffectiveRangedStrength(unit)}/近距離${getEffectiveCombatStrength(unit)}`
                : `${getEffectiveCombatStrength(unit)}`;
            lines.push(`§f  ${unit.label ?? unit.id} (${key}) §7- HP:${Math.max(0, Math.round(unit.hp ?? 0))}/${unit.maxHp ?? 100} 戦闘力:${strengthText} 移動:${unit.movementRemaining ?? unit.movement ?? 0}/${unit.movement ?? 0}`);
        }
    }

    // 外交関係
    const otherCivIds = (Array.isArray(turn?.playerOrder) ? turn.playerOrder : []).filter((id) => id !== civId);
    lines.push(`\n§6[Diplomacy] 外交関係:`);
    if (otherCivIds.length === 0) {
        lines.push("§7  他に参加国家がいません");
    } else {
        for (const otherId of otherCivIds) {
            const rel = getRelation(handle, otherId);
            const relLabel = rel === "alliance" ? "§b同盟" : rel === "pact" ? "§a不可侵条約" : rel === "war" ? "§4戦争中" : "§7関係なし";
            lines.push(`§f  ${resolveCivName(otherId) ?? otherId}: ${relLabel}`);
        }
    }

    const form = new ActionFormData()
        .title(`[Intel] ${handle.name}`)
        .body(lines.join("\n"))
        .button("戻る");
    await form.show(realPlayer);
    await openDebugAllCivsMenu(realPlayer);
}

/**
 * OP専用デバッグ機能: 今いるマスの状態を自由に書き換えるための入口メニュー。
 * 地形/資源/基礎産出量、所有者、都市の各種パラメータ、施設、区域、戦闘ユニット、宗教ユニット、
 * 宗教的圧力を、それぞれ専用のサブメニューで直接編集できる。通常の生産コスト・技術条件・
 * 隣接マスの状況などは一切判定せず、データを直接書き換える(動作確認・デモ用)。
 */
async function openDebugTileMenu(realPlayer, tx, tz) {
    const tile = getTile(tx, tz);
    if (!tile) { realPlayer.sendMessage("§cこのマスの情報が取得できません。"); await openMainMenu(realPlayer); return; }

    const body = [
        `§7座標: (${tx}, ${tz})`,
        `§7地形: ${TERRAIN_TYPES[tile.type]?.label ?? tile.type} §7| 資源: ${tile.resource ? (RESOURCE_TYPES[tile.resource]?.label ?? tile.resource) : "なし"}`,
        `§7基礎産出量: [Food]x${tile.foodYield ?? 0} [Prod]x${tile.productionYield ?? 0}`,
        `§7所有者: ${tile.ownerName ?? "未所有"}`,
        `§7都市: ${tile.city ? tile.city.name : "なし"} §7| 施設: ${tile.facility?.label ?? "なし"} §7| 区域: ${tile.district?.label ?? (tile.underDistrictConstruction ? "建設中" : "なし")}`,
        `§7戦闘ユニット: ${tile.combatUnit?.label ?? "なし"} §7| 宗教ユニット: ${tile.religiousUnit?.label ?? "なし"}`,
    ];

    const buttons = [
        { text: "§f[Map] 地形・資源・基礎産出量を編集", action: "terrain" },
        { text: "§f[Owner] 所有者を編集", action: "owner" },
    ];
    if (tile.city) buttons.push({ text: "§6[City] 都市を編集", action: "city" });
    buttons.push({ text: "§7[Facility] 施設を編集", action: "facility" });
    buttons.push({ text: "§5[District] 区域を編集", action: "district" });
    buttons.push({ text: "§c[Combat] 戦闘ユニットを編集", action: "combatunit" });
    buttons.push({ text: "§d[Faith] 宗教ユニットを編集", action: "religiousunit" });
    if (tile.city) buttons.push({ text: "§d[Religion] 宗教的圧力を編集", action: "pressure" });
    buttons.push({ text: "戻る", action: "back" });

    const form = new ActionFormData().title("§c[Debug] デバッグ: マス編集").body(body.join("\n"));
    for (const b of buttons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openMainMenu(realPlayer); return; }
    const action = buttons[res.selection]?.action;

    switch (action) {
        case "terrain": await openDebugTerrainMenu(realPlayer, tx, tz); break;
        case "owner": await openDebugOwnerMenu(realPlayer, tx, tz); break;
        case "city": await openDebugCityMenu(realPlayer, tx, tz); break;
        case "facility": await openDebugFacilityMenu(realPlayer, tx, tz); break;
        case "district": await openDebugDistrictMenu(realPlayer, tx, tz); break;
        case "combatunit": await openDebugCombatUnitMenu(realPlayer, tx, tz); break;
        case "religiousunit": await openDebugReligiousUnitMenu(realPlayer, tx, tz); break;
        case "pressure": await openDebugPressureMenu(realPlayer, tx, tz); break;
        default: await openMainMenu(realPlayer); break;
    }
}

/** デバッグ: 地形タイプ・資源・マス固有の基礎産出量(foodYield/productionYield)・伐採状態を直接編集する。 */
async function openDebugTerrainMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile) { await openMainMenu(realPlayer); return; }

    const terrainIds = Object.keys(TERRAIN_TYPES);
    const terrainLabels = terrainIds.map(id => TERRAIN_TYPES[id].label);
    const resourceIds = ["none", ...Object.keys(RESOURCE_TYPES)];
    const resourceLabels = ["なし", ...Object.keys(RESOURCE_TYPES).map(id => RESOURCE_TYPES[id].label)];

    const form = new ModalFormData()
        .title("[Map] 地形・資源・基礎産出量を編集")
        .dropdown("地形タイプ", terrainLabels, { defaultValueIndex: Math.max(0, terrainIds.indexOf(tile.type)) })
        .dropdown("資源", resourceLabels, { defaultValueIndex: Math.max(0, resourceIds.indexOf(tile.resource ?? "none")) })
        .textField("基礎食料産出量 (foodYield)", "例: 3", { defaultValue: String(tile.foodYield ?? 0) })
        .textField("基礎生産力産出量 (productionYield)", "例: 2", { defaultValue: String(tile.productionYield ?? 0) })
        .toggle("伐採済み扱いにする (isChopped)", { defaultValue: !!tile.isChopped });

    const res = await form.show(realPlayer);
    if (res.canceled) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const [terrainIndex, resourceIndex, foodStr, prodStr, chopped] = res.formValues;
    tile.type = terrainIds[terrainIndex] ?? tile.type;
    const pickedResource = resourceIds[resourceIndex];
    tile.resource = (!pickedResource || pickedResource === "none") ? null : pickedResource;
    const food = Number(foodStr); if (Number.isFinite(food)) tile.foodYield = food;
    const prod = Number(prodStr); if (Number.isFinite(prod)) tile.productionYield = prod;
    tile.isChopped = !!chopped;

    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の地形・資源・基礎産出量を更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: マスの所有者(国家)を直接付け替える。 */
async function openDebugOwnerMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile) { await openMainMenu(realPlayer); return; }
    const turn = getTurnState();
    const civIds = Array.isArray(turn.playerOrder) ? turn.playerOrder : [];

    const buttons = civIds.map(civId => ({ text: `${tile.ownerId === civId ? "§a> " : "§f"}${resolveCivName(civId) ?? civId}`, civId }));
    buttons.push({ text: `${!tile.ownerId ? "§a> " : "§7"}未所有にする`, civId: "__none__" });
    buttons.push({ text: "戻る", civId: "__back__" });

    const form = new ActionFormData().title("[Owner] 所有者を編集").body(`§7現在の所有者: ${tile.ownerName ?? "未所有"}`);
    for (const b of buttons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const picked = buttons[res.selection];
    if (picked.civId === "__back__") { await openDebugTileMenu(realPlayer, tx, tz); return; }

    if (picked.civId === "__none__") {
        tile.ownerId = null;
        tile.ownerName = null;
    } else {
        tile.ownerId = picked.civId;
        tile.ownerName = resolveCivName(picked.civId) ?? picked.civId;
    }
    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の所有者を更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: 都市の各種パラメータ(人口・住宅・貯留量・首都フラグ・各種建造物フラグなど)を直接編集する。 */
async function openDebugCityMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile?.city) { await openDebugTileMenu(realPlayer, tx, tz); return; }
    const city = tile.city;
    const wasCapital = !!city.isCapital;
    const wasTradingActive = city.tradingPost?.status === "active";

    const form = new ModalFormData()
        .title("[City] 都市を編集")
        .textField("都市名", "都市名", { defaultValue: city.name ?? "" })
        .textField("人口 (population)", "例: 4", { defaultValue: String(city.population ?? 1) })
        .textField("住宅上限 (housing)", "例: 5", { defaultValue: String(city.housing ?? 2) })
        .textField("労働者数 (workers)", "例: 2", { defaultValue: String(getWorkerCount(city)) })
        .textField("貯留食料 (foodStorage)", "例: 0", { defaultValue: String(city.foodStorage ?? 0) })
        .textField("貯留信仰力 (faithStorage)", "例: 0", { defaultValue: String(city.faithStorage ?? 0) })
        .textField("保有ミサイル数 (missiles)", "例: 0", { defaultValue: String(city.missiles ?? 0) })
        .toggle("首都にする (isCapital)", { defaultValue: wasCapital })
        .toggle("穀物庫 (granary)", { defaultValue: !!city.granary })
        .toggle("オベリスク (obelisk)", { defaultValue: !!city.obelisk })
        .toggle("社 (shrine)", { defaultValue: !!city.shrine })
        .toggle("交易所を稼働させる (tradingPost)", { defaultValue: wasTradingActive });

    const res = await form.show(realPlayer);
    if (res.canceled) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const [name, popStr, housingStr, workersStr, foodStr, faithStr, missilesStr, isCapital, granary, obelisk, shrine, tradingActive] = res.formValues;

    if (name && name.trim()) city.name = name.trim();
    const pop = Number(popStr); if (Number.isFinite(pop)) city.population = Math.max(0, Math.floor(pop));
    const housing = Number(housingStr); if (Number.isFinite(housing)) city.housing = Math.max(0, Math.floor(housing));
    const food = Number(foodStr); if (Number.isFinite(food)) city.foodStorage = food;
    const faith = Number(faithStr); if (Number.isFinite(faith)) city.faithStorage = faith;
    const missiles = Number(missilesStr); if (Number.isFinite(missiles)) city.missiles = Math.max(0, Math.floor(missiles));

    const workers = Number(workersStr);
    if (Number.isFinite(workers)) {
        const count = Math.max(0, Math.floor(workers));
        city.workerUnits = Array.from({ length: count }, () => WORKER_ACTIONS_PER_UNIT);
    }

    if (isCapital && !wasCapital) {
        // 💡 1国家1首都を保つため、同じ所有者が持つ他の都市から首都フラグを外す。
        for (const key in tiles) {
            const t = tiles[key];
            if (t.city && t.city.isCapital && t.ownerId === tile.ownerId) t.city.isCapital = false;
        }
    }
    city.isCapital = !!isCapital;
    city.granary = !!granary;
    city.obelisk = !!obelisk;
    city.shrine = !!shrine;

    if (tradingActive && !wasTradingActive) {
        city.tradingPost = { status: "active", routes: [] };
        connectTradeRoutes(`${tx},${tz}`, city, tiles);
    } else if (!tradingActive && wasTradingActive) {
        city.tradingPost = null;
    }

    setTiles(tiles);
    realPlayer.sendMessage(`§a【${city.name}】のデータを更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: マスの施設(facility)を、通常の設置条件を無視して直接設置/削除する。 */
async function openDebugFacilityMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile) { await openMainMenu(realPlayer); return; }

    const facilityIds = getFacilityIds();
    const buttons = facilityIds.map(id => ({ text: `${getFacilityDef(id)?.icon ?? ""} ${getFacilityDef(id)?.label ?? id}を設置する`, facilityId: id }));
    if (tile.facility) buttons.push({ text: "§c施設を削除する", facilityId: "__remove__" });
    buttons.push({ text: "戻る", facilityId: "__back__" });

    const form = new ActionFormData().title("[Facility] 施設を編集").body(`§7現在: ${tile.facility?.label ?? "なし"}`);
    for (const b of buttons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const picked = buttons[res.selection];
    if (picked.facilityId === "__back__") { await openDebugTileMenu(realPlayer, tx, tz); return; }

    if (picked.facilityId === "__remove__") {
        tile.facility = null;
    } else {
        const def = getFacilityDef(picked.facilityId);
        tile.facility = { id: picked.facilityId, label: def?.label ?? picked.facilityId, ownerId: tile.ownerId, ownerName: tile.ownerName };
    }
    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の施設を更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: マスの区域(district)を、通常の建設条件を無視して直接配置/削除する。 */
async function openDebugDistrictMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile) { await openMainMenu(realPlayer); return; }

    const districtIds = getDistrictIds();
    const buttons = districtIds.map(id => ({ text: `${getDistrictDef(id)?.icon ?? ""} ${getDistrictDef(id)?.label ?? id}を配置する`, districtId: id }));
    if (tile.district || tile.underDistrictConstruction) buttons.push({ text: "§c区域を削除する", districtId: "__remove__" });
    buttons.push({ text: "戻る", districtId: "__back__" });

    const form = new ActionFormData().title("[District] 区域を編集").body(`§7現在: ${tile.district?.label ?? (tile.underDistrictConstruction ? "建設中" : "なし")}`);
    for (const b of buttons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const picked = buttons[res.selection];
    if (picked.districtId === "__back__") { await openDebugTileMenu(realPlayer, tx, tz); return; }

    if (picked.districtId === "__remove__") {
        tile.district = null;
        delete tile.underDistrictConstruction;
    } else {
        const def = getDistrictDef(picked.districtId);
        tile.district = { id: picked.districtId, label: def?.label ?? picked.districtId, ownerId: tile.ownerId, ownerName: tile.ownerName };
        delete tile.underDistrictConstruction;
    }
    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の区域を更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: マスの戦闘ユニット(combatUnit)を自由なパラメータで配置/編集/削除する。 */
async function openDebugCombatUnitMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile) { await openMainMenu(realPlayer); return; }
    const unit = tile.combatUnit;

    const actionButtons = [{ text: unit ? "[Edit] 編集する" : "[Add] 配置する", act: "edit" }];
    if (unit) actionButtons.push({ text: "§c削除する", act: "remove" });
    actionButtons.push({ text: "戻る", act: "back" });

    const form = new ActionFormData().title("[Combat] 戦闘ユニットを編集")
        .body(`§7現在: ${unit ? `${unit.label} (HP:${Math.round(unit.hp ?? 0)}/${unit.maxHp ?? 100} 戦闘力:${unit.combatStrength ?? 0} 所有:${unit.ownerName})` : "なし"}`);
    for (const b of actionButtons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openDebugTileMenu(realPlayer, tx, tz); return; }
    const act = actionButtons[res.selection]?.act;

    if (act === "back") { await openDebugTileMenu(realPlayer, tx, tz); return; }
    if (act === "remove") {
        tile.combatUnit = null;
        setTiles(tiles);
        refreshUnitLabelAt(tx, tz);
        realPlayer.sendMessage(`§a(${tx}, ${tz}) の戦闘ユニットを削除しました。`);
        await openDebugTileMenu(realPlayer, tx, tz);
        return;
    }

    const turn = getTurnState();
    const civIds = Array.isArray(turn.playerOrder) ? turn.playerOrder : [];
    const ownerCivId = unit?.ownerId ?? tile.ownerId ?? civIds[0] ?? null;
    const ownerNames = civIds.map(id => resolveCivName(id) ?? id);
    const domainOptions = ["land", "naval"];

    const modal = new ModalFormData()
        .title("[Combat] 戦闘ユニットを配置/編集")
        .textField("ラベル", "例: 戦士", { defaultValue: unit?.label ?? "戦士" })
        .dropdown("所属国家", ownerNames.length ? ownerNames : ["(参加国家なし)"], { defaultValueIndex: Math.max(0, civIds.indexOf(ownerCivId)) })
        .dropdown("兵科", ["陸軍", "海軍"], { defaultValueIndex: unit?.domain === "naval" ? 1 : 0 })
        .textField("HP", "例: 100", { defaultValue: String(unit?.hp ?? 100) })
        .textField("最大HP (maxHp)", "例: 100", { defaultValue: String(unit?.maxHp ?? 100) })
        .textField("戦闘力 (combatStrength)", "例: 20", { defaultValue: String(unit?.combatStrength ?? 20) })
        .textField("移動力 (movement)", "例: 1", { defaultValue: String(unit?.movement ?? 1) })
        .textField("残り移動力 (movementRemaining)", "例: 1", { defaultValue: String(unit?.movementRemaining ?? unit?.movement ?? 1) })
        .textField("攻撃距離 (attackRange)", "例: 1", { defaultValue: String(unit?.attackRange ?? 1) });

    const modalRes = await modal.show(realPlayer);
    if (modalRes.canceled) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const [label, ownerIndex, domainIndex, hpStr, maxHpStr, strStr, moveStr, moveRemStr, rangeStr] = modalRes.formValues;
    const newOwnerId = civIds.length ? (civIds[ownerIndex] ?? ownerCivId) : ownerCivId;

    tile.combatUnit = {
        ...(unit ?? {}),
        id: unit?.id ?? "custom",
        label: label?.trim() || (unit?.label ?? "戦士"),
        ownerId: newOwnerId,
        ownerName: resolveCivName(newOwnerId) ?? newOwnerId,
        domain: domainOptions[domainIndex] ?? "land",
        hp: Number(hpStr) || 0,
        maxHp: Number(maxHpStr) || 100,
        combatStrength: Number(strStr) || 0,
        movement: Number(moveStr) || 0,
        movementRemaining: Number(moveRemStr) || 0,
        attackRange: Number(rangeStr) || 1,
    };

    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の戦闘ユニットを更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: マスの宗教ユニット(religiousUnit)を自由なパラメータで配置/編集/削除する。 */
async function openDebugReligiousUnitMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile) { await openMainMenu(realPlayer); return; }
    const unit = tile.religiousUnit;

    const actionButtons = [{ text: unit ? "[Edit] 編集する" : "[Add] 配置する", act: "edit" }];
    if (unit) actionButtons.push({ text: "§c削除する", act: "remove" });
    actionButtons.push({ text: "戻る", act: "back" });

    const form = new ActionFormData().title("[Faith] 宗教ユニットを編集")
        .body(`§7現在: ${unit ? `${unit.label} (HP:${Math.round(unit.hp ?? 0)}/${unit.maxHp ?? 100}) 所有:${unit.ownerName}` : "なし"}`);
    for (const b of actionButtons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openDebugTileMenu(realPlayer, tx, tz); return; }
    const act = actionButtons[res.selection]?.act;

    if (act === "back") { await openDebugTileMenu(realPlayer, tx, tz); return; }
    if (act === "remove") {
        tile.religiousUnit = null;
        setTiles(tiles);
        refreshUnitLabelAt(tx, tz);
        realPlayer.sendMessage(`§a(${tx}, ${tz}) の宗教ユニットを削除しました。`);
        await openDebugTileMenu(realPlayer, tx, tz);
        return;
    }

    const turn = getTurnState();
    const civIds = Array.isArray(turn.playerOrder) ? turn.playerOrder : [];
    const ownerCivId = unit?.ownerId ?? tile.ownerId ?? civIds[0] ?? null;
    const ownerNames = civIds.map(id => resolveCivName(id) ?? id);

    const modal = new ModalFormData()
        .title("[Faith] 宗教ユニットを配置/編集")
        .textField("ラベル", "例: 伝道者", { defaultValue: unit?.label ?? "伝道者" })
        .dropdown("所属国家", ownerNames.length ? ownerNames : ["(参加国家なし)"], { defaultValueIndex: Math.max(0, civIds.indexOf(ownerCivId)) })
        .textField("HP", "例: 100", { defaultValue: String(unit?.hp ?? 100) })
        .textField("最大HP (maxHp)", "例: 100", { defaultValue: String(unit?.maxHp ?? 100) })
        .textField("宗教戦闘力 (religiousCombatStrength)", "例: 100", { defaultValue: String(unit?.religiousCombatStrength ?? 100) })
        .textField("移動力 (movement)", "例: 4", { defaultValue: String(unit?.movement ?? 4) })
        .textField("残り移動力 (movementRemaining)", "例: 4", { defaultValue: String(unit?.movementRemaining ?? unit?.movement ?? 4) })
        .textField("布教力 (evangelismPower)", "例: 3", { defaultValue: String(unit?.evangelismPower ?? 3) });

    const modalRes = await modal.show(realPlayer);
    if (modalRes.canceled) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const [label, ownerIndex, hpStr, maxHpStr, strStr, moveStr, moveRemStr, evangelismStr] = modalRes.formValues;
    const newOwnerId = civIds.length ? (civIds[ownerIndex] ?? ownerCivId) : ownerCivId;

    tile.religiousUnit = {
        ...(unit ?? {}),
        id: unit?.id ?? "missionary",
        label: label?.trim() || (unit?.label ?? "伝道者"),
        ownerId: newOwnerId,
        ownerName: resolveCivName(newOwnerId) ?? newOwnerId,
        hp: Number(hpStr) || 0,
        maxHp: Number(maxHpStr) || 100,
        religiousCombatStrength: Number(strStr) || 0,
        movement: Number(moveStr) || 0,
        movementRemaining: Number(moveRemStr) || 0,
        evangelismPower: Number(evangelismStr) || 0,
        hasProselytizedThisTurn: unit?.hasProselytizedThisTurn ?? false,
    };

    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の宗教ユニットを更新しました。`);
    await openDebugTileMenu(realPlayer, tx, tz);
}

/** デバッグ: この都市の宗教的圧力(city.religiousPressure)を国家ごとに直接書き換える。 */
async function openDebugPressureMenu(realPlayer, tx, tz) {
    const tiles = getTiles();
    const tile = tiles[`${tx},${tz}`];
    if (!tile?.city) { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const turn = getTurnState();
    const civIds = Array.isArray(turn.playerOrder) ? turn.playerOrder : [];
    if (!civIds.length) { realPlayer.sendMessage("§c参加国家がいません。"); await openDebugTileMenu(realPlayer, tx, tz); return; }

    const pressures = tile.city.religiousPressure ?? {};
    const civButtons = civIds.map(id => ({ text: `${resolveCivName(id) ?? id} §7(現在: ${Math.floor(pressures[id] ?? 0)})`, civId: id }));
    civButtons.push({ text: "戻る", civId: "__back__" });

    const form = new ActionFormData().title("[Religion] 宗教的圧力を編集").body("§7値を設定する国家を選んでください(0にすると削除されます)。");
    for (const b of civButtons) form.button(b.text);
    const res = await form.show(realPlayer);
    if (res.canceled || res.selection === undefined) { await openDebugTileMenu(realPlayer, tx, tz); return; }
    const picked = civButtons[res.selection];
    if (picked.civId === "__back__") { await openDebugTileMenu(realPlayer, tx, tz); return; }

    const modal = new ModalFormData()
        .title(`[Religion] ${resolveCivName(picked.civId) ?? picked.civId} の宗教的圧力`)
        .textField("圧力値", "例: 100", { defaultValue: String(pressures[picked.civId] ?? 0) });
    const modalRes = await modal.show(realPlayer);
    if (modalRes.canceled) { await openDebugPressureMenu(realPlayer, tx, tz); return; }

    const value = Number(modalRes.formValues[0]);
    if (!tile.city.religiousPressure) tile.city.religiousPressure = {};
    if (Number.isFinite(value) && value > 0) tile.city.religiousPressure[picked.civId] = value;
    else delete tile.city.religiousPressure[picked.civId];

    setTiles(tiles);
    realPlayer.sendMessage(`§a(${tx}, ${tz}) の宗教的圧力を更新しました。`);
    await openDebugPressureMenu(realPlayer, tx, tz);
}

/**
 * 💡 生産メニュー(トップ) — ユニット / 建造物 のカテゴリ選択。
 *    カテゴリ内のボタンは全て PRODUCTION_DEFS から自動生成するため、
 *    新しい生産物を増やしてもこのファイルは変更不要。
 */
async function openProductionMenu(player, tx, tz) {
    const form = new ActionFormData()
        .title("[Production] 生産メニュー")
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
            buttons.push({ text: `§c[Stop] ${activeDef.label}の生産を中止する`, action: "cancel" });
        } else {
            body.push(`\n§7(他の生産【${activeDef.icon}${activeDef.label}】が進行中のため、この都市は今生産を開始できません)`);
        }
    }

    // 💡 このカテゴリに属する生産物を列挙し、開始可能な物だけボタンを出す
    if (!city.production) {
        for (const id of Object.keys(PRODUCTION_DEFS)) {
            const def = PRODUCTION_DEFS[id];
            if (def.category !== category) continue;

            const check = canStartProduction(city, id, tile, player);
            if (!check.ok) {
                if (def.uniquePerCity && def.hasBuilt?.(city)) {
                    body.push(`§7${def.icon} ${def.label}: 建設済み`);
                } else if (def.requiresTechnology && !hasCompletedProgress(player, "technology", def.requiresTechnology)) {
                    const techDef = getDefinition("technology", def.requiresTechnology);
                    body.push(`§7[Locked] ${def.icon} ${def.label}: 技術【${techDef?.label ?? def.requiresTechnology}】が必要`);
                } else if (def.requiresCivic && !hasCompletedProgress(player, "civic", def.requiresCivic)) {
                    const civicDef = getDefinition("civic", def.requiresCivic);
                    body.push(`§7[Locked] ${def.icon} ${def.label}: 社会制度【${civicDef?.label ?? def.requiresCivic}】が必要`);
                } else if (def.disallowInCapital && city.isCapital) {
                    body.push(`§7${def.icon} ${def.label}: この都市は既に首都です`);
                }
                continue;
            }

            const estTurns = production > 0 ? Math.ceil(def.cost / production) : "--";
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
 * 🏗️ 施設の設置メニュー。生産キューを使わず、労働者の行動回数を消費して即座に設置する。
 * (production.js の建造物と違い、都市のマスではなく「今立っている空き領有マス」が対象)
 */
async function openFacilityInstallMenu(player, tx, tz) {
    const tile = getTile(tx, tz);
    if (!tile) { await openMainMenu(player); return; }

    const body = [`(${tx}, ${tz}) に設置する施設を選んでください。`, "§7設置には帰属都市の労働者の行動回数を1消費します。"];
    const items = [];

    for (const id of getFacilityIds()) {
        const def = getFacilityDef(id);
        const check = canInstallFacility(tile, id, player.id, player);
        if (!check.ok) {
            if (def.requiresTechnology && !hasCompletedProgress(player, "technology", def.requiresTechnology)) {
                const techDef = getDefinition("technology", def.requiresTechnology);
                body.push(`§7[Locked] ${def.icon} ${def.label}: 技術【${techDef?.label ?? def.requiresTechnology}】が必要`);
            } else if (def.requiresCivic && !hasCompletedProgress(player, "civic", def.requiresCivic)) {
                const civicDef = getDefinition("civic", def.requiresCivic);
                body.push(`§7[Locked] ${def.icon} ${def.label}: 社会制度【${civicDef?.label ?? def.requiresCivic}】が必要`);
            } else if (def.requiresResource) {
                body.push(`§7${def.icon} ${def.label}: ${check.message}`);
            }
            continue;
        }
        items.push({ text: `${def.icon} ${def.label}`, action: id });
    }

    if (items.length === 0) body.push("§7現在設置できる施設がありません。");

    await showPaginatedMenu(
        getRealPlayer(player),
        "[Facility] 施設を設置",
        body.join("\n"),
        items,
        async (facilityId) => {
            (await import("./commands.js")).cmdInstallFacility(player, facilityId);
        },
        async () => { await openMainMenu(player); },
    );
}

/**
 * 🏛️ 区域の配置(建設開始)メニュー。都市の生産力を複数ターンかけて使う
 * (施設と違い、その場では完成しない)。
 */
async function openDistrictStartMenu(player, tx, tz) {
    const tile = getTile(tx, tz);
    if (!tile) { await openMainMenu(player); return; }

    // 💡 帰属先都市を探す(既に建設中の区域が無いかの判定に必要)
    const allTiles = getTiles();
    const cityKey = resolveOwningCityKey(tx, tz, tile, player.id, allTiles);
    const city = cityKey ? allTiles[cityKey]?.city : null;

    const body = [`(${tx}, ${tz}) に建設する区域を選んでください。`, "§7建設には帰属都市の生産力を複数ターンかけて使います。"];
    if (city?.districtConstruction) {
        const def = getDistrictDef(city.districtConstruction.id);
        body.push(`§7(帰属都市は既に【${def?.label ?? city.districtConstruction.id}】を建設中のため、新しい区域は開始できません)`);
    }
    const items = [];

    for (const id of getDistrictIds()) {
        const def = getDistrictDef(id);
        const check = canStartDistrict(tile, id, player.id, city, player, allTiles, cityKey);
        if (!check.ok) {
            if (def.requiresTechnology && !hasCompletedProgress(player, "technology", def.requiresTechnology)) {
                const techDef = getDefinition("technology", def.requiresTechnology);
                body.push(`§7[Locked] ${def.icon} ${def.label}: 技術【${techDef?.label ?? def.requiresTechnology}】が必要`);
            } else if (def.requiresCivic && !hasCompletedProgress(player, "civic", def.requiresCivic)) {
                const civicDef = getDefinition("civic", def.requiresCivic);
                body.push(`§7[Locked] ${def.icon} ${def.label}: 社会制度【${civicDef?.label ?? def.requiresCivic}】が必要`);
            } else if (cityKey && hasCityDistrict(cityKey, id, allTiles)) {
                body.push(`§7[Built] ${def.icon} ${def.label}: 帰属都市に既に存在します(1都市につき1つまで)`);
            }
            continue;
        }
        items.push({ text: `${def.icon} ${def.label} (コスト:${def.cost})`, action: id });
    }

    if (items.length === 0) body.push("§7現在建設できる区域がありません。");

    await showPaginatedMenu(
        getRealPlayer(player),
        "[District] 区域を配置",
        body.join("\n"),
        items,
        async (districtId) => {
            (await import("./commands.js")).cmdStartDistrict(player, districtId);
        },
        async () => { await openMainMenu(player); },
    );
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
        const effectText = def.effect ? ` - ${def.effect}` : "";
        // 💡 前提条件・ロック中に不足している項目名を、IDのままではなく表示名で出す
        //    (前提条件・効果がメニューから見えないという問題への対応)。
        const prereqLabels = (def.prerequisites ?? []).map(pid => defs[pid]?.label ?? pid);

        if (state.completed.includes(id)) {
            buttons.push({ text: `§a[Done] ${def.label} (取得済み)${effectText}`, action: null });
        } else if (state.activeId === id) {
            buttons.push({ text: `§e[Pending] ${def.label} (${state.progress}/${def.cost})${effectText}`, action: null });
        } else {
            const missingLabels = (def.prerequisites ?? [])
                .filter(prerequisite => !state.completed.includes(prerequisite))
                .map(pid => defs[pid]?.label ?? pid);
            const locked = missingLabels.length > 0;
            const prereqText = prereqLabels.length > 0 ? ` (前提: ${prereqLabels.join("・")})` : "";
            buttons.push({
                text: locked
                    ? `§8[Locked] ${def.label} (要: ${missingLabels.join("・")})${effectText}`
                    : `§f${def.label} (必要${getPointsLabel(kind)}: ${def.cost})${prereqText}${effectText}`,
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
        .title("[Diplomacy] 外交メニュー")
        .body(`自国: ${myCiv.name}\n届いている外交提案: ${requests.length} 件`);

    // 1. 届いた提案の確認ボタン
    if (requests.length > 0) {
        form.button(`[Request] 届いた提案を確認する (${requests.length}件)`);
    } else {
        form.button("[Request] 届いた提案はありません (0)");
    }

    // 2. 自分以外の他国一覧ボタン
    const otherCivs = civList.filter(c => c && c.id !== myCiv.id);
    otherCivs.forEach(civ => {
        const rel = getRelation(myCiv, civ.id);
        let statusTag = "【関係なし】";
        if (rel === "pact") statusTag = "【[Pact] 不可侵条約】";
        if (rel === "alliance") statusTag = "【[Alliance] 同盟】";
        if (rel === "war") statusTag = "§4【[War] 戦争中】§r";

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
        .title("[Request] 届いた外交提案")
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
            .button1("拒否する")
            .button2("承認する")
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
    //    さらに、試合の設定(§18参照)で不可侵条約・同盟そのものが無効化されている場合は
    //    civic条件を満たしていても提案できない。
    const diplomacyEnabled = getMatchSettings().diplomacyEnabled;
    const canProposePact = diplomacyEnabled && hasCompletedProgress(player, "civic", "emissaries");
    const canProposeAlliance = diplomacyEnabled && hasCompletedProgress(player, "civic", "diplomacy");

    let relText = "関係なし";
    if (currentRel === "pact") relText = "不可侵条約 締結中";
    if (currentRel === "alliance") relText = "同盟 締結中";
    if (currentRel === "war") relText = "§4戦争中§r";

    const body = [`対象国: ${targetCiv.name}`, `現在の関係: ${relText}`];
    if (currentRel === "none") {
        body.push("§7※「関係なし」の相手の領土にはユニットが進入できません。攻撃・都市の占領にも宣戦布告が必要です。");
    }
    if (!diplomacyEnabled) {
        body.push("§7※この試合では不可侵条約・同盟が無効に設定されています(新規提案不可)");
    } else {
        if (!canProposePact) body.push("§7※不可侵条約の提案には社会制度「使節団」の取得が必要です");
        if (!canProposeAlliance) body.push("§7※同盟の提案には社会制度「外交」の取得が必要です");
    }

    const buttons = [];
    if (currentRel === "none") {
        if (canProposePact) buttons.push({ text: "[Pact] 不可侵条約を提案する", action: "proposePact" });
        if (canProposeAlliance) buttons.push({ text: "[Alliance] 同盟を提案する", action: "proposeAlliance" });
    } else if (currentRel === "pact") {
        if (canProposeAlliance) buttons.push({ text: "[Alliance] 同盟を提案する", action: "proposeAlliance" });
        buttons.push({ text: "[Break] 不可侵条約を破棄する", action: "break" });
    } else if (currentRel === "alliance") {
        buttons.push({ text: "[Break] 同盟を解消する", action: "break" });
    }
    if (currentRel === "war") {
        buttons.push({ text: "§a[Peace] 講和する(戦争を終了する)", action: "break" });
    } else {
        buttons.push({ text: "§4[War] 宣戦布告する", action: "declareWar" });
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
        if (selected === "declareWar") confirmDeclareWar(player, targetCiv);
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

/** 関係破棄(講和を含む)の確認ダイアログ */
function confirmBreakRelation(player, targetCiv) {
    const realPlayer = getRealPlayer(player);
    const currentRel = getRelation(player, targetCiv.id);
    const isWar = currentRel === "war";
    const typeLabel = currentRel === "pact" ? "不可侵条約" : currentRel === "alliance" ? "同盟" : "戦争";
    const actionLabel = isWar ? "講和" : "解消・破棄";

    new MessageFormData()
        .title(`確認: ${isWar ? "講和" : `${typeLabel}の解消`}`)
        .body(`本当に【${targetCiv.name}】と${isWar ? "講和し、戦争を終了" : `の【${typeLabel}】を解消・破棄`}しますか？\nこの操作は即座に反映されます。`)
        .button1("キャンセル")
        .button2(`${actionLabel}する`)
        .show(realPlayer)
        .then(res => {
            if (res.selection === 1) {
                const result = breakRelation(player, targetCiv);
                player.sendMessage(result.message);
            }
        });
}

/** 宣戦布告の確認ダイアログ。宣戦布告は相手の承諾を必要とせず、確認後に即座に成立する。 */
function confirmDeclareWar(player, targetCiv) {
    const realPlayer = getRealPlayer(player);

    new MessageFormData()
        .title(`確認: 宣戦布告`)
        .body(`本当に【${targetCiv.name}】に宣戦布告しますか？\n結んでいる不可侵条約・同盟があれば同時に破棄されます。\nこの操作は相手の承諾を必要とせず、即座に成立します。`)
        .button1("キャンセル")
        .button2("宣戦布告する")
        .show(realPlayer)
        .then(res => {
            if (res.selection === 1) {
                const result = declareWar(player, targetCiv);
                if (result.ok) broadcast(result.message);
                else player.sendMessage(result.message);
            }
        });
}

/** 1ページあたりの選択肢の最大数。ボタンが多すぎるとフォームを開く際に重くなる(数秒固まる)ため制限する。 */
const MENU_PAGE_SIZE = 10;

/**
 * 選択肢の数が多くなりうるメニューを、ページ分割して表示する汎用ヘルパー。
 * 1画面あたりのボタン数を MENU_PAGE_SIZE 件までに抑えることで、フォームを開く際の
 * 重さ・数秒間の固まりを軽減する。
 * @param {any} realPlayer .show() に渡す実プレイヤー本体
 * @param {string} title フォームのタイトル
 * @param {string} bodyText フォーム本文(ページ情報は自動で末尾に付与される)
 * @param {{text: string, action: any}[]} items 選択肢の一覧(ページ分割される対象)
 * @param {(action: any) => (void|Promise<void>)} onSelect 項目が選ばれた時の処理
 * @param {() => (void|Promise<void>)} onBack 「戻る」が選ばれた時の処理
 * @param {number} [page] 表示するページ番号(0始まり)
 */
async function showPaginatedMenu(realPlayer, title, bodyText, items, onSelect, onBack, page = 0) {
    const totalPages = Math.max(1, Math.ceil(items.length / MENU_PAGE_SIZE));
    const currentPage = Math.max(0, Math.min(page, totalPages - 1));
    const start = currentPage * MENU_PAGE_SIZE;
    const pageItems = items.slice(start, start + MENU_PAGE_SIZE);

    const buttons = pageItems.map(item => ({ kind: "item", text: item.text, action: item.action }));
    if (currentPage > 0) buttons.push({ kind: "prev", text: "§b< 前のページ" });
    if (currentPage < totalPages - 1) buttons.push({ kind: "next", text: "§b次のページ >" });
    buttons.push({ kind: "back", text: "戻る" });

    const pageInfo = totalPages > 1 ? `\n§7(${currentPage + 1}/${totalPages}ページ, 全${items.length}件)` : "";
    const form = new ActionFormData().title(title).body(`${bodyText}${pageInfo}`);
    for (const btn of buttons) form.button(btn.text);

    const result = await form.show(realPlayer);
    if (result.canceled || result.selection === undefined) return;

    const selected = buttons[result.selection];
    if (selected.kind === "item") {
        await onSelect(selected.action);
    } else if (selected.kind === "next") {
        await showPaginatedMenu(realPlayer, title, bodyText, items, onSelect, onBack, currentPage + 1);
    } else if (selected.kind === "prev") {
        await showPaginatedMenu(realPlayer, title, bodyText, items, onSelect, onBack, currentPage - 1);
    } else {
        await onBack();
    }
}

/** 現在位置の戦闘ユニットが移動できるマスを一覧表示する。 */
async function openCombatUnitMoveMenu(player, fromTx, fromTz) {
    const source = getTile(fromTx, fromTz);
    const unit = source?.combatUnit;
    if (!unit || unit.ownerId !== player.id) return;

    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    const items = [];
    const body = [`${unit.label ?? "戦闘ユニット"}  HP: ${unit.hp ?? 0}/${unit.maxHp ?? 100}  戦闘力: ${getEffectiveCombatStrength(unit)}(基本${unit.combatStrength ?? 0})`, `残り移動力: ${remaining}`];
    const config = getMapConfig();
    const tiles = getTiles();

    // 💡 新機能: プレイヤーが今実際に立っているマスへワンタップで移動できる特別な選択肢。
    //    移動先の候補を毎回一覧からスクロールして探さなくても、目的地まで歩いてメニューを
    //    開くだけで移動できる(cmdClaim/cmdSettleと同じ「足元を対象にする」操作感)。
    if (remaining > 0 && config) {
        const { tx: standTx, tz: standTz } = worldToTile(config, Math.floor(player.location.x), Math.floor(player.location.z));
        if (standTx !== fromTx || standTz !== fromTz) {
            const standDistance = Math.max(Math.abs(standTx - fromTx), Math.abs(standTz - fromTz));
            const standTile = tiles[`${standTx},${standTz}`];
            const canStandMove = standDistance >= 1 && standDistance <= remaining
                && standTx >= 0 && standTz >= 0 && standTx < config.width && standTz < config.height
                && standTile && !standTile.combatUnit && canUnitEnterTile(unit, standTile)
                && canTravelPath(unit, fromTx, fromTz, standTx, standTz, tiles);
            if (canStandMove) {
                const cityText = standTile.city ? ` | 都市: ${standTile.city.name}` : "";
                items.push({ text: `§a[Here] 今いる場所へ移動 (${standTx}, ${standTz})${cityText}`, action: { tx: standTx, tz: standTz } });
            }
        }
    }

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
                if (!canUnitEnterTile(unit, tile)) continue;
                if (!canTravelPath(unit, fromTx, fromTz, tx, tz, tiles)) continue;
                const cityText = tile.city
                    ? ` | 都市: ${tile.city.name} (人口:${tile.city.population}/${tile.city.housing})`
                    : "";
                items.push({ text: `(${tx}, ${tz})${cityText}`, action: { tx, tz } });
            }
        }
    } else {
        body.push("§7移動力が残っていません。次の自分のターン開始時に回復します。");
    }

    if (items.length === 0 && remaining > 0) body.push("§7移動可能なマスがありません。");

    await showPaginatedMenu(
        getRealPlayer(player),
        "[Warrior] 移動",
        body.join("\n"),
        items,
        async (action) => {
            (await import("./commands.js")).cmdMoveCombatUnit(player, fromTx, fromTz, action.tx, action.tz);
        },
        async () => { await openMainMenu(player); },
    );
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
    const items = [];
    const body = [
        `${unit.label ?? "戦闘ユニット"}  HP: ${unit.hp ?? 0}/${unit.maxHp ?? 100}  戦闘力: ${getEffectiveCombatStrength(unit)}(基本${unit.combatStrength ?? 0})`,
        `攻撃距離: ${range} | 残り移動力: ${remaining}`,
    ];
    const config = getMapConfig();
    const tiles = getTiles();

    if (remaining > 0) {
        // 💡 攻撃できるのは宣戦布告済み(戦争状態)の相手のみ。hasAgreementFnは「除外する」述語なので、
        //    戦争状態でない相手を除外する形で渡す。
        const attackTargets = getAttackableTargets(fromTx, fromTz, player.id, unit, tiles, config, (a, b) => !isAtWar(a, b));
        for (const t of attackTargets) {
            const enemyUnit = t.unit;
            const cityText = t.tile.city ? ` | 都市: ${t.tile.city.name}` : "";
            items.push({
                text: `[Combat] (${t.tx}, ${t.tz}) | ${enemyUnit.label ?? enemyUnit.id} HP:${Math.max(0, Math.round(enemyUnit.hp ?? 0))}/${enemyUnit.maxHp ?? 100} 戦闘力:${getEffectiveCombatStrength(enemyUnit)}${cityText}`,
                action: { tx: t.tx, tz: t.tz },
            });
        }
    } else {
        body.push("§7移動力が残っていないため攻撃できません。次の自分のターン開始時に回復します。");
    }

    if (items.length === 0 && remaining > 0) body.push("§7攻撃可能な対象(攻撃距離内の敵ユニット)がありません。");

    await showPaginatedMenu(
        getRealPlayer(player),
        "[Warrior] 攻撃",
        body.join("\n"),
        items,
        async (action) => {
            (await import("./commands.js")).cmdAttackCombatUnit(player, fromTx, fromTz, action.tx, action.tz);
        },
        async () => { await openMainMenu(player); },
    );
}

/**
 * ⚔ 自分が所有する戦闘ユニットの一覧を表示する。
 * マップ上のどこにいても、ここから直接そのユニットの移動・攻撃メニューを開ける
 * (移動・攻撃コマンド自体が座標指定式で、その場にいる必要が無いため)。
 */
async function openMyUnitsMenu(player) {
    const config = getMapConfig();
    const tiles = config ? getTiles() : {};

    const myUnits = [];
    for (const key in tiles) {
        const tile = tiles[key];
        if (tile.combatUnit && tile.combatUnit.ownerId === player.id) {
            const [txStr, tzStr] = key.split(",");
            myUnits.push({ tx: Number(txStr), tz: Number(tzStr), unit: tile.combatUnit, tile });
        }
    }

    const body = [`§f保有している戦闘ユニット: §b${myUnits.length} 体`];
    const items = [];

    for (const entry of myUnits) {
        const unit = entry.unit;
        const strengthText = isRangedUnit(unit)
            ? `遠距離${getEffectiveRangedStrength(unit)}/近距離${getEffectiveCombatStrength(unit)}`
            : `${getEffectiveCombatStrength(unit)}`;
        const remaining = unit.movementRemaining ?? unit.movement ?? 0;
        const cityText = entry.tile.city ? ` | [City]${entry.tile.city.name}` : "";
        items.push({
            text: `${unit.label ?? unit.id} (${entry.tx},${entry.tz}) HP:${Math.max(0, Math.round(unit.hp ?? 0))}/${unit.maxHp ?? 100} 戦闘力:${strengthText} 移動:${remaining}/${unit.movement ?? 0}${cityText}`,
            action: { tx: entry.tx, tz: entry.tz },
        });
    }

    if (myUnits.length === 0) body.push("§7現在、戦闘ユニットを保有していません。");

    await showPaginatedMenu(
        getRealPlayer(player),
        "[Combat] 自分の戦闘ユニット一覧",
        body.join("\n"),
        items,
        async (action) => { await openUnitActionMenu(player, action.tx, action.tz); },
        async () => { await openMainMenu(player); },
    );
}

/** 一覧から選んだユニットに対して「移動 / 攻撃」を選べる小さなアクションメニュー。 */
async function openUnitActionMenu(player, tx, tz) {
    const tile = getTile(tx, tz);
    const unit = tile?.combatUnit;
    if (!unit || unit.ownerId !== player.id) { await openMyUnitsMenu(player); return; }

    const strengthText = isRangedUnit(unit)
        ? `遠距離${getEffectiveRangedStrength(unit)}(基本${unit.rangedCombatStrength ?? unit.combatStrength ?? 0})/近距離${getEffectiveCombatStrength(unit)}(基本${unit.meleeCombatStrength ?? unit.combatStrength ?? 0})`
        : `${getEffectiveCombatStrength(unit)}(基本${unit.combatStrength ?? 0})`;
    const remaining = unit.movementRemaining ?? unit.movement ?? 0;

    const body = [
        `${unit.label ?? unit.id}  位置: (${tx}, ${tz})`,
        `HP: ${Math.max(0, Math.round(unit.hp ?? 0))}/${unit.maxHp ?? 100}  戦闘力: ${strengthText}`,
        `攻撃距離: ${getAttackRange(unit)} | 残り移動力: ${remaining}/${unit.movement ?? 0}`,
    ];

    const buttons = [
        { text: "§f 移動", action: "move" },
        { text: "§c[Combat] 攻撃", action: "attack" },
        { text: "戻る", action: null },
    ];

    const form = new ActionFormData().title(unit.label ?? "戦闘ユニット").body(body.join("\n"));
    for (const btn of buttons) form.button(btn.text);
    const result = await form.show(getRealPlayer(player));
    if (result.canceled || result.selection === undefined) return;
    const action = buttons[result.selection]?.action;

    if (action === "move") await openCombatUnitMoveMenu(player, tx, tz);
    else if (action === "attack") await openCombatUnitAttackMenu(player, tx, tz);
    else await openMyUnitsMenu(player);
}

/**
 * ⛪ 宗教メニュー。
 * ・未創始: 国家全体の信仰力の進捗(現在値/100)と、聖地の有無を表示。条件を満たせば創始できる。
 * ・創始済み: 宗教名の表示・変更、国家の宗教状況(自国の宗教が国家主流かどうか)を表示。
 */
async function openReligionMenu(player) {
    const realPlayer = getRealPlayer(player);
    const allTiles = getTiles();
    const playerCities = [];
    for (const key in allTiles) {
        if (allTiles[key].ownerId === player.id && allTiles[key].city) {
            playerCities.push({ key, tile: allTiles[key] });
        }
    }

    if (!hasFoundedReligion(player)) {
        const totalFaith = getTotalCivFaith(playerCities);
        const hasSacredSite = Object.values(allTiles).some(t => isSacredSiteTile(t, player.id));
        const check = canFoundReligion(player, player.id, playerCities, allTiles);

        const body = [
            `§f国家全体の信仰力: §d[Faith] ${Math.floor(totalFaith)} / 100`,
            `§f聖地: ${hasSacredSite ? "§aあり" : "§cなし"}`,
        ];
        if (!check.ok) body.push(`§7${check.message}`);

        const buttons = [];
        if (check.ok) buttons.push({ text: "[Religion] 宗教を創始する", action: "found" });
        buttons.push({ text: "戻る", action: null });

        const form = new ActionFormData().title("[Religion] 宗教").body(body.join("\n"));
        for (const btn of buttons) form.button(btn.text);
        const result = await form.show(realPlayer);
        if (result.canceled || result.selection === undefined) return;
        const action = buttons[result.selection]?.action;

        if (action === "found") (await import("./commands.js")).cmdFoundReligion(player);
        else await openMainMenu(player);
        return;
    }

    const religionName = getReligionName(player) ?? "無名の宗教";
    const nationalReligion = getNationalDominantReligion(playerCities);
    const nationalText = nationalReligion === player.id
        ? "§a自国の宗教が国家の主流です"
        : (nationalReligion ? "§c他国の宗教が国家の主流になっています" : "§7まだどの宗教も都市の過半数を占めていません");

    const body = [
        `§f宗教名: §d${religionName}`,
        `§f国家の状況: ${nationalText}`,
        `§f保有都市: ${playerCities.length}`,
    ];

    const buttons = [
        { text: "[Rename] 宗教の名前を変更する", action: "rename" },
        { text: "戻る", action: null },
    ];

    const form = new ActionFormData().title(`[Religion] ${religionName}`).body(body.join("\n"));
    for (const btn of buttons) form.button(btn.text);
    const result = await form.show(realPlayer);
    if (result.canceled || result.selection === undefined) return;
    const action = buttons[result.selection]?.action;

    if (action === "rename") {
        const renameForm = new ModalFormData().title("宗教の名前を変更").textField("新しい名前", religionName, { defaultValue: religionName });
        const renameRes = await renameForm.show(realPlayer);
        if (!renameRes.canceled) {
            const newName = renameRes.formValues[0];
            if (newName && newName.trim() !== "") (await import("./commands.js")).cmdRenameReligion(player, newName.trim());
        }
    } else {
        await openMainMenu(player);
    }
}

/** 🏛️ 区域専用の建造物(社など)の建設メニュー。区域が完成しているマスで表示する。 */
async function openDistrictBuildingMenu(player, tx, tz) {
    const tile = getTile(tx, tz);
    if (!tile?.district) { await openMainMenu(player); return; }

    const allTiles = getTiles();
    const cityKey = tile.belongsToCityKey;
    const city = cityKey ? allTiles[cityKey]?.city : null;

    const body = [`(${tx}, ${tz}) の【${tile.district.label ?? tile.district.id}】に建設する建造物を選んでください。`, "§7建設には帰属都市の生産力を複数ターンかけて使います。"];
    const items = [];

    for (const id of getDistrictBuildingIds()) {
        const def = getDistrictBuildingDef(id);
        const check = canStartDistrictBuilding(tile, id, player.id, city, player);
        if (!check.ok) {
            if (def.requiresTechnology && !hasCompletedProgress(player, "technology", def.requiresTechnology)) {
                const techDef = getDefinition("technology", def.requiresTechnology);
                body.push(`§7[Locked] ${def.icon} ${def.label}: 技術【${techDef?.label ?? def.requiresTechnology}】が必要`);
            } else if (def.requiresCivic && !hasCompletedProgress(player, "civic", def.requiresCivic)) {
                const civicDef = getDefinition("civic", def.requiresCivic);
                body.push(`§7[Locked] ${def.icon} ${def.label}: 社会制度【${civicDef?.label ?? def.requiresCivic}】が必要`);
            } else {
                body.push(`§7${def.icon} ${def.label}: ${check.message}`);
            }
            continue;
        }
        items.push({ text: `${def.icon} ${def.label} (コスト:${def.cost})`, action: id });
    }
    if (items.length === 0) body.push("§7現在建設できる建造物がありません。");

    await showPaginatedMenu(
        getRealPlayer(player), "[District] 区域専用の建造物", body.join("\n"), items,
        async (buildingId) => { (await import("./commands.js")).cmdStartDistrictBuilding(player, buildingId); },
        async () => { await openMainMenu(player); },
    );
}

/** 🙏 都市の信仰力で宗教ユニットを購入するメニュー。社を持つ自分の都市で表示する。 */
async function openBuyReligiousUnitMenu(player, tx, tz) {
    const tile = getTile(tx, tz);
    if (!tile?.city) { await openMainMenu(player); return; }

    const body = [`【${tile.city.name}】の信仰力(${Math.floor(tile.city.faithStorage ?? 0)})で購入する宗教ユニットを選んでください。`];
    const items = [];

    for (const id of getReligiousUnitIds()) {
        const def = getReligiousUnitDef(id);
        if (def.requiresBuilding && !tile.city[def.requiresBuilding]) {
            body.push(`§7[Locked] ${def.icon} ${def.label}: 建造物が必要`);
            continue;
        }
        if (def.requiresInquisitionStarted && !hasStartedInquisition(player)) {
            body.push(`§7[Locked] ${def.icon} ${def.label}: 審問の開始が必要`);
            continue;
        }
        if (tile.religiousUnit) { body.push(`§7${def.icon} ${def.label}: このマスには既に宗教ユニットがいます`); continue; }
        const cost = getReligiousUnitCost(player, def);
        if ((tile.city.faithStorage ?? 0) < cost) { body.push(`§7${def.icon} ${def.label}: 信仰力が足りません(必要:${cost})`); continue; }
        items.push({ text: `${def.icon} ${def.label} (信仰力:${cost})`, action: id });
    }
    if (items.length === 0) body.push("§7現在購入できる宗教ユニットがありません。");

    await showPaginatedMenu(
        getRealPlayer(player), "[Faith] 宗教ユニットを購入", body.join("\n"), items,
        async (unitId) => { (await import("./commands.js")).cmdBuyReligiousUnit(player, unitId); },
        async () => { await openMainMenu(player); },
    );
}

/** 現在位置の宗教ユニットが移動できるマスを一覧表示する(戦闘ユニットの移動メニューと同型)。 */
async function openReligiousUnitMoveMenu(player, fromTx, fromTz) {
    const source = getTile(fromTx, fromTz);
    const unit = source?.religiousUnit;
    if (!unit || unit.ownerId !== player.id) { await openMainMenu(player); return; }

    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    const items = [];
    const body = [`${unit.label ?? "宗教ユニット"}  HP: ${unit.hp ?? 0}/${unit.maxHp ?? 100}  布教力: ${unit.evangelismPower ?? 0}`, `残り移動力: ${remaining}`];
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
                if (!tile || tile.religiousUnit) continue;
                items.push({ text: `(${tx}, ${tz})${tile.city ? ` | 都市: ${tile.city.name}` : ""}`, action: { tx, tz } });
            }
        }
    } else {
        body.push("§7移動力が残っていません。次の自分のターン開始時に回復します。");
    }

    await showPaginatedMenu(
        getRealPlayer(player), "[Missionary] 移動", body.join("\n"), items,
        async (action) => { (await import("./commands.js")).cmdMoveReligiousUnit(player, fromTx, fromTz, action.tx, action.tz); },
        async () => { await openMainMenu(player); },
    );
}

/** 隣接する都市への布教先を一覧表示する。 */
async function openProselytizeMenu(player, fromTx, fromTz) {
    const source = getTile(fromTx, fromTz);
    const unit = source?.religiousUnit;
    if (!unit || unit.ownerId !== player.id) { await openMainMenu(player); return; }

    const body = [`${unit.label ?? "宗教ユニット"} の布教力: ${unit.evangelismPower ?? 0}`];
    const items = [];

    if (unit.hasProselytizedThisTurn) {
        body.push("§7この宗教ユニットは今ターン既に布教しました。(1ターン1回まで。次の自分のターンで再度布教できます)");
    } else {
        const tiles = getTiles();
        for (const { tx, tz, tile } of getAdjacentTileEntries(fromTx, fromTz, tiles)) {
            if (tile.city) items.push({ text: `[Religion] (${tx}, ${tz}) | 都市: ${tile.city.name}`, action: { tx, tz } });
        }
        body.push("§7布教先の都市を選んでください(布教力を1消費します)。");
        if (items.length === 0) body.push("§7隣接する都市がありません。");
    }

    await showPaginatedMenu(
        getRealPlayer(player), "[Faith] 布教する", body.join("\n"), items,
        async (action) => { (await import("./commands.js")).cmdProselytize(player, fromTx, fromTz, action.tx, action.tz); },
        async () => { await openMainMenu(player); },
    );
}

/** 隣接する敵の宗教ユニットへの攻撃先を一覧表示する(使徒・審問官など canAttack:true のユニットのみ)。 */
async function openReligiousUnitAttackMenu(player, fromTx, fromTz) {
    const source = getTile(fromTx, fromTz);
    const unit = source?.religiousUnit;
    if (!unit || unit.ownerId !== player.id) { await openMainMenu(player); return; }

    const def = getReligiousUnitDef(unit.id);
    const body = [`${unit.label ?? "宗教ユニット"}  宗教戦闘力: ${unit.religiousCombatStrength ?? 0}`];
    const items = [];

    if (!def?.canAttack) {
        body.push("§7このユニットは敵の宗教ユニットを攻撃できません。");
    } else if (unit.hasAttackedThisTurn) {
        body.push("§7この宗教ユニットは今ターン既に攻撃しました。(1ターン1回まで)");
    } else {
        const tiles = getTiles();
        for (const { tx, tz, tile } of getAdjacentTileEntries(fromTx, fromTz, tiles)) {
            if (tile.religiousUnit && tile.religiousUnit.ownerId !== player.id) {
                const enemy = tile.religiousUnit;
                items.push({
                    text: `[Combat] (${tx}, ${tz}) | ${enemy.ownerName ?? "?"}の${enemy.label ?? "宗教ユニット"} (HP:${Math.max(0, enemy.hp ?? 0)}/${enemy.maxHp ?? 100})`,
                    action: { tx, tz },
                });
            }
        }
        body.push("§7攻撃対象を選んでください(反撃はありません)。");
        if (items.length === 0) body.push("§7隣接するマスに敵の宗教ユニットがいません。");
    }

    await showPaginatedMenu(
        getRealPlayer(player), "[Combat] 宗教ユニットで攻撃", body.join("\n"), items,
        async (action) => { (await import("./commands.js")).cmdAttackReligiousUnit(player, fromTx, fromTz, action.tx, action.tz); },
        async () => { await openMainMenu(player); },
    );
}
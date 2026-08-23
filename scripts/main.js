// main.js
// アドオンのエントリポイント。

import { world, system, ItemStack } from "@minecraft/server";
import { registerScriptCommands, registerCustomCommands } from "./commands.js";
import { openMainMenu } from "./ui.js";
import { getTurnState, getTiles, getMapConfig, getStateVersion, broadcast } from "./state.js";
import { worldToTile, TERRAIN_TYPES, RESOURCE_TYPES } from "./mapGen.js";
import { getCityCurrentYields } from "./turns.js";
import { forceEndTurnAuto } from "./bots.js";
import { PRODUCTION_DEFS, getWorkerCount } from "./production.js";
import { getDistrictDef } from "./districts.js";
import { getEffectiveCombatStrength, getEffectiveRangedStrength, isRangedUnit, getUnitClassLabel, CITY_MAX_HP, WALL_MAX_HP } from "./combat.js";
import { getActingPlayer, getActiveCivId, resolveCivName } from "./civs.js";
import { hasDiplomaticAgreement } from "./diplomacy.js";
import { syncUnitLabels } from "./unitLabels.js";

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
// 💡 カスタムスラッシュコマンド(/civ:settle など)の登録。system.beforeEvents.startup は
//    スクリプト読み込み時に同期的に購読する必要があるため、registerScriptCommands() と同様に
//    ここで直接呼び出す(イベントハンドラの中などから遅延して呼ぶと登録できない)。
registerCustomCommands();

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
    player.sendMessage("§6[Civ Tactics] §aアドオンを読み込みました。 /civ:help でコマンド一覧を表示します。");

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
        const result = forceEndTurnAuto();
        if (result.ok) {
            clearCityYieldCache();
            broadcast(`§7(${playerName} が退出したため、自動的にターンをスキップしました)`);
        }
    });
});

// ⏳ 0.5秒（10 ticks）ごとに全プレイヤーの画面表示を更新
system.runInterval(() => {
    const turn = getTurnState();
    const config = getMapConfig();
    const tiles = getTiles();

    // 💡 マスにいる戦闘ユニット(陸軍/海軍)をワールド内ラベルとして同期表示する。
    //    内部で間引き実行されるため、ここで毎tick呼んでもコストは小さい。
    syncUnitLabels();

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
            player.onScreenDisplay.setActionBar("§c[Warning] マップデータが読み込めません");
            continue;
        }

        // プレイヤーの現在地からマスの座標（tx, tz）を算出
        const pos = player.location;
        const { tx, tz } = worldToTile(config, pos.x, pos.z);
        const key = `${tx},${tz}`;
        const tile = tiles[key];

        if (tile) {
            // 💡 このプレイヤーが今操作している国家(ソロテストで仮想国家を操作中の場合はそちらのID)。
            //    自国・同盟国以外の都市については、内部管理情報(人口・生産・備蓄など)を
            //    見えないようにする(相手を偵察して有利になる情報を与えないため)。
            //    ただし、このゲームに参加していない(turn.playerOrderに含まれない)純粋な
            //    観戦者には、偵察による有利不利が生じ得ないため、この制限自体を適用しない
            //    (誰の都市でも詳細情報を見られる)。
            const viewerCivId = getActiveCivId(player);
            const viewerIsParticipant = Array.isArray(turn.playerOrder) && turn.playerOrder.includes(viewerCivId);
            const isFriendlyOwner = (ownerId) => !viewerIsParticipant || !ownerId || ownerId === viewerCivId || hasDiplomaticAgreement(viewerCivId, ownerId);

            // 地形ラベルの取得
            const terrainLabel = TERRAIN_TYPES[tile.type]?.label ?? "未知の地形";

            // 資源ラベルの取得（石油も含めて表示）
            let resourceLabel = "なし";
            if (tile.resource && RESOURCE_TYPES[tile.resource]) {
                const res = RESOURCE_TYPES[tile.resource];
                const icon = tile.resource === "oil" ? "[Oil] " : "";
                resourceLabel = `${icon}${res.label} (${res.category})`;
            }

            // 領有プレイヤー名と都市名の整形(人口は自国・同盟国の都市のみ表示)
            const ownerText = tile.ownerName ? `§a${tile.ownerName}` : "§7中立";
            // 💡 都心のHP/防壁シールドは、人口などと違い敵国の都市でも常に表示する
            //    (攻め落とせるかどうかの判断に直結する軍事情報のため。§13)。
            const cityHpText = tile.city
                ? ` §c[HP]${Math.max(0, Math.round(tile.city.hp ?? CITY_MAX_HP))}/${CITY_MAX_HP}${tile.city.wall ? ` §b[Wall]${Math.max(0, Math.round(tile.city.wallHp ?? WALL_MAX_HP))}/${WALL_MAX_HP}` : ""}`
                : "";
            const cityText = tile.city
                ? (isFriendlyOwner(tile.ownerId) ? ` §e[都市: ${tile.city.name} ([Pop]x${tile.city.population})]${cityHpText}` : ` §e[都市: ${tile.city.name}]${cityHpText}`)
                : "";
            const facilityText = tile.facility ? ` §7[施設: ${tile.facility.label ?? tile.facility.id}]` : "";
            const districtText = tile.district
                ? ` §5[区域: ${tile.district.label ?? tile.district.id}]`
                : (tile.underDistrictConstruction ? " §5[区域: 建設中...]" : "");
            const combatUnit = tile.combatUnit;
            const combatUnitText = combatUnit
                ? `§c[${combatUnit.domain === "naval" ? "Naval" : "Land"}] ${combatUnit.label ?? combatUnit.id} §7(${getUnitClassLabel(combatUnit.unitClass)})§r | HP: ${combatUnit.hp ?? 0}/${combatUnit.maxHp ?? 100} | 戦闘力: ${formatCombatStrengthText(combatUnit)} | 移動力: ${combatUnit.movementRemaining ?? combatUnit.movement ?? 0}/${combatUnit.movement ?? 0} | 攻撃距離: ${combatUnit.attackRange ?? combatUnit.movement ?? 0}`
                : "§7戦闘ユニット: なし";
            const religiousUnit = tile.religiousUnit;
            const religiousUnitText = religiousUnit
                ? `\n§d[Faith] ${religiousUnit.label ?? religiousUnit.id} | HP: ${religiousUnit.hp ?? 0}/${religiousUnit.maxHp ?? 100} | 宗教戦闘力: ${religiousUnit.religiousCombatStrength ?? 0} | 布教力: ${religiousUnit.evangelismPower ?? 0} | 移動力: ${religiousUnit.movementRemaining ?? religiousUnit.movement ?? 0}/${religiousUnit.movement ?? 0}${religiousUnit.hasProselytizedThisTurn ? " | §7(今ターン布教済み)" : ""}${religiousUnit.hasAttackedThisTurn ? " | §7(今ターン攻撃済み)" : ""}`
                : "";
            
            // 算出量の可視化 ([Food]食料 / [Prod]生産) ※マス自体が持つベース値
            const yieldText = `§a[Food]x${tile.foodYield ?? 0} §7| §6[Prod]x${tile.productionYield ?? 0}`;

            // 💡 このマスが帰属している都市（都市そのもの、または帰属先の都市）を特定
            const cityKey = tile.city ? key : tile.belongsToCityKey;
            const cityTile = cityKey ? tiles[cityKey] : null;

            let currentYieldLine = "";
            let cityInfoLine = "";

            if (cityTile && cityTile.city) {
                const c = cityTile.city;
                if (isFriendlyOwner(cityTile.ownerId)) {
                    // 💡 市民配置ロジックを考慮した「今」実際に出ている産出量
                    const yields = getCachedCityCurrentYields(cityKey, tiles);
                    const oilText = yields.oil > 0 ? ` §7| §b[Oil]x${yields.oil}` : "";
                    const ironText = yields.iron > 0 ? ` §7| §7[Iron]x${yields.iron}` : "";
                    const faithText = (yields.faith ?? 0) > 0 ? ` §7| §d[Faith]x${yields.faith}` : "";
                    currentYieldLine = `\n§f今の産出(都市全体): §a[Food]x${yields.food} §7| §6[Prod]x${yields.production}${oilText}${ironText}${faithText}`;

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
                    const faithStorageText = (c.faithStorage ?? 0) > 0 ? ` §7| §d[Faith]信仰力${c.faithStorage}` : "";
                    let districtProductionText = "";
                    if (c.districtConstruction) {
                        const districtDef = getDistrictDef(c.districtConstruction.id);
                        const districtProgressText = Math.floor(c.districtConstruction.progress * 10) / 10;
                        districtProductionText = ` §7| §5${districtDef?.icon ?? "[Sacred]"}${districtDef?.label ?? c.districtConstruction.id}区域建設中(${districtProgressText}/${c.districtConstruction.cost})`;
                    }
                    cityInfoLine = `\n§6【${c.isCapital ? "首都" : "都市"}: ${c.name}】§f 人口:§a${c.population}§f/§e${c.housing} §f| [Worker]${getWorkerCount(c)}人 §f| [Food]貯留${c.foodStorage ?? 0} §f| §c飢餓${c.starvationTurns ?? 0}/3${productionText}${tpText}${missileText}${faithStorageText}${districtProductionText}`;
                } else {
                    // 💡 自国・同盟国以外の都市は、偵察による有利化を防ぐため詳細情報を表示しない
                    //    (存在・所有者・都市名までは領有表示で分かるが、それ以上は隠す)。
                    cityInfoLine = `\n§6【${c.isCapital ? "首都" : "都市"}: ${c.name}】 §7(他国の都市のため詳細情報は非表示)`;
                }
            }

            // アクションバーへ出力
            player.onScreenDisplay.setActionBar(
                `§b[Map] 補正座標: [${tx}, ${tz}] §7| §f地形: §b${terrainLabel} §7| §f資源: §e${resourceLabel}\n` +
                `§f領有: ${ownerText}${cityText}${facilityText}${districtText}\n` +
                `§fベース産出: ${yieldText}\n${combatUnitText}${religiousUnitText}` +
                currentYieldLine +
                cityInfoLine
            );
        } else {
            // 生成されたグリッドの範囲外にプレイヤーがいる場合
            player.onScreenDisplay.setActionBar("§7[Warning] 国境線の外（未開の地）にいます");
        }
    }
}, 10);
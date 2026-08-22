// bots.js
// 🤖 プレイヤーの代わりに自動でゲームを操作する「Bot」。
//
// 【Botの正体】
// Botは物理的な実体(ワールド上のエンティティ)を持たない仮想国家(civs.js の仮想国家に
// isBot:true フラグを立てたもの)。既存のコマンド関数(cmdClaim/cmdSettle/cmdBuyRights/
// cmdStartProduction/cmdInstallFacility/cmdStartDistrict/cmdAttackCombatUnit 等)は
// 「プレイヤーが今立っているマス」または明示的なtx,tz引数を対象にする設計になっているため、
// Botの行動は「決定した目標マスの中心座標を location に持つ"擬似プレイヤーオブジェクト"」を
// 作り、既存のコマンド関数へそのまま渡すことで実現する。こうすることで、Botの行動は
// 人間が手動で行う場合と全く同じ検証・コスト・副作用(ブロック設置やメッセージ含む)を通る。
// ロジックを二重実装して後から挙動が乖離する事故を避けるための設計判断。
//
// 【戦略性: 「脅威」の判定について】
// 自国の都市の近くに、外交協定の無い敵ユニットが1体でもいる場合、そのターンは
// 「脅威あり」と判定する(computeThreatLevel)。この判定1つを、拡張(新都市の建設可否)・
// 生産の優先順位・研究の優先順位という3つの判断に横断的に使うことで、「危険な時は防衛、
// 安全な時は経済成長」というシンプルだが一貫した戦略を表現している。警戒距離は関係により
// 変える: 戦争状態(war)の相手はTHREAT_RADIUS_WAR(実際に領土へ侵入・攻撃してくる
// 可能性がある)、「関係なし」(none)の相手はより短いTHREAT_RADIUS_NONE(宣戦布告
// されない限り領土に入って来られず実害が無いため)。
//
// 【戦略性: 宣戦布告(declareWar)・講和(breakRelation)について】
// diplomacy.js の追加により、攻撃・都市の占領・他国領土への進入は戦争状態(war)の相手にしか
// 行えなくなった。そのためBotは、自国より明らかに弱い「関係なし」の相手には自分から
// 宣戦布告して征服を狙い(AGGRESSION_POWER_RATIO)、逆に明らかに強い相手には不可侵条約→
// 同盟を提案する(DIPLOMATIC_THREAT_POWER_RATIO)。強すぎず弱すぎない相手には何もしない
// (runBotDiplomacy)。宣戦布告はcivic・試合の設定を問わず常に行える。また、戦争中の相手が
// 自国よりPEACE_SUE_POWER_RATIO倍以上強くなった(圧倒的に負けている)場合は、自分から
// 講和(breakRelation)して撤退する(試合の設定でpeaceEnabledが無効な場合は試みない。
// §15参照)。この倍率はAGGRESSION_POWER_RATIO(宣戦布告の閾値)より意図的に大きくしてあり、
// 宣戦布告した瞬間に相手がすぐ講和して戦争が実質発生しなくなる(閾値が対称なせいで
// 往復するだけになる)のを防いでいる。
//
// 【毎ターンの自動行動】
// 1. 都市が1つも無ければ、空きマス(資源があれば優先)に最初の都市(首都)を建てる。
// 2. 脅威が無く、開拓権があれば、自国の空き領地マス(資源があれば優先)に新都市を建てる
//    (脅威がある間は拡張より防衛を優先し、新都市の建設を見送る)。
// 3. 自国の領地に隣接する未所有マス(資源があれば優先)を、最大3マス/ターンまで領有する。
// 4. 首都の人口に余裕があれば開拓権を取得する。
// 5. 空き領有マスがあり、その帰属都市が区域(専用建造物含む)を建設中でなければ、
//    着手できる区域または区域専用建造物(社など)の建設を開始する。
// 6. 空き領有マスがあれば、労働者の行動回数が続く限り施設を設置する。
// 7. 生産中でない都市があれば、脅威があり、かつ都市数に見合った戦力にまだ達していなければ
//    防衛ユニット(戦士・弓兵のうち数が少ない方を優先)を生産する。それ以外は労働者数に
//    応じた経済優先順位で、何かを生産キューに入れる(脅威時でも戦力が足りていれば経済を
//    優先することで、戦士だけを際限なく生産し続けることを防ぐ)。沿岸都市(隣接マスに
//    水上マスがある)なら、都市数に見合った隻数の軍艦をまだ持っていない限り、経済優先順位の
//    末尾に軍艦も選択肢として加える(内陸都市では配置できないため対象外)。経済・軍艦とも
//    生産すべきものが無く、戦争中で備蓄がMAX_MISSILE_STOCKPILE未満なら、最後の選択肢として
//    ミサイルを生産する。
// 8. 研究・社会制度が未選択なら、脅威がある間は弓術(弓兵解禁)を優先し、無ければ
//    経済・成長寄りの技術を優先して、条件を満たす最初の項目を自動選択する。
// 9. 届いている外交提案は全て承認する(自国にとってノーリスクなため)。その後、他の全国家
//    (同盟の相手を除く)について判定する。戦争中の相手は、自国が圧倒的に劣勢なら講和する。
//    それ以外の相手は、自国より明らかに弱ければ宣戦布告、明らかに強ければ(civic・試合の
//    設定が許せば)不可侵条約→同盟を提案する。
// 10. 戦争中で、ミサイルの在庫がある都市が1つでもあれば、敵都市(相手の首都を優先)へ
//     1発だけミサイルを発射する(都市を一撃で消滅させる切り札のため、1ターンにつき最大1発)。
// 11. 自国の戦闘ユニットごとに、次の優先順で1つだけ行動する(いずれも戦争状態の相手のみが
//     対象。「関係なし」・不可侵条約・同盟の相手は対象にしない)。近接ユニット(戦士等)を
//     遠距離ユニット(弓兵等)より先に処理することで、(e)の移動判断が同ターン内の
//     戦士の前進結果を踏まえられるようにしている:
//     (a) 無防備な敵都市の上で今ターン未行動なら占領する。
//     (b) 攻撃範囲内に敵がいれば、その中から包囲ボーナス(combat.js の countFlankingAllies。
//         既にその敵に隣接している味方ユニットの数)が最大の相手を選び、同数ならHPが
//         最も低い相手を選んで攻撃する(囲んでから仕留める・確実な撃破を優先)。
//     (c) HPが低ければ(RETREAT_HP_RATIO未満)、最寄りの自都市へ撤退する。
//     (d) 自都市を守備中で、近く(GARRISON_ALERT_RADIUS以内)に敵がいなければ持ち場を守る。
//     (e) 自分は健在で、近く(ESCORT_RADIUS以内)に撤退中の負傷した味方がいれば
//         (かつ最寄りの敵と同じかそれ以上に近ければ)、敵を追うより先にその護衛(合流)へ
//         向かう(単独で撤退する負傷ユニットが道中で各個撃破されるのを防ぐ)。
//     (f) それ以外は最も近い敵(ユニットまたは都市)へ向けて移動する(簡易な直進移動。
//         障害物を避ける経路探索は行わない)。ただし遠距離ユニットは、自軍に近接ユニットが
//         いるにもかかわらず、その近接ユニットの誰よりも自分の方が敵に近い(=最前線に
//         単独で突出してしまう)場合は前進を控えて待機する(弓兵が戦士より先に敵地へ
//         突っ込んで各個撃破されるのを防ぐ、簡易な「戦士を前に出す」隊列判断)。
//
// 【commands.js との循環importについて】
// このファイルは commands.js の cmd* 関数を呼び出す(上記の理由で)一方、commands.js
// 側もゲーム開始/ターン終了のたびにBotへ手番を回すため bots.js を呼び返す
// (cmdStart/cmdEndTurn/cmdForceEndTurn → advanceUntilHuman)。
// 相互import自体は発生するが、どちらの呼び出しも関数本体の中(=全モジュールの読み込みが
// 終わった後に実行される)でしか行われないため、ESモジュールの仕様上安全に解決される
// (モジュールの評価順序に依存する参照は無い)。

import { world, system } from "@minecraft/server";
import { getMapConfig, getTiles, getMatchSettings } from "./state.js";
import { getTurnState, joinGame, startGame, endTurn, forceEndTurn } from "./turns.js";
import { getVirtualCivById, addVirtualCiv, getCivStorageHandle } from "./civs.js";
import { getAdjacentTiles, resolveOwningCityKey } from "./adjacency.js";
import { isImpassableTerrain, isWaterTerrain } from "./mapGen.js";
import { canStartProduction, getWorkerCount } from "./production.js";
import { getDefinitions, getProgressState, startProgress, hasCompletedProgress } from "./progression.js";
import { getFacilityIds, canInstallFacility } from "./facilities.js";
import { getDistrictIds, canStartDistrict, getDistrictBuildingIds, canStartDistrictBuilding } from "./districts.js";
import { canUnitEnterTile, tileDistance, getAttackableTargets, isRangedUnit, countFlankingAllies } from "./combat.js";
import { getRelation, getRequestsFor, sendRequest, acceptRequest, hasDiplomaticAgreement, isAtWar, declareWar, breakRelation } from "./diplomacy.js";
import {
    cmdClaim, cmdSettle, cmdBuyRights, cmdStartProduction,
    cmdInstallFacility, cmdStartDistrict, cmdStartDistrictBuilding,
    cmdMoveCombatUnit, cmdAttackCombatUnit, cmdCaptureCity, cmdHealCombatUnit,
    cmdLaunchMissile,
} from "./commands.js";

const TILE_SIZE = 5;
const MAX_CLAIMS_PER_TURN = 3;
// 💡 Bot同士の対戦(全員Botの手番が連続する状況)が一瞬で終わってしまわないよう、
//    Botの手番から次のBotの手番へ移る際にこの間隔(tick、20tick=1秒)だけ間を置く。
//    人間の手番の直前・直後の「最初の1手」はこの遅延を挟まず即座に処理される
//    (advanceUntilHumanの実装を参照)。既定値だが、実際の間隔は試合の設定
//    (state.js の getMatchSettings().botTurnDelayTicks)からOPが変更できる。
const DEFAULT_BOT_TURN_DELAY_TICKS = 5;
// 💡 生産の優先順位。労働者が少ないうちは労働者を優先し、増えたら建造物/防衛ユニットへ回す。
// 脅威(THREAT_RADIUS以内の敵ユニット)が無い間の優先順位。
const PRODUCTION_PRIORITY_SAFE_EARLY = ["worker", "granary", "tradingPost", "obelisk", "warrior", "archer"];
const PRODUCTION_PRIORITY_SAFE_LATE = ["granary", "tradingPost", "obelisk", "warrior", "archer", "worker"];
const WORKER_COUNT_THRESHOLD = 3;
// 💡 脅威時でも際限なく戦士/弓兵を生産し続けると、経済(労働者・建造物)が完全に止まり、
//    かつ同じユニットばかりになってしまうため、都市数に対してこの倍率までの戦闘ユニット
//    (戦士+弓兵の合計)を持てば、脅威時でも経済優先度に戻す上限とする。
const MAX_COMBAT_UNITS_PER_CITY = 3;

// 💡 自国の都市からこの距離(マス目)以内に敵ユニットがいる場合、「脅威あり」と判定し、
//    生産・拡張・研究の優先順位を防衛寄りに切り替える。戦争状態の相手は実際に領土へ侵入・
//    攻撃してくる可能性があるため通常の距離で警戒するが、「関係なし」の相手は宣戦布告
//    されない限り領土に入って来られない(=実害が無い)ため、警戒距離を大幅に短くする
//    (よほど国境際まで来ていない限り、経済を止めてまで身構える必要は無いという判断)。
const THREAT_RADIUS_WAR = 6;
const THREAT_RADIUS_NONE = 2;
// 💡 このHP割合を下回った戦闘ユニットは、攻撃できない限り最寄りの自都市へ撤退する。
const RETREAT_HP_RATIO = 0.35;
// 💡 自都市を守っているユニットは、敵がこの距離まで近づかない限り持ち場を離れない
//    (THREAT_RADIUS_WARと同じ値にして、生産を防衛寄りに切り替える距離と、実際にユニットが
//    迎撃に動き出す距離がズレない=「警戒しているのに誰も動かない」状態を防ぐ)。
const GARRISON_ALERT_RADIUS = THREAT_RADIUS_WAR;
// 💡 相手の国力(都市数×10+戦闘力合計)が自国のこの倍率を超えたら「脅威国」とみなし、
//    自分から不可侵条約/同盟を提案する(弱い相手には自分から関係を提案しない=将来の
//    征服対象として残す)。
const DIPLOMATIC_THREAT_POWER_RATIO = 1.2;
// 💡 自国がこの倍率以上強ければ、「関係なし」の弱い相手に自分から宣戦布告して征服を狙う
//    (DIPLOMATIC_THREAT_POWER_RATIOと逆方向: 強い相手には和平、弱い相手には宣戦布告)。
const AGGRESSION_POWER_RATIO = 1.3;
// 💡 戦争中の相手の国力が自国のこの倍率を超えたら、自分から講和(breakRelation)して撤退する。
//    AGGRESSION_POWER_RATIO(1.3倍)より意図的に大きい値にしてあり、宣戦布告した瞬間に
//    相手がすぐ講和してしまい戦争が実質発生しなくなる(ヒステリシスの無い往復)のを防ぐ。
const PEACE_SUE_POWER_RATIO = 2.0;
// 💡 護衛撤退: 撤退中(HP低下)の味方がこの距離以内にいれば、健在なユニットは敵を追うより先に
//    合流へ向かう(単独で撤退する負傷ユニットが道中で各個撃破されるのを防ぐ)。
const ESCORT_RADIUS = 4;
// 💡 都市を一撃で消滅させるミサイル(生産力200と重い)は、国家全体でこの発数までしか
//    備蓄しない(それ以上は他の生産に回す)。
const MAX_MISSILE_STOCKPILE = 2;

// 💡 研究の優先順位。安全な間は経済・成長寄り、脅威がある間は弓術(弓兵解禁)を最優先する。
const TECH_PRIORITY_SAFE = ["pottery", "writing", "astrology", "mining", "animalHusbandry", "archery", "smelting", "apprenticeship"];
const TECH_PRIORITY_THREATENED = ["animalHusbandry", "archery", "mining", "pottery", "writing", "astrology", "smelting", "apprenticeship"];
// 💡 社会制度は元々「法典→使節団→外交」という前提条件の連鎖と一致した優先順位で問題ない。
const CIVIC_PRIORITY = ["codeOfLaws", "emissaries", "diplomacy"];

/** 指定した国家がBot(自動操作)かどうかを判定する。 */
export function isBotCiv(civId) {
    return !!getVirtualCivById(civId)?.isBot;
}

/**
 * Botとして仮想国家を追加し、ゲーム開始前であれば即座に参加させる。
 * @returns {{ ok: boolean, message: string }}
 */
export function addBot(controllerPlayer, name) {
    const turn = getTurnState();
    if (turn.started) return { ok: false, message: "§cゲーム開始後はBotを追加できません。次のゲームリセット後に追加してください。" };

    const civ = addVirtualCiv(controllerPlayer, name, { isBot: true });
    const joinResult = joinGame({ id: civ.id, name: civ.name });
    if (!joinResult.ok) return { ok: false, message: `§c[Bot]【${civ.name}】を追加しましたが、参加に失敗しました: ${joinResult.message}` };

    world.sendMessage(`§a[Bot]【${civ.name}】が追加され、ゲームに参加しました。`);
    return { ok: true, message: `§a[Bot]【${civ.name}】を追加し、ゲームに参加させました。` };
}

/** civId の Bot用の擬似プレイヤーオブジェクトを作る。tx,tzのマス中心を location として持つ。 */
function makeBotIdentity(civId, tx, tz, config) {
    const handle = getCivStorageHandle(civId);
    if (!handle) return null;
    return {
        ...handle,
        location: { x: config.originX + tx * TILE_SIZE + 2.5, y: config.ySurface, z: config.originZ + tz * TILE_SIZE + 2.5 },
        dimension: world.getDimension("overworld"),
        runCommand: () => {}, // 💡 title/playsoundの演出はBotには不要(そもそも実体が無く呼べない)
        // 💡 個々のコマンド関数が失敗時に呼ぶ reply()(=player.sendMessage)は、Botが判断ミスで
        //    条件を満たさない行動を試みた際のノイズになるだけなので黙らせる。成功時の通知は
        //    各コマンドが world.sendMessage() で全員に一斉送信するため、そちらは通常通り届く。
        sendMessage: () => {},
    };
}

function collectTiles(tiles, predicate) {
    const list = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (!predicate(t, key)) continue;
        const [tx, tz] = key.split(",").map(Number);
        list.push({ tx, tz, tile: t });
    }
    return list;
}

function pickRandom(list) {
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/** 候補の中に資源のあるマスがあれば、そちらを優先してランダムに1つ選ぶ。 */
function pickBestSite(candidates) {
    const withResource = candidates.filter((c) => c.tile?.resource);
    return pickRandom(withResource.length > 0 ? withResource : candidates);
}

/** 最初の都市(首都)を建てるのに良さそうな空きマスを選ぶ(資源があれば優先)。 */
function pickFirstCitySite(tiles) {
    return pickBestSite(collectTiles(tiles, (t) => !t.ownerId && !t.city && !isImpassableTerrain(t.type) && !isWaterTerrain(t.type)));
}

/** 新都市を建てられる、自国の空き領地マスを選ぶ(資源があれば優先)。 */
function pickNewCitySite(tiles, civId) {
    return pickBestSite(collectTiles(tiles, (t) => t.ownerId === civId && !t.city && !isImpassableTerrain(t.type) && !isWaterTerrain(t.type)));
}

/** 自国の領地に隣接する未所有マスを選ぶ(cmdClaimと同じ隣接ルール。資源があれば優先)。 */
function pickClaimableTile(tiles, civId) {
    const candidates = collectTiles(tiles, (t, key) => {
        if (t.ownerId) return false;
        const [tx, tz] = key.split(",").map(Number);
        return getAdjacentTiles(tx, tz, tiles).some((n) => n.ownerId === civId);
    });
    return pickBestSite(candidates);
}

/** この都市タイル(tx, tz)が隣接マスに水上マスを持つ(=軍艦を配置できる沿岸都市)かどうか。 */
function isCoastalCity(tx, tz, tiles) {
    return getAdjacentTiles(tx, tz, tiles).some((n) => isWaterTerrain(n.type));
}

/**
 * この都市で今から生産開始できる、優先度順で最初の生産物IDを選ぶ(無ければnull)。
 * 脅威があり、かつ都市数に見合った戦力(MAX_COMBAT_UNITS_PER_CITY)にまだ達していなければ
 * 防衛ユニットを最優先する。その際、戦士と弓兵のうち数が少ない方(同数なら弓兵。
 * 弓兵の技術が無ければ自動的に戦士にフォールバックする)を選ぶことで、常に同じユニットだけ
 * 生産され続けるのを防ぐ。それ以外(脅威が無い、またはもう十分な戦力がある)は
 * 労働者数に応じた経済優先順位を使い、沿岸都市(隣接マスに水上マスがある)であれば
 * まだ都市数に見合った隻数の軍艦を持っていない限り、その優先順位の末尾に軍艦も加える
 * (内陸都市では軍艦は配置できず生産が無駄になるため、沿岸都市でのみ選択肢に加える)。
 * 経済・軍艦のどちらも生産すべきものが無く、かつ戦争中で備蓄が上限未満なら、都市を
 * 一撃で破壊できるミサイルを最後の選択肢として生産する。
 * @param {{ cityCount: number, warriorCount: number, archerCount: number, battleshipCount: number,
 *   missileStock: number, atWar: boolean }} unitCounts
 */
function pickProductionChoice(city, tile, botIdentity, threatened, unitCounts, tx, tz, tiles) {
    const wantMilitary = threatened
        && unitCounts.warriorCount + unitCounts.archerCount < unitCounts.cityCount * MAX_COMBAT_UNITS_PER_CITY;
    if (wantMilitary) {
        const preferredOrder = unitCounts.archerCount <= unitCounts.warriorCount ? ["archer", "warrior"] : ["warrior", "archer"];
        for (const id of preferredOrder) {
            if (canStartProduction(city, id, tile, botIdentity).ok) return id;
        }
    }

    const basePriority = getWorkerCount(city) < WORKER_COUNT_THRESHOLD ? PRODUCTION_PRIORITY_SAFE_EARLY : PRODUCTION_PRIORITY_SAFE_LATE;
    const canWantBattleship = unitCounts.battleshipCount < unitCounts.cityCount && isCoastalCity(tx, tz, tiles);
    const priority = canWantBattleship ? [...basePriority, "battleship"] : basePriority;
    for (const id of priority) {
        if (canStartProduction(city, id, tile, botIdentity).ok) return id;
    }

    if (unitCounts.atWar && unitCounts.missileStock < MAX_MISSILE_STOCKPILE
        && canStartProduction(city, "missile", tile, botIdentity).ok) {
        return "missile";
    }
    return null;
}

/**
 * 研究/社会制度が未選択なら、条件(前提・未取得)を満たす最初の項目を、指定した優先順位リストに
 * 沿って自動選択する(リストに載っていない項目は対象外にはせず、末尾に回して拾う)。
 */
function autoStartProgress(botIdentity, kind, priority) {
    const state = getProgressState(botIdentity, kind);
    if (state.activeId) return;
    const defs = getDefinitions(kind);
    const orderedIds = [...priority, ...Object.keys(defs).filter((id) => !priority.includes(id))];
    for (const id of orderedIds) {
        if (startProgress(botIdentity, kind, id).ok) return;
    }
}

/** このマスに今から設置できる、定義順で最初の施設IDを選ぶ(無ければnull)。 */
function pickFacilityChoice(tile, botIdentity) {
    for (const id of getFacilityIds()) {
        if (canInstallFacility(tile, id, botIdentity.id, botIdentity).ok) return id;
    }
    return null;
}

/** このマスに今から着工できる、定義順で最初の区域IDを選ぶ(無ければnull)。 */
function pickDistrictChoice(tile, city, botIdentity, tiles, cityKey) {
    for (const id of getDistrictIds()) {
        if (canStartDistrict(tile, id, botIdentity.id, city, botIdentity, tiles, cityKey).ok) return id;
    }
    return null;
}

/** この(完成済み区域の)マスに今から着工できる、定義順で最初の区域専用建造物IDを選ぶ(無ければnull)。 */
function pickDistrictBuildingChoice(tile, city, civId) {
    for (const id of getDistrictBuildingIds()) {
        if (canStartDistrictBuilding(tile, id, civId, city).ok) return id;
    }
    return null;
}

/** 指定した国家の国力の目安を算出する(都市数×10+全戦闘ユニットの戦闘力合計)。 */
function computeCivPower(civId, tiles) {
    let power = 0;
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId) continue;
        if (t.city) power += 10;
        if (t.combatUnit) power += t.combatUnit.combatStrength ?? t.combatUnit.rangedCombatStrength ?? 0;
    }
    return power;
}

/**
 * 届いている外交提案を全て承認する(自国にとって関係樹立はリスクが無いため無条件で受け入れる)。
 * その後、他の全国家それぞれについて次の判断を行う(宣戦布告は社会制度・試合設定を問わず
 * 常に行える。不可侵条約・同盟の提案には civic 条件と試合の設定を要求する):
 * - 既に同盟なら何もしない。
 * - 既に戦争状態の相手は、試合の設定で講和(peaceEnabled)が有効、かつその相手の国力が
 *   自国のPEACE_SUE_POWER_RATIO倍を超えていれば(=圧倒的に負けている)、自分から講和して
 *   撤退する。戦闘そのもの(占領・攻撃・移動)は runBotCombat が別途担当する。
 * - 自国より明確に弱い(国力が自国のAGGRESSION_POWER_RATIO分の1以下)「関係なし」の相手には
 *   自分から宣戦布告して征服を狙う。
 * - 自国より明確に強い(国力が自国のDIPLOMATIC_THREAT_POWER_RATIO倍以上)相手にのみ、
 *   社会制度の条件を満たしていれば不可侵条約→同盟の順で関係を提案する(段階を踏む)。
 * - どちらでもない(強すぎず弱すぎない)相手には何もしない。
 */
function runBotDiplomacy(civId, botIdentity, tiles) {
    const requests = getRequestsFor(botIdentity);
    for (const req of requests) {
        const fromHandle = getCivStorageHandle(req.fromId) ?? { id: req.fromId, name: req.fromName };
        acceptRequest(botIdentity, fromHandle, req.id);
    }

    const diplomacyEnabled = getMatchSettings().diplomacyEnabled;
    const canPact = diplomacyEnabled && hasCompletedProgress(botIdentity, "civic", "emissaries");
    const canAlliance = diplomacyEnabled && hasCompletedProgress(botIdentity, "civic", "diplomacy");

    const myPower = computeCivPower(civId, tiles);
    const turn = getTurnState();
    for (const targetId of turn.playerOrder ?? []) {
        if (targetId === civId) continue;
        const targetHandle = getCivStorageHandle(targetId);
        if (!targetHandle) continue;

        const rel = getRelation(botIdentity, targetId);
        if (rel === "alliance") continue;
        const targetPower = computeCivPower(targetId, tiles);

        // 💡 戦争中に圧倒的な劣勢(相手の国力が自国のPEACE_SUE_POWER_RATIO倍超)になったら、
        //    自分から講和して撤退する(breakRelationは一方的に成立するため相手の承諾は不要)。
        //    試合の設定で講和(peaceEnabled)が無効なら、そもそも成立しないため試みない。
        if (rel === "war") {
            if (getMatchSettings().peaceEnabled && targetPower > myPower * PEACE_SUE_POWER_RATIO) {
                breakRelation(botIdentity, targetHandle);
            }
            continue;
        }

        // 💡 宣戦布告はcivic/試合設定を問わず常に行える。
        if (rel === "none" && myPower > targetPower * AGGRESSION_POWER_RATIO) {
            declareWar(botIdentity, targetHandle);
            continue;
        }
        if (!canPact && !canAlliance) continue;
        if (rel === "none" && targetPower < myPower * DIPLOMATIC_THREAT_POWER_RATIO) continue;

        // 💡 いきなり同盟ではなく、まず不可侵条約を結んでから同盟へ格上げする(条件を両方
        //    満たしていても段階を踏む)。不可侵条約の社会制度が無い場合のみ同盟を直接提案する。
        if (rel === "none" && canPact) sendRequest(botIdentity, targetHandle, "pact");
        else if (rel === "none" && canAlliance) sendRequest(botIdentity, targetHandle, "alliance");
        else if (rel === "pact" && canAlliance) sendRequest(botIdentity, targetHandle, "alliance");
    }
}

/** 指定した方向へ、今の移動力の範囲でこのユニットが進入できる最も遠いマスを探す。 */
function findValidMoveTarget(unit, tx, tz, dirX, dirZ, maxDist, tiles, config) {
    for (let dist = maxDist; dist >= 1; dist--) {
        const ntx = tx + dirX * dist;
        const ntz = tz + dirZ * dist;
        if (ntx < 0 || ntz < 0 || ntx >= config.width || ntz >= config.height) continue;
        const t = tiles[`${ntx},${ntz}`];
        if (!t || t.combatUnit || !canUnitEnterTile(unit, t)) continue;
        return { tx: ntx, tz: ntz };
    }
    return null;
}

/**
 * 目標地点へ向かって、今の移動力で進める最善のマスを選ぶ。
 * 目標方向への直進(斜め移動含む)が地形/占有マスで塞がっている場合は、
 * 縦方向・横方向の単軸移動を代わりに試す(簡易な経路探索の代替。障害物の迂回はしない)。
 */
function pickMoveDestination(unit, tx, tz, target, remaining, tiles, config) {
    const dirX = Math.sign(target.tx - tx);
    const dirZ = Math.sign(target.tz - tz);
    if (dirX === 0 && dirZ === 0) return null;
    return findValidMoveTarget(unit, tx, tz, dirX, dirZ, remaining, tiles, config)
        ?? (dirX !== 0 ? findValidMoveTarget(unit, tx, tz, dirX, 0, remaining, tiles, config) : null)
        ?? (dirZ !== 0 ? findValidMoveTarget(unit, tx, tz, 0, dirZ, remaining, tiles, config) : null);
}

/**
 * 戦争状態にある、最も近い敵(戦闘ユニットまたは都市)のマスを探す。
 * 「関係なし」の相手は宣戦布告されない限り攻撃も領土への進入もできない(=近づいても
 * 何もできない)ため、追跡・接近の対象からも除外する。
 */
function findNearestEnemyTarget(tiles, civId, fromTx, fromTz) {
    let best = null;
    let bestDist = Infinity;
    for (const key in tiles) {
        const t = tiles[key];
        if (!t.ownerId || t.ownerId === civId) continue;
        if (!t.city && !t.combatUnit) continue;
        if (!isAtWar(civId, t.ownerId)) continue;
        const [tx, tz] = key.split(",").map(Number);
        const dist = tileDistance(fromTx, fromTz, tx, tz);
        if (dist < bestDist) { bestDist = dist; best = { tx, tz }; }
    }
    return best;
}

/** 自国の都市の中で最も近いマスを探す(撤退先の決定に使う)。 */
function findNearestOwnCity(tiles, civId, fromTx, fromTz) {
    let best = null;
    let bestDist = Infinity;
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || !t.city) continue;
        const [tx, tz] = key.split(",").map(Number);
        const dist = tileDistance(fromTx, fromTz, tx, tz);
        if (dist < bestDist) { bestDist = dist; best = { tx, tz }; }
    }
    return best;
}

/**
 * 自国の戦闘ユニットの中で、HPが低く(RETREAT_HP_RATIO未満)撤退中とみなせるものの中から、
 * (fromTx, fromTz) から最も近い1体を探す(護衛撤退の対象を決めるのに使う。自分自身は除外)。
 */
function findNearestWoundedAlly(tiles, civId, fromTx, fromTz) {
    let best = null;
    let bestDist = Infinity;
    for (const key in tiles) {
        const t = tiles[key];
        const u = t.combatUnit;
        if (!u || u.ownerId !== civId) continue;
        const [tx, tz] = key.split(",").map(Number);
        if (tx === fromTx && tz === fromTz) continue;
        const maxHp = u.maxHp ?? 100;
        const hpRatio = (u.hp ?? maxHp) / maxHp;
        if (hpRatio >= RETREAT_HP_RATIO) continue;
        const dist = tileDistance(fromTx, fromTz, tx, tz);
        if (dist < bestDist) { bestDist = dist; best = { tx, tz, dist }; }
    }
    return best;
}

/**
 * 戦争状態にある相手が所有する都市の中から、ミサイルの標的を1つ選ぶ(無ければnull)。
 * 相手の首都を最優先し、無ければ最初に見つかった敵都市を選ぶ(戦争を終わらせる効果が
 * 大きい首都を優先的に狙う)。
 */
function pickMissileTarget(tiles, civId) {
    let fallback = null;
    for (const key in tiles) {
        const t = tiles[key];
        if (!t.city || !t.ownerId || t.ownerId === civId) continue;
        if (!isAtWar(civId, t.ownerId)) continue;
        const [tx, tz] = key.split(",").map(Number);
        if (t.city.isCapital) return { tx, tz };
        if (!fallback) fallback = { tx, tz };
    }
    return fallback;
}

/**
 * 攻撃可能な相手の中から、包囲ボーナス(その相手に既に隣接している味方ユニットの数、
 * combat.js の countFlankingAllies)が最大の相手を優先し、同数ならHPが最も低い
 * (=今ターンで倒せる可能性が最も高い)相手を選ぶ。既に囲んでいる相手を優先することで、
 * 包囲ボーナスを活かして確実に仕留めることを狙う。
 */
function pickBestAttackTarget(targets, civId, fromTx, fromTz, tiles) {
    let best = null;
    let bestScore = -1;
    let bestHp = Infinity;
    for (const t of targets) {
        const score = countFlankingAllies(t.tx, t.tz, civId, fromTx, fromTz, tiles);
        const hp = t.unit?.hp ?? t.unit?.maxHp ?? 0;
        if (!best || score > bestScore || (score === bestScore && hp < bestHp)) {
            best = t;
            bestScore = score;
            bestHp = hp;
        }
    }
    return best;
}

/** 自国の戦闘ユニットの中に、近接ユニット(遠距離戦闘ユニットでないもの)が1体でもいるかどうか。 */
function hasMeleeUnits(civId, tiles) {
    for (const key in tiles) {
        const u = tiles[key].combatUnit;
        if (u?.ownerId === civId && !isRangedUnit(u)) return true;
    }
    return false;
}

/**
 * (tx, tz) にいる自国の遠距離ユニットより、target に近い(または同じ距離の)自国の近接ユニットが
 * 1体でも存在するかどうか。存在すれば「戦士が前に出ている/並んでいる」とみなし、
 * 遠距離ユニットが安心して前進してよい合図とする。
 */
function meleeEscortIsForward(civId, tx, tz, target, tiles) {
    const myDist = tileDistance(tx, tz, target.tx, target.tz);
    for (const key in tiles) {
        const u = tiles[key].combatUnit;
        if (u?.ownerId !== civId || isRangedUnit(u)) continue;
        const [utx, utz] = key.split(",").map(Number);
        if (tileDistance(utx, utz, target.tx, target.tz) <= myDist) return true;
    }
    return false;
}

/**
 * 自国の都市からTHREAT_RADIUS以内に、外交協定の無い敵ユニットが1体でもいるかどうか。
 * 生産・拡張・研究の優先順位を防衛寄りに切り替えるかどうかの判定に使う。
 */
function computeThreatLevel(civId, tiles) {
    const cityPositions = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId && t.city) {
            const [tx, tz] = key.split(",").map(Number);
            cityPositions.push({ tx, tz });
        }
    }
    if (cityPositions.length === 0) return false;

    for (const key in tiles) {
        const t = tiles[key];
        const enemyUnit = t.combatUnit;
        if (!enemyUnit || enemyUnit.ownerId === civId) continue;
        if (hasDiplomaticAgreement(civId, enemyUnit.ownerId)) continue;
        const radius = isAtWar(civId, enemyUnit.ownerId) ? THREAT_RADIUS_WAR : THREAT_RADIUS_NONE;
        const [tx, tz] = key.split(",").map(Number);
        if (cityPositions.some((c) => tileDistance(c.tx, c.tz, tx, tz) <= radius)) return true;
    }
    return false;
}

/**
 * 1体の戦闘ユニットの行動を決定・実行する。優先順位:
 * (a) 無防備な敵都市の上で今ターン未行動なら占領する。
 * (b) 攻撃範囲内に敵がいれば、その中から包囲ボーナス(既にその相手に隣接している味方の数)が
 *     最大の相手を優先し、同数ならHPが最も低い相手を攻撃する。
 * (c) HPが低ければ(RETREAT_HP_RATIO未満)、最寄りの自都市へ撤退する。
 * (d) 自都市を守っている最中で、近く(GARRISON_ALERT_RADIUS以内)に敵がいなければ、
 *     HPが減っていれば休息して回復し(cmdHealCombatUnit)、満タンならそのまま持ち場を守る。
 * (e) 自分は健在で、近く(ESCORT_RADIUS以内)に撤退中の負傷した味方がいれば、敵を追うより
 *     先にその護衛(合流)へ向かう(単独で撤退する負傷ユニットが各個撃破されるのを防ぐ)。
 * (f) それ以外は最も近い敵(ユニットまたは都市)へ向けて移動する。ただし遠距離ユニットが
 *     自軍の近接ユニットより前に出てしまう場合は、近接ユニットが追いつくまで待機する。
 */
function runBotCombatUnit(civId, tx, tz, unit, tiles, config, botIdentity) {
    const tile = tiles[`${tx},${tz}`];
    if (!tile) return;

    if (tile.city && tile.ownerId && tile.ownerId !== civId && isAtWar(civId, tile.ownerId)) {
        const maxMovement = unit.movement ?? 0;
        if ((unit.movementRemaining ?? maxMovement) >= maxMovement) {
            cmdCaptureCity(botIdentity, tx, tz);
            return;
        }
    }

    // 💡 攻撃できるのは宣戦布告済み(戦争状態)の相手のみ。hasAgreementFnは「除外する」述語なので、
    //    戦争状態でない相手を除外する形で渡す。
    const targets = getAttackableTargets(tx, tz, civId, unit, tiles, config, (a, b) => !isAtWar(a, b));
    if (targets.length > 0) {
        const target = pickBestAttackTarget(targets, civId, tx, tz, tiles);
        cmdAttackCombatUnit(botIdentity, tx, tz, target.tx, target.tz);
        return;
    }

    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    if (remaining <= 0) return;

    const nearestEnemy = findNearestEnemyTarget(tiles, civId, tx, tz);

    const maxHp = unit.maxHp ?? 100;
    const hpRatio = (unit.hp ?? maxHp) / maxHp;
    if (hpRatio < RETREAT_HP_RATIO) {
        const home = findNearestOwnCity(tiles, civId, tx, tz);
        if (home && (home.tx !== tx || home.tz !== tz)) {
            const dest = pickMoveDestination(unit, tx, tz, home, remaining, tiles, config);
            if (dest) cmdMoveCombatUnit(botIdentity, tx, tz, dest.tx, dest.tz);
            return;
        }
    }

    if (tile.city && tile.ownerId === civId) {
        const enemyNear = nearestEnemy && tileDistance(tx, tz, nearestEnemy.tx, nearestEnemy.tz) <= GARRISON_ALERT_RADIUS;
        if (!enemyNear) {
            // 💡 remaining(=movementRemaining)は、このターンまだ他の行動を取っていないため
            //    常に満タン(unit.movementと同値)のはず。cmdHealCombatUnit自体もこの条件を
            //    改めて検証するため、ここでの判定はあくまで「無駄な呼び出しを避ける」ため。
            if (remaining >= (unit.movement ?? 0) && hpRatio < 1) {
                cmdHealCombatUnit(botIdentity, tx, tz);
            }
            return;
        }
    }

    // 💡 護衛撤退: 自分自身は健在で、近く(ESCORT_RADIUS以内)に撤退中の負傷した味方がいれば、
    //    (少なくとも最寄りの敵と同じかそれ以上に近い場合)敵を追うより先にその護衛(合流)へ
    //    向かう。単独で撤退する負傷ユニットが道中で各個撃破されるのを防ぐ狙い。撤退先は毎ターン
    //    最新の味方位置から再計算するため、合流後は自然と味方の撤退先(自都市)へ追従する形になり、
    //    専用の追跡状態を持つ必要が無い。
    const woundedAlly = findNearestWoundedAlly(tiles, civId, tx, tz);
    if (woundedAlly && woundedAlly.dist <= ESCORT_RADIUS
        && (!nearestEnemy || woundedAlly.dist <= tileDistance(tx, tz, nearestEnemy.tx, nearestEnemy.tz))) {
        const dest = pickMoveDestination(unit, tx, tz, woundedAlly, remaining, tiles, config);
        if (dest) cmdMoveCombatUnit(botIdentity, tx, tz, dest.tx, dest.tz);
        return;
    }

    if (!nearestEnemy) return;

    // 💡 遠距離ユニットは、自軍に近接ユニットがいるのに自分の方が敵に近い(=単独で最前線に
    //    出てしまう)場合は前進を控えて待機する(戦士を前に出す簡易な隊列判断)。
    //    近接ユニット自体が存在しない(弓兵しかいない)場合は待機せず通常通り前進する。
    if (isRangedUnit(unit) && hasMeleeUnits(civId, tiles) && !meleeEscortIsForward(civId, tx, tz, nearestEnemy, tiles)) {
        return;
    }

    const dest = pickMoveDestination(unit, tx, tz, nearestEnemy, remaining, tiles, config);
    if (dest) cmdMoveCombatUnit(botIdentity, tx, tz, dest.tx, dest.tz);
}

/**
 * 戦争中で、ミサイルの在庫がある自都市が1つでもあれば、そのうち1つから
 * pickMissileTarget が選んだ敵都市へ向けてミサイルを1発発射する(1ターンにつき最大1発。
 * 都市を一撃で消滅させる切り札のため乱発しない)。
 */
function runBotMissile(civId, tiles, config) {
    const target = pickMissileTarget(tiles, civId);
    if (!target) return;
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || !t.city || !(t.city.missiles > 0)) continue;
        const [tx, tz] = key.split(",").map(Number);
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) return;
        cmdLaunchMissile(bot, target.tx, target.tz);
        return;
    }
}

/**
 * 自国の戦闘ユニットすべてについて、1体ずつ行動を決定・実行する。
 * 💡 近接ユニット(戦士等)を遠距離ユニット(弓兵等)より先に処理する。こうすることで、
 *    同じターン内で戦士が先に前進した「後」の盤面を弓兵の移動判断(meleeEscortIsForward)が
 *    参照できるようになり、弓兵が戦士を追い越して単独で敵地に出るのを防ぎやすくなる。
 */
function runBotCombat(civId, config) {
    const startTiles = getTiles();
    const unitPositions = [];
    for (const key in startTiles) {
        const unit = startTiles[key].combatUnit;
        if (unit?.ownerId === civId) {
            const [tx, tz] = key.split(",").map(Number);
            unitPositions.push({ tx, tz, ranged: isRangedUnit(unit) });
        }
    }
    if (unitPositions.length === 0) return;
    unitPositions.sort((a, b) => Number(a.ranged) - Number(b.ranged));

    // 💡 combatコマンドはtx,tzを直接引数で受け取るため、位置に依存しない共通のBot識別子でよい。
    const bot = makeBotIdentity(civId, 0, 0, config);
    if (!bot) return;

    for (const pos of unitPositions) {
        const tiles = getTiles();
        const unit = tiles[`${pos.tx},${pos.tz}`]?.combatUnit;
        // 💡 このループの前半の行動(占領・撃破)で既に消滅/移動している場合があるため、
        //    実行直前に最新状態を読み直して確認する。
        if (!unit || unit.ownerId !== civId) continue;
        runBotCombatUnit(civId, pos.tx, pos.tz, unit, tiles, config, bot);
    }
}

/** 指定したBot国家の1ターン分の行動をまとめて実行する。 */
export function runBotTurn(civId) {
    const config = getMapConfig();
    if (!config) return;

    let tiles = getTiles();
    let hasCity = false;
    for (const key in tiles) {
        if (tiles[key].ownerId === civId && tiles[key].city) { hasCity = true; break; }
    }

    // 1. 都市が1つも無ければ、最初の都市(首都)を建てて今ターンはそこで終える。
    if (!hasCity) {
        const site = pickFirstCitySite(tiles);
        if (site) {
            const bot = makeBotIdentity(civId, site.tx, site.tz, config);
            if (bot) cmdSettle(bot);
        }
        return;
    }

    // 💡 自国の都市の近くに敵ユニットがいるかどうか。以降の拡張・生産・研究の判断に使う。
    const threatened = computeThreatLevel(civId, tiles);

    // 2. 開拓権があれば新都市を建てる(1ターン1つまで)。ただし脅威がある間は、拡張より
    //    防衛(生産・戦闘)を優先するため新都市の建設を見送る。
    const turn = getTurnState();
    if (!threatened && (turn.playerRights?.[civId] ?? 0) > 0) {
        const site = pickNewCitySite(tiles, civId);
        if (site) {
            const bot = makeBotIdentity(civId, site.tx, site.tz, config);
            if (bot) cmdSettle(bot);
        }
    }

    // 3. 領有(最大 MAX_CLAIMS_PER_TURN マスまで)。
    for (let i = 0; i < MAX_CLAIMS_PER_TURN; i++) {
        tiles = getTiles();
        const site = pickClaimableTile(tiles, civId);
        if (!site) break;
        const bot = makeBotIdentity(civId, site.tx, site.tz, config);
        if (!bot) break;
        cmdClaim(bot);
    }

    // 4. 首都に余裕があれば開拓権を取得する(次ターン以降の新都市建設のため)。
    tiles = getTiles();
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId && t.city?.isCapital) {
            const bot = makeBotIdentity(civId, 0, 0, config);
            if (bot) cmdBuyRights(bot);
            break;
        }
    }

    // 5. 区域: 空き領有マス → 新規着工、完成済み区域 → 区域専用建造物の着工。
    //    どちらも「都市1つにつき同時に1つまで」の枠を共有するため、着工済みの都市を記録する。
    const startedDistrictCities = new Set();

    tiles = getTiles();
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || t.city || t.facility || t.district || t.underDistrictConstruction) continue;
        const [tx, tz] = key.split(",").map(Number);
        const cityKey = resolveOwningCityKey(tx, tz, t, civId, tiles);
        const cityTile = cityKey ? tiles[cityKey] : null;
        if (!cityTile?.city || cityTile.city.districtConstruction || startedDistrictCities.has(cityKey)) continue;
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) continue;
        const choice = pickDistrictChoice(t, cityTile.city, bot, tiles, cityKey);
        if (choice) { cmdStartDistrict(bot, choice); startedDistrictCities.add(cityKey); }
    }

    tiles = getTiles();
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || !t.district) continue;
        const [tx, tz] = key.split(",").map(Number);
        const cityKey = resolveOwningCityKey(tx, tz, t, civId, tiles);
        const cityTile = cityKey ? tiles[cityKey] : null;
        if (!cityTile?.city || cityTile.city.districtConstruction || startedDistrictCities.has(cityKey)) continue;
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) continue;
        const choice = pickDistrictBuildingChoice(t, cityTile.city, civId);
        if (choice) { cmdStartDistrictBuilding(bot, choice); startedDistrictCities.add(cityKey); }
    }

    // 6. 施設: 空き領有マスがあれば、労働者の行動回数が続く限り設置する。
    tiles = getTiles();
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || t.city || t.facility || t.district || t.underDistrictConstruction) continue;
        const [tx, tz] = key.split(",").map(Number);
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) continue;
        const choice = pickFacilityChoice(t, bot);
        if (choice) cmdInstallFacility(bot, choice);
    }

    // 7. 生産中でない都市があれば、何か生産を開始する。
    tiles = getTiles();
    // 💡 脅威時の防衛ユニット生産に上限・多様性を持たせるため、現在の都市数、戦士/弓兵/軍艦の
    //    保有数、ミサイル備蓄、戦争中かどうかをあらかじめ集計しておく(pickProductionChoiceへ渡す)。
    let unitCounts = { cityCount: 0, warriorCount: 0, archerCount: 0, battleshipCount: 0, missileStock: 0, atWar: false };
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId && t.city) {
            unitCounts.cityCount++;
            unitCounts.missileStock += t.city.missiles ?? 0;
        }
        if (t.combatUnit?.ownerId === civId) {
            if (t.combatUnit.id === "warrior") unitCounts.warriorCount++;
            else if (t.combatUnit.id === "archer") unitCounts.archerCount++;
            else if (t.combatUnit.id === "battleship") unitCounts.battleshipCount++;
        }
    }
    unitCounts.atWar = (turn.playerOrder ?? []).some((id) => id !== civId && isAtWar(civId, id));
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || !t.city || t.city.production) continue;
        const [tx, tz] = key.split(",").map(Number);
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) continue;
        const choice = pickProductionChoice(t.city, t, bot, threatened, unitCounts, tx, tz, tiles);
        if (choice) {
            cmdStartProduction(bot, choice);
            if (choice === "warrior") unitCounts.warriorCount++;
            else if (choice === "archer") unitCounts.archerCount++;
            else if (choice === "battleship") unitCounts.battleshipCount++;
        }
    }

    // 8. 研究・社会制度(マス座標に依存しないので位置は原点でよい)。脅威がある間は
    //    弓術(弓兵解禁)を優先し、無ければ経済・成長寄りの技術を優先する。
    const originBot = makeBotIdentity(civId, 0, 0, config);
    if (originBot) {
        autoStartProgress(originBot, "technology", threatened ? TECH_PRIORITY_THREATENED : TECH_PRIORITY_SAFE);
        autoStartProgress(originBot, "civic", CIVIC_PRIORITY);

        // 9. 外交: 届いた提案を承認し、条件を満たしていれば国力の高い相手へ関係を提案する。
        //    戦争中で圧倒的に劣勢なら自分から講和する。
        runBotDiplomacy(civId, originBot, tiles);
    }

    // 10. ミサイル: 戦争中で在庫があれば、敵都市(優先して相手の首都)へ1発発射する。
    tiles = getTiles();
    runBotMissile(civId, tiles, config);

    // 11. 戦闘: 自国の戦闘ユニットで、占領・攻撃・移動を行う。
    runBotCombat(civId, config);
}

/**
 * 現在の手番がBotである間、Botの行動→強制ターン終了を繰り返し、人間(または操作不能)の
 * 手番になるまで進める。ゲーム開始・ターン終了・強制ターン終了のいずれの後にも必ず
 * 呼ぶことで、「Botの手番なのに誰も操作せず止まったまま」になるのを防ぐ。
 *
 * 💡 全員Bot(観戦用の対戦)のような状況で手番が一瞬で連続進行してしまわないよう、
 *    1手番処理するごとに BOT_TURN_DELAY_TICKS だけ間を置いてから次の手番を処理する
 *    (system.runTimeoutによる自己再スケジュール。同期のwhileループではない)。
 *    人間の手番の直前に来る最初の1手だけは、この関数を呼んだ側の処理と同じタイミングで
 *    即座に実行される(=遅延は「Bot→Bot」の連続分にのみ効く)。
 * 💡 遅延を挟む都合上、待機中に手番状況が変わる可能性がある(例: 待機中にOPが
 *    強制ターン終了を実行した場合)。再開時に毎回 getTurnState() を読み直し、
 *    その時点でも本当にBotの手番であることを確認してから行動するため、
 *    人間の手番を誤ってBotが代行してしまうことはない。
 * 💡 以前はここに「N手進めたら強制的に処理を打ち切る」回数上限があったが、全員Botの対戦
 *    (観戦用途)ではその上限に達した瞬間、以後は誰も advanceUntilHuman() を呼び直さないため
 *    ゲームがそこで完全に停止してしまう不具合になっていたため撤去した。同期whileループ版の
 *    名残りで「無限ループでサーバーが固まる」ことを懸念した安全弁だったが、system.runTimeout
 *    による自己再スケジュール方式ではそもそも毎回制御を手放すため固まる心配が無く、
 *    不要な安全弁だった。ゲームの終了自体は turn.started (ゲームリセット/勝利による終了)で
 *    自然に止まる。
 */
function advanceUntilHuman() {
    const turn = getTurnState();
    if (!turn.started || !Array.isArray(turn.playerOrder) || turn.playerOrder.length === 0) return;
    if (!isBotCiv(turn.playerOrder[turn.currentIndex])) return;

    runBotTurn(turn.playerOrder[turn.currentIndex]);
    const result = forceEndTurn();
    if (!result.ok) return;

    const delayTicks = getMatchSettings().botTurnDelayTicks ?? DEFAULT_BOT_TURN_DELAY_TICKS;
    system.runTimeout(() => advanceUntilHuman(), delayTicks);
}

/** startGame() を呼んだ後、必要ならBotの手番を自動で進める。 */
export function startGameAuto() {
    const result = startGame();
    advanceUntilHuman();
    return result;
}

/** endTurn(player) を呼んだ後、必要ならBotの手番を自動で進める。 */
export function endTurnAuto(player) {
    const result = endTurn(player);
    advanceUntilHuman();
    return result;
}

/** forceEndTurn() を呼んだ後、必要ならBotの手番を自動で進める。 */
export function forceEndTurnAuto() {
    const result = forceEndTurn();
    advanceUntilHuman();
    return result;
}

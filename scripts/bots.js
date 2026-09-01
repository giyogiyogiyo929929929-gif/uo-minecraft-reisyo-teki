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
// 自国の都市の近くにいる、外交協定の無い敵ユニットの戦闘力の合計がTHREAT_POWER_THRESHOLDを
// 超える場合、そのターンは「脅威あり」と判定する(computeThreatLevel)。この判定1つを、
// 拡張(新都市の建設可否)・生産の優先順位・研究の優先順位という3つの判断に横断的に使うことで、
// 「危険な時は防衛、安全な時は経済成長」というシンプルだが一貫した戦略を表現している。
// 単独ユニット1体が素通りする程度では過剰反応しないよう、戦闘力の合計で段階的に判定する
// (敵ユニットが1体でもいれば即座に脅威ありとしていた旧仕様は過敏すぎたための調整)。
// 警戒距離は関係により変える: 戦争状態(war)の相手はTHREAT_RADIUS_WAR(実際に領土へ侵入・
// 攻撃してくる可能性がある)、「関係なし」(none)の相手はより短いTHREAT_RADIUS_NONE
// (宣戦布告されない限り領土に入って来られず実害が無いため)。
//
// 【戦略性: 宣戦布告(declareWar)・講和(sendRequest(type:"peace"))について】
// diplomacy.js の追加により、攻撃・都市の占領・他国領土への進入は戦争状態(war)の相手にしか
// 行えなくなった。そのためBotは、自国より明らかに弱い「関係なし」の相手には自分から
// 宣戦布告して征服を狙い(AGGRESSION_POWER_RATIO)、逆に明らかに強い相手には不可侵条約→
// 同盟を提案する(DIPLOMATIC_THREAT_POWER_RATIO)。強すぎず弱すぎない相手には何もしない
// (runBotDiplomacy)。自分発の宣戦布告は、国力比の条件に加えて「ゲーム開始からある程度の
// ターン数(AGGRESSION_MIN_TURN)が経過している」「相手の領土が自国から一定距離
// (AGGRESSION_BORDER_RADIUS)以内にある」の2つも満たす必要がある(hasNearbyTerritory)。
// これは、序盤の未成熟な国力差(都市数の差がそのまま国力比に直結しやすい)だけで
// 即座に開戦してしまう挙動や、地理的に全く接点の無い遠方の国家へ意味もなく宣戦布告して
// しまう挙動を防ぐための安全弁で、「好戦的すぎる」という調整要望を受けて追加した
// (宣戦布告自体はcivic・試合の設定を問わず常に行える。応戦や既存の戦争の継続にはこれらの
// 制限はかからない)。また、戦争中の相手が自国よりPEACE_SUE_POWER_RATIO倍以上強くなった
// (圧倒的に負けている)場合は、自分から講和を提案する(相手の承諾が必要。試合の設定で
// peaceEnabledが無効な場合は試みない。§15参照)。この倍率はAGGRESSION_POWER_RATIO
// (宣戦布告の閾値)より意図的に大きくしてあり、宣戦布告した瞬間に相手がすぐ講和して
// 戦争が実質発生しなくなる(閾値が対称なせいで往復するだけになる)のを防いでいる。
//
// 【毎ターンの自動行動】
// 1. 都市が1つも無ければ、空きマス(資源があれば最優先、次に狭くない水域に隣接する
//    沿岸のマスを優先)に最初の都市(首都)を建てる。
// 2. 脅威が無く、開拓権があれば、自国の空き領地マス(既存の自国都市からMIN_CITY_SPACING未満の
//    近すぎる場所は除外した上で、資源、次に沿岸を優先)に新都市を建てる(脅威がある間は
//    拡張より防衛を優先し、新都市の建設を見送る)。沿岸に都市を建てることで、その都市が
//    帆船(7.参照)を生産できるようになる。
// 3. 自国の領地に隣接する未所有マス(資源があれば最優先、次に狭くない水上マスを優先)を、
//    最大3マス/ターンまで領有する。1〜2マスしかない狭い水域(MIN_WATER_BODY_SIZE未満)は
//    候補にすら含めない。
// 4. 首都の人口に余裕があれば開拓権を取得する。
// 5. 空き領有マスがあり、その帰属都市が区域(専用建造物含む)を建設中でなければ、
//    着手できる区域(新規着工分のみ。同じ都市に複数の候補マスがある場合は、隣接ボーナスが
//    最も大きいマスを選ぶ)または区域専用建造物(社など。着工先は完成済み区域のマス自体に
//    固定されるため選択の余地は無い)の建設を開始する。発電所3種(区域専用建造物)は、
//    対応する燃料資源(石炭/石油/ウラン)の在庫を1以上持っている場合のみ選ぶ(在庫の
//    当てもなく建てて維持費だけ払い続けるのを防ぐ)。財政危機時(下記)は区域・区域専用
//    建造物いずれも新規着工を見送る(どちらもゴールド維持費が発生するため)。
// 6. 空き領有マスがあれば、労働者の行動回数が続く限り施設を設置する。複数の候補マスがある
//    場合、隣接ボーナス(adjacency.js)が大きいマスから優先して設置する
//    (行動回数を使い切っても質の良いマスから埋まるようにするため)。財政危機時は、施設は
//    維持費がかからないことを利用して、ゴールドを稼ぐキャンプ/プランテーションを他の施設
//    より優先して設置する。
// 7. 生産中でない都市があれば、脅威があり、かつ都市数に見合った戦力にまだ達していなければ
//    防衛ユニット(近接・遠距離のうち数が少ない方のカテゴリを優先し、そのカテゴリの中では
//    前提技術を満たす最も戦闘力の高いユニットを選ぶ。例: 鉄器が無ければ剣士の代わりに
//    槍兵・戦士へ自動的にフォールバックする)を生産する。それ以外は労働者数に応じた
//    経済優先順位で、何かを生産キューに入れる(脅威時でも戦力が足りていれば経済を優先
//    することで、同じユニットだけを際限なく生産し続けることを防ぐ)。沿岸都市(隣接マスに
//    今すぐ配置できる空きの水上マスがある。既に隣接水上マスが自国/他国の船で埋まっている
//    場合は対象外)なら、沿岸都市数に見合った隻数(MAX_BATTLESHIPS_PER_COASTAL_CITY隻/
//    沿岸都市)の海軍ユニットをまだ持っていない限り、交易所の直後(市場・オベリスク・
//    訓練場・陸軍ユニットより前)に海軍ユニット(造船術を取得済みなら巡洋艦、なければ帆船)を
//    割り込ませる(末尾に追加すると他の生産に押し出されて事実上作られなくなるため、
//    あえて中盤の優先度にしてある。内陸都市では配置できないため対象外)。戦争中は、
//    都市1つにつき1基までの対空砲(ミサイル迎撃、§17参照)を穀物庫の直後に割り込ませる
//    (既に保有済みの都市は自動的に対象外になる)。経済・海軍・対空砲のいずれも生産すべき
//    ものが無く、戦争中で備蓄がMAX_MISSILE_STOCKPILE未満なら、最後の選択肢としてミサイルを
//    生産する。財政危機時(国庫がBOT_GOLD_CRISIS_THRESHOLD以下)は、経済優先順位のうち
//    新たにゴールド維持費が発生する建造物(category:"building")の着工を見送る
//    (戦時中の壁・対空砲は都心防衛に直結するため例外)。ユニット生産(worker含む)は
//    財政状況に関わらず変わらない(維持費よりも防衛・拡張を優先する)。防衛ユニットを選ぶ際、
//    近くの敵に騎兵(cavalry)がいれば、対騎兵(antiCavalry)ユニット(槍兵・長槍兵)を
//    同じカテゴリ内で優先する(combat.jsのUNIT_CLASS_COUNTERS: antiCavalry→cavalryは
//    戦闘力+10)。
// 8. 研究・社会制度が未選択なら、脅威がある間は軍事技術(弓術・青銅器・騎乗等)を優先し、
//    無ければ経済・成長寄りの技術を優先して、条件を満たす最初の項目を自動選択する
//    (TECH_PRIORITY_SAFE/THREATENED/CIVIC_PRIORITYに載っていない項目も、autoStartProgressが
//    自動的に末尾へ回して拾うため取りこぼさない)。
// 9. 外交の記憶: 前回の外交処理時点の関係(civ:lastRelations)と現在を比較し、不可侵条約/
//    同盟だった相手が(自分は何もしていないのに)戦争に変わっていれば「裏切られた」と判定し、
//    civ:grudgesに記録する。届いている外交提案は全て承認する(自国にとってノーリスクなため。
//    ただしグラッジがある相手からの提案は拒否する)。その後、他の全国家(同盟の相手を除く)に
//    ついて判定する。戦争中の相手は、自国が圧倒的に劣勢なら講和する。それ以外の相手は、
//    自国より明らかに弱く(AGGRESSION_POWER_RATIO。グラッジがある相手はより緩い
//    AGGRESSION_POWER_RATIO_GRUDGE=互角で可)、既に他の誰とも戦争中でなく(二正面作戦の回避)、
//    ゲーム開始から一定ターン数(AGGRESSION_MIN_TURN)が経過しており、かつ相手の領土が自国と
//    近い(AGGRESSION_BORDER_RADIUS以内)場合に限り宣戦布告する。明らかに強ければ(civic・
//    試合の設定が許せば)不可侵条約→同盟を提案する(グラッジがある相手には提案しない)。
//    最後に現在の関係をlastRelationsとして保存し直す。
// 10. 宗教: 宗教を未創始で条件(聖地・国家全体の信仰力100)を満たしていれば創始する。
//     創始済みなら、購入条件(建造物/審問開始状況)を満たし、実際の購入コスト(購入するたびに
//     +30、§11参照)を賄える都市があれば宗教ユニットを購入する。自国の宗教ユニットごとに、
//     次の優先順で行動する: (a) 攻撃可能(使徒・審問官)なら、隣接する敵の宗教ユニットを
//     今ターンまだ攻撃していない限り最優先で攻撃する(反撃なし。以降の行動を妨げない)。
//     (b) 使徒は、審問が未開始かつ布教力が満タンなら審問を開始する(一度きりの特殊能力。
//     国家全体が以後審問済みになり審問官を購入可能に。この使徒自身は消滅する)。
//     (c) 布教可能(伝道者・使徒)なら、隣接(マス距離1)する都市があり今ターン未布教で
//     布教力が残っていれば布教する(複数隣接していれば自国の宗教がまだ主流でない都市を優先)。
//     (d) 弾圧可能(審問官)なら、今立っているマスが何らかの都市の領地に属していれば、
//     布教力を1消費してその都市の自国以外の宗教の圧力を80%削減する。(e) それ以外は、
//     自国の宗教がまだ主流でない都市を最優先目標として、そこへ向けて移動する(無ければ
//     最も近い都市)。宗教ユニットは地形・所有者を問わず移動できる仕様(§13参照)のため、
//     戦闘ユニットのような8方向の経路探索は行わず、移動力の範囲内で目標に最も近いマスを
//     単純に総当たりで選ぶ。宗教ユニットが撃破されると、最寄りの都市の宗教的圧力が
//     ±1000変動する(§11)。
// 11. 戦争中で、ミサイルの在庫がある都市が1つでもあれば、敵都市(対空砲の無い都市を最優先、
//     その中でも相手の首都を優先。対空砲のある都市は迎撃され無駄撃ちになりやすいため後回し)へ
//     1発だけミサイルを発射する(都市を一撃で消滅させる切り札のため、1ターンにつき最大1発)。
// 12. 自国の戦闘ユニットごとに、次の優先順で行動する(攻撃・追跡・占領は戦争状態の
//     相手のみが対象。「関係なし」・不可侵条約・同盟の相手は対象にしない)。近接ユニット
//     (戦士等)を遠距離ユニット(弓兵等)より先に処理することで、(g)の移動判断が同ターン内の
//     戦士の前進結果を踏まえられるようにしている。(e)(g)(h)の移動(直線移動)は、移動後に
//     movementRemainingが残っていれば同じユニットがこのターン中に(a)から判定をやり直す
//     (advanceAfterBotMove。最大MAX_MOVE_HOPS_PER_TURN回)ため、1ユニットが移動力を使い切る
//     まで複数マス移動でき、移動の結果その場で攻撃可能になれば同じターンで(c)の攻撃も行う:
//     (a) 無防備な敵都市(都心のHPが既に0)の上で今ターン未行動なら占領する。
//     (b) 同じマスに敵(同盟関係の無い)の宗教ユニットがいて移動力が満タンなら、異教徒として
//         排除する(cmdPurgeHeretic)。一方的かつ確実に成功するため、成否がランダムな
//         攻撃(c)より先に判定する。
//     (c) 攻撃範囲内に敵ユニットがいれば、まず「今の攻撃力(包囲ボーナス込み)で最低ダメージ
//         ロールでも確実に撃破できる相手」(combat.js の canGuaranteeKill)を最優先で狙う
//         (中途半端に複数体を削るより確実に数を減らす)。確実に倒せる相手が複数/皆無の場合は、
//         その中で包囲ボーナス(countFlankingAllies。既にその敵に隣接している味方ユニットの数)
//         が最大の相手を選び、同数ならHPが最も低い相手を選んで攻撃する。
//     (d) 攻撃範囲内に敵ユニットはいないが敵の都市(都心)があれば、都心のHPが最も低い都市を
//         優先して攻城する(cmdAttackCity。§13。都心はHPを0にしない限り占領できないため、
//         これが無いとBotは都市を一切陥落させられなくなる)。
//     (e) HPが低ければ(RETREAT_HP_RATIO未満)、最寄りの自都市へ撤退する。
//     (f) 自都市を守備中で、近く(GARRISON_ALERT_RADIUS以内)に敵がいなければ持ち場を守る。
//     (g) 自分は健在で、近く(ESCORT_RADIUS以内)に撤退中の負傷した味方がいれば
//         (かつ最寄りの敵と同じかそれ以上に近ければ)、敵を追うより先にその護衛(合流)へ
//         向かう(単独で撤退する負傷ユニットが道中で各個撃破されるのを防ぐ)。
//     (h) それ以外は最も近い敵(ユニットまたは都市)へ向けて移動する(8方向のうち目標に
//         最も近づけるマスを選ぶ簡易な経路探索。1手先読みの貪欲法であり、行き止まりを
//         事前に見抜いて迂回するような本格的なパス探索ではないが、直進ルートが地形・
//         他国領土・占有マスで塞がっていても、他の方向から迂回できればそちらを選べる)。
//         この探索(撤退・護衛・追跡いずれの移動判断でも共通)がSTUCK_TURNS_FOR_SIDESTEP
//         ターン連続で失敗した(=目標に近づける移動先が1つも無かった)ユニットは、次回
//         以降は目標に近づかない移動(横移動・後退)も許可して再挑戦する(attemptMove)。
//         迂回しても回り込めない完全な袋小路でない限り、これで数ターン以内に動き出せる。
//         ただし遠距離ユニットは、自軍に近接ユニットが
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
import { getMapConfig, getTiles, getMatchSettings, broadcast, setTile } from "./state.js";
import { getTurnState, joinGame, startGame, endTurn, forceEndTurn, NUCLEAR_MELTDOWN_RISK_PER_TURN } from "./turns.js";
import { getVirtualCivById, addVirtualCiv, getCivStorageHandle } from "./civs.js";
import { getAdjacentTiles, getAdjacentTileEntries, resolveOwningCityKey, getAdjacencyBonus } from "./adjacency.js";
import { isImpassableTerrain, isWaterTerrain } from "./mapGen.js";
import { canStartProduction, getWorkerCount, PRODUCTION_DEFS } from "./production.js";
import { getDefinitions, getProgressState, startProgress, hasCompletedProgress } from "./progression.js";
import { getFacilityIds, getFacilityDef, canInstallFacility } from "./facilities.js";
import { getDistrictIds, getDistrictDef, canStartDistrict, getDistrictBuildingIds, getDistrictBuildingDef, canStartDistrictBuilding } from "./districts.js";
import { canUnitEnterTile, canUnitLandOnTile, tileDistance, getAttackableTargets, getAttackableCityTargets, isRangedUnit, countFlankingAllies, getFlankingBonus, canGuaranteeKill, CITY_MAX_HP, isMeleeUnitClass, isRangedUnitClass, isNavalUnitClass } from "./combat.js";
import { getAllBasedAirUnitsForPlayer } from "./airbase.js";
import { getRelation, getRequestsFor, sendRequest, acceptRequest, hasDiplomaticAgreement, isAtWar, declareWar } from "./diplomacy.js";
import { hasFoundedReligion, getReligiousUnitDef, getReligiousUnitIds, getCityDominantReligion, getReligiousUnitCost, hasStartedInquisition } from "./religion.js";
import {
    cmdClaim, cmdSettle, cmdBuyRights, cmdStartProduction,
    cmdInstallFacility, cmdStartDistrict, cmdStartDistrictBuilding,
    cmdMoveCombatUnit, cmdAttackCombatUnit, cmdAttackCity, cmdCaptureCity, cmdHealCombatUnit, cmdPurgeHeretic,
    cmdLaunchMissile,
    cmdFoundReligion, cmdBuyReligiousUnit, cmdMoveReligiousUnit, cmdProselytize,
    cmdAttackReligiousUnit, cmdStartInquisition, cmdInquisitorSuppress,
} from "./commands.js";

const TILE_SIZE = 5;
const MAX_CLAIMS_PER_TURN = 3;
// 💡 Bot同士の対戦(全員Botの手番が連続する状況)が一瞬で終わってしまわないよう、
//    Botの手番から次のBotの手番へ移る際にこの間隔(tick、20tick=1秒)だけ間を置く。
//    人間の手番の直前・直後の「最初の1手」はこの遅延を挟まず即座に処理される
//    (advanceUntilHumanの実装を参照)。既定値だが、実際の間隔は試合の設定
//    (state.js の getMatchSettings().botTurnDelayTicks)からOPが変更できる。
const DEFAULT_BOT_TURN_DELAY_TICKS = 5;
// 💡 陸軍ユニットを近接/遠距離の2カテゴリに分類し、各カテゴリ内は「今生産可能な中で最も
//    戦闘力の高いユニット」が優先されるようにする(前提技術が無ければ自動的に下位ユニットへ
//    フォールバックする。canStartProductionが前提技術を満たさない選択肢を弾くのを利用するだけで、
//    ここには判定ロジックを重複させない)。カタパルトは遠距離戦闘力こそ最大だが近接戦闘力が
//    低い攻城ユニットのため、フォールバック順ではクロスボウ兵の下(=より打たれ強い方を先に
//    使い切ってから頼る)にしてある。
const MELEE_UNIT_PRIORITY = ["tank", "modernInfantry", "musketman", "swordsman", "knight", "pikeman", "spearman", "horseman", "warrior"];
const RANGED_UNIT_PRIORITY = ["machineGunner", "artillery", "crossbowman", "cannon", "catapult", "archer"];
/** production.jsのunitClass(melee/antiCavalry/cavalry)を基準に、このユニットIDが近接系かどうかを判定する。 */
function isMeleeProductionId(id) {
    return isMeleeUnitClass(PRODUCTION_DEFS[id]?.unitClass);
}
/** production.jsのunitClass(ranged/siege)を基準に、このユニットIDが遠距離系かどうかを判定する。 */
function isRangedProductionId(id) {
    return isRangedUnitClass(PRODUCTION_DEFS[id]?.unitClass);
}
/** production.jsのunitClass(naval)を基準に、このユニットIDが海軍系かどうかを判定する。 */
function isNavalProductionId(id) {
    return isNavalUnitClass(PRODUCTION_DEFS[id]?.unitClass);
}
// 💡 生産の優先順位。労働者が少ないうちは労働者を優先し、増えたら建造物/防衛ユニットへ回す。
// 脅威(THREAT_RADIUS以内の敵ユニット)が無い間の優先順位。
const PRODUCTION_PRIORITY_SAFE_EARLY = ["worker", "granary", "tradingPost", "market", "obelisk", "trainingGround", "wall", ...MELEE_UNIT_PRIORITY, ...RANGED_UNIT_PRIORITY];
const PRODUCTION_PRIORITY_SAFE_LATE = ["granary", "tradingPost", "market", "obelisk", "trainingGround", "wall", ...MELEE_UNIT_PRIORITY, ...RANGED_UNIT_PRIORITY, "worker"];
const WORKER_COUNT_THRESHOLD = 3;
// 💡 脅威時でも際限なく戦士/弓兵を生産し続けると、経済(労働者・建造物)が完全に止まり、
//    かつ同じユニットばかりになってしまうため、都市数に対してこの倍率までの戦闘ユニット
//    (戦士+弓兵の合計)を持てば、脅威時でも経済優先度に戻す上限とする。
const MAX_COMBAT_UNITS_PER_CITY = 3;
// 💡 沿岸都市1つにつき保有してよい帆船の隻数の目安。内陸都市は帆船を配置できないため、
//    上限は「沿岸都市の数×この値」で計算する(unitCounts.coastalCityCount参照)。
const MAX_BATTLESHIPS_PER_COASTAL_CITY = 2;

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
// 💡 THREAT_RADIUS以内にいる、外交協定の無い敵ユニットの戦闘力(combatStrength等)の合計が
//    この値を超えて初めて「脅威あり」と判定する(computeThreatLevel)。以前は範囲内に敵が
//    1体でもいれば即座に脅威ありとしていたが、それだと素通りするだけの単独ユニット1体
//    (戦士20・弓兵15など)でも経済(生産・拡張・研究)を丸ごと防衛優先へ切り替えてしまい
//    過敏だったため、まとまった戦力(戦士2体分、または帆船1隻分を超える戦闘力)が
//    近づいて初めて反応するよう段階化した。
const THREAT_POWER_THRESHOLD = 20;
// 💡 移動判断(撤退・護衛・追跡のいずれか)で、目標に近づく移動先が見つからない状態が
//    この連続ターン数続いたら、目標に近づかない移動(横移動・後退)も許可して迂回を試みる
//    (pickMoveDestinationのallowSidestep引数。unit.stuckTurnsで連続失敗数を数える)。
const STUCK_TURNS_FOR_SIDESTEP = 3;
// 💡 相手の国力(都市数×10+戦闘力合計)が自国のこの倍率を超えたら「脅威国」とみなし、
//    自分から不可侵条約/同盟を提案する(弱い相手には自分から関係を提案しない=将来の
//    征服対象として残す)。
const DIPLOMATIC_THREAT_POWER_RATIO = 1.2;
// 💡 自国がこの倍率以上強ければ、「関係なし」の弱い相手に自分から宣戦布告して征服を狙う
//    (DIPLOMATIC_THREAT_POWER_RATIOと逆方向: 強い相手には和平、弱い相手には宣戦布告)。
//    国力は都市数の影響が大きい(都市数×10)ため、以前の1.3倍という閾値だと、都市を1つ
//    多く持っているだけ(ほぼ軍事力の差が無い状態)でも条件を満たして即座に宣戦布告して
//    しまい、「好戦的すぎる」「開始直後から戦争になる」という体感につながっていた。
//    明確な優位が無い限り攻めない、慎重な閾値に引き上げてある。
const AGGRESSION_POWER_RATIO = 1.8;
// 💡 (賢さ強化: 外交の記憶) 過去に不可侵条約/同盟を破って宣戦布告してきた(=裏切った)相手には、
//    通常のAGGRESSION_POWER_RATIO(1.8倍)ほど明確な優位が無くても、互角(この比率)以上で
//    あれば仕返しの宣戦布告に踏み切る。裏切った相手とは今後一切、不可侵条約・同盟も提案/
//    承認しない(isBotGrudgeHolder参照)。
const AGGRESSION_POWER_RATIO_GRUDGE = 1.0;
// 💡 開拓・拡張が落ち着くまでの猶予として、このターン数に達するまではBotから自分発の
//    宣戦布告(宣戦布告されての応戦や、既存の戦争の継続は含まない)を行わない。
//    ゲーム開始直後の未成熟な国力差(都市を1つ多く持っているだけ、等)で早期に開戦してしまう
//    「即戦争」感を和らげるための猶予期間。
const AGGRESSION_MIN_TURN = 10;
// 💡 自分発の宣戦布告は、相手の領有マスが自国の領有マスからこの距離(マス目)以内にある
//    場合のみ検討する(hasNearbyTerritory)。国力比だけで、地理的に全く接点の無い遠方の
//    国家へ意味もなく宣戦布告してしまう(艦隊も送れず実際には何もできない)不自然さを防ぐ。
const AGGRESSION_BORDER_RADIUS = 20;
// 💡 戦争中の相手の国力が自国のこの倍率を超えたら、自分から講和を提案する(相手の承諾が必要)。
//    AGGRESSION_POWER_RATIO(宣戦布告の閾値)より意図的に大きい値にしてあり、宣戦布告した
//    瞬間に相手がすぐ講和してしまい戦争が実質発生しなくなる(ヒステリシスの無い往復)のを防ぐ。
const PEACE_SUE_POWER_RATIO = 2.5;
// 💡 護衛撤退: 撤退中(HP低下)の味方がこの距離以内にいれば、健在なユニットは敵を追うより先に
//    合流へ向かう(単独で撤退する負傷ユニットが道中で各個撃破されるのを防ぐ)。
const ESCORT_RADIUS = 4;
// 💡 (賢さ強化: 複数回移動) 1ユニットが1ターン内に移動→再判定を繰り返せる最大回数。
//    移動のたびにmovementRemainingが必ず減るため理論上は無限ループしないが、念のための
//    保険的な上限(移動力の大きいユニットでも1ターンでここまで到達できれば十分)。
const MAX_MOVE_HOPS_PER_TURN = 5;
// 💡 都市を一撃で消滅させるミサイル(生産力200と重い)は、国家全体でこの発数までしか
//    備蓄しない(それ以上は他の生産に回す)。
const MAX_MISSILE_STOCKPILE = 2;

// 💡 研究の優先順位。安全な間は経済・成長寄り、脅威がある間は軍事技術(弓術・青銅器・騎乗・
//    鉄器等によるユニットの上位互換解禁)を最優先する。どちらのリストも、ここに載っていない
//    技術は autoStartProgress が自動的に末尾へ回して拾うため、載せ忘れても解禁自体は
//    されなくなるわけではない(優先度が下がるだけ)。
const TECH_PRIORITY_SAFE = [
    "pottery", "writing", "astrology", "mining", "animalHusbandry", "archery",
    "sailing", "currency", "smelting", "masonry", "education", "apprenticeship",
    "bronzeWorking", "horsebackRiding", "ironWorking", "shipBuilding", "engineering", "machinery",
    "gunpowder", "metallurgy", "industrialization", "electricity", "rocketry",
];
const TECH_PRIORITY_THREATENED = [
    "animalHusbandry", "archery", "mining", "masonry", "bronzeWorking", "horsebackRiding",
    "pottery", "writing", "astrology", "smelting", "ironWorking", "apprenticeship",
    "engineering", "machinery", "gunpowder", "metallurgy", "industrialization", "electricity",
    "rocketry", "sailing", "currency", "education", "shipBuilding",
];
// 💡 既存の「法典→使節団→外交」の連鎖に、政治哲学(軍制改革・神権政治・封建制度への橋渡し)と
//    商業(市場の前提の1つ)を割り込ませる。封建制度→騎士道は長槍兵・騎士(production.js)を
//    解放する、社会制度が直接ユニットを解放する初の例。
const CIVIC_PRIORITY = ["codeOfLaws", "emissaries", "politicalPhilosophy", "commerce", "diplomacy", "militaryTradition", "theocracy", "feudalism", "chivalry"];

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

    broadcast(`§a[Bot]【${civ.name}】が追加され、ゲームに参加しました。`);
    return { ok: true, message: `§a[Bot]【${civ.name}】を追加し、ゲームに参加させました。` };
}

/** civId の Bot用の擬似プレイヤーオブジェクトを作る。tx,tzのマス中心を location として持つ。 */
function makeBotIdentity(civId, tx, tz, config) {
    const handle = getCivStorageHandle(civId);
    if (!handle) return null;
    return {
        ...handle,
        // 💡 cmdMoveCombatUnit(commands.js)が、移動アニメーション(unitModels.js)を
        //    人間プレイヤーの操作時だけ待つための判別フラグ。Botは1ターンで複数ユニットを
        //    連続移動させるため、アニメーション待ちを挟むとターンが体感で遅くなる。
        isBot: true,
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

// 💡 連結する水上マスがこの枚数未満(=1〜2マスの池や短い川の切れ端)しかない水域は、
//    拠点としての価値が低いため、領有の対象から完全に除外する(狭い水上マスは無視してよい、
//    という前提)。海のように十分広い水域は、後述のとおり領有の優先候補として扱う。
const MIN_WATER_BODY_SIZE = 3;

/**
 * (tx, tz)を含む水上マスの連結範囲の広さを、cap枚まで数える(4方向連結のBFS)。
 * 海のように広い水域を全探索すると重くなるため、cap枚数えた時点で打ち切る
 * (「十分広いかどうか」の判定にのみ使う近似値であり、正確な総タイル数ではない)。
 */
function measureWaterBodySize(tx, tz, tiles, cap) {
    const startTile = tiles[`${tx},${tz}`];
    if (!isWaterTerrain(startTile?.type)) return 0;

    const visited = new Set([`${tx},${tz}`]);
    const queue = [[tx, tz]];
    let count = 0;
    while (queue.length > 0 && count < cap) {
        const [cx, cz] = queue.shift();
        count++;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx;
            const nz = cz + dz;
            const key = `${nx},${nz}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const t = tiles[key];
            if (t && isWaterTerrain(t.type)) queue.push([nx, nz]);
        }
    }
    return count;
}

/** この水上マスが、拠点として無視してよいほど狭い(連結範囲がMIN_WATER_BODY_SIZE未満)かどうか。 */
function isNarrowWaterTile(tx, tz, tile, tiles) {
    return isWaterTerrain(tile.type) && measureWaterBodySize(tx, tz, tiles, MIN_WATER_BODY_SIZE) < MIN_WATER_BODY_SIZE;
}

/**
 * 候補の中から優先順位に沿って1つ選ぶ: 資源のあるマス最優先、次に(狭くない)水上マス、
 * それ以外は残りからランダム。水上マスを積極的に領有・活用させる狙い(狭い水上マスは
 * 呼び出し元の候補収集時点で除外されている想定。isNarrowWaterTile参照)。
 */
function pickBestSite(candidates) {
    const withResource = candidates.filter((c) => c.tile?.resource);
    if (withResource.length > 0) return pickRandom(withResource);
    const withWater = candidates.filter((c) => isWaterTerrain(c.tile?.type));
    if (withWater.length > 0) return pickRandom(withWater);
    return pickRandom(candidates);
}

/** この陸地マス(tx, tz)が、狭くない(MIN_WATER_BODY_SIZE以上連結する)水域に隣接しているかどうか。 */
function isCoastalSite(tx, tz, tiles) {
    return getAdjacentTileEntries(tx, tz, tiles)
        .some((e) => isWaterTerrain(e.tile.type) && !isNarrowWaterTile(e.tx, e.tz, e.tile, tiles));
}

/**
 * 都市の建設候補(陸地マス)の中から優先順位に沿って1つ選ぶ: 資源のあるマス最優先、
 * 次に(狭くない)水域に隣接する沿岸のマスを優先し、それ以外は残りからランダムに選ぶ。
 * 沿岸に都市を建てることで、その都市が帆船(§8)を生産できるようになる(isCoastalCity)。
 */
function pickBestCitySite(candidates, tiles) {
    const withResource = candidates.filter((c) => c.tile?.resource);
    if (withResource.length > 0) return pickRandom(withResource);
    const coastal = candidates.filter((c) => isCoastalSite(c.tx, c.tz, tiles));
    if (coastal.length > 0) return pickRandom(coastal);
    return pickRandom(candidates);
}

/** 最初の都市(首都)を建てるのに良さそうな空きマスを選ぶ(資源、次に沿岸を優先)。 */
function pickFirstCitySite(tiles) {
    return pickBestCitySite(collectTiles(tiles, (t) => !t.ownerId && !t.city && !isImpassableTerrain(t.type) && !isWaterTerrain(t.type)), tiles);
}

// 💡 新都市は、自国の既存都市からこの距離(マス目)未満の場所には建てない。密集させると
//    互いの領地(施設・区域用のマス)を食い合って非効率になるため、少ない都市数で無駄なく
//    領土を広げられる間隔をあける。
const MIN_CITY_SPACING = 4;

/** (tx, tz) が、自国の既存都市すべてからMIN_CITY_SPACING以上離れているかどうか。 */
function isFarEnoughFromOwnCities(tx, tz, tiles, civId) {
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || !t.city) continue;
        const [ctx, ctz] = key.split(",").map(Number);
        if (tileDistance(tx, tz, ctx, ctz) < MIN_CITY_SPACING) return false;
    }
    return true;
}

/**
 * 新都市を建てられる、自国の空き領地マスを選ぶ(資源、次に沿岸を優先)。
 * 既存の自国都市に近すぎる(MIN_CITY_SPACING未満の)マスは候補から除外する。
 */
function pickNewCitySite(tiles, civId) {
    const candidates = collectTiles(tiles, (t) => t.ownerId === civId && !t.city && !isImpassableTerrain(t.type) && !isWaterTerrain(t.type))
        .filter((c) => isFarEnoughFromOwnCities(c.tx, c.tz, tiles, civId));
    return pickBestCitySite(candidates, tiles);
}

/**
 * 自国の領地に隣接する未所有マスを選ぶ(cmdClaimと同じ隣接ルール)。資源があれば最優先、
 * 次に(狭くない)水上マスを優先する。1〜2マスの狭い水域(MIN_WATER_BODY_SIZE未満)は
 * 候補にすら含めない(拠点として活用しにくいため無視する)。
 */
function pickClaimableTile(tiles, civId) {
    const candidates = collectTiles(tiles, (t, key) => {
        if (t.ownerId) return false;
        const [tx, tz] = key.split(",").map(Number);
        if (isNarrowWaterTile(tx, tz, t, tiles)) return false;
        return getAdjacentTiles(tx, tz, tiles).some((n) => n.ownerId === civId);
    });
    return pickBestSite(candidates);
}

/** この都市タイル(tx, tz)が隣接マスに水上マスを持つ(=帆船を配置できる沿岸都市)かどうか。 */
function isCoastalCity(tx, tz, tiles) {
    return getAdjacentTiles(tx, tz, tiles).some((n) => isWaterTerrain(n.type));
}

/**
 * (賢さ強化) この都市タイル(tx, tz)の隣接マスに、今すぐ配置できる空きの水上マスが1つでも
 * あるか。isCoastalCityは「水上マスが存在するか」だけを見るが、こちらは
 * production.jsのplaceProducedNavalUnitと全く同じ条件(水上マス かつ combatUnit が無い)で
 * 判定する。隣接水上マスが1〜2マスしかない都市で既に自国/他国の船が居座っていると、
 * isCoastalCityだけではBotが「配置先が無い」ことに気づかず、完成のたびに
 * cancelReason:"noNavalTile"で中止される(生産力は繰り越されるがターンを浪費する)海軍ユニットを
 * 選び続けてしまうため、生産候補に入れる前にここで空きの有無を見る。
 */
function hasFreeAdjacentWaterTile(tx, tz, tiles) {
    return getAdjacentTiles(tx, tz, tiles).some((n) => isWaterTerrain(n.type) && !n.combatUnit);
}

/**
 * 優先順位リストの中の targetId の直後に insertId を割り込ませた新しい配列を返す
 * (targetId が無ければ末尾に追加する)。元の配列は変更しない。
 */
function insertAfter(list, targetId, insertId) {
    const idx = list.indexOf(targetId);
    const result = [...list];
    result.splice(idx === -1 ? result.length : idx + 1, 0, insertId);
    return result;
}

/**
 * この都市で今から生産開始できる、優先度順で最初の生産物IDを選ぶ(無ければnull)。
 * 脅威があり、かつ都市数に見合った戦力(MAX_COMBAT_UNITS_PER_CITY)にまだ達していなければ
 * 防衛ユニットを最優先する。その際、近接ユニットと遠距離ユニットのうち数が少ない方
 * (同数なら遠距離)のカテゴリを選び、そのカテゴリの中で「今生産可能な最も戦闘力の高い
 * ユニット」(MELEE_UNIT_PRIORITY/RANGED_UNIT_PRIORITY。前提技術が無ければ自動的に
 * 下位ユニットへフォールバック)を選ぶことで、常に同じ下位ユニットだけ生産され続けるのを防ぐ。
 * それ以外(脅威が無い、またはもう十分な戦力がある)は労働者数に応じた経済優先順位を使う。
 * 沿岸都市(隣接マスに水上マスがある)であれば、まだ沿岸都市数に見合った隻数
 * (MAX_BATTLESHIPS_PER_COASTAL_CITY)の海軍ユニットを持っていない限り、交易所の直後
 * (市場・オベリスク・訓練場・陸軍ユニットより前)に海軍ユニット(造船術を取得済みなら
 * 巡洋艦を優先、無ければ帆船)を割り込ませる。末尾に追加すると常に他の生産に押し出されて
 * 事実上作られなくなるため、あえて中盤の優先度にしてある(内陸都市では海軍ユニットは
 * 配置できず生産が無駄になるため、沿岸都市でのみ選択肢に加える)。
 * 戦争中は、都市1つにつき1基までの対空砲(antiAir。ミサイル迎撃、§17参照)を、穀物庫の直後
 * (交易所・市場・オベリスク・陸軍ユニットより前)に割り込ませる。既に保有済みの都市は
 * canStartProduction側(uniquePerCity)が自動的に除外するため、ここでは戦争中かどうかしか
 * 見ていない(平時は無駄になりうる出費を避けて経済を優先する)。経済・海軍・対空砲の
 * いずれも生産すべきものが無く、かつ戦争中で備蓄が上限未満なら、都市を一撃で破壊できる
 * ミサイルを最後の選択肢として生産する。
 * @param {{ cityCount: number, coastalCityCount: number, meleeCount: number, rangedCount: number,
 *   battleshipCount: number, missileStock: number, atWar: boolean }} unitCounts
 */
// 💡 (簡素化) 以前はここでBotの分だけ独立して資源在庫(consumesResource)を確認していたが、
//    production.jsのcanStartProduction自体が在庫0を弾くようになったため(人間プレイヤーが
//    在庫0のまま着工できてしまうバグの修正)、これと完全に重複していた。canStartProduction
//    ひとつに任せれば、資源判定を2箇所で個別にメンテナンスする必要がなくなる。
function canBotStartProduction(city, id, tile, botIdentity, cityKey, tiles) {
    return canStartProduction(city, id, tile, botIdentity, cityKey, tiles).ok;
}

// 💡 老朽化した原子炉の事故率が一定を超えたら、脅威判定や通常優先度より先に
//    「原子炉の再稼働」を選ばせる(人間プレイヤーは自発的にできるが、Botはこれが無いと
//    原子力発電所を建てた瞬間から放置され続けてしまう非対称性への対策)。
const BOT_REACTOR_RESTART_RISK_THRESHOLD = 30;

// 💡 ゴールド経済(§23)の考慮。ユニット・建造物・区域・区域専用建造物はいずれも毎ターンの
//    ゴールド維持費(calculateGoldUpkeep、turns.js)がかかるが、以前のBotはこれを一切見ずに
//    生産・区域・区域専用建造物を選んでいたため、維持費だけが積み上がり続けて最終的に破産
//    (applyGoldBankruptcy、安いユニットから強制解散)に陥ることがあった。残高が0まで落ちて
//    から反応するのではなく、この閾値を下回った時点で「財政危機」とみなし前もって手を打つ
//    (実際に破産するとユニットが失われてしまい後戻りできないため、多少の余裕を持たせてある)。
const BOT_GOLD_CRISIS_THRESHOLD = 20;

// 💡 (バグ修正) ゴールドは全国家0から始まるため、上の閾値だけで判定すると首都建設直後の
//    数ターン(まだ収入が積み上がっていないだけで、維持費も何も無い)まで「財政危機」と
//    誤検知し、granary/tradingPostなどの着工を不必要に見送ってしまっていた。首都建設時に
//    刻む猶予ターン(goldCrisisGraceUntilTurn)が過ぎるまでは、残高に関わらず危機とみなさない。
const BOT_GOLD_CRISIS_GRACE_TURNS = 4;

/** このBotの国庫が財政危機(BOT_GOLD_CRISIS_THRESHOLD以下)にあるかどうか。 */
function isBotInGoldCrisis(botIdentity) {
    const graceUntilTurn = botIdentity.getDynamicProperty("goldCrisisGraceUntilTurn") ?? 0;
    if (getTurnState().turnNumber < graceUntilTurn) return false;
    return (botIdentity.getDynamicProperty("strategic_gold") ?? 0) <= BOT_GOLD_CRISIS_THRESHOLD;
}

function pickProductionChoice(city, tile, botIdentity, threatened, unitCounts, tx, tz, tiles) {
    if (city.nuclearPowerPlant && city.nuclearPowerPlantAge != null) {
        const meltdownRisk = Math.min(100, city.nuclearPowerPlantAge * NUCLEAR_MELTDOWN_RISK_PER_TURN);
        if (meltdownRisk >= BOT_REACTOR_RESTART_RISK_THRESHOLD && canBotStartProduction(city, "reactorRestart", tile, botIdentity, `${tx},${tz}`, tiles)) {
            return "reactorRestart";
        }
    }

    const wantMilitary = threatened
        && unitCounts.meleeCount + unitCounts.rangedCount < unitCounts.cityCount * MAX_COMBAT_UNITS_PER_CITY;
    if (wantMilitary) {
        let preferredOrder = unitCounts.rangedCount <= unitCounts.meleeCount
            ? [...RANGED_UNIT_PRIORITY, ...MELEE_UNIT_PRIORITY]
            : [...MELEE_UNIT_PRIORITY, ...RANGED_UNIT_PRIORITY];
        // 💡 (賢さ強化: 対抗ユニット優先) 近くに騎兵(cavalry)がいれば、対騎兵(antiCavalry)
        //    ユニット(槍兵・長槍兵)を同じ近接/遠距離カテゴリの並びの先頭へ引き上げる
        //    (combat.jsのUNIT_CLASS_COUNTERS: antiCavalry→cavalryは+10の戦闘力ボーナス)。
        if (unitCounts.nearbyEnemyClasses?.cavalry > 0) {
            const counters = preferredOrder.filter((id) => PRODUCTION_DEFS[id]?.unitClass === "antiCavalry");
            if (counters.length) preferredOrder = [...counters, ...preferredOrder.filter((id) => !counters.includes(id))];
        }
        for (const id of preferredOrder) {
            if (canBotStartProduction(city, id, tile, botIdentity, `${tx},${tz}`, tiles)) return id;
        }
    }

    const basePriority = getWorkerCount(city) < WORKER_COUNT_THRESHOLD ? PRODUCTION_PRIORITY_SAFE_EARLY : PRODUCTION_PRIORITY_SAFE_LATE;
    // 💡 isCoastalCityではなくhasFreeAdjacentWaterTileを使う: 隣接水上マスが既に自国/他国の
    //    船で埋まっている都市で選び続けると、完成のたびにplaceProducedNavalUnitが
    //    cancelReason:"noNavalTile"で中止し(生産力は繰り越されるがターンを浪費する)、
    //    Botが同じ無駄を繰り返してしまうため、「今空きがあるか」まで見て候補から外す。
    const canWantBattleship = unitCounts.battleshipCount < unitCounts.coastalCityCount * MAX_BATTLESHIPS_PER_COASTAL_CITY
        && hasFreeAdjacentWaterTile(tx, tz, tiles);
    // 💡 先に"battleship"(帆船)を、次に"cruiser"(巡洋艦)を、最後に"dreadnought"(戦艦)を
    //    同じ位置へ割り込ませることで、最終的な並びは [tradingPost, dreadnought, cruiser,
    //    battleship, ...] になる(=それぞれの前提技術が未取得ならcanStartProductionが失敗し、
    //    自動的に1段階下の海軍ユニットへフォールバックする)。
    let priority = basePriority;
    if (canWantBattleship) {
        priority = insertAfter(priority, "tradingPost", "battleship");
        priority = insertAfter(priority, "tradingPost", "cruiser");
        priority = insertAfter(priority, "tradingPost", "dreadnought");
    }
    // 💡 戦争中は都心の耐久力を上げる防壁(§13)を、対空砲よりさらに優先して割り込ませる
    //    (壁は都心のHP自体を守る基礎防衛、対空砲はミサイルという特定脅威への対策のため)。
    if (unitCounts.atWar) {
        priority = insertAfter(priority, "granary", "antiAir");
        priority = insertAfter(priority, "granary", "wall");
    }
    // 💡 財政危機時は、新たに毎ターンのゴールド維持費を増やす建造物(category:"building")の
    //    着工を見送る(壁・対空砲は都心防衛に直結するため、戦時中はそれでも優先する)。
    //    ユニット(worker含む)はこのフィルタの対象外(workerは一度きりのコストで維持費が無く、
    //    軍事ユニットは財政より防衛を優先すべきため)。
    if (isBotInGoldCrisis(botIdentity)) {
        priority = priority.filter((id) => id === "wall" || id === "antiAir" || PRODUCTION_DEFS[id]?.category !== "building");
    }
    for (const id of priority) {
        if (canBotStartProduction(city, id, tile, botIdentity, `${tx},${tz}`, tiles)) return id;
    }

    if (unitCounts.atWar && unitCounts.missileStock < MAX_MISSILE_STOCKPILE
        && canBotStartProduction(city, "missile", tile, botIdentity, `${tx},${tz}`, tiles)) {
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

// 💡 施設(facility)はゴールド維持費が一切かからない(calculateGoldUpkeepの対象外、§23)ため、
//    ゴールドを稼ぐ施設(flatYields.goldを持つもの。現状キャンプ/プランテーション)は財政危機時に
//    選んでも純粋な上振れしかない。通常時は他の施設(鍛冶場・牧場など)と同じ定義順の優先度で
//    構わないが、財政危機時だけこれらを他の施設より先に(設置できるマスなら)優先させる。
//    (バグ修正) 以前はここでIDを直書きしていたため、新しいゴールド産出施設を追加するたびに
//    facilities.jsとは別にここも手で更新する必要があった。FACILITY_DEFSのflatYields.goldから
//    自動的に導出する。
function getGoldIncomeFacilityIds() {
    return getFacilityIds().filter((id) => (getFacilityDef(id)?.flatYields?.gold ?? 0) > 0);
}

/** このマスに今から設置できる、定義順で最初の施設IDを選ぶ(無ければnull)。 */
function pickFacilityChoice(tile, botIdentity) {
    if (isBotInGoldCrisis(botIdentity)) {
        for (const id of getGoldIncomeFacilityIds()) {
            if (canInstallFacility(tile, id, botIdentity.id, botIdentity).ok) return id;
        }
    }
    for (const id of getFacilityIds()) {
        if (canInstallFacility(tile, id, botIdentity.id, botIdentity).ok) return id;
    }
    return null;
}

/** このマスに今から着工できる、定義順で最初の区域IDを選ぶ(無ければnull)。 */
function pickDistrictChoice(tile, city, botIdentity, tiles, cityKey) {
    // 💡 区域はそれ自体(まだ何も建てていなくても)DISTRICT_GOLD_UPKEEPがかかるため、
    //    財政危機時は新規着工を見送る(production側のbuilding着工見送りと同じ考え方)。
    if (isBotInGoldCrisis(botIdentity)) return null;
    for (const id of getDistrictIds()) {
        if (canStartDistrict(tile, id, botIdentity.id, city, botIdentity, tiles, cityKey).ok) return id;
    }
    return null;
}

/** この(完成済み区域の)マスに今から着工できる、定義順で最初の区域専用建造物IDを選ぶ(無ければnull)。 */
function pickDistrictBuildingChoice(tile, city, botIdentity) {
    // 💡 区域専用建造物もいずれもゴールド維持費がかかる(既定BUILDING_GOLD_UPKEEP、
    //    発電所3種は個別に3)ため、財政危機時は新規着工を見送る。
    if (isBotInGoldCrisis(botIdentity)) return null;
    for (const id of getDistrictBuildingIds()) {
        // 💡 (バグ修正) 以前はplayer(botIdentity)を渡していなかったため、requiresTechnology/
        //    requiresCivicを持つ建造物(library/cathedral/workshop/factory/発電所3種)を
        //    Botが一切選べなかった(前提無しのshrineだけが選ばれ続けていた)。
        if (!canStartDistrictBuilding(tile, id, botIdentity.id, city, botIdentity).ok) continue;
        // 💡 発電所(coal/oil/nuclearPowerPlant)は建設自体には燃料(fuelResource)在庫を要求しない
        //    (canStartDistrictBuildingは在庫を見ない)が、Botが燃料の当てもなく発電所を建てて
        //    毎ターンのゴールド維持費(goldUpkeep)だけを払い続ける無駄を避けるため、Bot側だけの
        //    追加ガードとして現在その燃料資源を1以上持っている場合のみ選ぶ(人間プレイヤーは
        //    在庫が無いと判断した上であえて先行投資することもできるため、canStartDistrictBuilding
        //    自体は変更しない)。
        const def = getDistrictBuildingDef(id);
        if (def?.fuelResource && (botIdentity.getDynamicProperty(def.fuelResource) ?? 0) < 1) continue;
        return id;
    }
    return null;
}

/**
 * (tx, tz)へ adjacencyBonuses(隣接ボーナスのルール一覧、施設/区域の定義が持つ)を適用した場合に
 * 得られる、周囲8マス分のボーナスの合計値(食料・生産力など複数種類あるものは単純合計して
 * 1つの比較用スコアにする)。施設・区域の「設置するマス」を、条件を満たす最初のマスではなく
 * 最もボーナスが大きいマスから優先させるために使う(pickFacilityPlacement/
 * pickDistrictPlacement)。
 */
function scoreAdjacencyPlacement(tx, tz, tiles, adjacencyBonuses) {
    if (!adjacencyBonuses) return 0;
    const bonus = getAdjacencyBonus(tx, tz, tiles, adjacencyBonuses);
    let total = 0;
    for (const key in bonus) total += bonus[key];
    return total;
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
    // 💡 (バグ修正) 航空ユニットは tile.combatUnit ではなく city.airbase.units に配置されるため、
    //    上のループでは一切カウントされず、航空戦力が国力評価(宣戦布告/講和の判断)に
    //    全く反映されていなかった。
    for (const { unit } of getAllBasedAirUnitsForPlayer(civId, tiles)) {
        power += unit.combatStrength ?? unit.rangedCombatStrength ?? 0;
    }
    return power;
}

/**
 * civId と targetId の領有マスの中に、互いに radius マス以内まで近づいているペアが
 * 1つでも存在するかどうかを判定する(宣戦布告の「国境を接しているか」の簡易判定)。
 * 最初に条件を満たすペアが見つかった時点で打ち切る。
 */
function hasNearbyTerritory(civId, targetId, tiles, radius) {
    const mine = [];
    const theirs = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId) mine.push(key);
        else if (t.ownerId === targetId) theirs.push(key);
    }
    for (const mKey of mine) {
        const [mx, mz] = mKey.split(",").map(Number);
        for (const tKey of theirs) {
            const [ttx, ttz] = tKey.split(",").map(Number);
            if (Math.max(Math.abs(mx - ttx), Math.abs(mz - ttz)) <= radius) return true;
        }
    }
    return false;
}

const GRUDGE_KEY = "civ:grudges";
const LAST_RELATIONS_KEY = "civ:lastRelations";

/**
 * BotのDynamic PropertyにJSON文字列として保存された値を読み取る共通ヘルパー。
 * 未設定・パース失敗・想定した形状(isValidShape)と異なる場合は、いずれもfallbackを返す
 * (呼び出し元ごとに「読み取り→JSON.parse→形状チェック→フォールバック」を書き直さないため)。
 */
function getBotJsonProperty(botIdentity, key, isValidShape, fallback) {
    try {
        const raw = botIdentity.getDynamicProperty(key);
        if (typeof raw === "string") {
            const parsed = JSON.parse(raw);
            if (isValidShape(parsed)) return parsed;
        }
    } catch (e) {}
    return fallback;
}

/**
 * (賢さ強化: 外交の記憶) このBotが過去に不可侵条約/同盟を破って宣戦布告された(=裏切られた)
 * 相手のcivId一覧を取得する。diplomacy.js自体は変更せず、あくまでこのBotの内部的な判断材料
 * として`civ:grudges`(JSON配列)にBot自身のストレージへ保存する。
 */
function getBotGrudges(botIdentity) {
    return getBotJsonProperty(botIdentity, GRUDGE_KEY, Array.isArray, []);
}

/** 前回runBotDiplomacyを実行した時点での、対象civIdごとの関係のスナップショットを取得する。 */
function getBotLastRelations(botIdentity) {
    return getBotJsonProperty(botIdentity, LAST_RELATIONS_KEY, (v) => v && typeof v === "object", {});
}

/**
 * 届いている外交提案を全て承認する(自国にとって関係樹立はリスクが無いため無条件で受け入れる。
 * ただしグラッジ(裏切り履歴)がある相手からの提案は除く)。その後、他の全国家それぞれについて
 * 次の判断を行う(宣戦布告は社会制度・試合設定を問わず常に行える。不可侵条約・同盟の提案には
 * civic 条件と試合の設定を要求する):
 * - 既に同盟なら何もしない。
 * - 既に戦争状態の相手は、試合の設定で講和(peaceEnabled)が有効、かつその相手の国力が
 *   自国のPEACE_SUE_POWER_RATIO倍を超えていれば(=圧倒的に負けている)、自分から講和して
 *   撤退する。戦闘そのもの(占領・攻撃・移動)は runBotCombat が別途担当する。
 * - 自国より明確に弱い(国力が自国のAGGRESSION_POWER_RATIO分の1以下、グラッジがある相手なら
 *   より緩いAGGRESSION_POWER_RATIO_GRUDGE分の1以下)「関係なし」の相手には、
 *   **既に他の誰とも戦争中でなく、ゲーム開始からAGGRESSION_MIN_TURNターン以上経過しており、
 *   かつ相手の領土が自国からAGGRESSION_BORDER_RADIUS以内に隣接している**場合に限り、
 *   自分から宣戦布告して征服を狙う(二正面作戦の回避、序盤の未成熟な国力差での即開戦の回避、
 *   地理的に接点の無い遠方の国家への無意味な宣戦布告の回避、の3つの安全弁)。
 *   1ターン中に複数の弱小国へ次々宣戦布告して同時に何ヶ国とも戦争になる事故も防ぐため、
 *   このターン中に(ループの途中で)新たに宣戦布告した時点でも以降の対象には適用する。
 * - 自国より明確に強い(国力が自国のDIPLOMATIC_THREAT_POWER_RATIO倍以上)相手にのみ、
 *   社会制度の条件を満たしていれば不可侵条約→同盟の順で関係を提案する(段階を踏む)。
 *   グラッジがある相手には(強くても)提案しない。
 * - どちらでもない(強すぎず弱すぎない)相手には何もしない。
 *
 * 【外交の記憶(グラッジ)について】
 * 関数の冒頭で、前回このBotの外交処理を実行した時点の関係(civ:lastRelations)と現在の関係を
 * 比較し、「不可侵条約/同盟」だった相手が(このBot自身は何もしていないのに)「戦争」に
 * 変わっていれば、相手が別ターンでdeclareWarした=裏切ったと判定してcivi:grudgesに記録する。
 * 以後そのcivIdとは不可侵条約・同盟を一切結ばず(提案・承認いずれも拒否)、宣戦布告の条件も
 * 緩和する(仕返し)。関数の最後に現在の全関係をlastRelationsとして保存し直し、次回の比較に使う。
 */
function runBotDiplomacy(civId, botIdentity, tiles) {
    const turn = getTurnState();

    const lastRelations = getBotLastRelations(botIdentity);
    let grudges = getBotGrudges(botIdentity);
    let grudgesChanged = false;
    for (const targetId of turn.playerOrder ?? []) {
        if (targetId === civId) continue;
        const previousRel = lastRelations[targetId];
        const currentRel = getRelation(botIdentity, targetId);
        if ((previousRel === "pact" || previousRel === "alliance") && currentRel === "war" && !grudges.includes(targetId)) {
            grudges = [...grudges, targetId];
            grudgesChanged = true;
            const myName = getCivStorageHandle(civId)?.name ?? civId;
            const targetName = getCivStorageHandle(targetId)?.name ?? targetId;
            broadcast(`§4[Grudge]【${myName}】は、協定を破って宣戦布告してきた【${targetName}】を記憶した。以後、協定は結ばない。`);
        }
    }
    if (grudgesChanged) botIdentity.setDynamicProperty(GRUDGE_KEY, JSON.stringify(grudges));

    const requests = getRequestsFor(botIdentity);
    for (const req of requests) {
        // 💡 (バグ修正) グラッジ(裏切り履歴)は「不可侵条約・同盟を結ばない」ためのものであり、
        //    講和(peace)提案まで拒否すると、恨みのある相手とは永久に戦争状態から抜け出せなく
        //    なってしまう(講和が承認された流れの提案キューを共有するようになったため)。
        if (req.type !== "peace" && grudges.includes(req.fromId)) continue;
        const fromHandle = getCivStorageHandle(req.fromId) ?? { id: req.fromId, name: req.fromName };
        acceptRequest(botIdentity, fromHandle, req.id);
    }

    const diplomacyEnabled = getMatchSettings().diplomacyEnabled;
    const canPact = diplomacyEnabled && hasCompletedProgress(botIdentity, "civic", "emissaries");
    const canAlliance = diplomacyEnabled && hasCompletedProgress(botIdentity, "civic", "diplomacy");

    const myPower = computeCivPower(civId, tiles);
    // 💡 二正面作戦の回避: 既に誰かと戦争中なら、新たな相手へは宣戦布告しない。
    let atWarWithAnyone = (turn.playerOrder ?? []).some((id) => id !== civId && isAtWar(civId, id));
    for (const targetId of turn.playerOrder ?? []) {
        if (targetId === civId) continue;
        const targetHandle = getCivStorageHandle(targetId);
        if (!targetHandle) continue;

        const rel = getRelation(botIdentity, targetId);
        if (rel === "alliance") continue;
        const targetPower = computeCivPower(targetId, tiles);
        const isGrudgeHolder = grudges.includes(targetId);

        // 💡 戦争中に圧倒的な劣勢(相手の国力が自国のPEACE_SUE_POWER_RATIO倍超)になったら、
        //    自分から講和を提案する(相手の承諾が必要。sendRequestが同じ提案の重複送信は
        //    弾くため、承諾されるまで毎ターン送り続けても実害は無い)。試合の設定で講和
        //    (peaceEnabled)が無効なら、そもそも成立しないため試みない。
        if (rel === "war") {
            if (getMatchSettings().peaceEnabled && targetPower > myPower * PEACE_SUE_POWER_RATIO) {
                sendRequest(botIdentity, targetHandle, "peace");
            }
            continue;
        }

        // 💡 宣戦布告はcivic/試合設定を問わず常に行えるが、二正面作戦・序盤の即開戦・
        //    遠方国家への無意味な宣戦布告を避けるため、3つの条件をすべて満たす場合のみ行う。
        //    グラッジがある相手には、より緩い比率(互角以上)で仕返しの宣戦布告に踏み切る。
        const aggressionRatio = isGrudgeHolder ? AGGRESSION_POWER_RATIO_GRUDGE : AGGRESSION_POWER_RATIO;
        if (rel === "none" && !atWarWithAnyone && turn.turnNumber >= AGGRESSION_MIN_TURN
            && myPower > targetPower * aggressionRatio
            && hasNearbyTerritory(civId, targetId, tiles, AGGRESSION_BORDER_RADIUS)) {
            declareWar(botIdentity, targetHandle);
            atWarWithAnyone = true;
            continue;
        }
        if (isGrudgeHolder) continue; // 💡 裏切った相手とは不可侵条約・同盟を二度と結ばない。
        if (!canPact && !canAlliance) continue;
        if (rel === "none" && targetPower < myPower * DIPLOMATIC_THREAT_POWER_RATIO) continue;

        // 💡 いきなり同盟ではなく、まず不可侵条約を結んでから同盟へ格上げする(条件を両方
        //    満たしていても段階を踏む)。不可侵条約の社会制度が無い場合のみ同盟を直接提案する。
        if (rel === "none" && canPact) sendRequest(botIdentity, targetHandle, "pact");
        else if (rel === "none" && canAlliance) sendRequest(botIdentity, targetHandle, "alliance");
        else if (rel === "pact" && canAlliance) sendRequest(botIdentity, targetHandle, "alliance");
    }

    // 💡 次回このBotの外交処理が呼ばれたときに「相手側の行動による変化」を検出できるよう、
    //    今回のこの関数自身の変更も含めた最新の関係をスナップショットとして保存し直す。
    const newLastRelations = {};
    for (const targetId of turn.playerOrder ?? []) {
        if (targetId === civId) continue;
        newLastRelations[targetId] = getRelation(botIdentity, targetId);
    }
    botIdentity.setDynamicProperty(LAST_RELATIONS_KEY, JSON.stringify(newLastRelations));
}

/**
 * 指定した方向へ、今の移動力の範囲でこのユニットが進入できる最も遠いマスを探す。
 * 経路上の全マス(distance=1から順に辿る途中のマスも含む)が地形・外交関係・占有の
 * 観点で進入可能である必要があり、途中に障害物(海軍ユニットにとっての陸地、他国の
 * 「関係なし」領土、他ユニットなど)があればそこで探索を打ち切る。移動力が2以上の
 * ユニット(帆船など)が、間に挟まる陸地を飛び越えて別の水域へ「ワープ」してしまう
 * (=最終着地マスだけを見て、経路上のマスを検証していなかった)不具合の修正。
 */
function findValidMoveTarget(unit, tx, tz, dirX, dirZ, maxDist, tiles, config) {
    let farthest = null;
    for (let dist = 1; dist <= maxDist; dist++) {
        const ntx = tx + dirX * dist;
        const ntz = tz + dirZ * dist;
        if (ntx < 0 || ntz < 0 || ntx >= config.width || ntz >= config.height) break;
        const t = tiles[`${ntx},${ntz}`];
        if (!t) break;
        if (t.combatUnit) {
            // 💡 (バグ修正) 陥落済みの敵都市(駐留ユニットが残っているだけ)なら、そこへ
            //    着地(占領)することはできるが、そこを通り越して先へは進めない
            //    (駐留ユニットが健在な限り、通過点としては今まで通り塞がっている)。
            //    canUnitLandOnTileで地形・外交関係・都心HPも合わせて判定する(以前は
            //    isFallenEnemyCityTileの結果だけを見ており、例えば海軍ユニットが地形を
            //    無視して内陸の陥落都市に「着地」できてしまう抜け穴があった)。
            if (canUnitLandOnTile(unit, t)) farthest = { tx: ntx, tz: ntz };
            break;
        }
        if (!canUnitEnterTile(unit, t)) break;
        farthest = { tx: ntx, tz: ntz };
    }
    return farthest;
}

// 💡 pickMoveDestinationが試す8方向(斜め4 + 直交4)。目標方向への直進(斜め含む)だけでなく
//    全方向を候補にすることで、直進ルートが地形・他国領土・占有マスで塞がっていても、
//    迂回できる別ルートがあれば見つけられるようにする(完全なパス探索ではなく、
//    あくまで「今この一手で目標に一番近づけるマス」を選ぶ貪欲法)。
const MOVE_DIRECTIONS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * 目標地点へ向かって、今の移動力で進める最善のマスを選ぶ。
 * 8方向それぞれについて、その方向へ今の移動力の範囲で進入できる最も遠いマスを求め、
 * その中から目標地点までの距離が最も縮むマスを選ぶ(簡易な経路探索。深さ1手ぶんの
 * 貪欲法であり、行き止まりを事前に見抜いて迂回するような先読みはしない)。
 * どの方向へ動いても目標に近づけない(=完全に行き止まり)場合は null を返し、その場に留まる。
 * @param {boolean} [allowSidestep=false] true の場合、目標に近づく移動先が無くても、
 *   進入できる8方向のうち目標に最も近いマス(距離が縮まなくても、横移動・後退でもよい)を
 *   代わりに返す。数ターン同じ場所で行き詰まっているユニットに、迂回のきっかけを
 *   与えるための脱出モード(attemptMoveがunit.stuckTurnsを見て有効化する)。
 */
function pickMoveDestination(unit, tx, tz, target, remaining, tiles, config, allowSidestep = false) {
    const currentDist = tileDistance(tx, tz, target.tx, target.tz);
    let best = null;
    let bestDist = allowSidestep ? Infinity : currentDist;
    for (const [dirX, dirZ] of MOVE_DIRECTIONS) {
        const dest = findValidMoveTarget(unit, tx, tz, dirX, dirZ, remaining, tiles, config);
        if (!dest) continue;
        const dist = tileDistance(dest.tx, dest.tz, target.tx, target.tz);
        if (dist < bestDist) { bestDist = dist; best = dest; }
    }
    return best;
}

/**
 * pickMoveDestination() を呼びつつ、ユニットの「膠着カウンタ」(unit.stuckTurns)を管理する。
 * 目標に近づく移動先が見つかった場合はカウンタを0に戻す。見つからなかった場合は+1し、
 * その結果 STUCK_TURNS_FOR_SIDESTEP に達していれば、目標に近づかない移動(横移動・後退)も
 * 許可して再挑戦する(=迂回のための「別のアプローチ」)。それでも見つからなければ、
 * 本当に手詰まり(周囲8マス全てが進入不可)なので、その場に留まる。
 * 💡 移動に成功した場合はcmdMoveCombatUnitがタイルを保存するため、ここでの永続化は不要。
 *    移動できなかった場合はどのcmd*関数も呼ばれないため、カウンタの変化をここで明示的に
 *    保存する(保存しないと、次に誰かがこの行にsetTileするまでメモリ上にしか残らない)。
 */
function attemptMove(tx, tz, unit, target, remaining, tiles, config) {
    const stuck = (unit.stuckTurns ?? 0) >= STUCK_TURNS_FOR_SIDESTEP;
    const dest = pickMoveDestination(unit, tx, tz, target, remaining, tiles, config, stuck);
    const nextStuckTurns = dest ? 0 : (unit.stuckTurns ?? 0) + 1;
    if (unit.stuckTurns !== nextStuckTurns) {
        unit.stuckTurns = nextStuckTurns;
        if (!dest) {
            const tile = tiles[`${tx},${tz}`];
            if (tile) setTile(tx, tz, tile);
        }
    }
    return dest;
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
 * 対空砲(antiAir)が無く迎撃されない都市を最優先し、その中でも首都を優先する
 * (対空砲のある都市を狙うと迎撃されて無駄撃ちになりやすいため。都市を一撃で消滅させる
 * 切り札のミサイルを無駄にしないよう、確実に着弾する相手を優先する)。
 * スコア: 対空砲が無い(+2) + 首都である(+1)。最高スコアの都市を選ぶ
 * (対空砲の無い首都(3) > 対空砲の無い一般都市(2) > 対空砲のある首都(1) > 対空砲のある一般都市(0))。
 */
function pickMissileTarget(tiles, civId) {
    let best = null;
    let bestScore = -1;
    for (const key in tiles) {
        const t = tiles[key];
        if (!t.city || !t.ownerId || t.ownerId === civId) continue;
        if (!isAtWar(civId, t.ownerId)) continue;
        const [tx, tz] = key.split(",").map(Number);
        const score = (t.city.antiAir ? 0 : 2) + (t.city.isCapital ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = { tx, tz }; }
    }
    return best;
}

/**
 * 攻撃可能な相手の中から1つ選ぶ。最優先は「今の攻撃力(包囲ボーナス込み)で、最低ダメージ
 * ロールでも確実に撃破できる相手」(combat.js の canGuaranteeKill)。中途半端に複数体へ
 * ダメージを分散させるより、確実に1体ずつ数を減らす方が有利なため。確実に倒せる相手が
 * 複数/皆無の場合はそれぞれの中で、包囲ボーナス(その相手に既に隣接している味方ユニットの数、
 * combat.js の countFlankingAllies)が最大の相手を優先し、同数ならHPが最も低い相手を選ぶ
 * (確実に倒せる相手が無い場合も、包囲を活かして次善の一撃を狙う)。
 */
function pickBestAttackTarget(unit, targets, civId, fromTx, fromTz, tiles) {
    let best = null;
    let bestLethal = false;
    let bestScore = -1;
    let bestHp = Infinity;
    for (const t of targets) {
        const score = countFlankingAllies(t.tx, t.tz, civId, fromTx, fromTz, tiles);
        const lethal = canGuaranteeKill(unit, t.unit, getFlankingBonus(score));
        const hp = t.unit?.hp ?? t.unit?.maxHp ?? 0;
        const better = !best
            || (lethal && !bestLethal)
            || (lethal === bestLethal && score > bestScore)
            || (lethal === bestLethal && score === bestScore && hp < bestHp);
        if (better) { best = t; bestLethal = lethal; bestScore = score; bestHp = hp; }
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
 * 自国の都市からTHREAT_RADIUS以内にいる、外交協定の無い敵ユニットの戦闘力の合計が
 * THREAT_POWER_THRESHOLDを超えるかどうかを判定する。生産・拡張・研究の優先順位を
 * 防衛寄りに切り替えるかどうかの判定に使う。
 */
/** 自国都市の座標一覧。computeThreatLevel/computeNearbyEnemyClassCountsが同じ走査を
 *  それぞれ独立に行っていたため、共通のヘルパーとして1回にまとめる。 */
function getOwnCityPositions(civId, tiles) {
    const cityPositions = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId && t.city) {
            const [tx, tz] = key.split(",").map(Number);
            cityPositions.push({ tx, tz });
        }
    }
    return cityPositions;
}

function computeThreatLevel(civId, tiles) {
    const cityPositions = getOwnCityPositions(civId, tiles);
    if (cityPositions.length === 0) return false;

    let enemyPower = 0;
    for (const key in tiles) {
        const t = tiles[key];
        const enemyUnit = t.combatUnit;
        if (!enemyUnit || enemyUnit.ownerId === civId) continue;
        if (hasDiplomaticAgreement(civId, enemyUnit.ownerId)) continue;
        const radius = isAtWar(civId, enemyUnit.ownerId) ? THREAT_RADIUS_WAR : THREAT_RADIUS_NONE;
        const [tx, tz] = key.split(",").map(Number);
        if (!cityPositions.some((c) => tileDistance(c.tx, c.tz, tx, tz) <= radius)) continue;
        enemyPower += enemyUnit.combatStrength ?? enemyUnit.rangedCombatStrength ?? 0;
        if (enemyPower > THREAT_POWER_THRESHOLD) return true;
    }
    return false;
}

/**
 * (賢さ強化: 対抗ユニット優先) computeThreatLevelと同じ「自国都市からTHREAT_RADIUS_WAR/NONE
 * 以内、外交協定の無い敵」の走査条件で、今度は早期returnせず全件走査し、兵種(unitClass)
 * ごとの出現数を集計して返す。pickProductionChoiceがこれを見て、近くに騎兵(cavalry)が
 * いれば対騎兵(antiCavalry)ユニットを優先生産できるようにする(combat.jsのUNIT_CLASS_COUNTERS
 * を活かす)。脅威が無いターンは呼ばない前提(呼び出し元がthreatened===trueのときだけ呼ぶ)。
 */
function computeNearbyEnemyClassCounts(civId, tiles) {
    const counts = {};
    const cityPositions = getOwnCityPositions(civId, tiles);
    if (cityPositions.length === 0) return counts;

    for (const key in tiles) {
        const t = tiles[key];
        const enemyUnit = t.combatUnit;
        if (!enemyUnit || enemyUnit.ownerId === civId || !enemyUnit.unitClass) continue;
        if (hasDiplomaticAgreement(civId, enemyUnit.ownerId)) continue;
        const radius = isAtWar(civId, enemyUnit.ownerId) ? THREAT_RADIUS_WAR : THREAT_RADIUS_NONE;
        const [tx, tz] = key.split(",").map(Number);
        if (!cityPositions.some((c) => tileDistance(c.tx, c.tz, tx, tz) <= radius)) continue;
        counts[enemyUnit.unitClass] = (counts[enemyUnit.unitClass] ?? 0) + 1;
    }
    return counts;
}

/**
 * この都市で今から購入できる、定義順で最初の宗教ユニットIDを選ぶ(無ければnull)。
 * cmdBuyReligiousUnit自体が同じ条件を再検証するため、ここでの判定は「候補があるかどうか」の
 * 事前確認に過ぎない(必要建造物・審問開始状況の有無、実際の購入コスト(購入回数に応じて
 * 上昇する。getReligiousUnitCost参照)に対する信仰力の充足を見る)。
 */
function pickReligiousUnitChoice(tile, botIdentity) {
    for (const id of getReligiousUnitIds()) {
        const def = getReligiousUnitDef(id);
        if (!def) continue;
        if (def.requiresBuilding && !tile.city[def.requiresBuilding]) continue;
        if (def.requiresInquisitionStarted && !hasStartedInquisition(botIdentity)) continue;
        if ((tile.city.faithStorage ?? 0) < getReligiousUnitCost(botIdentity, def)) continue;
        return id;
    }
    return null;
}

/**
 * 布教の目標として最も価値のある都市(自国・他国問わず全ての都市が対象)を1つ選ぶ。
 * 宗教勝利は「生存する全ての国家の主流宗教が自国の宗教になる」ことが条件(religion.js参照)
 * なので、既に自国の宗教が主流になっている都市より、まだそうなっていない都市を優先し、
 * 同条件なら単純に近い都市を選ぶ(伝道者の限られた移動力・布教力を無駄にしないため)。
 */
function findBestMissionaryTarget(civId, tiles, fromTx, fromTz) {
    let best = null;
    let bestNeedsConversion = false;
    let bestDist = Infinity;
    for (const key in tiles) {
        const t = tiles[key];
        if (!t.city) continue;
        const [tx, tz] = key.split(",").map(Number);
        const needsConversion = getCityDominantReligion(t.city) !== civId;
        const dist = tileDistance(fromTx, fromTz, tx, tz);
        if (!best || (needsConversion && !bestNeedsConversion) || (needsConversion === bestNeedsConversion && dist < bestDist)) {
            best = { tx, tz };
            bestNeedsConversion = needsConversion;
            bestDist = dist;
        }
    }
    return best;
}

/**
 * 宗教ユニットの移動先を選ぶ。cmdMoveReligiousUnitには地形・所有者・経路上の障害物といった
 * 制約が一切無く(戦闘ユニットと違い、布教という性質上どの国の領土・地形へも移動できる設計。
 * combat.js参照)、移動力の範囲内(マス距離、8方向の直進である必要も無い)で移動先に他の
 * 宗教ユニットさえいなければどこへでも移動できるため、戦闘ユニットのpickMoveDestinationのような
 * 方向別の経路探索は不要で、単純に「移動力の範囲内で目標に最も近いマス」を総当たりで選べばよい。
 */
function pickReligiousMoveDestination(tx, tz, target, remaining, tiles, config) {
    let best = null;
    let bestDist = tileDistance(tx, tz, target.tx, target.tz);
    for (let dz = -remaining; dz <= remaining; dz++) {
        for (let dx = -remaining; dx <= remaining; dx++) {
            if (dx === 0 && dz === 0) continue;
            if (Math.max(Math.abs(dx), Math.abs(dz)) > remaining) continue;
            const ntx = tx + dx;
            const ntz = tz + dz;
            if (ntx < 0 || ntz < 0 || ntx >= config.width || ntz >= config.height) continue;
            const t = tiles[`${ntx},${ntz}`];
            if (!t || t.religiousUnit) continue;
            const dist = tileDistance(ntx, ntz, target.tx, target.tz);
            if (dist < bestDist) { bestDist = dist; best = { tx: ntx, tz: ntz }; }
        }
    }
    return best;
}

/** 隣接する(距離1の)敵(同盟関係の無い)宗教ユニットの座標を1つ返す(無ければnull)。 */
function findAdjacentEnemyReligiousUnit(civId, tx, tz, tiles) {
    for (const { tx: ntx, tz: ntz, tile } of getAdjacentTileEntries(tx, tz, tiles)) {
        const enemy = tile.religiousUnit;
        if (enemy && enemy.ownerId !== civId && !hasDiplomaticAgreement(civId, enemy.ownerId)) {
            return { tx: ntx, tz: ntz };
        }
    }
    return null;
}

/**
 * 1体の宗教ユニット(伝道者/使徒/審問官)の行動を決定・実行する。
 * (a) 攻撃可能(使徒・審問官)なユニットは、隣接する敵(同盟関係の無い)宗教ユニットがいて
 *     今ターンまだ攻撃していなければ、最優先で攻撃する(反撃なし。布教/弾圧とは独立した
 *     行動のため、この後の(c)(d)を妨げない)。
 * (b) 使徒は、審問が未開始かつ布教力が満タン(=一度も布教していない)なら、審問を開始する
 *     (一度きりの特殊能力)。国家全体が以後審問済み扱いになり審問官を購入できるようになる、
 *     長期的な価値の高い投資と判断し、機会があれば即座に行う。この使徒自身は消滅するため、
 *     残りの行動より先に判定して以降の処理を打ち切る。
 * (c) 布教可能(伝道者・使徒)なユニットは、隣接する都市があり今ターンまだ未布教で布教力が
 *     残っていれば布教する(複数隣接していれば自国の宗教がまだ主流でない都市を優先)。
 * (d) 弾圧可能(審問官)なユニットは、今立っているマスが何らかの都市の領地(所有者問わず)に
 *     属していれば、布教力を1消費してその都市を弾圧する(自国以外の宗教の圧力を80%削減)。
 * (e) それ以外は、findBestMissionaryTargetが選んだ都市(自国の宗教がまだ主流でない都市を
 *     優先)へ向けて移動する(伝道者/使徒は布教のための隣接を、審問官はその都市の領地への
 *     進入を目指す形になる)。
 */
function runBotReligiousUnit(civId, tx, tz, unit, tiles, config, botIdentity) {
    const def = getReligiousUnitDef(unit.id);

    if (def?.canAttack && !unit.hasAttackedThisTurn) {
        const attackTarget = findAdjacentEnemyReligiousUnit(civId, tx, tz, tiles);
        if (attackTarget) cmdAttackReligiousUnit(botIdentity, tx, tz, attackTarget.tx, attackTarget.tz);
    }

    if (def?.canStartInquisition && !hasStartedInquisition(botIdentity)
        && (unit.evangelismPower ?? 0) >= (def.evangelismPower ?? 0)) {
        cmdStartInquisition(botIdentity, tx, tz);
        return;
    }

    const canProselytize = def?.canProselytize !== false;
    if (canProselytize && !unit.hasProselytizedThisTurn && (unit.evangelismPower ?? 0) > 0) {
        const adjacentCities = getAdjacentTileEntries(tx, tz, tiles).filter((e) => e.tile.city);
        if (adjacentCities.length > 0) {
            const cityTarget = adjacentCities.find((e) => getCityDominantReligion(e.tile.city) !== civId) ?? adjacentCities[0];
            cmdProselytize(botIdentity, tx, tz, cityTarget.tx, cityTarget.tz);
            return;
        }
    }

    if (def?.canSuppress && (unit.evangelismPower ?? 0) > 0) {
        const currentTile = tiles[`${tx},${tz}`];
        const cityKey = resolveOwningCityKey(tx, tz, currentTile, currentTile?.ownerId, tiles);
        if (cityKey && tiles[cityKey]?.city) {
            cmdInquisitorSuppress(botIdentity, tx, tz);
            return;
        }
    }

    const remaining = unit.movementRemaining ?? unit.movement ?? 0;
    if (remaining <= 0) return;

    const target = findBestMissionaryTarget(civId, tiles, tx, tz);
    if (!target) return;

    const dest = pickReligiousMoveDestination(tx, tz, target, remaining, tiles, config);
    if (dest) cmdMoveReligiousUnit(botIdentity, tx, tz, dest.tx, dest.tz);
}

/**
 * 自国の宗教関連の行動をまとめて実行する。
 * 1. 宗教を未創始なら、条件(聖地・国家全体の信仰力)を満たしていれば創始する
 *    (cmdFoundReligionが条件を再検証するため、満たしていなければ何も起きない)。
 * 2. 創始済みなら、宗教ユニットが不在で購入条件を満たす都市があれば購入する。
 * 3. 自国の宗教ユニット(伝道者)ごとに、布教または移動を行う(runBotReligiousUnit)。
 */
function runBotReligion(civId, botIdentity, tiles, config) {
    if (!hasFoundedReligion(botIdentity)) {
        cmdFoundReligion(botIdentity);
    }

    if (hasFoundedReligion(botIdentity)) {
        tiles = getTiles();
        for (const key in tiles) {
            const t = tiles[key];
            if (t.ownerId !== civId || !t.city || t.religiousUnit) continue;
            const choice = pickReligiousUnitChoice(t, botIdentity);
            if (!choice) continue;
            const [tx, tz] = key.split(",").map(Number);
            const bot = makeBotIdentity(civId, tx, tz, config);
            if (bot) cmdBuyReligiousUnit(bot, choice);
        }
    }

    tiles = getTiles();
    for (const key in tiles) {
        const unit = tiles[key].religiousUnit;
        if (unit?.ownerId !== civId) continue;
        const [tx, tz] = key.split(",").map(Number);
        runBotReligiousUnit(civId, tx, tz, unit, tiles, config, botIdentity);
    }
}

/**
 * (賢さ強化: 複数回移動) 撤退・護衛・追跡の移動コマンドを実行した直後に呼ぶ。移動先の
 * ユニットを最新のtiles(getTiles())から取り直し、まだ移動力(movementRemaining)が
 * 残っていれば呼び出し元(runBotCombatUnit)がその場で再度行動判定できるよう
 * { tx, tz, tiles, unit } を返す。移動できなかった場合(dest===null)、または
 * 移動力を使い切った場合はnullを返す(呼び出し元はそのユニットのこのターンの行動を終える)。
 * これにより、1ユニットが1ターンで移動力を使い切るまで複数マス移動でき、移動の結果
 * その場で攻撃可能になれば(次のループで(c)の攻撃判定に達するため)「移動して攻撃」も
 * 自然に実現される。1回の移動コマンド自体は経路探索(combat.jsのgetReachablePositions)で
 * 曲がった経路も許容されるが、このBotの移動先選定(findValidMoveTarget)自体は今も
 * 8方向への直進のみを試す簡易な貪欲法のままなので、実際にBotが選ぶ移動先は変わらない。
 */
function advanceAfterBotMove(botIdentity, fromTx, fromTz, dest) {
    if (!dest) return null;
    cmdMoveCombatUnit(botIdentity, fromTx, fromTz, dest.tx, dest.tz);
    const tiles = getTiles();
    const unit = tiles[`${dest.tx},${dest.tz}`]?.combatUnit;
    if (!unit || (unit.movementRemaining ?? 0) <= 0) return null;
    return { tx: dest.tx, tz: dest.tz, tiles, unit };
}

/**
 * 1体の戦闘ユニットの行動を決定・実行する。移動力が残っている限り、1回の移動(直線移動)の
 * 後にこの判定全体をこのターン内で繰り返す(advanceAfterBotMove参照。最大MAX_MOVE_HOPS_PER_TURN
 * 回)ため、「移動力を使い切るまで複数マス移動する」「移動後に攻撃可能になれば同じターンで
 * 攻撃する」が実現される。優先順位:
 * (a) 無防備な敵都市(都心のHPが既に0)の上で今ターン未行動なら占領する。
 * (b) 同じマスに敵(同盟関係の無い)の宗教ユニットがいて移動力が満タンなら、異教徒として
 *     排除する(cmdPurgeHeretic。確実に成功する一方的な排除のため、成否がランダムな攻撃(c)
 *     より先に判定する)。
 * (c) 攻撃範囲内に敵ユニットがいれば、確実に撃破できる相手(canGuaranteeKill)を最優先し、
 *     いなければその中から包囲ボーナス(既にその相手に隣接している味方の数)が最大の相手を
 *     優先し、同数ならHPが最も低い相手を攻撃する。
 * (d) 攻撃範囲内に敵ユニットはいないが敵の都市(都心)があれば、都心のHPが最も低い(最も
 *     陥落に近い)都市を優先して攻城する(cmdAttackCity。§13。これが無いとBotは都市の
 *     HPを一切削れず、占領を進められなくなる)。
 * (e) HPが低ければ(RETREAT_HP_RATIO未満)、最寄りの自都市へ撤退する。
 * (f) 自都市を守っている最中で、近く(GARRISON_ALERT_RADIUS以内)に敵がいなければ、
 *     HPが減っていれば休息して回復し(cmdHealCombatUnit)、満タンならそのまま持ち場を守る。
 * (g) 自分は健在で、近く(ESCORT_RADIUS以内)に撤退中の負傷した味方がいれば、敵を追うより
 *     先にその護衛(合流)へ向かう(単独で撤退する負傷ユニットが各個撃破されるのを防ぐ)。
 * (h) それ以外は最も近い敵(ユニットまたは都市)へ向けて移動する。ただし遠距離ユニットが
 *     自軍の近接ユニットより前に出てしまう場合は、近接ユニットが追いつくまで待機する。
 */
function runBotCombatUnit(civId, tx, tz, unit, tiles, config, botIdentity) {
    for (let hop = 0; hop < MAX_MOVE_HOPS_PER_TURN; hop++) {
        const tile = tiles[`${tx},${tz}`];
        if (!tile) return;

        if (tile.city && tile.ownerId && tile.ownerId !== civId && isAtWar(civId, tile.ownerId)) {
            const maxMovement = unit.movement ?? 0;
            if ((unit.movementRemaining ?? maxMovement) >= maxMovement) {
                cmdCaptureCity(botIdentity, tx, tz);
                return;
            }
        }

        const heretic = tile.religiousUnit;
        if (heretic && heretic.ownerId !== civId && !hasDiplomaticAgreement(civId, heretic.ownerId)) {
            const maxMovement = unit.movement ?? 0;
            if ((unit.movementRemaining ?? maxMovement) >= maxMovement) {
                cmdPurgeHeretic(botIdentity, tx, tz);
                return;
            }
        }

        // 💡 攻撃できるのは宣戦布告済み(戦争状態)の相手のみ。hasAgreementFnは「除外する」述語なので、
        //    戦争状態でない相手を除外する形で渡す。
        const targets = getAttackableTargets(tx, tz, civId, unit, tiles, config, (a, b) => !isAtWar(a, b));
        if (targets.length > 0) {
            const target = pickBestAttackTarget(unit, targets, civId, tx, tz, tiles);
            cmdAttackCombatUnit(botIdentity, tx, tz, target.tx, target.tz);
            return;
        }

        // 💡 攻撃範囲内に敵ユニットがいなくても、敵の都市(都心)が範囲内にあれば攻城を行う
        //    (§13。都心はHPを0にしない限り占領できないため、これが無いとBotは一切都市を
        //    陥落させられなくなる)。HPが最も低い=最も陥落に近い都市を優先して攻撃を集中させる。
        const cityTargets = getAttackableCityTargets(tx, tz, civId, unit, tiles, config, (a, b) => !isAtWar(a, b));
        if (cityTargets.length > 0) {
            const cityTarget = cityTargets.reduce((best, t) =>
                (t.city.hp ?? CITY_MAX_HP) < (best.city.hp ?? CITY_MAX_HP) ? t : best);
            cmdAttackCity(botIdentity, tx, tz, cityTarget.tx, cityTarget.tz);
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
                const dest = attemptMove(tx, tz, unit, home, remaining, tiles, config);
                const advanced = advanceAfterBotMove(botIdentity, tx, tz, dest);
                if (!advanced) return;
                ({ tx, tz, tiles, unit } = advanced);
                continue;
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
            const dest = attemptMove(tx, tz, unit, woundedAlly, remaining, tiles, config);
            const advanced = advanceAfterBotMove(botIdentity, tx, tz, dest);
            if (!advanced) return;
            ({ tx, tz, tiles, unit } = advanced);
            continue;
        }

        if (!nearestEnemy) return;

        // 💡 遠距離ユニットは、自軍に近接ユニットがいるのに自分の方が敵に近い(=単独で最前線に
        //    出てしまう)場合は前進を控えて待機する(戦士を前に出す簡易な隊列判断)。
        //    近接ユニット自体が存在しない(弓兵しかいない)場合は待機せず通常通り前進する。
        if (isRangedUnit(unit) && hasMeleeUnits(civId, tiles) && !meleeEscortIsForward(civId, tx, tz, nearestEnemy, tiles)) {
            return;
        }

        const dest = attemptMove(tx, tz, unit, nearestEnemy, remaining, tiles, config);
        const advanced = advanceAfterBotMove(botIdentity, tx, tz, dest);
        if (!advanced) return;
        ({ tx, tz, tiles, unit } = advanced);
    }
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
            if (bot) {
                cmdSettle(bot);
                bot.setDynamicProperty("goldCrisisGraceUntilTurn", getTurnState().turnNumber + BOT_GOLD_CRISIS_GRACE_TURNS);
            }
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

    // 💡 新規着工の候補マスを都市ごとにまとめ、隣接ボーナス(scoreAdjacencyPlacement)が
    //    最も大きいマスから着工する(条件を満たす最初のマスに無条件で着工していた以前の実装だと、
    //    たまたま先に見つかった質の低いマスに区域を建ててしまうことがあったための改善)。
    tiles = getTiles();
    const districtCandidatesByCity = new Map();
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || t.city || t.facility || t.district || t.underDistrictConstruction) continue;
        const [tx, tz] = key.split(",").map(Number);
        const cityKey = resolveOwningCityKey(tx, tz, t, civId, tiles);
        const cityTile = cityKey ? tiles[cityKey] : null;
        if (!cityTile?.city || cityTile.city.districtConstruction) continue;
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) continue;
        const choice = pickDistrictChoice(t, cityTile.city, bot, tiles, cityKey);
        if (!choice) continue;
        const score = scoreAdjacencyPlacement(tx, tz, tiles, getDistrictDef(choice)?.adjacencyBonuses);
        const candidates = districtCandidatesByCity.get(cityKey) ?? [];
        candidates.push({ bot, choice, score });
        districtCandidatesByCity.set(cityKey, candidates);
    }
    for (const [cityKey, candidates] of districtCandidatesByCity) {
        candidates.sort((a, b) => b.score - a.score);
        cmdStartDistrict(candidates[0].bot, candidates[0].choice);
        startedDistrictCities.add(cityKey);
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
        const choice = pickDistrictBuildingChoice(t, cityTile.city, bot);
        if (choice) { cmdStartDistrictBuilding(bot, choice); startedDistrictCities.add(cityKey); }
    }

    // 6. 施設: 空き領有マスがあれば、労働者の行動回数が続く限り設置する。
    //    候補マスを隣接ボーナス(scoreAdjacencyPlacement)が大きい順に並べ替えてから設置する。
    //    労働者の行動回数には限りがあるため、マスを見つけた順に無条件で設置していた以前の
    //    実装だと、行動回数を使い切った時点で質の良いマスが手つかずのまま残ることがあった。
    tiles = getTiles();
    const facilityCandidates = [];
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== civId || t.city || t.facility || t.district || t.underDistrictConstruction) continue;
        const [tx, tz] = key.split(",").map(Number);
        const bot = makeBotIdentity(civId, tx, tz, config);
        if (!bot) continue;
        const choice = pickFacilityChoice(t, bot);
        if (!choice) continue;
        const score = scoreAdjacencyPlacement(tx, tz, tiles, getFacilityDef(choice)?.adjacencyBonuses);
        facilityCandidates.push({ bot, choice, score });
    }
    facilityCandidates.sort((a, b) => b.score - a.score);
    // 💡 行動回数切れなどでcanInstallFacilityの条件を満たさなくなった候補はcmdInstallFacility
    //    内部の再検証で安全に無視される(候補収集時と設置時の間で状態は変わらないが、念のため)。
    for (const c of facilityCandidates) cmdInstallFacility(c.bot, c.choice);

    // 7. 生産中でない都市があれば、何か生産を開始する。
    tiles = getTiles();
    // 💡 脅威時の防衛ユニット生産に上限・多様性を持たせるため、現在の都市数(沿岸都市数も
    //    別途)、近接/遠距離/海軍ユニットの保有数、ミサイル備蓄、戦争中かどうかをあらかじめ
    //    集計しておく(pickProductionChoiceへ渡す)。battleshipCountは帆船・巡洋艦・戦艦を
    //    まとめて数える(いずれも同じ「沿岸都市1つにつきN隻まで」の上限を共有するため)。
    // 💡 (賢さ強化) 脅威時のみ、近くの敵の兵種構成を集計しておく(pickProductionChoiceが
    //    対抗ユニットの優先生産に使う)。脅威が無ければ無駄な走査になるため計算しない。
    let unitCounts = { cityCount: 0, coastalCityCount: 0, meleeCount: 0, rangedCount: 0, battleshipCount: 0, missileStock: 0, atWar: false, nearbyEnemyClasses: threatened ? computeNearbyEnemyClassCounts(civId, tiles) : {} };
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId === civId && t.city) {
            unitCounts.cityCount++;
            unitCounts.missileStock += t.city.missiles ?? 0;
            const [ctx, ctz] = key.split(",").map(Number);
            if (isCoastalCity(ctx, ctz, tiles)) unitCounts.coastalCityCount++;
        }
        if (t.combatUnit?.ownerId === civId) {
            const unitId = t.combatUnit.id;
            if (isMeleeProductionId(unitId)) unitCounts.meleeCount++;
            else if (isRangedProductionId(unitId)) unitCounts.rangedCount++;
            else if (isNavalProductionId(unitId)) unitCounts.battleshipCount++;
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
            if (isMeleeProductionId(choice)) unitCounts.meleeCount++;
            else if (isRangedProductionId(choice)) unitCounts.rangedCount++;
            else if (isNavalProductionId(choice)) unitCounts.battleshipCount++;
        }
    }

    // 8. 研究・社会制度(マス座標に依存しないので位置は原点でよい)。脅威がある間は
    //    弓術(弓兵解禁)を優先し、無ければ経済・成長寄りの技術を優先する。
    const originBot = makeBotIdentity(civId, 0, 0, config);
    if (originBot) {
        autoStartProgress(originBot, "technology", threatened ? TECH_PRIORITY_THREATENED : TECH_PRIORITY_SAFE);
        autoStartProgress(originBot, "civic", CIVIC_PRIORITY);

        // 9. 外交: 届いた提案を承認し、条件を満たしていれば国力の高い相手へ関係を提案する。
        //    戦争中で圧倒的に劣勢なら自分から講和する。既に誰かと戦争中なら新たな宣戦布告はしない
        //    (二正面作戦の回避)。
        runBotDiplomacy(civId, originBot, tiles);

        // 10. 宗教: 条件を満たせば創始し、伝道者を購入・移動・布教させる。
        runBotReligion(civId, originBot, tiles, config);
    }

    // 11. ミサイル: 戦争中で在庫があれば、敵都市(優先して相手の首都)へ1発発射する。
    tiles = getTiles();
    runBotMissile(civId, tiles, config);

    // 12. 戦闘: 自国の戦闘ユニットで、占領・攻撃・移動を行う。
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

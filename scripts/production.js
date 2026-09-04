// production.js
// 🏭 生産(ユニット/建造物)を汎用的に管理するモジュール。
//
// 【設計方針】
// 生産物ごとに個別の関数を作るのではなく、PRODUCTION_DEFS に定義を1つ追加するだけで
// 新しいユニット/建造物を増やせるようにする。
//
// 各都市(city)は一度に1つだけ生産を行える。
//   city.production      = { id, progress, cost } | null   … 進行中の生産
//   city.productionCarry = number                           … 中断/完了時に余った生産力(次回に引き継ぐ)
//
// 生産の流れ:
//   1. startProduction() で開始。開始時、直前までの余剰(productionCarry)を初期値として引き継ぐ。
//   2. 毎ターン tickProduction() で、その都市の産出生産力ぶんだけ progress を加算する。
//   3. progress が cost に到達したら完成。onComplete() を呼び、超過分は productionCarry として次回に持ち越す。
//   4. cancelProduction() で生産を中止した場合も、その時点の progress は productionCarry として持ち越される(消滅しない)。
//
// 【陸軍/海軍について】
// 戦闘ユニットは domain: "land"(陸軍) / "naval"(海軍) を持つ(未指定は陸軍扱い)。
// 陸軍ユニットは都市のマス(常に陸地)にそのまま配置できるが、海軍ユニットは都市に隣接する
// 水上マス(海・川・池・湖)にのみ配置できる。placeProducedNavalUnit() がその配置を担う。
//
// 【労働者(worker)について】
// 労働者は「行動回数」を持つ(1人につき WORKER_ACTIONS_PER_UNIT 回)。伐採などの労働者を消費する
// アクションは、労働者を1人まるごと消費するのではなく、その行動回数を1減らすだけにする。行動回数が
// 0になった労働者だけがプールから取り除かれる(＝行動回数を使い切って初めて「消費」される)。
//   city.workerUnits = number[]  … 各労働者の残り行動回数の配列(例: [3, 3, 1] なら労働者3人)
//   労働者数の表示には getWorkerCount(city) を使う(workerUnits.length から都度算出し、
//   別フィールドとして保持・同期しない。旧セーブの city.workers はマイグレーション用の
//   読み取り専用フォールバックとして ensureWorkerUnits 内でのみ参照される)。

import { hasCompletedProgress, getDefinition } from "./progression.js";
import { isWaterTerrain } from "./mapGen.js";
import { getAdjacentTiles } from "./adjacency.js";
import { WALL_MAX_HP } from "./combat.js";
import { getWonderClaims, releaseWonder } from "./state.js";
import { getAirbaseCapacity, getBasedAirUnits, addBasedAirUnit } from "./airbase.js";

/** 労働者1人が持つ行動回数。 */
export const WORKER_ACTIONS_PER_UNIT = 3;

// 💡 ゴールドでの即時購入(ラッシュバイ、§23)1生産力あたりの必要ゴールド。commands.js(実際の
//    購入処理)とui.js(ボタンのプレビュー表示)の両方がこの1箇所を参照する(以前は同じ値を
//    別名の定数として2ファイルにそれぞれ直書きしており、ズレる恐れがあった)。
export const RUSH_BUY_GOLD_PER_PRODUCTION = 3;

/**
 * 都市の労働者データを正規化して返す。
 * 💡 旧セーブ(city.workers だけを持ち、city.workerUnits を持たないデータ)との互換性のため、
 *    workerUnits が無い場合は「city.workers 人ぶん、行動回数MAXの労働者がいる」とみなして生成する。
 */
function ensureWorkerUnits(city) {
    if (!Array.isArray(city.workerUnits)) {
        const legacyCount = Math.max(0, Math.floor(city.workers ?? 0));
        city.workerUnits = Array.from({ length: legacyCount }, () => WORKER_ACTIONS_PER_UNIT);
    }
    return city.workerUnits;
}

/** 労働者を指定人数ぶん追加する(1人につき行動回数 WORKER_ACTIONS_PER_UNIT を持つ)。 */
export function addWorkers(city, count = 1) {
    const units = ensureWorkerUnits(city);
    for (let i = 0; i < count; i++) units.push(WORKER_ACTIONS_PER_UNIT);
    return units.length;
}

/**
 * 労働者を1回分「消費」する(行動回数を1減らす)。行動回数が0になった労働者はプールから取り除かれる。
 * @returns {boolean} 消費できた場合 true。行動可能な労働者がいない場合は false(何も変更しない)。
 */
export function consumeWorkerAction(city) {
    const units = ensureWorkerUnits(city);
    if (units.length === 0) return false;

    units[0] -= 1;
    if (units[0] <= 0) units.shift();
    return true;
}

/** この都市に、行動回数が1以上残っている労働者が存在するかどうかを判定する。 */
export function hasAvailableWorkerAction(city) {
    return ensureWorkerUnits(city).length > 0;
}

/**
 * 表示用: この都市の労働者数を取得する。city.workers を別途持たず、常に
 * workerUnits.length から算出する(旧セーブ(workerUnits が無いデータ)からの復元も
 * ensureWorkerUnits が面倒を見るので、ここでは意識しなくてよい)。
 */
export function getWorkerCount(city) {
    return ensureWorkerUnits(city).length;
}

/** 表示用: この都市の労働者全体の残り行動回数の合計を取得する。 */
export function getTotalWorkerActionsRemaining(city) {
    return ensureWorkerUnits(city).reduce((sum, n) => sum + n, 0);
}

/**
 * 生産可能な物の定義。
 * 新しいユニット/建造物を増やしたい場合は、ここに1エントリ追加するだけでよい。
 *
 * @typedef {Object} ProductionDef
 * @property {string} label 表示名
 * @property {string} icon 表示アイコン(絵文字)
 * @property {"unit"|"building"} category カテゴリ(メニュー分類用)
 * @property {string} [unitClass] 戦闘ユニット(category:"unit")の兵種("melee"/"antiCavalry"/
 *   "cavalry"/"ranged"/"siege"/"naval")。combat.js の UNIT_CLASS_COUNTERS によるクラス相性
 *   ボーナス(例: 対騎兵は騎兵相手に戦闘力+10)の判定に使う。この値はメニュー表示用の参照で、
 *   実際の戦闘計算には onComplete が配置するユニット個体データ側の unitClass を使う(両方に
 *   同じ値を設定しておくこと)。💡 一部のユニットは完成時に国家の戦略資源在庫を1消費する
 *   (horseman/knight→馬、swordsman/musketman/cannon→鉄、tank/dreadnought→石油。
 *   placeProducedCombatUnitConsumingResource参照)。在庫が無ければ配置失敗と同様に
 *   生産が中止される(onComplete参照)。
 * @property {string} [consumesResource] onComplete が完成時に1消費する国家の戦略資源のDynamic
 *   Property名(例: "strategic_horse")。onComplete側の実際の消費処理
 *   (placeProducedCombatUnitConsumingResource/completeConsumingResource)とは独立して、
 *   bots.js が「在庫が無い間はそもそも着工しない」ガードの判定にこの値を直接参照する
 *   (在庫の有無をbots.js側で別途手動管理しないための単一の情報源。§8/§24)。
 * @property {number} cost 完成に必要な生産力の合計値
 * @property {boolean} [uniquePerCity] true の場合、都市に既に存在する場合は再生産不可
 * @property {(city: any) => boolean} [hasBuilt] uniquePerCity 用: 既に保有済みか判定する関数
 * @property {number} [extraUpkeep] 生産中、都市の食料消費に追加される値
 * @property {string} [requiresTechnology] 生産に必要な技術ID(technology progression)
 * @property {string} [requiresCivic] 生産に必要な社会制度ID(civic progression)。requiresTechnology と
 *   併用した場合、両方を取得済みでなければ生産できない(例: 市場は貨幣経済+商業の両方が必要)。
 * @property {boolean} [requiresEmptyCombatTile] true の場合、都市のマスに既に戦闘ユニットが
 *   いると着工できない(陸軍/海軍ユニット向け。canStartProduction参照)
 * @property {boolean} [requiresAirbaseCapacity] true の場合、都市の航空基地(airbase.js、
 *   §航空戦)に空き枠が無いと着工できない(航空ユニット向け。canStartProductionにcityKey/tiles
 *   が渡された場合のみ事前チェックされる。最終的な強制はonComplete側のplaceProducedAirUnitが行う)
 * @property {boolean} [disallowInCapital] true の場合、首都ではこの建造物を生産できない(遷都用)
 * @property {string} [requiresBuildingFlag] この都市が city[このID] を保有していないと生産できない
 *   (例: プロジェクト「原子炉の再稼働」は city.nuclearPowerPlant が必要。§24)
 * @property {Record<string, number>} [flatYields] この建造物(category:"building")があるだけで
 *   (隣接マスに関係なく)都市に毎ターン加算される産出量(例: { faith: 4 })。
 *   adjacency.js の getFlagFlatYields() が city[buildingId] を見て自動的に反映するので、
 *   turns.js 側の変更は不要。
 * @property {Array<any>} [adjacencyBonuses] 隣接マスに応じたボーナスのルール一覧。
 *   adjacency.js の AdjacencyBonusRule 形式で書く(matchesTerrain/matchesResource/matchesBuilding
 *   などのヘルパーを使うと簡潔に書ける)。この建造物を持つ都市の産出量計算(turns.js)に
 *   自動的に反映されるので、ここにルールを追加するだけでよい(反映側のコード変更は不要)。
 * @property {(city: any, ctx: any) => void} onComplete 完成時の効果を適用する関数
 * @property {(city: any) => string} [completeMessage] 完成時のメッセージ生成関数
 */
/**
 * 戦闘ユニット生産の完了処理を共通化するヘルパー。
 * ・都市のマスが空いていれば、そのままそこに新しいユニットを配置する。
 * ・都市のマスに敵(自国でも同盟国でもない)の戦闘ユニットがいる場合、生産を中止する
 *   (進行度は消滅させず、呼び出し元でproductionCarryとして保持させる)。
 * ・都市のマスに自国 or 同盟国の戦闘ユニットがいる場合、周囲8マスのうち空いているマスに
 *   新しいユニットを配置する。空きマスが無ければ、この場合も生産を中止する。
 * @param {any} ctx tickProduction から渡されるコンテキスト({ cityKey, tiles, isAllied } など)
 * @param {(ownerId: string, ownerName: string) => any} createUnit 配置するユニットのデータを作る関数
 * @returns {{ cancelled: boolean, cancelReason?: "enemyOccupied" | "noRoomNearby", relocated?: boolean } | undefined}
 *   配置に成功した場合は undefined(通常の完成メッセージを出す)、中止した場合は cancelled:true を返す。
 */
function placeProducedCombatUnit(ctx, createUnit) {
    const tile = ctx?.tiles?.[ctx?.cityKey];
    if (!tile) return { cancelled: true, cancelReason: "noRoomNearby" };

    const newUnit = createUnit(tile.ownerId, tile.ownerName);

    if (!tile.combatUnit) {
        tile.combatUnit = newUnit;
        return undefined;
    }

    // 💡 都市のマスに既にいる戦闘ユニットが、自国 or 同盟国のものかどうかを判定する。
    const occupant = tile.combatUnit;
    const isFriendly = occupant.ownerId === tile.ownerId || !!ctx?.isAllied?.(tile.ownerId, occupant.ownerId);

    if (!isFriendly) {
        // 💡 敵の戦闘ユニットが都市のマスにいる場合、生産そのものを中止する。
        return { cancelled: true, cancelReason: "enemyOccupied" };
    }

    // 💡 自国/同盟のユニットが既にいる場合、都市のマスを取り囲む8マスのうち空いているマスへ配置する。
    const [tx, tz] = String(ctx.cityKey).split(",").map(Number);
    for (const neighborTile of getAdjacentTiles(tx, tz, ctx.tiles)) {
        if (!neighborTile.combatUnit) {
            neighborTile.combatUnit = newUnit;
            return { cancelled: false, relocated: true };
        }
    }

    // 💡 周囲に空きマスが無ければ、この場合も生産を中止する(進行度は保持される)。
    return { cancelled: true, cancelReason: "noRoomNearby" };
}

/**
 * 海軍ユニット生産の完了処理。都市自身のマスは常に陸地なので、そこには配置せず、
 * 都市に隣接する8マスのうち「水上マス(海・川・池・湖)かつ戦闘ユニットが空いている」マスへ配置する。
 * 隣接する水上マスが無い、またはすべて埋まっている場合は生産を中止する(進行度は保持される)。
 * @param {any} ctx tickProduction から渡されるコンテキスト({ cityKey, tiles } など)
 * @param {(ownerId: string, ownerName: string) => any} createUnit 配置するユニットのデータを作る関数
 * @returns {{ cancelled: boolean, cancelReason?: "noNavalTile" } | undefined}
 */
function placeProducedNavalUnit(ctx, createUnit) {
    const tile = ctx?.tiles?.[ctx?.cityKey];
    if (!tile) return { cancelled: true, cancelReason: "noNavalTile" };

    const newUnit = createUnit(tile.ownerId, tile.ownerName);

    const [tx, tz] = String(ctx.cityKey).split(",").map(Number);
    for (const neighborTile of getAdjacentTiles(tx, tz, ctx.tiles)) {
        if (isWaterTerrain(neighborTile.type) && !neighborTile.combatUnit) {
            neighborTile.combatUnit = newUnit;
            return undefined;
        }
    }

    return { cancelled: true, cancelReason: "noNavalTile" };
}

/**
 * 航空ユニット生産の完了処理。陸軍/海軍と違ってマスには配置せず、この都市の航空基地
 * (city.airbase.units、airbase.js参照)に空き枠があればそこへ加える。都心は常に1枠、
 * 飛行場(区域専用建造物)・滑走路(施設)があればさらに枠が増える(getAirbaseCapacity)。
 * 空き枠が無ければ生産を中止する(進行度は保持される)。
 * @param {any} ctx tickProduction から渡されるコンテキスト({ cityKey, tiles } など)
 * @param {(ownerId: string, ownerName: string) => any} createUnit 配置するユニットのデータを作る関数
 * @returns {{ cancelled: boolean, cancelReason?: "noAirbaseCapacity" } | undefined}
 */
function placeProducedAirUnit(ctx, createUnit) {
    const tile = ctx?.tiles?.[ctx?.cityKey];
    if (!tile?.city) return { cancelled: true, cancelReason: "noAirbaseCapacity" };

    const capacity = getAirbaseCapacity(tile.city, ctx.cityKey, ctx.tiles);
    if (getBasedAirUnits(tile.city).length >= capacity) {
        return { cancelled: true, cancelReason: "noAirbaseCapacity" };
    }

    addBasedAirUnit(tile.city, createUnit(tile.ownerId, tile.ownerName));
    return undefined;
}

/**
 * placeProducedCombatUnit()(または placeProducedNavalUnit())に、完成時に国家の戦略資源在庫を
 * 1消費する前提条件を追加する共通ヘルパー(horsemanの馬・swordsmanの鉄・tank/dreadnoughtの
 * 石油など)。在庫が無ければ他の配置失敗と同じく生産を中止する(cancelReason: "noResource")。
 * 消費は実際に配置できた場合のみ行う(配置自体が中止された場合は消費しない)。
 * @param {any} ctx tickProduction から渡されるコンテキスト({ player } を含む)
 * @param {string} resourceProp 消費するDynamic Property名(例: "strategic_horse")
 * @param {string} resourceLabel 在庫不足時のメッセージに使う表示名(例: "馬")
 * @param {(ownerId: string, ownerName: string) => any} createUnit 配置するユニットのデータを作る関数
 * @param {(ctx: any, createUnit: any) => any} [placeFn] 配置関数(既定は placeProducedCombatUnit。
 *   海軍ユニットは placeProducedNavalUnit を渡す)
 * @returns {{ cancelled: boolean, cancelReason?: string, resourceLabel?: string } | undefined}
 */
/**
 * 資源消費を伴う完成処理の共通ガード。在庫を確認し、無ければ生産を中止する
 * (cancelReason: "noResource")。在庫があれば fn() を呼び、fn() 自身が別の理由で
 * cancelled を返した場合は資源を消費せずそのまま返す。それ以外は在庫を1消費して
 * fn() の戻り値をそのまま返す。
 * @param {any} ctx tickProduction から渡されるコンテキスト({ player } を含む)
 * @param {string} resourceProp 消費するDynamic Property名(例: "strategic_uranium")
 * @param {string} resourceLabel 在庫不足時のメッセージに使う表示名(例: "ウラン")
 * @param {() => any} fn 実際の完成効果(在庫が確認できた場合のみ呼ばれる)
 */
function withResourceConsumed(ctx, resourceProp, resourceLabel, fn) {
    const stock = ctx?.player?.getDynamicProperty(resourceProp) ?? 0;
    if (stock < 1) return { cancelled: true, cancelReason: "noResource", resourceLabel };
    const result = fn();
    if (result?.cancelled) return result;
    ctx.player.setDynamicProperty(resourceProp, stock - 1);
    return result;
}

function placeProducedCombatUnitConsumingResource(ctx, resourceProp, resourceLabel, createUnit, placeFn = placeProducedCombatUnit) {
    return withResourceConsumed(ctx, resourceProp, resourceLabel, () => placeFn(ctx, createUnit));
}

/**
 * placeProducedCombatUnitConsumingResource() のマス配置を伴わない版(ミサイルの在庫加算・
 * 対空砲のフラグ設定など、city.production完了時にマスへの配置を行わない完成処理向け)。
 * 在庫が無ければ他の資源消費ユニットと同じく生産を中止する(cancelReason: "noResource")。
 * @param {any} ctx tickProduction から渡されるコンテキスト({ player } を含む)
 * @param {string} resourceProp 消費するDynamic Property名(例: "strategic_uranium")
 * @param {string} resourceLabel 在庫不足時のメッセージに使う表示名(例: "ウラン")
 * @param {() => void} applyEffect 実際に完成効果を適用する関数(在庫が確認できた場合のみ呼ばれる)
 */
function completeConsumingResource(ctx, resourceProp, resourceLabel, applyEffect) {
    return withResourceConsumed(ctx, resourceProp, resourceLabel, () => { applyEffect(); return undefined; });
}

export const PRODUCTION_DEFS = {
    worker: {
        label: "労働者",
        icon: "[Worker]",
        category: "unit",
        cost: 10,
        onComplete: (city) => {
            addWorkers(city, 1);
        },
        completeMessage: (city) => `§e[Complete]【${city.name}】労働者の生産が完了！ ([Worker]x${getWorkerCount(city)}、1人あたり行動回数${WORKER_ACTIONS_PER_UNIT})`,
    },
    missile: {
        label: "ミサイル",
        icon: "[Missile]",
        category: "unit",
        cost: 200,
        requiresTechnology: "rocketry",
        // 💡 ミサイルは完成時に国家の資源「ウラン」在庫を1消費する(在庫が無ければ生産中止。§24)。
        consumesResource: "strategic_uranium",
        onComplete: (city, ctx) => completeConsumingResource(ctx, "strategic_uranium", "ウラン", () => {
            city.missiles = (city.missiles ?? 0) + 1;
        }),
        completeMessage: (city) => `§c[Missile][Complete]【${city.name}】ミサイルの製造が完了しました！ (在庫: ${city.missiles}発、資源「ウラン」-1)`,
    },
    warrior: {
        label: "戦士",
        icon: "[Warrior]",
        category: "unit",
        cost: 30,
        unitClass: "melee",
        requiresEmptyCombatTile: true,
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            // 💡 attackRange: 近接ユニットのため攻撃距離は移動力と同じ(1)。domain: 陸軍ユニット。
            id: "warrior", label: "戦士", hp: 100, maxHp: 100, combatStrength: 20, unitClass: "melee",
            movement: 1, movementRemaining: 1, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Warrior]【${city.name}】に戦士を配置しました！ (HP: 100/100、戦闘力: 20)`,
    },
    archer: {
        label: "弓兵",
        icon: "[Archer]",
        category: "unit",
        cost: 50,
        unitClass: "ranged",
        requiresEmptyCombatTile: true,
        requiresTechnology: "archery",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            // 💡 弓兵は遠距離戦闘ユニット: 遠距離戦闘力20、近距離戦闘力15の2種類の戦闘力を持つ。
            //    combatStrength は互換表示用に近距離戦闘力と同じ値を入れておく。domain: 陸軍ユニット。
            id: "archer", label: "弓兵", hp: 100, maxHp: 100, unitClass: "ranged",
            combatStrength: 15, rangedCombatStrength: 20, meleeCombatStrength: 15,
            movement: 1, movementRemaining: 1, attackRange: 2, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Archer]【${city.name}】に弓兵を配置しました！ (HP: 100/100、遠距離戦闘力: 20、近距離戦闘力: 15)`,
    },
    uoooo: {
        label: "うおおおおおお",
        icon: "[うおｗ]",
        category: "unit",
        cost: 500,
        goldUpkeep: 0, // 💡 ネタユニットのため、通常のcost基準の計算式を上書きしてゴールド維持費を0固定にする。
        requiresEmptyCombatTile: true,
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            id: "uoooo", label: "うおｗ", hp: 100, maxHp: 100, combatStrength: 200,
            movement: 10, movementRemaining: 10, attackRange: 20, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Warrior]【${city.name}】にうおｗを配置しました！ (HP: 100/100、戦闘力: 20)`,
    },
    // 💡 id/内部キーは"battleship"のままだが、表示名は「帆船」にしている(§8参照)。
    //    前提技術「航海術」は序盤の安い技術(帆走の時代)なので、駆逐艦・巡洋艦のような
    //    近代の鋼鉄艦の名前を割り当てると時代感が逆転してしまう。造船術(前提: 航海術)で
    //    解禁される巡洋艦との上位関係も「帆船→巡洋艦」なら一目で分かるため、こちらにした。
    battleship: {
        label: "帆船",
        icon: "[Sailboat]",
        category: "unit",
        cost: 60,
        unitClass: "naval",
        requiresTechnology: "sailing",
        // 💡 都市自身のマスではなく、隣接する水上マス(海・川・池・湖)に配置される海軍ユニット。
        //    隣接する水上マスが無い(内陸の都市)場合は生産完了時に中止される。
        onComplete: (city, ctx) => placeProducedNavalUnit(ctx, (ownerId, ownerName) => ({
            // 💡 domain: 海軍ユニット。水上マスにしか進入できない。
            id: "battleship", label: "帆船", hp: 100, maxHp: 100, combatStrength: 25, unitClass: "naval",
            movement: 2, movementRemaining: 2, attackRange: 3, domain: "naval", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Sailboat]【${city.name}】に帆船を配置しました！ (HP: 100/100、戦闘力: 25)`,
    },
    spearman: {
        label: "槍兵",
        icon: "[Spearman]",
        category: "unit",
        cost: 45,
        unitClass: "antiCavalry",
        requiresEmptyCombatTile: true,
        requiresTechnology: "bronzeWorking",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            // 💡 対騎兵(antiCavalry): 単体の戦闘力は控えめだが、騎兵(cavalry)クラス相手には
            //    combat.js の UNIT_CLASS_COUNTERS により戦闘力+10される専門兵科。
            id: "spearman", label: "槍兵", hp: 100, maxHp: 100, combatStrength: 32, unitClass: "antiCavalry",
            movement: 1, movementRemaining: 1, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Spearman]【${city.name}】に槍兵を配置しました！ (HP: 100/100、戦闘力: 32、対騎兵+10)`,
    },
    pikeman: {
        label: "長槍兵",
        icon: "[Pikeman]",
        category: "unit",
        cost: 70,
        unitClass: "antiCavalry",
        requiresEmptyCombatTile: true,
        // 💡 社会制度「封建制度」で解放される、槍兵の上位互換(中世の対騎兵専門兵科)。
        requiresCivic: "feudalism",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            id: "pikeman", label: "長槍兵", hp: 100, maxHp: 100, combatStrength: 42, unitClass: "antiCavalry",
            movement: 1, movementRemaining: 1, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Pikeman]【${city.name}】に長槍兵を配置しました！ (HP: 100/100、戦闘力: 42、対騎兵+10)`,
    },
    horseman: {
        label: "騎兵",
        icon: "[Horseman]",
        category: "unit",
        cost: 75,
        unitClass: "cavalry",
        requiresEmptyCombatTile: true,
        requiresTechnology: "horsebackRiding",
        // 💡 兵種が騎兵(cavalry)のユニットは、完成時に国家の資源「馬」在庫を1消費する
        //    (placeProducedCombatUnitConsumingResource参照。在庫が無ければ生産中止)。
        consumesResource: "strategic_horse",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_horse", "馬", (ownerId, ownerName) => ({
            id: "horseman", label: "騎兵", hp: 100, maxHp: 100, combatStrength: 30, unitClass: "cavalry",
            movement: 3, movementRemaining: 3, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Horseman]【${city.name}】に騎兵を配置しました！ (HP: 100/100、戦闘力: 30、移動力: 3、資源「馬」-1)`,
    },
    knight: {
        label: "騎士",
        icon: "[Knight]",
        category: "unit",
        cost: 110,
        unitClass: "cavalry",
        requiresEmptyCombatTile: true,
        // 💡 社会制度「騎士道」で解放される、騎兵の上位互換。騎兵と同じく完成時に資源「馬」を1消費する。
        requiresCivic: "chivalry",
        consumesResource: "strategic_horse",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_horse", "馬", (ownerId, ownerName) => ({
            id: "knight", label: "騎士", hp: 100, maxHp: 100, combatStrength: 45, unitClass: "cavalry",
            movement: 4, movementRemaining: 4, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Knight]【${city.name}】に騎士を配置しました！ (HP: 100/100、戦闘力: 45、移動力: 4、資源「馬」-1)`,
    },
    tank: {
        label: "戦車",
        icon: "[Tank]",
        category: "unit",
        cost: 300,
        unitClass: "cavalry",
        requiresEmptyCombatTile: true,
        requiresTechnology: "industrialization",
        // 💡 騎兵・騎士の系譜を継ぐ機動兵科(兵種は変わらずcavalry)。馬ではなく燃料として
        //    資源「石油」を1消費する(戦車・戦艦が初めての石油消費ユニット)。
        consumesResource: "strategic_oil",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_oil", "石油", (ownerId, ownerName) => ({
            id: "tank", label: "戦車", hp: 100, maxHp: 100, combatStrength: 110, unitClass: "cavalry",
            movement: 5, movementRemaining: 5, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Tank]【${city.name}】に戦車を配置しました！ (HP: 100/100、戦闘力: 110、移動力: 5、資源「石油」-1)`,
    },
    // 💡 空軍(domain: "air")。陸軍/海軍と違ってマスには配置されず、都市の航空基地
    //    (airbase.js。都心+飛行場+滑走路の合計枠)に配置され、そこから直接出撃する
    //    (§航空戦。placeProducedAirUnit参照)。「移動力(movement)」は出撃・帰投(移動)の
    //    航続距離、「攻撃距離(attackRange)」は拠点から出撃できる攻撃射程として使われる。
    //    interceptCombatStrengthを持つユニット(recon以外)は哨戒(patrol)状態にでき、
    //    自国の拠点周辺への空爆を迎撃できる(airbase.js/combat.js参照)。
    //    対空砲(antiAir)は、これらのユニットが出撃・攻撃を行った際に迎撃できる(commands.js参照)。
    airRecon: {
        label: "支援偵察機",
        icon: "[Recon]",
        category: "unit",
        cost: 130,
        unitClass: "air",
        requiresAirbaseCapacity: true,
        requiresTechnology: "aviation",
        onComplete: (city, ctx) => placeProducedAirUnit(ctx, (ownerId, ownerName) => ({
            id: "airRecon", label: "支援偵察機", hp: 70, maxHp: 70, unitClass: "air", airRole: "recon",
            rangedCombatStrength: 30, meleeCombatStrength: 15,
            movement: 10, attackRange: 1, domain: "air", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Recon]【${city.name}】の航空基地に支援偵察機を配置しました！ (HP: 70/70、遠距離戦闘力: 30、近距離戦闘力: 15、航続距離: 10)`,
    },
    airDefense: {
        label: "支援防御機",
        icon: "[AirDefense]",
        category: "unit",
        cost: 200,
        unitClass: "air",
        requiresAirbaseCapacity: true,
        requiresTechnology: "aviation",
        consumesResource: "strategic_oil",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_oil", "石油", (ownerId, ownerName) => ({
            id: "airDefense", label: "支援防御機", hp: 110, maxHp: 110, unitClass: "air", airRole: "defense",
            rangedCombatStrength: 50, meleeCombatStrength: 70, interceptCombatStrength: 130,
            movement: 7, attackRange: 1, domain: "air", ownerId, ownerName,
        }), placeProducedAirUnit),
        completeMessage: (city) => `§e[AirDefense]【${city.name}】の航空基地に支援防御機を配置しました！ (HP: 110/110、迎撃戦闘力: 130、航続距離: 7、資源「石油」-1)`,
    },
    fighter: {
        label: "戦闘機",
        icon: "[Fighter]",
        category: "unit",
        cost: 240,
        unitClass: "air",
        requiresAirbaseCapacity: true,
        requiresTechnology: "aviation",
        consumesResource: "strategic_oil",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_oil", "石油", (ownerId, ownerName) => ({
            id: "fighter", label: "戦闘機", hp: 100, maxHp: 100, unitClass: "air", airRole: "fighter",
            rangedCombatStrength: 100, meleeCombatStrength: 40, interceptCombatStrength: 90,
            movement: 8, attackRange: 2, domain: "air", ownerId, ownerName,
        }), placeProducedAirUnit),
        completeMessage: (city) => `§e[Fighter]【${city.name}】の航空基地に戦闘機を配置しました！ (HP: 100/100、遠距離戦闘力: 100、近距離戦闘力: 40、迎撃戦闘力: 90、航続距離: 8、資源「石油」-1)`,
    },
    bomber: {
        label: "戦略爆撃機",
        icon: "[Bomber]",
        category: "unit",
        cost: 320,
        unitClass: "air",
        requiresAirbaseCapacity: true,
        requiresTechnology: "rocketry",
        consumesResource: "strategic_oil",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_oil", "石油", (ownerId, ownerName) => ({
            id: "bomber", label: "戦略爆撃機", hp: 100, maxHp: 100, unitClass: "air", airRole: "bomber",
            rangedCombatStrength: 140, meleeCombatStrength: 30,
            movement: 6, attackRange: 3, domain: "air", ownerId, ownerName,
        }), placeProducedAirUnit),
        completeMessage: (city) => `§e[Bomber]【${city.name}】の航空基地に戦略爆撃機を配置しました！ (HP: 100/100、遠距離戦闘力: 140、近距離戦闘力: 30、航続距離: 6、資源「石油」-1。哨戒はできないが略奪が可能)`,
    },
    // 💡 飛行船(airship)は domain:"air" だが、上の航空ユニット(戦闘機など)とは別物で、
    //    航空基地の枠ではなく「マスそのもの」に配置される飛行する戦闘ユニット。
    //    combat.js の canUnitEnterTerrain は domain:"air" のユニットに地形制約を課さないため、
    //    山脈・海の上をそのまま進める(陸軍にも海軍にも進路を塞がれない)。
    //    unitClass を "air" ではなく "siege" にしているのは意図的で、"air" は
    //    airbase.js / ui.js が「拠点から出撃するユニット」として扱う分類のため、
    //    マスに立つこのユニットに付けると航空基地のUIに流れ込んでしまう。
    airship: {
        label: "飛行船",
        icon: "[Airship]",
        category: "unit",
        cost: 340,
        unitClass: "siege",
        requiresEmptyCombatTile: true,
        requiresTechnology: "aviation",
        consumesResource: "strategic_oil",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_oil", "石油", (ownerId, ownerName) => ({
            // 💡 近代砲兵(遠距離130・移動1・射程2)と対になる攻城ユニット。遠距離戦闘力は劣るが、
            //    移動力4・射程3で地形を無視して詰め寄れる。代わりに近距離戦闘力35と打たれ弱く、
            //    戦車(戦闘力110)のような近接ユニットに肉薄されると一方的に落とされる。
            id: "airship", label: "飛行船", hp: 130, maxHp: 130, unitClass: "siege",
            combatStrength: 35, rangedCombatStrength: 95, meleeCombatStrength: 35,
            movement: 4, movementRemaining: 4, attackRange: 3, domain: "air", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Airship]【${city.name}】に飛行船を配置しました！ (HP: 130/130、遠距離戦闘力: 95、近距離戦闘力: 35、移動力: 4、攻撃距離: 3、地形を無視して移動、資源「石油」-1)`,
    },
    swordsman: {
        label: "剣士",
        icon: "[Swordsman]",
        category: "unit",
        cost: 90,
        unitClass: "melee",
        requiresEmptyCombatTile: true,
        requiresTechnology: "ironWorking",
        // 💡 剣士は完成時に国家の資源「鉄」在庫を1消費する(在庫が無ければ生産中止)。
        consumesResource: "strategic_iron",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_iron", "鉄", (ownerId, ownerName) => ({
            id: "swordsman", label: "剣士", hp: 100, maxHp: 100, combatStrength: 48, unitClass: "melee",
            movement: 1, movementRemaining: 1, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Swordsman]【${city.name}】に剣士を配置しました！ (HP: 100/100、戦闘力: 48、資源「鉄」-1)`,
    },
    musketman: {
        label: "銃士",
        icon: "[Musketman]",
        category: "unit",
        cost: 140,
        // 💡 マスケット銃兵はcombat.jsの兵種上は"melee"扱い(現実の間合いではなく「前線の
        //    主力歩兵」という役割上の分類。剣士の直系の上位互換)。
        unitClass: "melee",
        requiresEmptyCombatTile: true,
        requiresTechnology: "gunpowder",
        // 💡 剣士と同じく完成時に資源「鉄」を1消費する(銃身・銃剣の原料として)。
        consumesResource: "strategic_iron",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_iron", "鉄", (ownerId, ownerName) => ({
            id: "musketman", label: "銃士", hp: 100, maxHp: 100, combatStrength: 65, unitClass: "melee",
            movement: 1, movementRemaining: 1, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Musketman]【${city.name}】に銃士を配置しました！ (HP: 100/100、戦闘力: 65、資源「鉄」-1)`,
    },
    modernInfantry: {
        label: "近代歩兵",
        icon: "[ModernInfantry]",
        category: "unit",
        cost: 240,
        unitClass: "melee",
        requiresEmptyCombatTile: true,
        requiresTechnology: "electricity",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            id: "modernInfantry", label: "近代歩兵", hp: 100, maxHp: 100, combatStrength: 95, unitClass: "melee",
            movement: 1, movementRemaining: 1, attackRange: 1, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[ModernInfantry]【${city.name}】に近代歩兵を配置しました！ (HP: 100/100、戦闘力: 95)`,
    },
    catapult: {
        label: "カタパルト",
        icon: "[Catapult]",
        category: "unit",
        // 💡 前提技術「工学」は徒弟制度(300)→工学(150)という、このツリーで最も投資の重い
        //    チェーンの1つ(累積560)。以前はコスト100(剣士とほぼ同額)と釣り合っていなかったため
        //    引き上げた。
        cost: 160,
        unitClass: "siege",
        requiresEmptyCombatTile: true,
        requiresTechnology: "engineering",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            // 💡 攻城ユニット: 遠距離戦闘力40だが近距離戦闘力(反撃を受けた際の値)は12と低め。
            id: "catapult", label: "カタパルト", hp: 100, maxHp: 100, unitClass: "siege",
            combatStrength: 12, rangedCombatStrength: 40, meleeCombatStrength: 12,
            movement: 1, movementRemaining: 1, attackRange: 2, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Catapult]【${city.name}】にカタパルトを配置しました！ (HP: 100/100、遠距離戦闘力: 40、近距離戦闘力: 12)`,
    },
    cannon: {
        label: "大砲",
        icon: "[Cannon]",
        category: "unit",
        cost: 220,
        unitClass: "siege",
        requiresEmptyCombatTile: true,
        requiresTechnology: "metallurgy",
        // 💡 カタパルトの上位互換。剣士・銃士と同じく完成時に資源「鉄」を1消費する(砲身の原料)。
        consumesResource: "strategic_iron",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_iron", "鉄", (ownerId, ownerName) => ({
            id: "cannon", label: "大砲", hp: 100, maxHp: 100, unitClass: "siege",
            combatStrength: 20, rangedCombatStrength: 70, meleeCombatStrength: 20,
            movement: 1, movementRemaining: 1, attackRange: 2, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Cannon]【${city.name}】に大砲を配置しました！ (HP: 100/100、遠距離戦闘力: 70、近距離戦闘力: 20、資源「鉄」-1)`,
    },
    artillery: {
        label: "近代砲兵",
        icon: "[Artillery]",
        category: "unit",
        cost: 320,
        unitClass: "siege",
        requiresEmptyCombatTile: true,
        requiresTechnology: "industrialization",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            id: "artillery", label: "近代砲兵", hp: 100, maxHp: 100, unitClass: "siege",
            combatStrength: 30, rangedCombatStrength: 130, meleeCombatStrength: 30,
            movement: 1, movementRemaining: 1, attackRange: 2, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Artillery]【${city.name}】に近代砲兵を配置しました！ (HP: 100/100、遠距離戦闘力: 130、近距離戦闘力: 30)`,
    },
    crossbowman: {
        label: "重装弓兵",
        icon: "[Crossbowman]",
        category: "unit",
        // 💡 前提技術「機械工学」は徒弟制度(300)→工学(150)→機械工学(220)というツリー最深部
        //    (累積780)。以前はコスト110(剣士とほぼ同額)と釣り合っていなかったため引き上げた。
        cost: 170,
        unitClass: "ranged",
        requiresEmptyCombatTile: true,
        requiresTechnology: "machinery",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            id: "crossbowman", label: "重装弓兵", hp: 100, maxHp: 100, unitClass: "ranged",
            combatStrength: 25, rangedCombatStrength: 38, meleeCombatStrength: 25,
            movement: 1, movementRemaining: 1, attackRange: 2, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Crossbowman]【${city.name}】に重装弓兵を配置しました！ (HP: 100/100、遠距離戦闘力: 38、近距離戦闘力: 25)`,
    },
    machineGunner: {
        label: "機関銃兵",
        icon: "[MachineGunner]",
        category: "unit",
        cost: 260,
        unitClass: "ranged",
        requiresEmptyCombatTile: true,
        requiresTechnology: "electricity",
        onComplete: (city, ctx) => placeProducedCombatUnit(ctx, (ownerId, ownerName) => ({
            id: "machineGunner", label: "機関銃兵", hp: 100, maxHp: 100, unitClass: "ranged",
            combatStrength: 45, rangedCombatStrength: 85, meleeCombatStrength: 45,
            movement: 1, movementRemaining: 1, attackRange: 2, domain: "land", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[MachineGunner]【${city.name}】に機関銃兵を配置しました！ (HP: 100/100、遠距離戦闘力: 85、近距離戦闘力: 45)`,
    },
    cruiser: {
        label: "巡洋艦",
        icon: "[Cruiser]",
        category: "unit",
        cost: 140,
        unitClass: "naval",
        requiresTechnology: "shipBuilding",
        // 💡 帆船(battleship)と同じく、都市に隣接する水上マスへ配置される海軍ユニット。
        onComplete: (city, ctx) => placeProducedNavalUnit(ctx, (ownerId, ownerName) => ({
            id: "cruiser", label: "巡洋艦", hp: 100, maxHp: 100, combatStrength: 50, unitClass: "naval",
            movement: 3, movementRemaining: 3, attackRange: 4, domain: "naval", ownerId, ownerName,
        })),
        completeMessage: (city) => `§e[Cruiser]【${city.name}】に巡洋艦を配置しました！ (HP: 100/100、戦闘力: 50)`,
    },
    // 💡 id は "dreadnought"(内部キー"battleship"は帆船が既に使っているため別名)。表示名は
    //    「戦艦」で、帆船(sailboat)→巡洋艦(cruiser)→戦艦(battleship)という海軍の最終ティア。
    dreadnought: {
        label: "戦艦",
        icon: "[Dreadnought]",
        category: "unit",
        cost: 280,
        unitClass: "naval",
        requiresTechnology: "industrialization",
        // 💡 戦車と同じく、燃料として資源「石油」を1消費する。
        consumesResource: "strategic_oil",
        onComplete: (city, ctx) => placeProducedCombatUnitConsumingResource(ctx, "strategic_oil", "石油", (ownerId, ownerName) => ({
            id: "dreadnought", label: "戦艦", hp: 100, maxHp: 100, combatStrength: 90, unitClass: "naval",
            movement: 3, movementRemaining: 3, attackRange: 5, domain: "naval", ownerId, ownerName,
        }), placeProducedNavalUnit),
        completeMessage: (city) => `§e[Dreadnought]【${city.name}】に戦艦を配置しました！ (HP: 100/100、戦闘力: 90、資源「石油」-1)`,
    },
    tradingPost: {
        label: "交易所",
        icon: "[Trade]",
        category: "building",
        cost: 10,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.tradingPost,
        extraUpkeep: 1, // 建設中は食料消費+1
        onComplete: (city, ctx) => {
            city.tradingPost = { status: "active", routes: [] };
            if (ctx?.connectTradeRoutes && ctx?.cityKey && ctx?.tiles) {
                ctx.connectTradeRoutes(ctx.cityKey, city, ctx.tiles);
            }
        },
        completeMessage: (city) => `§e[Complete]【${city.name}】交易所が完成しました！`,
    },
    granary: {
        label: "穀物庫",
        icon: "[Granary]",
        category: "building",
        cost: 15,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.granary,
        requiresTechnology: "pottery",
        // 💡 食料生産量+1 は flatYields 経由で getFlagFlatYields() が city.granary を見て
        //    自動的に加算する(turns.js 側に個別の分岐は不要)。
        //    住居+2 はここで即時・恒久的に加算する(交易所建設時のhousing+1と同じ考え方)。
        flatYields: { food: 1 },
        onComplete: (city) => {
            city.granary = true;
            city.housing = (city.housing ?? 0) + 2;
        },
        completeMessage: (city) => `§e[Complete]【${city.name}】穀物庫が完成しました！ (食料生産量+1、住居+2)`,
    },
    obelisk: {
        label: "オベリスク",
        icon: "[Obelisk]",
        category: "building",
        cost: 60,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.obelisk,
        requiresTechnology: "astrology",
        // 💡 信仰力+4 は flatYields 経由で getFlagFlatYields() が city.obelisk を見て
        //    自動的に加算する(turns.js 側に個別の分岐は不要)。
        flatYields: { faith: 4 },
        onComplete: (city) => { city.obelisk = true; },
        completeMessage: (city) => `§e[Complete]【${city.name}】オベリスクが完成しました！ (信仰力の産出+4)`,
    },
    antiAir: {
        label: "対空砲",
        icon: "[AntiAir]",
        category: "building",
        cost: 200,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.antiAir,
        requiresTechnology: "rocketry",
        // 💡 効果そのもの(ミサイルの迎撃)はflatYields等では表現できない特殊効果のため、
        //    turns.js の resolveMissileImpact() が city.antiAir / city.antiAirUsedThisTurn を
        //    直接見て判定する(§17)。1ターンに1回までという制限は、他の「今ターン使用済み」系
        //    フラグ(hasProselytizedThisTurn等)と同じく processPlayerTurnStart で毎ターン
        //    falseにリセットされる。
        // 💡 ミサイルと同じく、完成時に国家の資源「ウラン」在庫を1消費する(§24)。
        consumesResource: "strategic_uranium",
        onComplete: (city, ctx) => completeConsumingResource(ctx, "strategic_uranium", "ウラン", () => { city.antiAir = true; }),
        completeMessage: (city) => `§e[Complete]【${city.name}】に対空砲が完成しました！ (1ターンに1回、この都市と周囲8マスへ着弾するミサイルを迎撃、資源「ウラン」-1)`,
    },
    market: {
        label: "市場",
        icon: "[Market]",
        category: "building",
        cost: 50,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.market,
        // 💡 技術「貨幣経済」と社会制度「商業」の両方が必要(requiresTechnology/requiresCivicの併用例)。
        requiresTechnology: "currency",
        requiresCivic: "commerce",
        flatYields: { production: 2, food: 1 },
        onComplete: (city) => { city.market = true; },
        completeMessage: (city) => `§e[Complete]【${city.name}】市場が完成しました！ (生産力+2、食料生産量+1)`,
    },
    // 💡 世界遺産(新要素)。1ゲームにつき1国家しか着工できない(isWonder。canStartProduction
    //    参照)。着工した時点で早い者勝ちで予約され(cmdStartProduction呼び出し時にclaimWonder)、
    //    他国はそもそも着工できなくなる。効果自体はflatYields経由でgetFlagFlatYields()が
    //    自動加算するため、通常の建造物と全く同じ扱い(uniquePerCityも1都市1つの意味で
    //    そのまま流用できる)。
    pyramids: {
        label: "ピラミッド",
        icon: "[Pyramids]",
        category: "building",
        cost: 200,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.pyramids,
        requiresTechnology: "masonry",
        isWonder: true,
        flatYields: { production: 5 },
        onComplete: (city) => { city.pyramids = true; },
        completeMessage: (city) => `§6*** [Wonder]【${city.name}】に世界遺産「ピラミッド」が完成しました！ (生産力+5) ***`,
    },
    greatLighthouse: {
        label: "大灯台",
        icon: "[Lighthouse]",
        category: "building",
        cost: 220,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.greatLighthouse,
        requiresTechnology: "shipBuilding",
        isWonder: true,
        flatYields: { gold: 5 },
        onComplete: (city) => { city.greatLighthouse = true; },
        completeMessage: (city) => `§6*** [Wonder]【${city.name}】に世界遺産「大灯台」が完成しました！ (ゴールドの産出+5) ***`,
    },
    trainingGround: {
        label: "訓練場",
        icon: "[Training]",
        category: "building",
        cost: 70,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.trainingGround,
        requiresCivic: "militaryTradition",
        // 💡 軍制改革(政治哲学20+軍制改革35=累積55)という社会制度投資の重さに対して
        //    生産力+2は見劣りしていたため+4に引き上げた。
        flatYields: { production: 4 },
        onComplete: (city) => { city.trainingGround = true; },
        completeMessage: (city) => `§e[Complete]【${city.name}】訓練場が完成しました！ (生産力+4)`,
    },
    wall: {
        label: "防壁",
        icon: "[Wall]",
        category: "building",
        cost: 80,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.wall,
        requiresTechnology: "masonry",
        // 💡 効果そのもの(遠距離攻撃の解禁、被ダメージ軽減、+100のシールドHP)はflatYields等では
        //    表現できない特殊効果のため、combat.js の resolveCityAttack/getWallDamageMultiplier や
        //    commands.js の都市の遠距離攻撃コマンドが city.wall / city.wallHp を直接見て判定する
        //    (§13参照)。
        onComplete: (city) => { city.wall = true; city.wallHp = WALL_MAX_HP; },
        completeMessage: (city) => `§e[Complete]【${city.name}】に防壁が完成しました！ (シールドHP+${WALL_MAX_HP}、遠距離攻撃が可能に、被ダメージ軽減: 近接15%/遠隔50%/攻城100%)`,
    },
    capital: {
        label: "遷都",
        icon: "[Capital]",
        category: "building",
        cost: 100,
        // 💡 「すでに首都である都市」では実行不可(首都以外の都市でのみ遷都できる)。
        disallowInCapital: true,
        onComplete: (city, ctx) => {
            // 💡 この都市の所有者が今まで持っていた(であろう)首都から、首都フラグを外してから
            //    この都市を新しい首都にする(1国家につき首都は常に1つだけにする)。
            const ownerId = ctx?.tiles?.[ctx?.cityKey]?.ownerId;
            if (ownerId && ctx?.tiles) {
                for (const key in ctx.tiles) {
                    const t = ctx.tiles[key];
                    if (t.city && t.city.isCapital && t.ownerId === ownerId) {
                        t.city.isCapital = false;
                    }
                }
            }
            city.isCapital = true;
        },
        completeMessage: (city) => `§e[Capital]【${city.name}】が新たな首都になりました！(遷都完了)`,
    },
    // 💡 区域専用建造物「原子力発電所」(districts.js)を持つ都市限定のプロジェクト。区域専用
    //    建造物メニューではなく、通常の生産メニュー(建造物カテゴリ)から選べるようにするため、
    //    ここPRODUCTION_DEFS側に置く(§24)。uniquePerCityは付けない(老朽化年数が溜まるたびに
    //    何度でも実行できる)。
    reactorRestart: {
        label: "原子炉の再稼働",
        icon: "[Reactor]",
        category: "building",
        cost: 300,
        requiresBuildingFlag: "nuclearPowerPlant",
        onComplete: (city) => { city.nuclearPowerPlantAge = 0; },
        completeMessage: (city) => `§e[Complete]【${city.name}】原子炉を再稼働し、老朽化年数をリセットしました！`,
    },
};

/** 生産物IDの一覧を取得 */
export function getProductionIds() {
    return Object.keys(PRODUCTION_DEFS);
}

/** 生産物の定義を取得 */
export function getProductionDef(id) {
    return PRODUCTION_DEFS[id] ?? null;
}

/**
 * 指定した生産物を、この都市で今から開始できるかどうかを判定する。
 * @param {any} city 対象の都市データ
 * @param {string} id 生産物ID
 * @param {any} [tile] 都市が乗っているマス(requiresEmptyCombatTileの判定に使用)
 * @param {any} [player] 生産を行おうとしているプレイヤー/国家(requiresTechnologyの判定に使用)
 * @param {string} [cityKey] "tx,tz"形式の都市タイルのキー(requiresAirbaseCapacityの判定に使用)
 * @param {any} [tiles] 全タイルデータ(requiresAirbaseCapacityの判定に使用)
 * @returns {{ ok: boolean, message?: string }}
 */
export function canStartProduction(city, id, tile = null, player = null, cityKey = null, tiles = null) {
    const def = PRODUCTION_DEFS[id];
    if (!def) return { ok: false, message: "§c不明な生産物です。" };
    if (city.production) return { ok: false, message: "§c既にこの都市では別の生産が進行中です。" };
    if (def.uniquePerCity && def.hasBuilt?.(city)) {
        return { ok: false, message: `§cこの都市には既に【${def.label}】が存在します。` };
    }
    if (def.requiresEmptyCombatTile && tile?.combatUnit) {
        return { ok: false, message: "§cこのマスにはすでに戦闘ユニットが存在します。" };
    }
    // 💡 航空ユニットはマスではなく航空基地(都心+飛行場+滑走路の合計枠、airbase.js)に配置される。
    //    実際の空き枠チェックはonComplete(placeProducedAirUnit)で確実に行うが、cityKey/tilesが
    //    渡されていればここでも先んじて弾き、無駄な着工を防ぐ(進行度は消えないとはいえUXのため)。
    if (def.requiresAirbaseCapacity && cityKey && tiles) {
        const capacity = getAirbaseCapacity(city, cityKey, tiles);
        if (getBasedAirUnits(city).length >= capacity) {
            return { ok: false, message: `§c航空基地の空き枠がありません。(枠: ${getBasedAirUnits(city).length}/${capacity}。飛行場・滑走路で拡張できます)` };
        }
    }
    if (def.disallowInCapital && city.isCapital) {
        return { ok: false, message: "§cこの都市は既に首都です。" };
    }
    if (def.category === "building" && city.districtConstruction) {
        return { ok: false, message: "§c区域を建設中はこの都市で新しい建造物を着工できません。" };
    }
    if (def.requiresBuildingFlag && !city[def.requiresBuildingFlag]) {
        return { ok: false, message: `§c【${def.label}】の生産には対応する建造物が必要です。` };
    }
    // 💡 世界遺産(新要素): 1ゲームにつき1国家しか着工できない。着工した時点で早い者勝ちで
    //    予約されるため(startProduction呼び出し元がclaimWonderする)、他国はそもそも
    //    着工できない(完成まで競争して負けたらゴールドに還元、のような仕組みはスコープ外)。
    if (def.isWonder) {
        const ownerId = getWonderClaims()[id];
        if (ownerId) {
            // 💡 自国の別の都市で既に着工済みの場合も含めてブロックする(同じ遺産を複数の
            //    自都市で並行着工してボーナスを重複させられてしまうのを防ぐため)。
            const message = ownerId === player?.id
                ? `§c【${def.label}】は既に自国の別の都市で建設中/完成済みです。`
                : `§c【${def.label}】は既に他の国家が建設中/完成済みです。`;
            return { ok: false, message };
        }
    }
    if (def.requiresTechnology) {
        const hasTech = !!player && hasCompletedProgress(player, "technology", def.requiresTechnology);
        if (!hasTech) {
            const techDef = getDefinition("technology", def.requiresTechnology);
            return { ok: false, message: `§c【${def.label}】の生産には技術【${techDef?.label ?? def.requiresTechnology}】の取得が必要です。` };
        }
    }
    if (def.requiresCivic) {
        const hasCivic = !!player && hasCompletedProgress(player, "civic", def.requiresCivic);
        if (!hasCivic) {
            const civicDef = getDefinition("civic", def.requiresCivic);
            return { ok: false, message: `§c【${def.label}】の生産には社会制度【${civicDef?.label ?? def.requiresCivic}】の取得が必要です。` };
        }
    }
    // 💡 (バグ修正) 資源消費ユニット(consumesResource)は、以前はここで在庫を確認していなかった
    //    ため、在庫0のまま着工でき、数ターン生産力を注ぎ込んだ末に完成時(onComplete内)で
    //    静かにキャンセルされる(BotはcanBotStartProductionで別途この確認をしていたため、
    //    このバグは人間プレイヤーのみが踏んでいた)。着工前にここで弾く。
    if (def.consumesResource) {
        const stock = player ? (player.getDynamicProperty(def.consumesResource) ?? 0) : 0;
        if (stock < 1) {
            return { ok: false, message: `§c【${def.label}】の生産には必要な資源が不足しています。(在庫: ${stock})` };
        }
    }
    return { ok: true };
}

/**
 * この都市が保持する「完成済み」の世界遺産すべての予約(civ:wonderClaims)を解放する。
 * 建設中の世界遺産(city.production.id)は destroyCity/cmdCaptureCity 側で個別に扱われるため、
 * ここでは city[id] === true (=完成済み) の世界遺産のみを対象にする。
 * 都市の占領・破壊時に呼ばないと、完成済み遺産を持っていた都市が消えた後もその遺産IDが
 * 永久にロックされ、誰も二度と建設できなくなってしまう。
 */
export function releaseCityCompletedWonders(city, ownerId) {
    if (!city || !ownerId) return;
    for (const id in PRODUCTION_DEFS) {
        if (PRODUCTION_DEFS[id].isWonder && city[id]) releaseWonder(id, ownerId);
    }
}

/**
 * 生産を開始する。直前までの余剰生産力(productionCarry)があれば初期値として引き継ぐ。
 * @returns {{id: string, progress: number, cost: number} | null}
 */
export function startProduction(city, id) {
    const def = PRODUCTION_DEFS[id];
    if (!def) return null;

    const carry = city.productionCarry ?? 0;
    city.production = { id, progress: carry, cost: def.cost };
    city.productionCarry = 0;
    return city.production;
}

/**
 * 生産を中止する。蓄積していた生産力は消滅させず、次の生産に引き継ぐ。
 * @returns {{id: string, progress: number, cost: number} | null} 中止された生産の情報(なければ null)
 */
export function cancelProduction(city) {
    if (!city.production) return null;
    const cancelled = city.production;
    city.productionCarry = (city.productionCarry ?? 0) + cancelled.progress;
    city.production = null;
    return cancelled;
}

/**
 * 毎ターン呼び出す生産の進行処理。
 * @param {any} city 対象の都市データ
 * @param {number} productionAmount このターン、この都市が産出した生産力
 * @param {any} ctx onComplete に渡す追加情報 ({ cityKey, tiles, connectTradeRoutes, player } など。
 *   player は都市の所有者のストレージハンドル。horsemanの馬消費など、国家単位の資源を
 *   参照/消費するonCompleteが使う)
 * @returns {{ done: boolean, message: string } | null} 生産中でなければ null
 */
export function tickProduction(city, productionAmount, ctx) {
    if (!city.production) return null;
    const def = PRODUCTION_DEFS[city.production.id];
    if (!def) {
        // 不明な生産物データが残っていた場合の安全策
        city.production = null;
        return null;
    }

    city.production.progress += productionAmount ?? 0;

    if (city.production.progress >= city.production.cost) {
        const completionResult = def.onComplete(city, ctx);

        if (completionResult && completionResult.cancelled) {
            // 💡 完成条件(必要生産力)は満たしたが、配置できずに中止された場合。
            //    進行度は消滅させず、全額を productionCarry として次の生産に持ち越す。
            const progress = city.production.progress;
            const reasonText = completionResult.cancelReason === "enemyOccupied"
                ? "都市のマスに敵の戦闘ユニットがいる"
                : completionResult.cancelReason === "noNavalTile"
                ? "隣接する海・川などの水上マスが無い(または空きが無い)"
                : completionResult.cancelReason === "noResource"
                ? `資源「${completionResult.resourceLabel ?? "?"}」の在庫が無い`
                : "配置できる空きマスが周囲に無い";
            const message = `§c[Warning]【${city.name}】${def.label}の生産が完了しましたが、${reasonText}ため配置できず中止されました。(進行度は保持されます)`;

            city.production = null;
            city.productionCarry = (city.productionCarry ?? 0) + progress;
            return { done: true, cancelled: true, message };
        }

        const overflow = city.production.progress - city.production.cost;
        let message = def.completeMessage
            ? def.completeMessage(city)
            : `§e[Complete]【${city.name}】${def.label}の生産が完了！`;
        if (completionResult && completionResult.relocated) {
            message += " §7(都市のマスが自国/同盟ユニットで埋まっていたため、隣接マスに配置されました)";
        }

        city.production = null;
        city.productionCarry = (city.productionCarry ?? 0) + overflow;
        return { done: true, message };
    }

    const progressText = Math.floor(city.production.progress * 10) / 10;
    return {
        done: false,
        message: `§7【${city.name}】${def.icon} ${def.label}を生産中... (${progressText}/${city.production.cost})`,
    };
}
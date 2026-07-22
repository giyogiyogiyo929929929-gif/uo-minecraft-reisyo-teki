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
// 【労働者(worker)について】
// 労働者は「行動回数」を持つ(1人につき WORKER_ACTIONS_PER_UNIT 回)。伐採などの労働者を消費する
// アクションは、労働者を1人まるごと消費するのではなく、その行動回数を1減らすだけにする。行動回数が
// 0になった労働者だけがプールから取り除かれる(＝行動回数を使い切って初めて「消費」される)。
//   city.workerUnits = number[]  … 各労働者の残り行動回数の配列(例: [3, 3, 1] なら労働者3人)
//   city.workers      = number   … 表示・互換用の労働者数(常に workerUnits.length と同期する)

import { hasCompletedProgress, getDefinition } from "./progression.js";

/** 労働者1人が持つ行動回数。 */
export const WORKER_ACTIONS_PER_UNIT = 3;

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
    city.workers = units.length; // 表示・互換用フィールドを同期
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
    city.workers = units.length; // 表示・互換用フィールドを同期
    return true;
}

/** この都市に、行動回数が1以上残っている労働者が存在するかどうかを判定する。 */
export function hasAvailableWorkerAction(city) {
    return ensureWorkerUnits(city).length > 0;
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
 * @property {number} cost 完成に必要な生産力の合計値
 * @property {boolean} [uniquePerCity] true の場合、都市に既に存在する場合は再生産不可
 * @property {(city: any) => boolean} [hasBuilt] uniquePerCity 用: 既に保有済みか判定する関数
 * @property {number} [extraUpkeep] 生産中、都市の食料消費に追加される値
 * @property {(city: any, ctx: any) => void} onComplete 完成時の効果を適用する関数
 * @property {(city: any) => string} [completeMessage] 完成時のメッセージ生成関数
 */
export const PRODUCTION_DEFS = {
    worker: {
        label: "労働者",
        icon: "[Worker]",
        category: "unit",
        cost: 10,
        onComplete: (city) => {
            addWorkers(city, 1);
        },
        completeMessage: (city) => `§e🎉【${city.name}】労働者の生産が完了！ ([Worker]x${city.workers}、1人あたり行動回数${WORKER_ACTIONS_PER_UNIT})`,
    },
    missile: {
        label: "ミサイル",
        icon: "[Missile]",
        category: "unit",
        cost: 200,
        onComplete: (city) => {
            city.missiles = (city.missiles ?? 0) + 1;
        },
        completeMessage: (city) => `§c[Missile]🎉【${city.name}】ミサイルの製造が完了しました！ (在庫: ${city.missiles}発)`,
    },
    warrior: {
        label: "戦士",
        icon: "[Warrior]",
        category: "unit",
        cost: 30,
        requiresEmptyCombatTile: true,
        onComplete: (city, ctx) => {
            const tile = ctx?.tiles?.[ctx.cityKey];
            if (tile) {
                tile.combatUnit = {
                    // 💡 attackRange: 近接ユニットのため攻撃距離は移動力と同じ(1)。
                    id: "warrior", label: "戦士", hp: 100, maxHp: 100, combatStrength: 20,
                    movement: 1, movementRemaining: 1, attackRange: 1, ownerId: tile.ownerId, ownerName: tile.ownerName,
                };
            }
        },
        completeMessage: (city) => `§e[Warrior]【${city.name}】に戦士を配置しました！ (HP: 100/100、戦闘力: 20)`,
    },
    archer: {
        label: "弓兵",
        icon: "[Archer]",
        category: "unit",
        cost: 50,
        requiresEmptyCombatTile: true,
        requiresTechnology: "archery",
        onComplete: (city, ctx) => {
            const tile = ctx?.tiles?.[ctx.cityKey];
            if (tile) {
                tile.combatUnit = {
                    // 💡 弓兵は遠距離戦闘ユニット: 遠距離戦闘力20、近距離戦闘力15の2種類の戦闘力を持つ。
                    //    combatStrength は互換表示用に近距離戦闘力と同じ値を入れておく。
                    id: "archer", label: "弓兵", hp: 100, maxHp: 100,
                    combatStrength: 15, rangedCombatStrength: 20, meleeCombatStrength: 15,
                    movement: 1, movementRemaining: 1, attackRange: 2, ownerId: tile.ownerId, ownerName: tile.ownerName,
                };
            }
        },
        completeMessage: (city) => `§e[Archer]【${city.name}】に弓兵を配置しました！ (HP: 100/100、遠距離戦闘力: 20、近距離戦闘力: 15)`,
    },
    uoooo: {
        label: "うおおおおおお",
        icon: "[うおｗ]",
        category: "unit",
        cost: 500,
        requiresEmptyCombatTile: true,
        onComplete: (city, ctx) => {
            const tile = ctx?.tiles?.[ctx.cityKey];
            if (tile) {
                tile.combatUnit = {
                    id: "uoooo", label: "うおｗ", hp: 100, maxHp: 100, combatStrength: 200,
                    movement: 10, movementRemaining: 10, attackRange: 20, ownerId: tile.ownerId, ownerName: tile.ownerName,
                };
            }
        },
        completeMessage: (city) => `§e[Warrior]【${city.name}】にうおｗを配置しました！ (HP: 100/100、戦闘力: 20)`,
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
        completeMessage: (city) => `§e🎉【${city.name}】交易所が完成しました！`,
    },
    granary: {
        label: "穀物庫",
        icon: "[Granary]",
        category: "building",
        cost: 15,
        uniquePerCity: true,
        hasBuilt: (city) => !!city.granary,
        requiresTechnology: "pottery",
        // 💡 食料生産量+1 は turns.js の getCityCurrentYields 側で city.granary を見て加算する。
        //    住居+2 はここで即時・恒久的に加算する(交易所建設時のhousing+1と同じ考え方)。
        onComplete: (city) => {
            city.granary = true;
            city.housing = (city.housing ?? 0) + 2;
        },
        completeMessage: (city) => `§e🎉【${city.name}】穀物庫が完成しました！ (食料生産量+1、住居+2)`,
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
 * @returns {{ ok: boolean, message?: string }}
 */
export function canStartProduction(city, id, tile = null, player = null) {
    const def = PRODUCTION_DEFS[id];
    if (!def) return { ok: false, message: "§c不明な生産物です。" };
    if (city.production) return { ok: false, message: "§c既にこの都市では別の生産が進行中です。" };
    if (def.uniquePerCity && def.hasBuilt?.(city)) {
        return { ok: false, message: `§cこの都市には既に【${def.label}】が存在します。` };
    }
    if (def.requiresEmptyCombatTile && tile?.combatUnit) {
        return { ok: false, message: "§cこのマスにはすでに戦闘ユニットが存在します。" };
    }
    if (def.requiresTechnology) {
        const hasTech = !!player && hasCompletedProgress(player, "technology", def.requiresTechnology);
        if (!hasTech) {
            const techDef = getDefinition("technology", def.requiresTechnology);
            return { ok: false, message: `§c【${def.label}】の生産には技術【${techDef?.label ?? def.requiresTechnology}】の取得が必要です。` };
        }
    }
    return { ok: true };
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
 * @param {any} ctx onComplete に渡す追加情報 ({ cityKey, tiles, connectTradeRoutes } など)
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
        const overflow = city.production.progress - city.production.cost;
        def.onComplete(city, ctx);
        const message = def.completeMessage
            ? def.completeMessage(city)
            : `§e🎉【${city.name}】${def.label}の生産が完了！`;

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
// unitModels.js
// 各マスにいる戦闘ユニットのうち、見た目モデルが用意されている種類(現状は戦車・戦士・飛行船・戦艦)を
// 実際のエンティティ(civ:tank など、resource pack "testapia_models" 側で定義)として
// ワールドに配置し、同期を取るモジュール。unitLabels.js と全く同じ設計パターン
// (getStateVersion() で変化を検知、一定間隔で間引き、"tx,tz" キーで現在の表示物を管理し、
// 居なくなったマスのぶんだけ消す)を踏襲している。この方式なら production.js・commands.js・
// turns.js・ui.js 側は今まで通り tile.combatUnit を読み書きするだけでよく、新しいフックを
// 増やさずに済む。
//
// 【航空基地の機体(§航空戦)】
// 航空ユニットは tile.combatUnit ではなく city.airbase.units(airbase.js)に配置され、
// 1マスに複数機が居るためマス単位のキーでは表せない。そこで地上ユニットとは別の表
// (AIR_MODEL_TYPE_IDS)・別のキー体系("tx,tz#何機目")・別の配置ルール(拠点の上空を旋回)で
// 扱う。旋回はステート変化とは無関係に動き続ける必要があるため、定期同期とは別の
// 短い runInterval で位置を更新する(表示中の機体が1機も無い間はそのループごと止める)。

import { world, system } from "@minecraft/server";
import { getMapConfig, getTiles, getStateVersion } from "./state.js";

const TILE_SIZE = 5;
// 💡 毎tick同期すると負荷が大きいため、unitLabels.js と同じ間隔でのみ同期する。
const SYNC_INTERVAL_TICKS = 20;
// 💡 山(mountain)は地形生成時にタイル中心が最大3ブロック隆起する(mapGen.jsのpeak計算)。
//    山脈(mountainRange)はimpassableでユニットが乗ることはないため、山の最大値+余裕分だけ
//    見れば十分。config.ySurface+1に固定していると、山タイルの中心では地形に埋まってしまう。
const GROUND_SCAN_HEIGHT_ABOVE_SURFACE = 4;
// 💡 森林(forest)/熱帯雨林(rainforest)は、mapGen.jsのbuildSimpleTreeがタイル中心
//    (ローカル座標 dx=2, dz=2)に木を生やす(葉は幹の周囲1マス=dx/dz 1〜3に展開)。
//    通常のタイル中心(+2.5, +2.5)にそのまま置くと木の真下に埋まるため、この地形のときだけ
//    葉の範囲外(タイル端寄り)にずらして配置する。
const TREE_TERRAIN_TYPES = new Set(["forest", "rainforest"]);
// タイル中心(+2.5)ではなく端寄り(ローカルX=4.25。葉が展開する1〜3の範囲外)に配置する。
const TREE_AVOIDANCE_X_OFFSET = 4.25;
// 💡 人間プレイヤーが移動を指示したときだけ、瞬間移動ではなく目的地へ直進するアニメーションを
//    見せる(commands.js の cmdMoveCombatUnit から呼ばれる。Botの移動は体感速度を落とさない
//    ためアニメーションしない)。2tickごとに0.6ブロック進む(=秒速6ブロック相当)。
const MODEL_WALK_STEP_INTERVAL_TICKS = 2;
const MODEL_WALK_BLOCKS_PER_STEP = 0.6;

// 見た目モデルが用意されているユニットID → 対応するエンティティのtypeId。
// 新しいユニットの見た目を追加する際は、ここに1行足すだけでよい。
// 💡 航空ユニット(fighter/bomber/airRecon/airDefense)はtile.combatUnitに配置されず
//    (§航空戦。city.airbase.unitsに配置され、マス上には存在しない)、ここには載せない。
//    そちらは下の AIR_MODEL_TYPE_IDS 側で拠点上空を旋回させる。
//    飛行船(airship)は同じdomain:"air"でも例外で、航空基地ではなくマスに立つ戦闘ユニット
//    なのでここに載せる(ただし接地させず、MODEL_CRUISE_ALTITUDEの高度を巡航させる)。
const MODEL_TYPE_IDS = {
    tank: "civ:tank",
    warrior: "civ:warrior",
    airship: "civ:airship",
    dreadnought: "civ:dreadnought",
};

// 航空基地(city.airbase.units)に配置される航空ユニットのうち、見た目モデルがあるものの表。
// 支援偵察機・支援防御機・戦略爆撃機はまだモデルが無いので載せていない(作ったら1行足す)。
const AIR_MODEL_TYPE_IDS = {
    fighter: "civ:fighter",
};

// 1つの拠点で同時に表示する機数の上限。枠は飛行場(+8)・滑走路(+3)で最大12まで増えるが、
// 全機出すと都市の上が機体で埋まって見づらく、旋回の更新コストもそのぶん増える。
const MAX_AIR_MODELS_PER_CITY = 3;
// 旋回半径(ブロック)。1マス=5ブロックなので、隣のマスへ軽くはみ出す程度の大きさ。
const AIR_ORBIT_RADIUS = 3.2;
// 1周にかかるtick数と位置の更新間隔。160tick(8秒)で1周、4tickごと=1回あたり9度進む。
const AIR_ORBIT_PERIOD_TICKS = 160;
const AIR_ORBIT_STEP_TICKS = 4;
// 何機目かで高度をずらして重ならないようにする(1機目の高度と、1機あたりの増分。ブロック)。
// 💡 飛行船の巡航高度(MODEL_CRUISE_ALTITUDE=8)より上に取ること。同じ都市の上空に
//    飛行船が居ても機体同士がめり込まない。
const AIR_ORBIT_ALTITUDE_BASE = 13;
const AIR_ORBIT_ALTITUDE_STEP = 2;

// 💡 飛行ユニットは地形に沿わせず、config.ySurface からの一定高度に置く(値はブロック数)。
//    地表をなぞる findGroundY で置くと、山の隆起(最大+3)・山脈(+5)・森の樹冠(+6)に
//    出入りするたびに高度がガタつき、飛んでいるように見えない。地形の最大隆起より
//    高い値にしておくこと(現状の最大は山脈の+5と森の葉の+6)。
const MODEL_CRUISE_ALTITUDE = {
    airship: 8,
};

/** このユニットが巡航高度で飛ぶ場合はその高度(ブロック)、接地するユニットなら0を返す。 */
function cruiseAltitude(unitId) {
    return MODEL_CRUISE_ALTITUDE[unitId] ?? 0;
}

// "tx,tz" キー → { entity, unitId }
const activeModels = new Map();
// "tx,tz#何機目" キー → { entity, unitId, cx, cz, y, phase }(拠点上空を旋回中の航空ユニット)
const activeAirModels = new Map();
// 進行中の移動アニメーションの intervalハンドル → resolve関数。ゲームリセット時にまとめて
// 止め、対応する await が永久に解決しないまま固まらないよう resolve も呼べるようにする。
const activeAnimationIntervals = new Map();
let lastSyncTick = -Infinity;
let lastSyncedVersion = -1;
let airOrbitIntervalId = null;
// 💡 スクリプトを読み込み直す(/reload・ワールド再入場)と上の Map は空に戻るが、前回置いた
//    モデルのエンティティはワールドに残っている(minecraft:persistent)。そのまま同期すると
//    同じ場所に二重に湧いてしまうため、最初にモデルを置く直前に一度だけ掃除する。
//    掃除できたと記録するのは、実際にチャンクが読み込まれている状態で走らせたときだけ
//    (ensureOrphanModelsPurged を参照)。
let purgedOrphanModels = false;

/**
 * (x, z)の真上を config.ySurface + GROUND_SCAN_HEIGHT_ABOVE_SURFACE から下方向へ走査し、
 * 最初に見つかった非空気ブロックの1つ上のYを返す(=実際の地表面。山タイルの隆起分も
 * 自然に反映される)。チャンク未読み込みなどで何も見つからなければ従来通り ySurface + 1 に
 * フォールバックする。
 */
function findGroundY(dimension, x, config, z) {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let y = config.ySurface + GROUND_SCAN_HEIGHT_ABOVE_SURFACE; y >= config.ySurface; y--) {
        try {
            const block = dimension.getBlock({ x: bx, y, z: bz });
            if (block && !block.isAir) return y + 1;
        } catch (e) {}
    }
    return config.ySurface + 1;
}

/**
 * ワールド空間の移動方向(dx, dz)から、Minecraftのyaw(度、0=南/+Z、90=西/-X)を求める。
 * 戦車のジオメトリ(tank.geo.json)は砲身をローカルZ座標のマイナス方向へ向けて作っており、
 * これはyaw=0(南向き)のときエンティティの正面が向く方向と一致する想定(要実機確認。
 * もし実際に前後逆に見えたら、この式の符号を反転させれば直る)。
 */
function yawTowards(dx, dz) {
    return Math.atan2(-dx, dz) * (180 / Math.PI);
}

function tileGroundLocation(config, tx, tz, dimension, terrainType, unitId) {
    // 💡 巡航高度を持つユニット(飛行船)は樹冠より上を飛ぶため、木を避ける必要がない。
    //    むしろタイル端に寄せると大きなモデルが隣のマスへはみ出すので、常にマス中心に置く。
    const altitude = cruiseAltitude(unitId);
    const avoidsTree = altitude === 0 && TREE_TERRAIN_TYPES.has(terrainType);
    const x = config.originX + tx * TILE_SIZE + (avoidsTree ? TREE_AVOIDANCE_X_OFFSET : 2.5);
    const z = config.originZ + tz * TILE_SIZE + 2.5;
    const y = altitude > 0 ? config.ySurface + altitude : findGroundY(dimension, x, config, z);
    return { x, y, z };
}

function removeModel(key) {
    const entry = activeModels.get(key);
    if (!entry) return;
    try { if (entry.entity?.isValid) entry.entity.remove(); } catch (e) {}
    activeModels.delete(key);
}

function removeAirModel(key) {
    const entry = activeAirModels.get(key);
    if (!entry) return;
    try { if (entry.entity?.isValid) entry.entity.remove(); } catch (e) {}
    activeAirModels.delete(key);
}

/**
 * 前回のセッションが残した見た目モデルのエンティティを全て消す(セッション中に1回だけ)。
 */
function purgeOrphanModelEntities(dimension) {
    const typeIds = new Set([...Object.values(MODEL_TYPE_IDS), ...Object.values(AIR_MODEL_TYPE_IDS)]);
    for (const typeId of typeIds) {
        try {
            for (const entity of dimension.getEntities({ type: typeId })) {
                try { entity.remove(); } catch (e) {}
            }
        } catch (e) {}
    }
}

/**
 * これからモデルを置く location のチャンクが読み込まれていることを確かめてから、
 * 前セッションの残骸の掃除を1回だけ走らせる。
 * 💡 getEntities は未読み込みのチャンクの中身を返さないため、チャンクが読まれていないうちに
 *    掃除を走らせると「何も見つからなかった」だけで終わる。それを掃除済みとして記録すると、
 *    後からチャンクが読み込まれたときに前回のモデルが残ったまま二重に湧いてしまうので、
 *    読み込み済みだと確認できるまでは記録せず、次の同期でやり直す。
 *    実際にモデルを湧かせられる(=spawnEntity が通る)状況とこの判定は一致するので、
 *    「掃除より先にモデルが置かれてしまう」順序にはならない。
 */
function ensureOrphanModelsPurged(dimension, location) {
    if (purgedOrphanModels) return;
    try {
        if (!dimension.getBlock({ x: Math.floor(location.x), y: Math.floor(location.y), z: Math.floor(location.z) })) return;
    } catch (e) {
        return; // チャンク未読み込み。次の同期で改めて試す。
    }
    purgedOrphanModels = true;
    purgeOrphanModelEntities(dimension);
}

/** 旋回中の1機の、あるtickにおける位置と向き。 */
function airOrbitPose(entry, tick) {
    const theta = (tick / AIR_ORBIT_PERIOD_TICKS) * Math.PI * 2 + entry.phase;
    const sin = Math.sin(theta), cos = Math.cos(theta);
    return {
        location: { x: entry.cx + cos * AIR_ORBIT_RADIUS, y: entry.y, z: entry.cz + sin * AIR_ORBIT_RADIUS },
        // 進行方向は円の接線(位置 (cos, sin) の微分 = (-sin, cos))。
        rotation: { x: 0, y: yawTowards(-sin, cos) },
    };
}

/** 旋回の更新ループ本体。表示中の機体が1機でもある間だけ動かす。 */
function updateAirOrbits() {
    const tick = system.currentTick;
    for (const [key, entry] of activeAirModels) {
        try {
            if (!entry.entity?.isValid) throw new Error("entity invalidated");
            const { location, rotation } = airOrbitPose(entry, tick);
            entry.entity.teleport(location, { rotation });
        } catch (e) {
            // 何らかの理由で消えた機体は登録から外し、次の定期同期で置き直させる。
            // 定期同期は stateVersion が変わらないと走らないので、明示的に無効化しておく。
            activeAirModels.delete(key);
            lastSyncedVersion = -1;
        }
    }
    stopAirOrbitLoopIfIdle();
}

function ensureAirOrbitLoop() {
    if (airOrbitIntervalId !== null || activeAirModels.size === 0) return;
    airOrbitIntervalId = system.runInterval(updateAirOrbits, AIR_ORBIT_STEP_TICKS);
}

/** 表示中の機体が1機も無くなったら、旋回ループごと止める(常駐コストを残さない)。 */
function stopAirOrbitLoopIfIdle() {
    if (airOrbitIntervalId === null || activeAirModels.size > 0) return;
    try { system.clearRun(airOrbitIntervalId); } catch (e) {}
    airOrbitIntervalId = null;
}

/** マス上の戦闘ユニット(陸軍/海軍/飛行船)のモデルを1マスぶん同期する。 */
function syncGroundModelForTile(key, tile, config, dimension, seenKeys) {
    const unitId = tile.combatUnit?.id;
    const typeId = unitId ? MODEL_TYPE_IDS[unitId] : undefined;
    if (!typeId) return;
    seenKeys.add(key);

    const existing = activeModels.get(key);
    if (existing?.unitId === unitId && existing.entity?.isValid) return;
    if (existing) removeModel(key);

    const [txStr, tzStr] = key.split(",");
    const tx = Number(txStr), tz = Number(tzStr);
    const location = tileGroundLocation(config, tx, tz, dimension, tile.type, unitId);
    ensureOrphanModelsPurged(dimension, location);
    try {
        const entity = dimension.spawnEntity(typeId, location);
        activeModels.set(key, { entity, unitId });
    } catch (e) {}
}

/**
 * 1つの拠点(都心タイル)の航空基地に配置中の機体のモデルを同期する。
 * 何機目か(slot)はモデルのある機体だけを数えた通し番号で、キー・高度・円周上の位相を決める。
 */
function syncAirModelsForCity(cityKey, city, config, dimension, seenAirKeys) {
    const units = city.airbase?.units;
    if (!units?.length) return;

    const [txStr, tzStr] = cityKey.split(",");
    const cx = config.originX + Number(txStr) * TILE_SIZE + 2.5;
    const cz = config.originZ + Number(tzStr) * TILE_SIZE + 2.5;

    let slot = 0;
    for (const unit of units) {
        if (slot >= MAX_AIR_MODELS_PER_CITY) break;
        const typeId = AIR_MODEL_TYPE_IDS[unit?.id];
        if (!typeId || (unit.hp ?? 0) <= 0) continue;

        const index = slot++;
        const airKey = `${cityKey}#${index}`;
        seenAirKeys.add(airKey);

        const existing = activeAirModels.get(airKey);
        if (existing?.unitId === unit.id && existing.entity?.isValid) continue;
        if (existing) removeAirModel(airKey);

        const entry = {
            entity: null,
            unitId: unit.id,
            cx, cz,
            y: config.ySurface + AIR_ORBIT_ALTITUDE_BASE + index * AIR_ORBIT_ALTITUDE_STEP,
            // 同じ拠点の機体は円周上で等間隔に散らす(先頭に固まらないように)
            phase: (index / MAX_AIR_MODELS_PER_CITY) * Math.PI * 2,
        };
        const { location, rotation } = airOrbitPose(entry, system.currentTick);
        ensureOrphanModelsPurged(dimension, location);
        try {
            entry.entity = dimension.spawnEntity(typeId, location);
            entry.entity.teleport(location, { rotation });
            activeAirModels.set(airKey, entry);
        } catch (e) {}
    }
}

function syncUnitModelsInner() {
    const config = getMapConfig();
    if (!config) return;

    const tiles = getTiles();
    const dimension = world.getDimension("overworld");
    const seenKeys = new Set();
    const seenAirKeys = new Set();

    for (const key in tiles) {
        const tile = tiles[key];
        syncGroundModelForTile(key, tile, config, dimension, seenKeys);
        // 💡 航空ユニットは都心タイルの city.airbase.units に居るため、combatUnit が
        //    無いマスでも(=上の関数が何もしなかったマスでも)必ずここを通す。
        if (tile.city) syncAirModelsForCity(key, tile.city, config, dimension, seenAirKeys);
    }

    // 見た目モデル付きユニットが居なくなった(移動・撃破・マップ再生成など)マスのモデルを削除する。
    for (const key of activeModels.keys()) {
        if (!seenKeys.has(key)) removeModel(key);
    }
    for (const key of activeAirModels.keys()) {
        if (!seenAirKeys.has(key)) removeAirModel(key);
    }
    ensureAirOrbitLoop();
    stopAirOrbitLoopIfIdle();
}

/**
 * 現在の全タイルを走査し、見た目モデルがあるユニットが乗っているマスへのエンティティ配置を
 * ワールドに同期する。main.js の定期ループから呼び出す想定。
 */
export function syncUnitModels() {
    const currentTick = system.currentTick;
    if (currentTick - lastSyncTick < SYNC_INTERVAL_TICKS) return;
    lastSyncTick = currentTick;

    const version = getStateVersion();
    if (version === lastSyncedVersion) return;
    lastSyncedVersion = version;

    try {
        syncUnitModelsInner();
    } catch (e) {}
}

/**
 * "fromTx,fromTz" にある見た目モデル付きユニットを、"toTx,toTz" へ目的地に直進するアニメーション
 * で移動させる。対象のマスに見た目モデル(MODEL_TYPE_IDSに登録されたユニットのみ)が無ければ
 * 何もせず即座に解決するため、呼び出し元(commands.js の cmdMoveCombatUnit)はユニット種別を
 * 気にせず常に await してよい。
 * 経路上は数tickごとに findGroundY を呼び直してYを求め直すことで、山の隆起などの高低差にも
 * 追従する。最終ステップでは目的地タイルの正式な着地点(tileGroundLocation、森林の
 * 端寄りオフセットも含む)にきっちり合わせる。
 */
export function animateUnitModelMove(fromTx, fromTz, toTx, toTz) {
    const fromKey = `${fromTx},${fromTz}`;
    const toKey = `${toTx},${toTz}`;
    const entry = activeModels.get(fromKey);
    if (!entry) return Promise.resolve();

    // 💡 定期同期(syncUnitModelsInner)が移動元・移動先どちらのマスにも誤って手を出さないよう、
    //    アニメーション開始前に先にキーを移し替えておく(移動先タイルのデータは
    //    cmdMoveCombatUnit が既に同期的に書き込み済みのため、ここで先に移し替えても
    //    整合性は崩れない)。移動先(陥落都市の守備ユニットなど)に既存モデルが残っていれば
    //    上書きで見失わないよう先に片付ける。
    activeModels.delete(fromKey);
    if (activeModels.has(toKey)) removeModel(toKey);
    activeModels.set(toKey, entry);

    const config = getMapConfig();
    const { entity } = entry;
    if (!config || !entity?.isValid) return Promise.resolve();

    const dimension = world.getDimension("overworld");
    const tiles = getTiles();
    const startLoc = entity.location;
    const endLoc = tileGroundLocation(config, toTx, toTz, dimension, tiles[toKey]?.type, entry.unitId);
    // 💡 巡航高度を持つユニットは経路上も高度一定。地表を追わせると山越えのたびに上下してしまう。
    const altitude = cruiseAltitude(entry.unitId);

    const dx = endLoc.x - startLoc.x, dz = endLoc.z - startLoc.z;
    const distance = Math.hypot(dx, dz);
    const totalSteps = Math.max(1, Math.round(distance / MODEL_WALK_BLOCKS_PER_STEP));
    // 移動方向は直進なので経路上ずっと一定。ステップごとに求め直す必要はない。
    const rotation = { x: 0, y: yawTowards(dx, dz) };

    return new Promise((resolve) => {
        let step = 0;
        const intervalId = system.runInterval(() => {
            step++;
            try {
                if (!entity.isValid) throw new Error("entity invalidated mid-animation");
                const t = Math.min(1, step / totalSteps);
                if (t >= 1) {
                    entity.teleport(endLoc, { rotation });
                } else {
                    const x = startLoc.x + dx * t, z = startLoc.z + dz * t;
                    const y = altitude > 0 ? config.ySurface + altitude : findGroundY(dimension, x, config, z);
                    entity.teleport({ x, y, z }, { rotation });
                }
            } catch (e) {
                step = totalSteps; // 異常終了時もこのtickでアニメーションを打ち切る
            }
            if (step >= totalSteps) {
                system.clearRun(intervalId);
                activeAnimationIntervals.delete(intervalId);
                resolve();
            }
        }, MODEL_WALK_STEP_INTERVAL_TICKS);
        activeAnimationIntervals.set(intervalId, resolve);
    });
}

/** 全モデルを即座に削除する。ゲームリセット・マップ再生成などで明示的に片付けたい場合に使う。 */
export function clearAllUnitModels() {
    for (const [intervalId, resolve] of activeAnimationIntervals) {
        try { system.clearRun(intervalId); } catch (e) {}
        resolve(); // 対応する await (cmdMoveCombatUnit側)が固まらないよう、打ち切って解決する
    }
    activeAnimationIntervals.clear();
    for (const key of [...activeModels.keys()]) removeModel(key);
    for (const key of [...activeAirModels.keys()]) removeAirModel(key);
    stopAirOrbitLoopIfIdle();
}

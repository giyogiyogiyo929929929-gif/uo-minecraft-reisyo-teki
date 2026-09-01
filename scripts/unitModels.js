// unitModels.js
// 各マスにいる戦闘ユニットのうち、見た目モデルが用意されている種類(現状は戦車・戦士)を
// 実際のエンティティ(civ:tank など、resource pack "testapia_models" 側で定義)として
// ワールドに配置し、同期を取るモジュール。unitLabels.js と全く同じ設計パターン
// (getStateVersion() で変化を検知、一定間隔で間引き、"tx,tz" キーで現在の表示物を管理し、
// 居なくなったマスのぶんだけ消す)を踏襲している。この方式なら production.js・commands.js・
// turns.js・ui.js 側は今まで通り tile.combatUnit を読み書きするだけでよく、新しいフックを
// 増やさずに済む。

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
const MODEL_TYPE_IDS = {
    tank: "civ:tank",
    warrior: "civ:warrior",
};

// "tx,tz" キー → { entity, unitId }
const activeModels = new Map();
// 進行中の移動アニメーションの intervalハンドル → resolve関数。ゲームリセット時にまとめて
// 止め、対応する await が永久に解決しないまま固まらないよう resolve も呼べるようにする。
const activeAnimationIntervals = new Map();
let lastSyncTick = -Infinity;
let lastSyncedVersion = -1;

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

function tileGroundLocation(config, tx, tz, dimension, terrainType) {
    const xOffset = TREE_TERRAIN_TYPES.has(terrainType) ? TREE_AVOIDANCE_X_OFFSET : 2.5;
    const x = config.originX + tx * TILE_SIZE + xOffset;
    const z = config.originZ + tz * TILE_SIZE + 2.5;
    const y = findGroundY(dimension, x, config, z);
    return { x, y, z };
}

function removeModel(key) {
    const entry = activeModels.get(key);
    if (!entry) return;
    try { if (entry.entity?.isValid) entry.entity.remove(); } catch (e) {}
    activeModels.delete(key);
}

function syncUnitModelsInner() {
    const config = getMapConfig();
    if (!config) return;

    const tiles = getTiles();
    const dimension = world.getDimension("overworld");
    const seenKeys = new Set();

    for (const key in tiles) {
        const tile = tiles[key];
        const unitId = tile.combatUnit?.id;
        const typeId = unitId ? MODEL_TYPE_IDS[unitId] : undefined;
        if (!typeId) continue;
        seenKeys.add(key);

        const existing = activeModels.get(key);
        if (existing?.unitId === unitId && existing.entity?.isValid) continue;
        if (existing) removeModel(key);

        const [txStr, tzStr] = key.split(",");
        const tx = Number(txStr), tz = Number(tzStr);
        try {
            const entity = dimension.spawnEntity(typeId, tileGroundLocation(config, tx, tz, dimension, tile.type));
            activeModels.set(key, { entity, unitId });
        } catch (e) {}
    }

    // 見た目モデル付きユニットが居なくなった(移動・撃破・マップ再生成など)マスのモデルを削除する。
    for (const key of activeModels.keys()) {
        if (!seenKeys.has(key)) removeModel(key);
    }
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
    const endLoc = tileGroundLocation(config, toTx, toTz, dimension, tiles[toKey]?.type);

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
                    entity.teleport({ x, y: findGroundY(dimension, x, config, z), z }, { rotation });
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
}

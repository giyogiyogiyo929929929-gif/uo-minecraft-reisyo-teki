// mapGen.js
import { BlockPermutation, world, system } from "@minecraft/server";

export const TILE_SIZE = 5;

// 💡 マップ生成時、プレイヤーのシミュレーション範囲(読み込まれるチャンクの範囲)をどの程度と
//    見積もるか(ブロック単位)。Script API にはワールドの実際のシミュレーション距離設定を
//    取得する手段が無いため、控えめな既定値を保守的に仮定している。
//    もし自分のワールドの実際のシミュレーション距離を把握しているなら、この値を調整してよい。
export const ASSUMED_SIMULATION_RANGE_BLOCKS = 64; // 目安: 4チャンク相当

// 💡 tickingarea を使う場合の1バンドあたりのタイル数(正方形の一辺)。
//    範囲が広すぎる単一のtickingareaはマインクラフトをクラッシュさせうるため、
//    生成中は「今まさに書き込んでいる小さな範囲」だけを一時的にtickingarea化し、
//    書き終えたら解除して次の範囲へ移動する。
//    💡 安定性を優先し、あえて小さめの値にしている(時間はかかっても良いという判断のため)。
const TICKING_BAND_TILES = 4;
// tickingareaのY範囲(ySurfaceからの相対値)。地形整形で実際に触るのは
// ySurface-3(山の地下)〜ySurface+8(熱帯雨林の木の葉+2)程度なので、少し余裕を持たせる。
const TICKING_Y_BELOW = 4;
const TICKING_Y_ABOVE = 9;
const TICKING_AREA_NAME_PREFIX = "civ_addon_gen_area";

// マス種別: 草原, 川, 海, 山, 砂漠, 森林, 熱帯雨林, 寒冷地
export const TERRAIN_TYPES = {
    grassland: { label: "草原", weight: 22 },
    river: { label: "川", weight: 8 },
    sea: { label: "海", weight: 10 },
    mountain: { label: "山", weight: 10 },
    desert: { label: "砂漠", weight: 12 },
    forest: { label: "森林", weight: 16 },
    rainforest: { label: "熱帯雨林", weight: 10 },
    cold: { label: "寒冷地", weight: 12 },
    pond: { label: "池", weight: 0 }, // 自動変化用
    lake: { label: "湖", weight: 0 }, // 自動変化用
};

// 💎 資源の定義
export const RESOURCE_TYPES = {
    iron: { label: "鉄", category: "戦略", allowedTerrains: ["mountain", "grassland"], block: "minecraft:iron_ore" },
    coal: { label: "石炭", category: "戦略", allowedTerrains: ["mountain", "cold"], block: "minecraft:coal_ore" },
    diamonds: { label: "ダイヤモンド", category: "高級", allowedTerrains: ["desert", "mountain"], block: "minecraft:diamond_ore" },
    gold_ore: { label: "金", category: "高級", allowedTerrains: ["desert", "river"], block: "minecraft:gold_ore" },
    wheat: { label: "小麦", category: "ボーナス", allowedTerrains: ["grassland"], block: "minecraft:hay_block" },
    fish: { label: "魚", category: "ボーナス", allowedTerrains: ["sea", "river"], block: "minecraft:prismarine_crystals" },
    oil: { label: "石油", category: "戦略", allowedTerrains: ["desert", "sea"], block: "minecraft:coal_block" }, // 💡 🛢️ 石油を追加！
    meteor: { label: "隕石", category: "戦略", allowedTerrains: ["grassland", "desert", "mountain"], block: "minecraft:magma" },
    magic_crystal: { label: "魔晶石", category: "高級", allowedTerrains: ["desert"], block: "minecraft:crying_obsidian" },
    moonstone: { label: "月の石", category: "高級", allowedTerrains: ["grassland"], block: "minecraft:end_stone" },
    uranium: { label: "ウラン(238)", category: "戦略", allowedTerrains: ["grassland"], block: "minecraft:element_92" }
};

const TYPE_KEYS = Object.keys(TERRAIN_TYPES);
const RESOURCE_KEYS = Object.keys(RESOURCE_TYPES);

// 💡 各地形タイプの「表面(dx=0,dz=0の位置)に置かれるはずのブロック」。
//    タイル生成後、実際にこのブロックが置かれているかを確認することで、
//    シミュレーション範囲外などが原因の「設置漏れ」を検出できるようにする。
const SURFACE_BLOCK_BY_TYPE = {
    grassland: "minecraft:grass_block",
    forest: "minecraft:grass_block",
    desert: "minecraft:sand",
    mountain: "minecraft:stone",
    river: "minecraft:water",
    pond: "minecraft:water",
    lake: "minecraft:water",
    sea: "minecraft:water",
    cold: "minecraft:snow",
    rainforest: "minecraft:podzol",
};

function pickWeightedType(rng) {
    const totalWeight = TYPE_KEYS.reduce((sum, k) => sum + TERRAIN_TYPES[k].weight, 0);
    let roll = rng() * totalWeight;
    for (const key of TYPE_KEYS) {
        roll -= TERRAIN_TYPES[key].weight;
        if (roll <= 0) return key;
    }
    return TYPE_KEYS[0];
}

function pickRandomResource(terrainType, rng) {
    if (rng() > 0.25) return null;

    const matchingResources = RESOURCE_KEYS.filter(rKey => 
        RESOURCE_TYPES[rKey].allowedTerrains.includes(terrainType)
    );

    if (matchingResources.length === 0) return null;
    const index = Math.floor(rng() * matchingResources.length);
    return matchingResources[index];
}

// 💡 地形と資源に応じた食料（1〜3）を計算するロジック
function calculateFoodYield(terrainType, resource, rng) {
    let base = 2;
    const roll = rng();

    if (terrainType === "grassland") {
        base = roll < 0.6 ? 3 : (roll < 0.9 ? 2 : 1);
    } else if (terrainType === "desert" || terrainType === "cold") {
        base = roll < 0.7 ? 1 : (roll < 0.9 ? 2 : 3);
    } else if (terrainType === "mountain") {
        base = roll < 0.6 ? 1 : (roll < 0.9 ? 2 : 3);
    } else {
        base = roll < 0.3 ? 1 : (roll < 0.8 ? 2 : 3);
    }

    if (resource === "wheat" || resource === "fish") {
        base += 2;
    }

    return Math.min(5, base);
}

function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

// 💡 直前のバンドで使っていたtickingareaの名前。「新しい方が確実に有効になってから、
//    古い方を消す」という順序にするため、名前は使い回さずバンドごとに変える(連番)。
//    同じ名前に対してremoveとaddがほぼ同時に走る競合(removeがまだ内部処理中のうちに
//    同名でaddしてしまい、addが黙って無視される、等)を根本的に避けるのが狙い。
let tickingAreaCounter = 0;
let previousTickingAreaName = null;

/**
 * 💡 指定した範囲(ブロック座標)を、一時的にtickingarea化して読み込み状態にする。
 * ・毎回「新しい名前」でtickingareaを追加し、追加に成功してから直前のtickingareaを消す
 *   (remove→addではなくadd→removeの順にすることで、同名の競合を避ける)。
 * ・add コマンドが失敗しても、時間がかかっても構わないので成功するまでリトライし続ける
 *   (安定性優先。ただし無限ループで完全に固まらないよう、一定回数ごとに警告ログを出す)。
 * @returns {string|null} 追加できたtickingareaの名前(失敗し続けた場合はnullを返しベストエフォートで進める)
 */
async function setBandTickingArea(dimension, minX, minZ, maxX, maxZ, ySurface) {
    const minY = ySurface - TICKING_Y_BELOW;
    const maxY = ySurface + TICKING_Y_ABOVE;
    const areaName = `${TICKING_AREA_NAME_PREFIX}_${tickingAreaCounter++}`;

    let addedName = null;
    const maxAttempts = 60; // 5tick × 60 = 300tick(約15秒)ごとに警告しつつ、それでも成功するまで続ける
    for (let attempt = 1; ; attempt++) {
        try {
            dimension.runCommand(`tickingarea add ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} ${areaName}`);
            addedName = areaName;
            break;
        } catch (e) {
            if (attempt % maxAttempts === 0) {
                console.warn?.(`[civ mapGen] tickingarea追加に${attempt}回失敗中: ${areaName} (${e})`);
            }
            await system.waitTicks(5);
        }
    }

    // 💡 新しいtickingareaの追加に成功した「後」で、直前のバンドのtickingareaを消す。
    //    (先に消してしまうと、上のaddが終わるまでの間だけ何も読み込み保証が無い空白ができる)
    if (previousTickingAreaName) {
        try { dimension.runCommand(`tickingarea remove ${previousTickingAreaName}`); } catch (e) { /* 無視 */ }
    }
    previousTickingAreaName = addedName;
    return addedName;
}

/** 生成完了後、最後に残っているtickingareaを解除する。 */
function clearBandTickingArea(dimension) {
    if (previousTickingAreaName) {
        try { dimension.runCommand(`tickingarea remove ${previousTickingAreaName}`); } catch (e) { /* 無視 */ }
        previousTickingAreaName = null;
    }
    // 💡 保険: プレフィックスに一致する残骸が万一残っていても、名前が分からないと消せないため、
    //    せめて既定の番号0〜多めの範囲だけ試みる(通常は上のprevious解除だけで十分足りる)。
}

/**
 * 💡 指定範囲(の四隅+中心の計5点)のチャンクが実際に読み込まれてブロック操作可能になるまで待つ。
 * tickingareaを追加しても、そのtick内に読み込みが完了している保証は無いため、このチェックを
 * 挟むことで「読み込まれる前にブロックを設置してしまい、一部が反映されない」事故を防ぐ。
 * 💡 時間がかかっても安定性を優先するため、既定では諦めずに待ち続ける(タイムアウトなし)。
 *    ただし完全に固まったように見えないよう、一定間隔で進行中であることをログに残す。
 * @returns {boolean} 常に true(読み込みが確認できるまで戻らない)。将来の拡張用に真偽値を返す形にしている。
 */
async function waitForBandLoaded(dimension, minX, minZ, maxX, maxZ, ySurface) {
    const midX = Math.floor((minX + maxX) / 2);
    const midZ = Math.floor((minZ + maxZ) / 2);
    const samplePoints = [
        { x: minX, z: minZ }, { x: maxX, z: minZ },
        { x: minX, z: maxZ }, { x: maxX, z: maxZ },
        { x: midX, z: midZ },
    ];

    for (let attempt = 1; ; attempt++) {
        let allLoaded = true;
        for (const p of samplePoints) {
            try {
                if (!dimension.getBlock({ x: p.x, y: ySurface, z: p.z })) { allLoaded = false; break; }
            } catch (e) {
                allLoaded = false;
                break;
            }
        }
        if (allLoaded) return true;
        if (attempt % 60 === 0) {
            // 約15秒おきに状況をログへ(進行が完全に見えなくならないように)
            console.warn?.(`[civ mapGen] 範囲(${minX},${minZ})〜(${maxX},${maxZ})の読み込み待ち... (${attempt * 5}tick経過)`);
        }
        await system.waitTicks(5);
    }
}

/** system.runJob(CPU負荷を複数tickに分散する仕組み)を、await で待てるPromiseとして扱うためのラッパー。 */
function runJobAsync(generatorFn) {
    return new Promise((resolve) => {
        system.runJob((function* () {
            yield* generatorFn();
            resolve();
        })());
    });
}

/** 指定座標のブロックのtypeIdを、失敗しても例外を投げずに取得する(不安定な状況での防御用)。 */
function safeGetBlockTypeId(dimension, x, y, z) {
    try {
        return dimension.getBlock({ x, y, z })?.typeId ?? null;
    } catch (e) {
        return null;
    }
}

/** 指定座標にブロックを設置する。失敗しても例外を外に投げず、成否をbooleanで返す(生成全体を止めないため)。 */
function safeSetBlock(dimension, x, y, z, permutation) {
    if (!permutation) return false;
    try {
        const block = dimension.getBlock({ x, y, z });
        if (!block) return false;
        block.setPermutation(permutation);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 💡 タイルの表面(dx=0,dz=0の位置)に、その地形タイプで期待されるブロックが実際に
 * 置かれているかどうかを確認する。シミュレーション範囲外などが原因で設置が反映されて
 * いない場合、ここで検出してリトライ対象にできる。
 */
function isTilePlaced(dimension, baseX, ySurface, baseZ, type) {
    const expected = SURFACE_BLOCK_BY_TYPE[type] ?? "minecraft:grass_block";
    return safeGetBlockTypeId(dimension, baseX, ySurface, baseZ) === expected;
}


function setCol(dimension, x, ySurface, z, surfaceBlock, fillBlock, fillDepth = 2) {
    safeSetBlock(dimension, x, ySurface, z, surfaceBlock);
    for (let d = 1; d <= fillDepth; d++) {
        safeSetBlock(dimension, x, ySurface - d, z, fillBlock);
    }
}

function buildSimpleTree(dimension, cx, ySurface, cz, logType, leavesType, height = 4) {
    const logPerm = BlockPermutation.resolve(logType);
    const leavesPerm = BlockPermutation.resolve(leavesType);
    for (let h = 1; h <= height; h++) {
        safeSetBlock(dimension, cx, ySurface + h, cz, logPerm);
    }
    for (let lx = -1; lx <= 1; lx++) {
        for (let lz = -1; lz <= 1; lz++) {
            for (let ly = 0; ly <= 1; ly++) {
                if (lx === 0 && lz === 0 && ly === 0) continue;
                safeSetBlock(dimension, cx + lx, ySurface + height + ly, cz + lz, leavesPerm);
            }
        }
    }
    safeSetBlock(dimension, cx, ySurface + height + 2, cz, leavesPerm);
}

function* shapeTile(dimension, baseX, ySurface, baseZ, type, resource) {
    const grass = BlockPermutation.resolve("minecraft:grass_block");
    const dirt = BlockPermutation.resolve("minecraft:dirt");
    const water = BlockPermutation.resolve("minecraft:water");
    const sand = BlockPermutation.resolve("minecraft:sand");
    const sandstone = BlockPermutation.resolve("minecraft:sandstone");
    const stone = BlockPermutation.resolve("minecraft:stone");
    const andesite = BlockPermutation.resolve("minecraft:andesite");
    const snow = BlockPermutation.resolve("minecraft:snow");
    const packedIce = BlockPermutation.resolve("minecraft:packed_ice");
    const podzol = BlockPermutation.resolve("minecraft:podzol");
    const prismarine = BlockPermutation.resolve("minecraft:prismarine");
    const clay = BlockPermutation.resolve("minecraft:clay");

    for (let dx = 0; dx < TILE_SIZE; dx++) {
        for (let dz = 0; dz < TILE_SIZE; dz++) {
            const x = baseX + dx;
            const z = baseZ + dz;

            switch (type) {
                case "grassland":
                    setCol(dimension, x, ySurface, z, grass, dirt);
                    break;
                case "desert":
                    setCol(dimension, x, ySurface, z, sand, sandstone);
                    break;
                case "mountain": {
                    setCol(dimension, x, ySurface, z, stone, andesite, 3);
                    const distFromCenter = Math.abs(dx - 2) + Math.abs(dz - 2);
                    const peak = Math.max(0, 3 - distFromCenter);
                    for (let h = 1; h <= peak; h++) {
                        safeSetBlock(dimension, x, ySurface + h, z, h === peak ? stone : andesite);
                    }
                    break;
                }
                case "river":
                case "pond":
                case "lake":
                    setCol(dimension, x, ySurface, z, water, sand, 1);
                    safeSetBlock(dimension, x, ySurface - 2, z, clay);
                    break;
                case "sea":
                    setCol(dimension, x, ySurface, z, water, sand, 1);
                    safeSetBlock(dimension, x, ySurface - 2, z, prismarine);
                    break;
                case "cold":
                    setCol(dimension, x, ySurface, z, snow, packedIce, 2);
                    break;
                case "forest":
                    setCol(dimension, x, ySurface, z, grass, dirt);
                    break;
                case "rainforest":
                    setCol(dimension, x, ySurface, z, podzol, dirt);
                    break;
                default:
                    setCol(dimension, x, ySurface, z, grass, dirt);
            }
        }
        yield;
    }

    if (type === "forest") {
        buildSimpleTree(dimension, baseX + 2, ySurface, baseZ + 2, "minecraft:oak_log", "minecraft:oak_leaves", 4);
    } else if (type === "rainforest") {
        buildSimpleTree(dimension, baseX + 2, ySurface, baseZ + 2, "minecraft:jungle_log", "minecraft:jungle_leaves", 6);
    }

    if (resource && RESOURCE_TYPES[resource]) {
        const resDef = RESOURCE_TYPES[resource];
        const rx = baseX + 1;
        const rz = baseZ + 2;
        let ry = ySurface;

        if (type === "mountain") {
            ry = ySurface + 1;
        }

        try {
            const blockPerm = BlockPermutation.resolve(resDef.block);
            safeSetBlock(dimension, rx, ry, rz, blockPerm);
        } catch (e) {}
    }

    yield;
}

/**
 * 💡 マップの外周(黒曜石の壁)を、上下左右の4辺に分けて、さらにそれぞれをブロック単位の
 * バンドに分割しながら設置する。tickingareaを使う場合、辺全体を1度に読み込み状態にすると
 * (特に細長いマップで)範囲が広くなりすぎる恐れがあるため、辺ごと・バンドごとに
 * 小さくtickingareaを張り直し、読み込みを確認してから設置を行う。
 */
async function placeBorderWallsAsync(dimension, originX, originZ, width, height, ySurface, useTickingArea) {
    const obsidian = BlockPermutation.resolve("minecraft:obsidian");
    if (!obsidian) return;

    const minX = originX - 1;
    const maxX = originX + width * TILE_SIZE;
    const minZ = originZ - 1;
    const maxZ = originZ + height * TILE_SIZE;
    const bandBlocks = TICKING_BAND_TILES * TILE_SIZE;

    // 上辺・下辺(x方向にバンド分割、zは固定の1ライン)
    for (const z of [minZ, maxZ]) {
        for (let bx = minX; bx <= maxX; bx += bandBlocks) {
            const bxEnd = Math.min(maxX, bx + bandBlocks - 1);
            if (useTickingArea) {
                await setBandTickingArea(dimension, bx - 1, z - 1, bxEnd + 1, z + 1, ySurface);
                await waitForBandLoaded(dimension, bx - 1, z - 1, bxEnd + 1, z + 1, ySurface);
            }
            for (let x = bx; x <= bxEnd; x++) {
                safeSetBlock(dimension, x, ySurface, z, obsidian);
            }
        }
    }

    // 左辺・右辺(z方向にバンド分割、xは固定の1ライン)
    for (const x of [minX, maxX]) {
        for (let bz = minZ; bz <= maxZ; bz += bandBlocks) {
            const bzEnd = Math.min(maxZ, bz + bandBlocks - 1);
            if (useTickingArea) {
                await setBandTickingArea(dimension, x - 1, bz - 1, x + 1, bzEnd + 1, ySurface);
                await waitForBandLoaded(dimension, x - 1, bz - 1, x + 1, bzEnd + 1, ySurface);
            }
            for (let z = bz; z <= bzEnd; z++) {
                safeSetBlock(dimension, x, ySurface, z, obsidian);
            }
        }
    }
}

/**
 * マップを生成する(非同期関数)。
 * 💡 tickingareaを使う場合、各帯(バンド)ごとに「範囲を設定→実際に読み込まれるまで待って
 *    確認→ブロック設置→解除」という手順を踏むため、以前の即時生成(同期ジェネレータ)に比べて
 *    時間はかかるが、シミュレーション範囲外でもブロックの設置漏れが起きにくい。
 * @param {any} dimension
 * @param {{originX:number, ySurface:number, originZ:number, width:number, height:number, seed?:number, useTickingArea?:boolean}} cfg
 *   useTickingArea: true の場合のみ、生成中に小さく分割したtickingareaを一時的に使用する。
 *   (呼び出し側で、マップ範囲がシミュレーション範囲を超えるかどうかを判定して渡すこと。
 *    範囲内に収まっているなら渡さない/falseにして、不要なtickingareaの使用を避ける)
 * @param {(tx:number, tz:number, type:string, resource:string|null, foodYield:number, productionYield:number) => void} onTileDone
 */
export async function generateMap(dimension, { originX, ySurface, originZ, width, height, seed, useTickingArea }, onTileDone) {
    // 💡 前回の生成が異常終了していた場合に備え、tickingarea管理用の状態をリセットしておく。
    tickingAreaCounter = 0;
    previousTickingAreaName = null;

    const rng = makeRng(seed ?? Date.now());
    const grid = Array.from({ length: height }, () => Array(width).fill(null));
    const seaGroups = Math.max(1, Math.floor((width * height) / 40));
    for (let i = 0; i < seaGroups; i++) {
        const sx = Math.floor(rng() * (width - 1));
        const sz = Math.floor(rng() * (height - 1));
        grid[sz][sx] = "sea";
        grid[sz][sx+1] = "sea";
        grid[sz+1][sx] = "sea";
        grid[sz+1][sx+1] = "sea";
    }
    const riverCount = Math.max(1, Math.floor((width * height) / 30));
    for (let i = 0; i < riverCount; i++) {
        let rx = Math.floor(rng() * width);
        let rz = Math.floor(rng() * height);
        const length = 5 + Math.floor(rng() * 10);

        for (let l = 0; l < length; l++) {
            if (rx >= 0 && rx < width && rz >= 0 && rz < height) {
                if (grid[rz][rx] === "sea") break;
                grid[rz][rx] = "river";
            }
            const dir = Math.floor(rng() * 4);
            if (dir === 0) rx++; else if (dir === 1) rx--; else if (dir === 2) rz++; else rz--;
        }
    }
    for (let tz = 0; tz < height; tz++) {
        for (let tx = 0; tx < width; tx++) {
            if (grid[tz][tx] === null) {
                let type = pickWeightedType(rng);
                while (type === "river" || type === "sea") { type = pickWeightedType(rng); }
                grid[tz][tx] = type;
            }
        }
    }
    const connectedRiver = Array.from({ length: height }, () => Array(width).fill(false));
    const queue = [];

    for (let tz = 0; tz < height; tz++) {
        for (let tx = 0; tx < width; tx++) {
            if (grid[tz][tx] === "river") {
                let adjSea = false;
                const dirs = [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}];
                for (const d of dirs) {
                    if (grid[tz+d.z]?.[tx+d.x] === "sea") adjSea = true;
                }
                if (adjSea) { connectedRiver[tz][tx] = true; queue.push({x: tx, z: tz}); }
            }
        }
    }

    while (queue.length > 0) {
        const {x, z} = queue.shift();
        const dirs = [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}];
        for (const d of dirs) {
            const nx = x + d.x, nz = z + d.z;
            if (grid[nz]?.[nx] === "river" && !connectedRiver[nz][nx]) {
                connectedRiver[nz][nx] = true; queue.push({x: nx, z: nz});
            }
        }
    }

    for (let tz = 0; tz < height; tz++) {
        for (let tx = 0; tx < width; tx++) {
            if (grid[tz][tx] === "river" && !connectedRiver[tz][tx]) grid[tz][tx] = "pond";
        }
    }

    const visitedPond = Array.from({ length: height }, () => Array(width).fill(false));
    for (let tz = 0; tz < height; tz++) {
        for (let tx = 0; tx < width; tx++) {
            if (grid[tz][tx] === "pond" && !visitedPond[tz][tx]) {
                const component = [];
                const pQueue = [{x: tx, z: tz}];
                visitedPond[tz][tx] = true;

                while (pQueue.length > 0) {
                    const curr = pQueue.shift(); component.push(curr);
                    const dirs = [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}];
                    for (const d of dirs) {
                        const nx = curr.x + d.x, nz = curr.z + d.z;
                        if (grid[nz]?.[nx] === "pond" && !visitedPond[nz][nx]) {
                            visitedPond[nz][nx] = true; pQueue.push({x: nx, z: nz});
                        }
                    }
                }
                if (component.length >= 3) {
                    for (const p of component) grid[p.z][p.x] = "lake";
                }
            }
        }
    }

    // 💡 タイルの実際のブロック設置(帯=バンド単位で「範囲確保→読み込み確認→設置→解除」を繰り返す)。
    //    grid/連結判定などここまでの処理はメモリ上の計算のみでブロックに触れないため、
    //    tickingareaは不要(ここから先、実際にsetPermutationするところから必要になる)。
    const failedTiles = [];

    for (let bandTz = 0; bandTz < height; bandTz += TICKING_BAND_TILES) {
        const bandTzEnd = Math.min(height, bandTz + TICKING_BAND_TILES);
        for (let bandTx = 0; bandTx < width; bandTx += TICKING_BAND_TILES) {
            const bandTxEnd = Math.min(width, bandTx + TICKING_BAND_TILES);

            if (useTickingArea) {
                const minBX = originX + bandTx * TILE_SIZE - 2;
                const maxBX = originX + bandTxEnd * TILE_SIZE + 2;
                const minBZ = originZ + bandTz * TILE_SIZE - 2;
                const maxBZ = originZ + bandTzEnd * TILE_SIZE + 2;
                // 💡 「新しい範囲を確保できてから、直前の範囲を手放す」順序になっているため、
                //    バンド間で一瞬たりとも「どこも読み込み保証が無い」空白ができない。
                await setBandTickingArea(dimension, minBX, minBZ, maxBX, maxBZ, ySurface);
                // 💡 tickingareaを追加しても、そのtick内で読み込みが完了している保証は無いため、
                //    実際に読み込まれたことを確認できるまで待つ(＝時間をかけて安定性を優先する)。
                await waitForBandLoaded(dimension, minBX, minBZ, maxBX, maxBZ, ySurface);
            }

            // 💡 実際のブロック設置はCPU負荷が大きいため、system.runJobで複数tickに分散して行う。
            await runJobAsync(function* () {
                for (let tz = bandTz; tz < bandTzEnd; tz++) {
                    for (let tx = bandTx; tx < bandTxEnd; tx++) {
                        const type = grid[tz][tx];
                        const resource = pickRandomResource(type, rng);
                        const foodYield = calculateFoodYield(type, resource, rng);

                        let productionYield = Math.floor(rng() * 3) + 1;
                        if (resource && RESOURCE_TYPES[resource]?.category === "戦略") productionYield += 2;

                        const baseX = originX + tx * TILE_SIZE;
                        const baseZ = originZ + tz * TILE_SIZE;
                        yield* shapeTile(dimension, baseX, ySurface, baseZ, type, resource);

                        // 💡 実際にブロックが反映されているかを確認する。反映されていなければ、
                        //    このバンドがまだ完全には読み込まれていなかった可能性があるため、
                        //    その場で失敗にせず、後でリトライするタイルとして記録しておく。
                        if (isTilePlaced(dimension, baseX, ySurface, baseZ, type)) {
                            onTileDone(tx, tz, type, resource, foodYield, productionYield);
                        } else {
                            failedTiles.push({ tx, tz, type, resource, foodYield, productionYield, baseX, baseZ });
                        }
                    }
                }
            });

            // 💡 ここではtickingareaを解除しない。次のバンドのsetBandTickingArea()が
            //    「新しい範囲を追加できてから、この範囲を解除する」ため、意図的にここでは何もしない。
        }
    }

    // 💡 メインパスで設置が確認できなかったタイルを、範囲を1タイルずつに絞って個別に再試行する。
    //    (時間がかかっても構わないので、諦めずに再試行してから最終手段として警告を残す)
    const permanentlyFailedTiles = [];
    if (failedTiles.length > 0) {
        console.warn?.(`[civ mapGen] ${failedTiles.length}箇所のタイルでブロック未反映を検出。個別に再試行します。`);
        for (const failed of failedTiles) {
            let succeeded = false;
            for (let retry = 0; retry < 5 && !succeeded; retry++) {
                if (useTickingArea) {
                    const minBX = failed.baseX - 2;
                    const maxBX = failed.baseX + TILE_SIZE + 1;
                    const minBZ = failed.baseZ - 2;
                    const maxBZ = failed.baseZ + TILE_SIZE + 1;
                    await setBandTickingArea(dimension, minBX, minBZ, maxBX, maxBZ, ySurface);
                    await waitForBandLoaded(dimension, minBX, minBZ, maxBX, maxBZ, ySurface);
                }
                await runJobAsync(function* () {
                    yield* shapeTile(dimension, failed.baseX, ySurface, failed.baseZ, failed.type, failed.resource);
                });
                succeeded = isTilePlaced(dimension, failed.baseX, ySurface, failed.baseZ, failed.type);
            }
            if (!succeeded) {
                console.warn?.(`[civ mapGen] タイル(${failed.tx},${failed.tz})は再試行しても設置を確認できませんでした。`);
                permanentlyFailedTiles.push({ tx: failed.tx, tz: failed.tz });
            }
            // 💡 見た目の設置に最終的に失敗した場合でも、ゲーム内データ(所有権・資源など)は
            //    登録しておく(タイルデータが歯抜けになると、他の処理が正しく動かなくなるため)。
            onTileDone(failed.tx, failed.tz, failed.type, failed.resource, failed.foodYield, failed.productionYield);
        }
    }

    // 💡 外周の黒曜石の壁も、辺・バンドごとにtickingareaを張り直し、読み込みを確認しながら設置する。
    await placeBorderWallsAsync(dimension, originX, originZ, width, height, ySurface, useTickingArea);

    // 💡 最終クリーンアップ: 最後のバンドのtickingareaを解除する。
    if (useTickingArea) clearBandTickingArea(dimension);

    return { failedTiles: permanentlyFailedTiles };
}

export function worldToTile(config, x, z) {
    const tx = Math.floor((x - config.originX) / TILE_SIZE);
    const tz = Math.floor((z - config.originZ) / TILE_SIZE);
    return { tx, tz };
}
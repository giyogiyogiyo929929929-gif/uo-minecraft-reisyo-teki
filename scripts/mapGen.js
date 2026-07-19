// mapGen.js
import { BlockPermutation, world } from "@minecraft/server";

export const TILE_SIZE = 5;

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

function setCol(dimension, x, ySurface, z, surfaceBlock, fillBlock, fillDepth = 2) {
    dimension.getBlock({ x, y: ySurface, z })?.setPermutation(surfaceBlock);
    for (let d = 1; d <= fillDepth; d++) {
        dimension.getBlock({ x, y: ySurface - d, z })?.setPermutation(fillBlock);
    }
}

function buildSimpleTree(dimension, cx, ySurface, cz, logType, leavesType, height = 4) {
    for (let h = 1; h <= height; h++) {
        dimension.getBlock({ x: cx, y: ySurface + h, z: cz })?.setPermutation(BlockPermutation.resolve(logType));
    }
    for (let lx = -1; lx <= 1; lx++) {
        for (let lz = -1; lz <= 1; lz++) {
            for (let ly = 0; ly <= 1; ly++) {
                if (lx === 0 && lz === 0 && ly === 0) continue;
                dimension
                    .getBlock({ x: cx + lx, y: ySurface + height + ly, z: cz + lz })
                    ?.setPermutation(BlockPermutation.resolve(leavesType));
            }
        }
    }
    dimension.getBlock({ x: cx, y: ySurface + height + 2, z: cz })?.setPermutation(BlockPermutation.resolve(leavesType));
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
                        dimension.getBlock({ x, y: ySurface + h, z })?.setPermutation(h === peak ? stone : andesite);
                    }
                    break;
                }
                case "river":
                case "pond":
                case "lake":
                    setCol(dimension, x, ySurface, z, water, sand, 1);
                    dimension.getBlock({ x, y: ySurface - 2, z })?.setPermutation(clay);
                    break;
                case "sea":
                    setCol(dimension, x, ySurface, z, water, sand, 1);
                    dimension.getBlock({ x, y: ySurface - 2, z })?.setPermutation(prismarine);
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
            dimension.getBlock({ x: rx, y: ry, z: rz })?.setPermutation(blockPerm);
        } catch (e) {}
    }

    yield;
}

export function* generateMapJob(dimension, { originX, ySurface, originZ, width, height, seed }, onTileDone) {
    const rng = makeRng(seed ?? Date.now());
    const grid = Array.from({ length: height }, () => Array(width).fill(null));
    const seaGroups = Math.max(1, Math.floor((width * height) / 40));
    const obsidian = BlockPermutation.resolve("minecraft:obsidian");
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
    for (let tz = 0; tz < height; tz++) {
        for (let tx = 0; tx < width; tx++) {
            const type = grid[tz][tx];
            const resource = pickRandomResource(type, rng);
            const foodYield = calculateFoodYield(type, resource, rng);
            
            let productionYield = Math.floor(rng() * 3) + 1;
            if (resource && RESOURCE_TYPES[resource]?.category === "戦略") productionYield += 2;

            const baseX = originX + tx * TILE_SIZE;
            const baseZ = originZ + tz * TILE_SIZE;
            yield* shapeTile(dimension, baseX, ySurface, baseZ, type, resource);
            
            onTileDone(tx, tz, type, resource, foodYield, productionYield);
        }
    }
    if (obsidian) {
        const minX = originX - 1;
        const maxX = originX + width * TILE_SIZE;
        const minZ = originZ - 1;
        const maxZ = originZ + height * TILE_SIZE;

        for (let x = minX; x <= maxX; x++) {
            dimension.getBlock({ x, y: ySurface, z: minZ })?.setPermutation(obsidian);
            dimension.getBlock({ x, y: ySurface, z: maxZ })?.setPermutation(obsidian);
        }
        for (let z = minZ; z <= maxZ; z++) {
            dimension.getBlock({ x: minX, y: ySurface, z })?.setPermutation(obsidian);
            dimension.getBlock({ x: maxX, y: ySurface, z })?.setPermutation(obsidian);
        }
    }
}

export function worldToTile(config, x, z) {
    const tx = Math.floor((x - config.originX) / TILE_SIZE);
    const tz = Math.floor((z - config.originZ) / TILE_SIZE);
    return { tx, tz };
}
// mapGen.js
import { BlockPermutation, world, system } from "@minecraft/server";

export const TILE_SIZE = 5;
export const ASSUMED_SIMULATION_RANGE_BLOCKS = 64;
const TICKING_BAND_TILES = 4;
const TICKING_Y_BELOW = 4;
const TICKING_Y_ABOVE = 9;
const TICKING_AREA_NAME_PREFIX = "civ_addon_gen_area";

export const TERRAIN_TYPES = {
    grassland: { label: "草原", weight: 22 }, river: { label: "川", weight: 8 }, sea: { label: "海", weight: 10 },
    mountain: { label: "山", weight: 10 }, desert: { label: "砂漠", weight: 12 }, forest: { label: "森林", weight: 16 },
    rainforest: { label: "熱帯雨林", weight: 10 }, cold: { label: "寒冷地", weight: 12 }, pond: { label: "池", weight: 0 }, lake: { label: "湖", weight: 0 },
};

export const RESOURCE_TYPES = {
    iron: { label: "鉄", category: "戦略", allowedTerrains: ["mountain", "grassland"], block: "minecraft:iron_ore" },
    coal: { label: "石炭", category: "戦略", allowedTerrains: ["mountain", "cold"], block: "minecraft:coal_ore" },
    diamonds: { label: "ダイヤモンド", category: "高級", allowedTerrains: ["desert", "mountain"], block: "minecraft:diamond_ore" },
    gold_ore: { label: "金", category: "高級", allowedTerrains: ["desert", "river"], block: "minecraft:gold_ore" },
    wheat: { label: "小麦", category: "ボーナス", allowedTerrains: ["grassland"], block: "minecraft:hay_block" },
    fish: { label: "魚", category: "ボーナス", allowedTerrains: ["sea", "river"], block: "minecraft:prismarine_crystals" },
    oil: { label: "石油", category: "戦略", allowedTerrains: ["desert", "sea"], block: "minecraft:coal_block" },
    meteor: { label: "隕石", category: "戦略", allowedTerrains: ["grassland", "desert", "mountain"], block: "minecraft:magma" },
    magic_crystal: { label: "魔晶石", category: "高級", allowedTerrains: ["desert"], block: "minecraft:crying_obsidian" },
    moonstone: { label: "月の石", category: "高級", allowedTerrains: ["grassland"], block: "minecraft:end_stone" },
    uranium: { label: "ウラン(238)", category: "戦略", allowedTerrains: ["grassland"], block: "minecraft:element_92" }
};

const TYPE_KEYS = Object.keys(TERRAIN_TYPES);
const RESOURCE_KEYS = Object.keys(RESOURCE_TYPES);
const SURFACE_BLOCK_BY_TYPE = {
    grassland: "minecraft:grass_block", forest: "minecraft:grass_block", desert: "minecraft:sand", mountain: "minecraft:stone",
    river: "minecraft:water", pond: "minecraft:water", lake: "minecraft:water", sea: "minecraft:water", cold: "minecraft:snow", rainforest: "minecraft:podzol",
};

function pickWeightedType(rng) {
    const totalWeight = TYPE_KEYS.reduce((sum, k) => sum + TERRAIN_TYPES[k].weight, 0);
    let roll = rng() * totalWeight;
    for (const key of TYPE_KEYS) { roll -= TERRAIN_TYPES[key].weight; if (roll <= 0) return key; }
    return TYPE_KEYS[0];
}
function pickRandomResource(terrainType, rng) {
    if (rng() > 0.25) return null;
    const matchingResources = RESOURCE_KEYS.filter(rKey => RESOURCE_TYPES[rKey].allowedTerrains.includes(terrainType));
    if (matchingResources.length === 0) return null;
    return matchingResources[Math.floor(rng() * matchingResources.length)];
}
function calculateFoodYield(terrainType, resource, rng) {
    let base = 2;
    const roll = rng();
    if (terrainType === "grassland") base = roll < 0.6 ? 3 : (roll < 0.9 ? 2 : 1);
    else if (terrainType === "desert" || terrainType === "cold") base = roll < 0.7 ? 1 : (roll < 0.9 ? 2 : 3);
    else if (terrainType === "mountain") base = roll < 0.6 ? 1 : (roll < 0.9 ? 2 : 3);
    else base = roll < 0.3 ? 1 : (roll < 0.8 ? 2 : 3);
    if (resource === "wheat" || resource === "fish") base += 2;
    return Math.min(5, base);
}
function makeRng(seed) {
    let s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

let tickingAreaCounter = 0;
let previousTickingAreaName = null;

async function setBandTickingArea(dimension, minX, minZ, maxX, maxZ, ySurface) {
    const minY = ySurface - TICKING_Y_BELOW;
    const maxY = ySurface + TICKING_Y_ABOVE;
    const areaName = `${TICKING_AREA_NAME_PREFIX}_${tickingAreaCounter++}`;
    const maxAttempts = 360; // 最大約90秒。永久待機を防ぐ。
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            dimension.runCommand(`tickingarea add ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} ${areaName}`);
            previousTickingAreaName && (() => { try { dimension.runCommand(`tickingarea remove ${previousTickingAreaName}`); } catch (e) {} })();
            previousTickingAreaName = areaName;
            return areaName;
        } catch (e) {
            if (attempt % 60 === 0) console.warn?.(`[civ mapGen] tickingarea追加に${attempt}回失敗中: ${areaName}`);
            await system.waitTicks(5);
        }
    }
    console.warn?.(`[civ mapGen] tickingarea追加をタイムアウトしました: ${areaName}`);
    return null;
}

function clearBandTickingArea(dimension) {
    if (previousTickingAreaName) {
        try { dimension.runCommand(`tickingarea remove ${previousTickingAreaName}`); } catch (e) {}
        previousTickingAreaName = null;
    }
}

async function waitForBandLoaded(dimension, minX, minZ, maxX, maxZ, ySurface) {
    const midX = Math.floor((minX + maxX) / 2), midZ = Math.floor((minZ + maxZ) / 2);
    const samplePoints = [{x:minX,z:minZ},{x:maxX,z:minZ},{x:minX,z:maxZ},{x:maxX,z:maxZ},{x:midX,z:midZ}];
    const maxAttempts = 360; // 最大約90秒。生成全体の永久停止を防ぐ。
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let allLoaded = true;
        for (const p of samplePoints) {
            try { if (!dimension.getBlock({x:p.x,y:ySurface,z:p.z})) { allLoaded = false; break; } }
            catch (e) { allLoaded = false; break; }
        }
        if (allLoaded) return true;
        if (attempt % 60 === 0) console.warn?.(`[civ mapGen] 範囲(${minX},${minZ})〜(${maxX},${maxZ})の読み込み待ち... (${attempt * 5}tick経過)`);
        await system.waitTicks(5);
    }
    console.warn?.(`[civ mapGen] 範囲(${minX},${minZ})〜(${maxX},${maxZ})の読み込み確認をタイムアウトしました。ベストエフォートで続行します。`);
    return false;
}

function runJobAsync(generatorFn) {
    return new Promise((resolve) => system.runJob((function* () { yield* generatorFn(); resolve(); })()));
}
function safeGetBlockTypeId(dimension, x, y, z) { try { return dimension.getBlock({x,y,z})?.typeId ?? null; } catch (e) { return null; } }
function safeSetBlock(dimension, x, y, z, permutation) {
    if (!permutation) return false;
    try { const block = dimension.getBlock({x,y,z}); if (!block) return false; block.setPermutation(permutation); return true; } catch (e) { return false; }
}
function isTilePlaced(dimension, baseX, ySurface, baseZ, type) { return safeGetBlockTypeId(dimension, baseX, ySurface, baseZ) === (SURFACE_BLOCK_BY_TYPE[type] ?? "minecraft:grass_block"); }
function setCol(dimension, x, ySurface, z, surfaceBlock, fillBlock, fillDepth = 2) {
    safeSetBlock(dimension,x,ySurface,z,surfaceBlock);
    for (let d=1; d<=fillDepth; d++) safeSetBlock(dimension,x,ySurface-d,z,fillBlock);
}
function buildSimpleTree(dimension,cx,ySurface,cz,logType,leavesType,height=4) {
    const logPerm=BlockPermutation.resolve(logType), leavesPerm=BlockPermutation.resolve(leavesType);
    for(let h=1;h<=height;h++) safeSetBlock(dimension,cx,ySurface+h,cz,logPerm);
    for(let lx=-1;lx<=1;lx++) for(let lz=-1;lz<=1;lz++) for(let ly=0;ly<=1;ly++) { if(lx===0&&lz===0&&ly===0) continue; safeSetBlock(dimension,cx+lx,ySurface+height+ly,cz+lz,leavesPerm); }
    safeSetBlock(dimension,cx,ySurface+height+2,cz,leavesPerm);
}
function* shapeTile(dimension,baseX,ySurface,baseZ,type,resource) {
    const grass=BlockPermutation.resolve("minecraft:grass_block"), dirt=BlockPermutation.resolve("minecraft:dirt"), water=BlockPermutation.resolve("minecraft:water"), sand=BlockPermutation.resolve("minecraft:sand"), sandstone=BlockPermutation.resolve("minecraft:sandstone"), stone=BlockPermutation.resolve("minecraft:stone"), andesite=BlockPermutation.resolve("minecraft:andesite"), snow=BlockPermutation.resolve("minecraft:snow"), packedIce=BlockPermutation.resolve("minecraft:packed_ice"), podzol=BlockPermutation.resolve("minecraft:podzol"), prismarine=BlockPermutation.resolve("minecraft:prismarine"), clay=BlockPermutation.resolve("minecraft:clay");
    for(let dx=0;dx<TILE_SIZE;dx++) { for(let dz=0;dz<TILE_SIZE;dz++) { const x=baseX+dx,z=baseZ+dz; switch(type) {
        case "grassland": setCol(dimension,x,ySurface,z,grass,dirt); break;
        case "desert": setCol(dimension,x,ySurface,z,sand,sandstone); break;
        case "mountain": { setCol(dimension,x,ySurface,z,stone,andesite,3); const dist=Math.abs(dx-2)+Math.abs(dz-2),peak=Math.max(0,3-dist); for(let h=1;h<=peak;h++) safeSetBlock(dimension,x,ySurface+h,z,h===peak?stone:andesite); break; }
        case "river": case "pond": case "lake": setCol(dimension,x,ySurface,z,water,sand,1); safeSetBlock(dimension,x,ySurface-2,z,clay); break;
        case "sea": setCol(dimension,x,ySurface,z,water,sand,1); safeSetBlock(dimension,x,ySurface-2,z,prismarine); break;
        case "cold": setCol(dimension,x,ySurface,z,snow,packedIce,2); break;
        case "forest": setCol(dimension,x,ySurface,z,grass,dirt); break;
        case "rainforest": setCol(dimension,x,ySurface,z,podzol,dirt); break;
        default: setCol(dimension,x,ySurface,z,grass,dirt);
    }} yield; }
    if(type==="forest") buildSimpleTree(dimension,baseX+2,ySurface,baseZ+2,"minecraft:oak_log","minecraft:oak_leaves",4);
    else if(type==="rainforest") buildSimpleTree(dimension,baseX+2,ySurface,baseZ+2,"minecraft:jungle_log","minecraft:jungle_leaves",6);
    if(resource&&RESOURCE_TYPES[resource]) { const resDef=RESOURCE_TYPES[resource],rx=baseX+1,rz=baseZ+2; let ry=type==="mountain"?ySurface+1:ySurface; try { safeSetBlock(dimension,rx,ry,rz,BlockPermutation.resolve(resDef.block)); } catch(e) {} }
    yield;
}

async function placeBorderWallsAsync(dimension,originX,originZ,width,height,ySurface,useTickingArea) {
    const obsidian=BlockPermutation.resolve("minecraft:obsidian"); if(!obsidian) return;
    const minX=originX-1,maxX=originX+width*TILE_SIZE,minZ=originZ-1,maxZ=originZ+height*TILE_SIZE,bandBlocks=TICKING_BAND_TILES*TILE_SIZE;
    for(const z of [minZ,maxZ]) for(let bx=minX;bx<=maxX;bx+=bandBlocks) { const bxEnd=Math.min(maxX,bx+bandBlocks-1); if(useTickingArea){await setBandTickingArea(dimension,bx-1,z-1,bxEnd+1,z+1,ySurface);await waitForBandLoaded(dimension,bx-1,z-1,bxEnd+1,z+1,ySurface);} for(let x=bx;x<=bxEnd;x++) safeSetBlock(dimension,x,ySurface,z,obsidian); }
    for(const x of [minX,maxX]) for(let bz=minZ;bz<=maxZ;bz+=bandBlocks) { const bzEnd=Math.min(maxZ,bz+bandBlocks-1); if(useTickingArea){await setBandTickingArea(dimension,x-1,bz-1,x+1,bzEnd+1,ySurface);await waitForBandLoaded(dimension,x-1,bz-1,x+1,bzEnd+1,ySurface);} for(let z=bz;z<=bzEnd;z++) safeSetBlock(dimension,x,ySurface,z,obsidian); }
}

export async function generateMap(dimension,{originX,ySurface,originZ,width,height,seed,useTickingArea},onTileDone) {
    tickingAreaCounter=0; previousTickingAreaName=null;
    const rng=makeRng(seed??Date.now());
    const grid=Array.from({length:height},()=>Array(width).fill(null));
    const seaGroups=Math.max(1,Math.floor(width*height/40));
    for(let i=0;i<seaGroups;i++){const sx=Math.floor(rng()*Math.max(1,width-1)),sz=Math.floor(rng()*Math.max(1,height-1));grid[sz][sx]="sea";if(width>1)grid[sz][sx+1]="sea";if(height>1){grid[sz+1][sx]="sea";if(width>1)grid[sz+1][sx+1]="sea";}}
    const riverCount=Math.max(1,Math.floor(width*height/30));
    for(let i=0;i<riverCount;i++){let rx=Math.floor(rng()*width),rz=Math.floor(rng()*height),length=5+Math.floor(rng()*10);for(let l=0;l<length;l++){if(rx>=0&&rx<width&&rz>=0&&rz<height){if(grid[rz][rx]==="sea")break;grid[rz][rx]="river";}const dir=Math.floor(rng()*4);if(dir===0)rx++;else if(dir===1)rx--;else if(dir===2)rz++;else rz--;}}
    for(let tz=0;tz<height;tz++)for(let tx=0;tx<width;tx++)if(grid[tz][tx]===null){let type=pickWeightedType(rng);while(type==="river"||type==="sea")type=pickWeightedType(rng);grid[tz][tx]=type;}
    const connectedRiver=Array.from({length:height},()=>Array(width).fill(false)),queue=[];let queueHead=0;
    for(let tz=0;tz<height;tz++)for(let tx=0;tx<width;tx++)if(grid[tz][tx]==="river"){let adjSea=false;for(const d of [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}])if(grid[tz+d.z]?.[tx+d.x]==="sea")adjSea=true;if(adjSea){connectedRiver[tz][tx]=true;queue.push({x:tx,z:tz});}}
    while(queueHead<queue.length){const {x,z}=queue[queueHead++];for(const d of [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}]){const nx=x+d.x,nz=z+d.z;if(grid[nz]?.[nx]==="river"&&!connectedRiver[nz][nx]){connectedRiver[nz][nx]=true;queue.push({x:nx,z:nz});}}}
    for(let tz=0;tz<height;tz++)for(let tx=0;tx<width;tx++)if(grid[tz][tx]==="river"&&!connectedRiver[tz][tx])grid[tz][tx]="pond";
    const visitedPond=Array.from({length:height},()=>Array(width).fill(false));
    for(let tz=0;tz<height;tz++)for(let tx=0;tx<width;tx++)if(grid[tz][tx]==="pond"&&!visitedPond[tz][tx]){const component=[],pQueue=[{x:tx,z:tz}];let pQueueHead=0;visitedPond[tz][tx]=true;while(pQueueHead<pQueue.length){const curr=pQueue[pQueueHead++];component.push(curr);for(const d of [{x:1,z:0},{x:-1,z:0},{x:0,z:1},{x:0,z:-1}]){const nx=curr.x+d.x,nz=curr.z+d.z;if(grid[nz]?.[nx]==="pond"&&!visitedPond[nz][nx]){visitedPond[nz][nx]=true;pQueue.push({x:nx,z:nz});}}}if(component.length>=3)for(const p of component)grid[p.z][p.x]="lake";}
    const failedTiles=[];
    for(let bandTz=0;bandTz<height;bandTz+=TICKING_BAND_TILES){const bandTzEnd=Math.min(height,bandTz+TICKING_BAND_TILES);for(let bandTx=0;bandTx<width;bandTx+=TICKING_BAND_TILES){const bandTxEnd=Math.min(width,bandTx+TICKING_BAND_TILES);if(useTickingArea){const minBX=originX+bandTx*TILE_SIZE-2,maxBX=originX+bandTxEnd*TILE_SIZE+2,minBZ=originZ+bandTz*TILE_SIZE-2,maxBZ=originZ+bandTzEnd*TILE_SIZE+2;await setBandTickingArea(dimension,minBX,minBZ,maxBX,maxBZ,ySurface);await waitForBandLoaded(dimension,minBX,minBZ,maxBX,maxBZ,ySurface);}await runJobAsync(function*(){for(let tz=bandTz;tz<bandTzEnd;tz++)for(let tx=bandTx;tx<bandTxEnd;tx++){const type=grid[tz][tx],resource=pickRandomResource(type,rng),foodYield=calculateFoodYield(type,resource,rng);let productionYield=Math.floor(rng()*3)+1;if(resource&&RESOURCE_TYPES[resource]?.category==="戦略")productionYield+=2;const baseX=originX+tx*TILE_SIZE,baseZ=originZ+tz*TILE_SIZE;yield*shapeTile(dimension,baseX,ySurface,baseZ,type,resource);if(isTilePlaced(dimension,baseX,ySurface,baseZ,type))onTileDone(tx,tz,type,resource,foodYield,productionYield);else failedTiles.push({tx,tz,type,resource,foodYield,productionYield,baseX,baseZ});}});}}
    const permanentlyFailedTiles=[];
    for(const failed of failedTiles){let succeeded=false;for(let retry=0;retry<5&&!succeeded;retry++){if(useTickingArea){const minBX=failed.baseX-2,maxBX=failed.baseX+TILE_SIZE+1,minBZ=failed.baseZ-2,maxBZ=failed.baseZ+TILE_SIZE+1;await setBandTickingArea(dimension,minBX,minBZ,maxBX,maxBZ,ySurface);await waitForBandLoaded(dimension,minBX,minBZ,maxBX,maxBZ,ySurface);}await runJobAsync(function*(){yield*shapeTile(dimension,failed.baseX,ySurface,failed.baseZ,failed.type,failed.resource);});succeeded=isTilePlaced(dimension,failed.baseX,ySurface,failed.baseZ,failed.type);}if(!succeeded){console.warn?.(`[civ mapGen] タイル(${failed.tx},${failed.tz})は再試行しても設置を確認できませんでした。`);permanentlyFailedTiles.push({tx:failed.tx,tz:failed.tz});}onTileDone(failed.tx,failed.tz,failed.type,failed.resource,failed.foodYield,failed.productionYield);}
    await placeBorderWallsAsync(dimension,originX,originZ,width,height,ySurface,useTickingArea);if(useTickingArea)clearBandTickingArea(dimension);return {failedTiles:permanentlyFailedTiles};
}

export function worldToTile(config,x,z){return{tx:Math.floor((x-config.originX)/TILE_SIZE),tz:Math.floor((z-config.originZ)/TILE_SIZE)};}

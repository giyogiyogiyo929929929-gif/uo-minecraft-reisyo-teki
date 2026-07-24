// adjacency.js
// 🏗️ 建造物・区域(district)などが「隣接マスの状況(地形・資源・他の建造物など)に応じた
// ボーナス」を受け取れるようにするための汎用モジュール。
//
// 【狙い】
// 今後、建造物や区域を追加するたびに「周囲のマスをチェックして加算する」処理を
// 個別に書かなくて済むようにする。建造物/区域の定義に adjacencyBonuses(ルールの配列)を
// 追加するだけで、隣接ボーナスの計算が自動的に行われるようにする。
//
// 【使い方(建造物側)】
//   production.js の PRODUCTION_DEFS に、以下のようなルールを1つ追加するだけでよい:
//
//   quarry: {
//       label: "採石場", icon: "[Quarry]", category: "building", cost: 20,
//       uniquePerCity: true, hasBuilt: (city) => !!city.quarry,
//       requiresTechnology: "mining",
//       adjacencyBonuses: [
//           { id: "mountainOre", label: "山からの採掘恩恵", match: matchesTerrain("mountain"), yieldPerMatch: { production: 1 } },
//       ],
//       onComplete: (city) => { city.quarry = true; },
//       completeMessage: (city) => `...`,
//   },
//
// 【使い方(反映側)】
//   turns.js の getCityCurrentYields などで、その建造物を持つ都市について
//   getAdjacencyBonus(tx, tz, tiles, def.adjacencyBonuses) を呼び出し、戻り値
//   ({ food, production, ... } のような加算量マップ)をそのまま産出量に加算すればよい。
//   実際には getBuildingAdjacencyYields() が、都市が持つ建造物すべてぶんをまとめて
//   計算してくれるので、通常はそちらを呼ぶだけでよい。
//
// 【ルール(AdjacencyBonusRule)の形】
//   {
//     id: string,                          … 識別用ID(内訳表示・デバッグ用)
//     label: string,                       … 表示名
//     match: (neighborTile) => boolean,    … 隣接マス1つがこの条件を満たすか判定する関数
//     yieldPerMatch: { [key: string]: number }, … 条件を満たす隣接マス1つにつき加算する量
//     maxMatches?: number,                 … 加算対象にする隣接マス数の上限(省略時は上限なし、最大8)
//     oncePerTile?: boolean,               … true なら「1つでも条件を満たせば固定量を1回だけ加算」
//                                             (maxMatches より優先される)
//   }
//   yieldPerMatch のキーは自由(food/production/oil など、今後増える産出量にもそのまま使える)。
//
// 【条件判定用のヘルパー】
//   matchesTerrain(...types)       … 指定した地形タイプのいずれかであれば true
//   matchesResource(...resources) … 指定した資源のいずれかがあれば true
//   matchesBuilding(buildingId)   … 指定した建造物(city[buildingId] が true)を持つ都市マスなら true
//   matchesAnyCity()               … 何らかの都市があるマスなら true
//   これらで表現しきれない条件は、match に直接カスタム関数を書けばよい。

/** 指定したマスを取り囲む8マス(存在する範囲のみ)のタイルデータ一覧を返す。 */
export function getAdjacentTiles(tx, tz, tiles) {
    const neighbors = [];
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const tile = tiles[`${tx + dx},${tz + dz}`];
            if (tile) neighbors.push(tile);
        }
    }
    return neighbors;
}

/** 指定した地形タイプ一覧のいずれかにマッチする判定関数を作る。例: matchesTerrain("mountain", "desert") */
export function matchesTerrain(...types) {
    return (tile) => !!tile && types.includes(tile.type);
}

/** 指定した資源一覧のいずれかにマッチする判定関数を作る。例: matchesResource("oil", "iron") */
export function matchesResource(...resources) {
    return (tile) => !!tile && !!tile.resource && resources.includes(tile.resource);
}

/** 指定した建造物(city[buildingId] が truthy)を持つ都市マスにマッチする判定関数を作る。 */
export function matchesBuilding(buildingId) {
    return (tile) => !!tile?.city?.[buildingId];
}

/** 何らかの都市が存在するマスにマッチする判定関数を作る。 */
export function matchesAnyCity() {
    return (tile) => !!tile?.city;
}

/**
 * 指定したマスの周囲8マスを、渡されたルール一覧と照合し、加算されるべき量を合算する。
 * @param {number} tx
 * @param {number} tz
 * @param {any} tiles
 * @param {Array<any>} rules AdjacencyBonusRuleの配列(未指定/空なら何も加算しない)
 * @returns {{ [yieldKey: string]: number }} 例: { food: 2, production: 1 }
 */
export function getAdjacencyBonus(tx, tz, tiles, rules) {
    return getAdjacencyBonusDetailed(tx, tz, tiles, rules).totals;
}

/**
 * getAdjacencyBonus() の内訳付き版。どのルールが何マス分マッチして、何が加算されたのかを
 * 個別に返すため、UIでの内訳表示やデバッグに使える。
 * @returns {{ totals: {[k:string]:number}, breakdown: Array<{id:string, label:string, matchCount:number, yields:{[k:string]:number}}> }}
 */
export function getAdjacencyBonusDetailed(tx, tz, tiles, rules) {
    const totals = {};
    const breakdown = [];
    if (!Array.isArray(rules) || rules.length === 0) return { totals, breakdown };

    const neighbors = getAdjacentTiles(tx, tz, tiles);

    for (const rule of rules) {
        if (typeof rule?.match !== "function" || !rule.yieldPerMatch) continue;

        let matchCount = 0;
        for (const neighbor of neighbors) {
            if (rule.match(neighbor)) matchCount++;
        }
        if (matchCount === 0) continue;

        const effectiveCount = rule.oncePerTile
            ? 1
            : (typeof rule.maxMatches === "number" ? Math.min(matchCount, rule.maxMatches) : matchCount);

        const ruleYields = {};
        for (const key in rule.yieldPerMatch) {
            const amount = rule.yieldPerMatch[key] * effectiveCount;
            totals[key] = (totals[key] ?? 0) + amount;
            ruleYields[key] = amount;
        }
        breakdown.push({ id: rule.id ?? "?", label: rule.label ?? rule.id ?? "?", matchCount, yields: ruleYields });
    }

    return { totals, breakdown };
}

/**
 * 指定した都市が現在保有している建造物すべてについて、隣接ボーナスをまとめて計算する。
 * production.js の PRODUCTION_DEFS を渡すことで、「city[buildingId] が true の建造物」を
 * 自動的に拾い、それぞれの adjacencyBonuses を都市のマス(tx, tz)基準で計算・合算する。
 * 新しい建造物を追加しても、ここのコードは一切変更不要(定義側にルールを書くだけでよい)。
 * @param {number} tx 都市のマスのx座標
 * @param {number} tz 都市のマスのz座標
 * @param {any} tiles
 * @param {any} city 都市データ(city.granary, city.quarry などのフラグを持つオブジェクト)
 * @param {Record<string, any>} productionDefs production.js の PRODUCTION_DEFS
 * @returns {{ [yieldKey: string]: number }}
 */
export function getBuildingAdjacencyYields(tx, tz, tiles, city, productionDefs) {
    const totals = {};
    if (!city || !productionDefs) return totals;

    for (const buildingId in productionDefs) {
        const def = productionDefs[buildingId];
        if (def?.category !== "building") continue;
        if (!def.adjacencyBonuses || !city[buildingId]) continue;

        const bonus = getAdjacencyBonus(tx, tz, tiles, def.adjacencyBonuses);
        for (const key in bonus) {
            totals[key] = (totals[key] ?? 0) + bonus[key];
        }
    }

    return totals;
}
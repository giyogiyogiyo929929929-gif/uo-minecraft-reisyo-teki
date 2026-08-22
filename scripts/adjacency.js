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
//     match: (neighborTile) => boolean | number, … 隣接マス1つがこの条件を満たすか判定する関数。
//                                             真偽値の代わりに数値を返すと、その数値を「重み」として扱う
//                                             (例: 山脈は山の2倍の重み、のように地形ごとに倍率を変えたい場合)。
//     yieldPerMatch: { [key: string]: number }, … 条件を満たす隣接マス1つ(重み1)につき加算する量
//     maxMatches?: number,                 … 加算対象にする隣接マス数の上限(省略時は上限なし、最大8)
//     oncePerTile?: boolean,               … true なら「1つでも条件を満たせば固定量を1回だけ加算」
//                                             (maxMatches より優先される)
//   }
//   yieldPerMatch のキーは自由(food/production/oil など、今後増える産出量にもそのまま使える)。
//
// 【条件判定用のヘルパー】
//   matchesTerrain(...types)       … 指定した地形タイプのいずれかであれば true
//   matchesTerrainWeighted(map)   … 地形タイプごとに異なる重みを設定できる版(例: { mountain: 1, mountainRange: 2 })
//   matchesResource(...resources) … 指定した資源のいずれかがあれば true
//   matchesBuilding(buildingId)   … 指定した建造物(city[buildingId] が true)を持つ都市マスなら true
//   matchesAnyCity()               … 何らかの都市があるマスなら true
//   matchesFacility(facilityId)   … 指定した施設(facility.id)を持つマスなら true(省略時は施設なら何でも true)
//   matchesDistrict(districtId)   … 指定した区域(district.id)を持つマスなら true(省略時は区域なら何でも true)
//   これらで表現しきれない条件は、match に直接カスタム関数を書けばよい。

/**
 * 対象マス(tx, tz)の帰属都市のマスキー("tx,tz")を解決する。tile.belongsToCityKey が
 * 既にあればそれをそのまま使い、無ければ自国の都市の中から(マンハッタン距離で)最も近いものを探す。
 * 施設の設置(cmdInstallFacility)・区域/区域専用建造物の建設開始(cmdStartDistrict/
 * cmdStartDistrictBuilding)・区域配置メニューの表示(ui.js の openDistrictStartMenu)が
 * 共通して使う「労働者/生産力の帰属先都市を決める」ロジック。
 * 呼び出し側で `tile.belongsToCityKey = cityKey` を永続化するかどうか(タイミング含め)は
 * 各呼び出し元の判断に任せる(この関数自体は tiles を書き換えない)。
 * @param {number} tx
 * @param {number} tz
 * @param {any} tile 対象マスのデータ(belongsToCityKey の有無を確認する。省略時は毎回探索する)
 * @param {string} playerId
 * @param {any} tiles 全タイルデータ
 * @returns {string|null} 帰属都市のマスキー。見つからなければ null
 */
export function resolveOwningCityKey(tx, tz, tile, playerId, tiles) {
    if (tile?.belongsToCityKey) return tile.belongsToCityKey;

    let cityKey = null, minDist = Infinity;
    for (const key in tiles) {
        const t = tiles[key];
        if (t.ownerId !== playerId || !t.city) continue;
        const [cx, cz] = key.split(",");
        const dist = Math.abs(tx - parseInt(cx, 10)) + Math.abs(tz - parseInt(cz, 10));
        if (dist < minDist) { minDist = dist; cityKey = key; }
    }
    return cityKey;
}

/**
 * 指定したマスを取り囲む8マス(存在する範囲のみ)を { tx, tz, tile } の形で返す。
 * 座標自体も必要な呼び出し元(ボタン表示・アクションペイロードの構築など)向け。
 * production.js のユニット配置先探索・ui.js の布教先探索など、8近傍を走査する処理は
 * すべてこれ(またはタイルだけで良い場合は getAdjacentTiles)を使う。
 */
export function getAdjacentTileEntries(tx, tz, tiles) {
    const entries = [];
    for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nx = tx + dx, nz = tz + dz;
            const tile = tiles[`${nx},${nz}`];
            if (tile) entries.push({ tx: nx, tz: nz, tile });
        }
    }
    return entries;
}

/** 指定したマスを取り囲む8マス(存在する範囲のみ)のタイルデータ一覧を返す。 */
export function getAdjacentTiles(tx, tz, tiles) {
    return getAdjacentTileEntries(tx, tz, tiles).map((e) => e.tile);
}

/** 指定した地形タイプ一覧のいずれかにマッチする判定関数を作る。例: matchesTerrain("mountain", "desert") */
export function matchesTerrain(...types) {
    return (tile) => !!tile && types.includes(tile.type);
}

/**
 * 地形タイプごとに異なる重み(倍率)を指定できる版。例: 山脈は山の2倍の恩恵にしたい場合、
 * matchesTerrainWeighted({ mountain: 1, mountainRange: 2 }) のように書く。
 * 戻り値の関数は、マッチしない地形なら false、マッチする地形なら重み(数値)を返す。
 */
export function matchesTerrainWeighted(weightMap) {
    return (tile) => {
        if (!tile) return false;
        const weight = weightMap[tile.type];
        return weight ? weight : false;
    };
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
 * 指定した施設(facility)を持つマスにマッチする判定関数を作る。
 * IDを省略すると、施設の種類を問わず「何らかの施設があるマス」にマッチする。
 */
export function matchesFacility(facilityId) {
    return (tile) => facilityId ? tile?.facility?.id === facilityId : !!tile?.facility;
}

/**
 * 指定した区域(district)を持つマスにマッチする判定関数を作る。
 * IDを省略すると、区域の種類を問わず「何らかの区域があるマス」にマッチする。
 */
export function matchesDistrict(districtId) {
    return (tile) => districtId ? tile?.district?.id === districtId : !!tile?.district;
}

/**
 * 隣接マス一覧を既に取得済みの場合に、ルールとの照合と加算を行う内部関数。
 * getBuildingAdjacencyYields() では同じ都市について建造物ごとにルールを評価するため、
 * 8近傍の取得を建造物ごとに繰り返さないようにする。
 */
function getAdjacencyBonusDetailedFromNeighbors(neighbors, rules) {
    const totals = {};
    const breakdown = [];
    if (!Array.isArray(rules) || rules.length === 0) return { totals, breakdown };

    for (const rule of rules) {
        if (typeof rule?.match !== "function" || !rule.yieldPerMatch) continue;

        let matchCount = 0;
        let weightSum = 0;
        for (const neighbor of neighbors) {
            const result = rule.match(neighbor);
            if (!result) continue;
            matchCount++;
            weightSum += typeof result === "number" ? result : 1;
        }
        if (matchCount === 0) continue;

        const effectiveCount = rule.oncePerTile
            ? 1
            : (typeof rule.maxMatches === "number" ? Math.min(weightSum, rule.maxMatches) : weightSum);

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
    const neighbors = getAdjacentTiles(tx, tz, tiles);
    return getAdjacencyBonusDetailedFromNeighbors(neighbors, rules);
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

    // 同じ都市については建造物ごとに同じ8近傍を参照するため、1回だけ取得する。
    const neighbors = getAdjacentTiles(tx, tz, tiles);

    for (const buildingId in productionDefs) {
        const def = productionDefs[buildingId];
        if (def?.category !== "building") continue;
        if (!def.adjacencyBonuses || !city[buildingId]) continue;

        const bonus = getAdjacencyBonusDetailedFromNeighbors(neighbors, def.adjacencyBonuses).totals;
        mergeYields(totals, bonus);
    }

    return totals;
}

/** totals(合算先) に yields のキーを加算する。yields が無ければ何もしない。 */
function mergeYields(totals, yields) {
    if (!yields) return totals;
    for (const key in yields) totals[key] = (totals[key] ?? 0) + yields[key];
    return totals;
}

/**
 * 都市に帰属するマスの一覧(assignedTiles)を走査し、各マスから getEntry() で取り出した
 * エントリ(施設/区域など、{id}を持つオブジェクト)の定義を defs から引いて、その定義の
 * 指定フィールド(flatYields/perPopulationYields など、{ [yieldKey]: number } の形)を合算する
 * 汎用ヘルパー。facilities.js/districts.js の getXxxFlatYields・getDistrictPopulationYields が
 * 使う(いずれも「assignedTilesを回してエントリの定義から特定フィールドを合算する」という
 * 同じ形だったため、ここに1つにまとめている)。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles
 * @param {(tile: any) => {id: string}|null|undefined} getEntry マスから対象のエントリを取り出す関数
 * @param {Record<string, any>} defs エントリのIDをキーとする定義オブジェクト
 * @param {string} field 合算するフィールド名(例: "flatYields", "perPopulationYields")
 * @param {number} [multiplier=1] 各値に掛ける倍率(人口比例ボーナスの人口数など)
 * @returns {{ [yieldKey: string]: number }}
 */
export function sumAssignedTileYields(assignedTiles, getEntry, defs, field, multiplier = 1) {
    const totals = {};
    if (!Array.isArray(assignedTiles)) return totals;

    for (const t of assignedTiles) {
        const entry = getEntry(t.tile);
        if (!entry) continue;
        const def = defs[entry.id];
        const yields = def?.[field];
        if (!yields) continue;

        for (const key in yields) totals[key] = (totals[key] ?? 0) + yields[key] * multiplier;
    }

    return totals;
}

/**
 * sumAssignedTileYields() の隣接ボーナス版。エントリごとに、そのマス(tx,tz)を基準にした
 * 8近傍の adjacencyBonuses を計算して合算する(facilities.js/districts.js の
 * getFacilityAdjacencyYields/getDistrictAdjacencyYields が使う)。
 * @param {Array<{tx:number, tz:number, tile:any}>} assignedTiles
 * @param {any} tiles 全タイルデータ
 * @param {(tile: any) => {id: string}|null|undefined} getEntry マスから対象のエントリを取り出す関数
 * @param {Record<string, any>} defs エントリのIDをキーとする定義オブジェクト
 * @returns {{ [yieldKey: string]: number }}
 */
export function sumAssignedTileAdjacencyYields(assignedTiles, tiles, getEntry, defs) {
    const totals = {};
    if (!Array.isArray(assignedTiles)) return totals;

    for (const t of assignedTiles) {
        const entry = getEntry(t.tile);
        if (!entry) continue;
        const def = defs[entry.id];
        if (!def?.adjacencyBonuses) continue;

        mergeYields(totals, getAdjacencyBonus(t.tx, t.tz, tiles, def.adjacencyBonuses));
    }

    return totals;
}

/**
 * city[id] が true(その建造物/区域専用建造物を保有している)な定義について、flatYieldsを
 * 合算する汎用ヘルパー。production.js の PRODUCTION_DEFS(category:"building")と
 * districts.js の DISTRICT_BUILDING_DEFS の両方で使う(turns.js が個別の建造物ごとに
 * `if(city.granary)food++;` のような手書きの分岐を増やさずに済むようにするため)。
 * @param {any} city 都市データ
 * @param {Record<string, any>} defs 定義オブジェクト(PRODUCTION_DEFS または DISTRICT_BUILDING_DEFS)
 * @param {string} [categoryFilter] 指定すると def.category がこの値のものだけを対象にする
 *   (PRODUCTION_DEFS は unit/building が混在するため "building" を渡す。区域専用建造物にはcategoryが無いので省略)
 * @returns {{ [yieldKey: string]: number }}
 */
export function getFlagFlatYields(city, defs, categoryFilter = null) {
    const totals = {};
    if (!city || !defs) return totals;

    for (const id in defs) {
        const def = defs[id];
        if (categoryFilter && def?.category !== categoryFilter) continue;
        if (!def?.flatYields || !city[id]) continue;
        mergeYields(totals, def.flatYields);
    }

    return totals;
}
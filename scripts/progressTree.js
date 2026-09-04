// progressTree.js
// 研究(技術)ツリー・社会制度ツリーを「ツリー状の盤面」で表示・操作する画面。
// ui.js の openProgressMenu(ボタンを縦一列に並べる従来のリスト表示)の置き換えで、
// 前提条件の依存関係をそのまま左→右の階層(ティア)として並べ、ノードの間を接続線で結ぶ。
//
// 【仕組み】
// 表示は treeForm.js の TreeFormData(= リソースパック側の ui/tree_server_form.json が
// 描く TREE_COLS×TREE_ROWS のグリッド)。グリッドの偶数列(0,2,4,6)がノード列、奇数列
// (1,3,5)が接続線専用の列で、最終行(TREE_NAV_ROW)はページ送り等の操作ボタン専用。
// 1画面に収まるノード列は TREE_COLUMNS_PER_PAGE 列ぶんだけなので、それより深いツリーは
// TREE_PAGE_STEP 列ずつ(1列ぶん重ねて文脈が切れないように)横スクロールする。
//
// 【レイアウト計算】
// 1. 各項目の「ティア」= 前提条件チェーンの最長深さ。前提なしがティア0。
// 2. ティアごとに列へ割り当てる。1列に置ける数(TREE_NODE_ROWS)を超えるティアは、
//    同じティアのまま次の列へあふれさせる(将来項目が増えても表示が消えないための保険)。
// 3. 行は「前提条件の行の平均値(重心)に近い空き行」を順に埋めていく方式で決める。
//    これで親子が同じ行付近に並び、接続線が交差しにくくなる。
// 4. 接続線は「親の行を右へ進む → 子の直前の列で上下へ折れる → 子へ入る」の一筆書きで
//    引き、セルごとに上下左右のビット(DIR_*)を積算して、その組み合わせのテクスチャ
//    (textures/ui/tree/line_<mask>[_on].png、_on は親を取得済みの線)を選ぶ。

import { ActionFormData } from "@minecraft/server-ui";
import { TreeFormData, TREE_COLS, TREE_ROWS } from "./treeForm.js";
import { getDefinitions, getKindLabel, getPointsLabel, getProgressState } from "./progression.js";
import { getRealPlayer } from "./civs.js";

// 最終行は操作ボタン専用。残りの行にノードを並べる。
const TREE_NAV_ROW = TREE_ROWS - 1;
const TREE_NODE_ROWS = TREE_ROWS - 1;
// 偶数列がノード列(奇数列は接続線専用)なので、1ページに映るノード列は (COLS+1)/2 列。
const TREE_COLUMNS_PER_PAGE = Math.ceil(TREE_COLS / 2);
// ページ送りは1列ぶん重ねる(前のページの最終列が次のページの先頭列になる)。
const TREE_PAGE_STEP = Math.max(1, TREE_COLUMNS_PER_PAGE - 1);

const DIR_UP = 1;
const DIR_DOWN = 2;
const DIR_LEFT = 4;
const DIR_RIGHT = 8;

// 💡 接続線テクスチャの置き場所。tree_server_form.json は「テクスチャパスがこの文字列で
//    始まるセル」を接続線とみなして、枠・ラベル・アイコンを描かずにセル全面へ線を描く。
//    パスの先頭16文字("textures/ui/tree")で判定しているため、ここを変える場合は
//    リソースパック側のバインディングも合わせること。
const LINE_TEXTURE_DIR = "textures/ui/tree";

// 💡 ノードのアイコン(バニラのアイテム/ブロックのtypeId)。見た目の分かりやすさのための
//    対応付けで、ゲームロジックには影響しない。ここに無いIDは種別ごとの既定アイコンになる。
const TREE_NODE_ICONS = {
    technology: {
        animalHusbandry: "minecraft:hay_block",
        mining: "minecraft:iron_pickaxe",
        astrology: "minecraft:amethyst_shard",
        archery: "minecraft:bow",
        pottery: "minecraft:clay_ball",
        smelting: "minecraft:furnace",
        apprenticeship: "minecraft:anvil",
        writing: "minecraft:writable_book",
        bronzeWorking: "minecraft:golden_sword",
        horsebackRiding: "minecraft:saddle",
        sailing: "minecraft:oak_boat",
        currency: "minecraft:gold_ingot",
        education: "minecraft:bookshelf",
        ironWorking: "minecraft:iron_sword",
        shipBuilding: "minecraft:scaffolding",
        engineering: "minecraft:lantern",
        machinery: "minecraft:piston",
        masonry: "minecraft:stone_bricks",
        gunpowder: "minecraft:gunpowder",
        metallurgy: "minecraft:blast_furnace",
        industrialization: "minecraft:copper_ingot",
        electricity: "minecraft:redstone_lamp",
        rocketry: "minecraft:firework_rocket",
        aviation: "minecraft:elytra",
    },
    civic: {
        codeOfLaws: "minecraft:paper",
        emissaries: "minecraft:oak_sign",
        diplomacy: "minecraft:emerald",
        politicalPhilosophy: "minecraft:book",
        militaryTradition: "minecraft:iron_helmet",
        theocracy: "minecraft:golden_apple",
        commerce: "minecraft:gold_nugget",
        feudalism: "minecraft:shield",
        chivalry: "minecraft:iron_horse_armor",
    },
};
const TREE_DEFAULT_ICONS = {
    technology: "minecraft:iron_ingot",
    civic: "minecraft:writable_book",
};

// 最終行(操作ボタン)の列割り当て。
const NAV_PREV_COL = 0;
const NAV_NEXT_COL = 1;
const NAV_STATUS_COL = 2;
const NAV_SWITCH_COL = 3;
const NAV_LIST_COL = 4;
const NAV_HELP_COL = 5;
const NAV_BACK_COL = 6;

// ツリーの並び(ティア・行・列)は定義が固定なら毎回同じなので、種別ごとに1度だけ計算する。
const layoutCache = new Map();

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/** 前提条件チェーンの最長深さ(ティア)を全項目ぶん求める。循環参照は0扱いで打ち切る。 */
function computeTiers(defs) {
    const tiers = {};
    const visiting = new Set();
    const resolve = (id) => {
        if (tiers[id] !== undefined) return tiers[id];
        const def = defs[id];
        if (!def || visiting.has(id)) return 0;
        visiting.add(id);
        let tier = 0;
        for (const prerequisite of def.prerequisites ?? []) {
            if (!defs[prerequisite]) continue;
            tier = Math.max(tier, resolve(prerequisite) + 1);
        }
        visiting.delete(id);
        tiers[id] = tier;
        return tier;
    };
    for (const id of Object.keys(defs)) resolve(id);
    return tiers;
}

/**
 * 種別(technology/civic)のツリー配置を求める。
 * @returns {{columns: string[][], colById: Object, rowById: Object, occupied: Set<string>, edges: {from: string, to: string}[]}}
 */
function getLayout(kind) {
    const cached = layoutCache.get(kind);
    if (cached) return cached;

    const defs = getDefinitions(kind);
    const ids = Object.keys(defs);
    const tiers = computeTiers(defs);

    // ティアごとに列へ流し込む(1列に収まらないティアは同じティアのまま次の列へあふれさせる)。
    const columns = [];
    const colById = {};
    const maxTier = ids.reduce((max, id) => Math.max(max, tiers[id]), 0);
    for (let tier = 0; tier <= maxTier; tier++) {
        const members = ids.filter(id => tiers[id] === tier);
        if (members.length === 0) continue;
        for (let index = 0; index < members.length; index += TREE_NODE_ROWS) {
            const column = members.slice(index, index + TREE_NODE_ROWS);
            for (const id of column) colById[id] = columns.length;
            columns.push(column);
        }
    }

    // 行は「前提条件の行の重心」に近い空き行から埋める(前提なしの列は縦に均等配置)。
    const rowById = {};
    for (const column of columns) {
        const desired = new Map();
        column.forEach((id, index) => {
            const prerequisiteRows = (defs[id].prerequisites ?? [])
                .map(prerequisite => rowById[prerequisite])
                .filter(row => row !== undefined);
            if (prerequisiteRows.length > 0) {
                desired.set(id, prerequisiteRows.reduce((sum, row) => sum + row, 0) / prerequisiteRows.length);
            } else if (column.length > 1) {
                desired.set(id, (index * (TREE_NODE_ROWS - 1)) / (column.length - 1));
            } else {
                desired.set(id, Math.floor((TREE_NODE_ROWS - 1) / 2));
            }
        });

        // 重心の小さい順(=上に来てほしい順)に上から詰める。単純に「空いている最寄りの行」を
        // 探す方式だと、下が埋まっている列で最後の1つが一番上へ回り込み、線が列を大きく
        // 跨いでしまうため、順序を保ったまま順番に置いていく方式にしている。
        // (行が足りなくならないよう、残りの個数ぶんの行は必ず空けておく)
        const order = [...column].sort((a, b) => (desired.get(a) - desired.get(b)) || (column.indexOf(a) - column.indexOf(b)));
        let nextRow = 0;
        order.forEach((id, index) => {
            const remaining = order.length - index;
            let row = Math.max(Math.round(desired.get(id)), nextRow);
            row = clamp(Math.min(row, TREE_NODE_ROWS - remaining), 0, TREE_NODE_ROWS - 1);
            rowById[id] = row;
            nextRow = row + 1;
        });
    }

    // ツリー全体を縦方向に中央寄せする(小さいツリーが画面の下半分に寄ってしまうため)。
    const usedRows = ids.map(id => rowById[id]).filter(row => row !== undefined);
    if (usedRows.length > 0) {
        const minRow = Math.min(...usedRows);
        const height = Math.max(...usedRows) - minRow + 1;
        const shift = Math.floor((TREE_NODE_ROWS - height) / 2) - minRow;
        if (shift !== 0) for (const id of ids) rowById[id] += shift;
    }

    // ノードが埋まっている(列,行)の一覧。接続線が途中のノードを踏まないよう迂回させるのに使う。
    const occupied = new Set(ids.map(id => `${colById[id]},${rowById[id]}`));

    const edges = [];
    for (const id of ids) {
        for (const prerequisite of defs[id].prerequisites ?? []) {
            if (defs[prerequisite]) edges.push({ from: prerequisite, to: id });
        }
    }

    const layout = { columns, colById, rowById, occupied, edges };
    layoutCache.set(kind, layout);
    return layout;
}

export function getProgressTreePageCount(kind) {
    const layout = getLayout(kind);
    const extra = Math.max(0, layout.columns.length - TREE_COLUMNS_PER_PAGE);
    return 1 + Math.ceil(extra / TREE_PAGE_STEP);
}

/**
 * ページ番号から「そのページの左端に置くノード列」を求める。
 * 最終ページが右端に張り付くよう、ページ数で等分する(単純に TREE_PAGE_STEP 倍すると
 * 最終ページだけ極端に重なって、新しく見える列が1列しか増えないことがあるため)。
 */
function getPageStart(layout, page, pageCount) {
    const maxStart = Math.max(0, layout.columns.length - TREE_COLUMNS_PER_PAGE);
    if (pageCount <= 1) return 0;
    return Math.round((page * maxStart) / (pageCount - 1));
}

/**
 * 奇数列(接続線専用の列)の1マスで、左から入ってきた線を fromRow から toRow まで
 * 上下に折り、右へ出す。同じ行なら折らずに素通り(左右)。
 */
function addBend(cells, x, fromRow, toRow) {
    if (fromRow === toRow) {
        cells.push({ x, row: fromRow, mask: DIR_LEFT | DIR_RIGHT });
        return;
    }
    const goingDown = toRow > fromRow;
    const step = goingDown ? 1 : -1;
    cells.push({ x, row: fromRow, mask: DIR_LEFT | (goingDown ? DIR_DOWN : DIR_UP) });
    for (let row = fromRow + step; row !== toRow; row += step) cells.push({ x, row, mask: DIR_UP | DIR_DOWN });
    cells.push({ x, row: toRow, mask: (goingDown ? DIR_UP : DIR_DOWN) | DIR_RIGHT });
}

/**
 * 親の列と子の列が離れている(間にノード列を挟む)とき、横に走らせる行を選ぶ。
 * 💡 間のノード列を「そのノードと同じ行で」通り抜けると、線がそのマスで途切れて(ノードの
 *    絵が優先される)、あたかもそのノードが前提条件であるかのように読めてしまう。
 *    そこで、間のノード列がすべて空いている行を選んで、そこを走らせる。
 */
function pickRunRow(layout, parentCol, childCol, parentRow, childRow) {
    if (childCol - parentCol <= 1) return childRow; // 間に挟まるノード列が無い

    const isFree = (row) => {
        for (let col = parentCol + 1; col < childCol; col++) {
            if (layout.occupied.has(`${col},${row}`)) return false;
        }
        return true;
    };
    // 親の行・子の行をそのまま使えるならそれが一番自然。だめなら親子の中間に近い空き行を選ぶ。
    if (isFree(parentRow)) return parentRow;
    if (isFree(childRow)) return childRow;
    const center = (parentRow + childRow) / 2;
    const candidates = [];
    for (let row = 0; row < TREE_NODE_ROWS; row++) candidates.push(row);
    candidates.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b);
    for (const row of candidates) if (isFree(row)) return row;
    return parentRow; // 全ての行が埋まっている場合の保険(この形のツリーでは起きない想定)
}

/**
 * 1本の依存関係(親→子)が通るセルと、その向き(DIR_*)を列挙する。
 * 「親の直後の列で走行行へ折れる → その行を右へ進む → 子の直前の列で子の行へ折れる」
 * の一筆書き。走行行は途中のノードを踏まない行を選ぶ(pickRunRow)。
 * 画面外(ページ外)にはみ出したセルは呼び出し側が捨てる(線が画面端で切れて、続きが
 * 隣のページにあることが分かる)。
 */
function collectEdgeCells(layout, edge, pageStart) {
    const parentCol = layout.colById[edge.from];
    const childCol = layout.colById[edge.to];
    if (parentCol === undefined || childCol === undefined || childCol <= parentCol) return [];

    const parentRow = layout.rowById[edge.from];
    const childRow = layout.rowById[edge.to];
    const bendOutX = (parentCol - pageStart) * 2 + 1; // 親の直後(奇数列)
    const bendInX = (childCol - pageStart) * 2 - 1;   // 子の直前(奇数列)
    const runRow = pickRunRow(layout, parentCol, childCol, parentRow, childRow);
    const cells = [];

    // 親の直後で走行行へ折れる(隣の列が子なら、ここが唯一の折れ点で子の行へ直接繋がる)。
    addBend(cells, bendOutX, parentRow, runRow);
    if (bendInX > bendOutX) {
        // 走行行を右へ走り、子の直前で子の行へ折れる。
        for (let x = bendOutX + 1; x < bendInX; x++) cells.push({ x, row: runRow, mask: DIR_LEFT | DIR_RIGHT });
        addBend(cells, bendInX, runRow, childRow);
    }
    return cells;
}

function getNodeIcon(kind, id) {
    return TREE_NODE_ICONS[kind]?.[id] ?? TREE_DEFAULT_ICONS[kind] ?? "minecraft:paper";
}

/** 項目の現在の状態(取得済み/進行中/選択可/前提未達)を求める。 */
function getNodeStatus(state, defs, id) {
    if (state.completed.includes(id)) return "done";
    if (state.activeId === id) return "active";
    const missing = (defs[id].prerequisites ?? []).filter(prerequisite => !state.completed.includes(prerequisite));
    return missing.length > 0 ? "locked" : "available";
}

/**
 * 研究/社会制度ツリーをツリー状の盤面で表示する。
 * 補助リソースパック(testapia_ui)が無効なワールドでは、マーカー文字列付きの普通のフォーム
 * (ボタンが縦に並ぶだけ)として表示される。見た目が崩れるだけで操作は同じ。
 * @param {number} [page] 表示するページ(0始まり。横スクロール位置)
 */
export async function openProgressTreeMenu(player, kind, page = 0) {
    let currentKind = kind;
    let currentPage = Math.floor(page) || 0;

    // 💡 以前はページ送り・詳細画面から戻るたびに自分自身をawait再帰していたが、操作のたびに
    //    未解決のPromiseとスタックフレームが積み上がるため、mapMonitor.js と同じく
    //    同じ画面を開き直すループに変えてある。
    while (true) {
        const defs = getDefinitions(currentKind);
        const layout = getLayout(currentKind);
        const state = getProgressState(player, currentKind);
        const pageCount = getProgressTreePageCount(currentKind);
        currentPage = clamp(currentPage, 0, pageCount - 1);
        const pageStart = getPageStart(layout, currentPage, pageCount);

        // 1. 接続線。セルごとに向きのビットを積算し、親が取得済みの線は「点灯」色にする。
        const lines = new Map();
        for (const edge of layout.edges) {
            const active = state.completed.includes(edge.from);
            for (const cell of collectEdgeCells(layout, edge, pageStart)) {
                if (cell.x < 0 || cell.x >= TREE_COLS || cell.row < 0 || cell.row >= TREE_NODE_ROWS) continue;
                const slot = cell.row * TREE_COLS + cell.x;
                const previous = lines.get(slot) ?? { mask: 0, active: false };
                lines.set(slot, { mask: previous.mask | cell.mask, active: previous.active || active });
            }
        }

        // 2. ノード。線より優先(同じセルに来たらノードを描く)。
        const nodeBySlot = new Map();
        for (let index = 0; index < TREE_COLUMNS_PER_PAGE; index++) {
            const column = layout.columns[pageStart + index];
            if (!column) break;
            for (const id of column) {
                nodeBySlot.set(layout.rowById[id] * TREE_COLS + index * 2, id);
            }
        }

        const form = new TreeFormData().title(`${getKindLabel(currentKind)}ツリー`);
        for (const [slot, line] of lines) {
            if (nodeBySlot.has(slot)) continue;
            form.cell(slot, "", null, `${LINE_TEXTURE_DIR}/line_${line.mask}${line.active ? "_on" : ""}`);
        }
        for (const [slot, id] of nodeBySlot) {
            const def = defs[id];
            const status = getNodeStatus(state, defs, id);
            const color = { done: "§a", active: "§e", available: "§f", locked: "§8" }[status];
            const detail = {
                done: "取得済",
                active: `${Math.floor(state.progress)}/${def.cost}`,
                available: `${def.cost}`,
                locked: `${def.cost}`,
            }[status];
            form.cell(slot, `${color}${def.label}`, [`${status === "locked" ? "§8" : "§7"}${detail}`], getNodeIcon(currentKind, id));
        }

        // 3. 最終行の操作ボタン。
        const navBase = TREE_NAV_ROW * TREE_COLS;
        const activeDef = state.activeId ? defs[state.activeId] : null;
        // 💡 端のページでも「前へ/次へ」のマスは消さずに灰色で残す(押しても現在のページを
        //    開き直すだけ。マスが消えると操作ボタンの位置がページごとにずれて押し間違えるため)。
        const hasPrev = currentPage > 0;
        const hasNext = currentPage < pageCount - 1;
        form.cell(navBase + NAV_PREV_COL, hasPrev ? "§b前へ" : "§8前へ", [`§7${currentPage + 1}/${pageCount}`], "textures/ui/monitor/arrow_left");
        form.cell(navBase + NAV_NEXT_COL, hasNext ? "§b次へ" : "§8次へ", [`§7${currentPage + 1}/${pageCount}`], "textures/ui/monitor/arrow_right");
        form.cell(navBase + NAV_STATUS_COL, activeDef ? `§e${activeDef.label}` : "§7未選択", [
            activeDef ? `§7${Math.floor(state.progress)}/${activeDef.cost}` : `§7繰越${Math.floor(state.carry)}`,
        ], "minecraft:clock");
        form.cell(navBase + NAV_SWITCH_COL, currentKind === "technology" ? "§d社会制度" : "§a研究", ["§7へ切替"],
            currentKind === "technology" ? TREE_DEFAULT_ICONS.civic : TREE_DEFAULT_ICONS.technology);
        form.cell(navBase + NAV_LIST_COL, "§fリスト", ["§7表示"], "minecraft:book");
        form.cell(navBase + NAV_HELP_COL, "§f凡例", ["§7見方"], "minecraft:paper");
        form.cell(navBase + NAV_BACK_COL, "§c戻る", ["§7メニュー"], "minecraft:barrier");

        const result = await form.show(getRealPlayer(player));
        if (result.canceled || result.selection === undefined) return;

        const slot = result.selection;
        if (Math.floor(slot / TREE_COLS) === TREE_NAV_ROW) {
            switch (slot % TREE_COLS) {
                case NAV_PREV_COL:
                    currentPage -= 1;
                    break;
                case NAV_NEXT_COL:
                    currentPage += 1;
                    break;
                case NAV_SWITCH_COL:
                    currentKind = currentKind === "technology" ? "civic" : "technology";
                    currentPage = 0;
                    break;
                case NAV_LIST_COL:
                    await (await import("./ui.js")).openProgressMenu(player, currentKind);
                    return;
                case NAV_HELP_COL:
                    await openTreeHelp(player, currentKind);
                    break;
                case NAV_BACK_COL:
                    await (await import("./ui.js")).openMainMenu(player);
                    return;
            }
            continue; // 進行中の表示など、何も起きないマスを押した場合も同じページを開き直す
        }

        const nodeId = nodeBySlot.get(slot);
        if (nodeId && !await openNodeDetail(player, currentKind, nodeId)) return;
    }
}

/** ツリーの見方(色・線の意味)の説明画面。閉じると呼び出し元のループがツリーを開き直す。 */
async function openTreeHelp(player, kind) {
    const pointsLabel = getPointsLabel(kind);
    const body = [
        `§f左の列ほど早く取得できる${getKindLabel(kind)}です。線は前提条件(左の項目→右の項目)を表します。`,
        "",
        "§a緑§f: 取得済み",
        `§e黄§f: 進行中(いま${pointsLabel}が入っています)`,
        "§f白§f: 前提条件を満たしていて、すぐ開始できる",
        "§8灰§f: 前提条件がまだ足りない",
        "",
        `§7・アイコンの下の数字は必要${pointsLabel}です。`,
        "§7・緑色の線は、その前提条件を取得済みであることを表します。",
        "§7・マスを押すと効果と前提条件が見られ、そこから開始できます。",
        "§7・画面端で切れている線は、続きが前後のページにあります(前へ/次へ)。",
    ];
    const form = new ActionFormData().title("ツリーの見方").body(body.join("\n")).button("戻る");
    await form.show(getRealPlayer(player));
}

/**
 * ノード(1項目)の詳細画面。ここから研究/社会制度の開始も行う。
 * @returns {Promise<boolean>} ツリーへ戻る場合は true、画面ごと閉じられた場合は false
 */
async function openNodeDetail(player, kind, id) {
    const defs = getDefinitions(kind);
    const def = defs[id];
    if (!def) return true;
    const state = getProgressState(player, kind);
    const status = getNodeStatus(state, defs, id);
    const pointsLabel = getPointsLabel(kind);

    const body = [];
    switch (status) {
        case "done": body.push("§a取得済みです。"); break;
        case "active": body.push(`§e進行中: ${Math.floor(state.progress)}/${def.cost} ${pointsLabel}`); break;
        case "available": body.push(`§f必要${pointsLabel}: ${def.cost} §7(繰越: ${Math.floor(state.carry)})`); break;
        default: body.push(`§8前提条件が足りません。 必要${pointsLabel}: ${def.cost}`); break;
    }
    const prerequisites = (def.prerequisites ?? []).map((prerequisite) => {
        const label = defs[prerequisite]?.label ?? prerequisite;
        return state.completed.includes(prerequisite) ? `§a${label}` : `§c${label}`;
    });
    body.push(`§7前提条件: ${prerequisites.length > 0 ? prerequisites.join("§7・") : "なし"}`);
    if (def.effect) body.push(`§7効果: ${def.effect}`);
    const unlocks = Object.keys(defs).filter(other => (defs[other].prerequisites ?? []).includes(id));
    if (unlocks.length > 0) body.push(`§7この先: ${unlocks.map(other => defs[other].label).join("、")}`);

    const canStart = status === "available" && !state.activeId;
    const form = new ActionFormData().title(def.label).body(body.join("\n"));
    if (canStart) form.button(`§a${getKindLabel(kind)}を開始する`);
    else if (status === "available") form.button("§8他の項目が進行中のため開始できません");
    form.button("戻る");

    const result = await form.show(getRealPlayer(player));
    if (result.canceled || result.selection === undefined) return false;
    if (canStart && result.selection === 0) {
        (await import("./commands.js")).cmdStartProgress(player, kind, id);
    }
    return true;
}

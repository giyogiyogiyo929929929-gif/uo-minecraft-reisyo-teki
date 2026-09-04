// mapMonitor.js
// マップ全体の状況(所有者・都市・地形)を、チェストUIの見た目を借りない専用の自作UI画面
// (monitorForm.js / development_resource_packs/testapia_ui の ui/monitor_server_form.json)で
// 一覧表示するモニター画面。以前はワールドに実際にブロックを設置して常時表示する形だったが、
// ワールドを恒久的に改変してしまう(マップ再生成のたびに追従処理が要る、他プレイヤーの
// 視界を塞ぐ等)ため、メニューから開くUIに置き換えた。
//
// 【mapview(ui.jsのopenMapViewMenu)との役割分担】
// mapviewはチェストUIの見た目(§18)で9×5マスを詳細ロア(座標・産出量・資源・ユニット有無)
// 付きでパン移動しながら見る「精査用」ビューア。こちらのモニターは単色スウォッチで勢力図を
// 「一目で見る」ための軽量なスナップショットで、開くたびに現在の状態を再取得して表示する
// (常時同期は行わない)。
//
// 【操作】
// ・最終行の矢印ボタン: 表示範囲を1画面ぶんパンする(ActionFormDataはリクエスト/レスポンス型で、
//   ドラッグ操作のような連続入力は取れないため、押すたびに開き直す方式)。
// ・最終行の左端(使い方): 操作中の国家の首都(無ければ自国の最初の都市)を中央に置き直す。
// ・左上の角(0,0): 縮尺(ズーム)の切り替え。1マス=zoom×zoomタイルぶんの「ブロック」にまとめ、
//   都市>戦闘ユニット>支配勢力>地形の優先順で代表色を出す(マップ全体を俯瞰するためのモード)。
//   選べる段階はマップサイズから決まり、全体が収まる段階で打ち止めになる。
// ・マスのタップ: 等倍ならそのマスが中央に来るように置き直す(矢印より細かいパン)、
//   縮小表示中ならそのブロックへ1段階ズームインする。
import { getMapConfig, getTiles, getTurnState } from "./state.js";
import { TERRAIN_TYPES } from "./mapGen.js";
import { getPlayerColor } from "./turns.js";
import { resolveCivName, getActiveCivId } from "./civs.js";
import { MonitorFormData, MONITOR_COLS, MONITOR_ROWS } from "./monitorForm.js";

// 💡 ブロック/アイテムの実物アイコンではなく、development_resource_packs/testapia_ui/
//    textures/ui/monitor/ に用意した単色スウォッチ(バイオームに近い色合いの塗りつぶし画像)を
//    使う。「ブロックそのものの見た目」ではなく「地図記号としての色」を見せたいための選択。
//    地形にここに無い種類が来た場合は草原色にフォールバックする。
const MONITOR_DEFAULT_TERRAIN_TYPE = "grassland";
const MONITOR_TERRAIN_TYPES_WITH_SWATCH = new Set([
    "grassland", "forest", "rainforest", "desert", "mountain", "mountainRange",
    "cold", "sea", "river", "pond", "lake",
]);

function pickTerrainIcon(type) {
    const key = MONITOR_TERRAIN_TYPES_WITH_SWATCH.has(type) ? type : MONITOR_DEFAULT_TERRAIN_TYPE;
    return `textures/ui/monitor/terrain_${key}`;
}

// 💡 グリッドの先頭行(0行目)・先頭列(0列目)は座標見出し(タイルのtx/tz)専用、
//    最終行は移動用ボタン専用に確保するため、実際にタイルを敷き詰められるのは
//    MONITOR_TILE_COLS×MONITOR_TILE_ROWSぶんだけ(タイルは(1,1)を起点に敷く)。
//    移動ボタンの列は、MONITOR_COLS全体ではなく実際にタイルが占める範囲(1〜MONITOR_TILE_COLS)
//    を基準に左右対称(列の合計が常にMONITOR_TILE_LEFT+MONITOR_TILE_RIGHTになるよう)に置く。
//    タイル列幅(MONITOR_TILE_COLS=14)は偶数なので、9マスの奇数クラスタを画面全体の中央に
//    置くと必ず半マスぶんズレる。ここでは「現在地」ボタンを廃止して6要素の偶数クラスタにし、
//    ズレが出ないようにしている(現在地の範囲は使い方ボタンのロアに載せる)。
const MONITOR_HEADER_ROW = 0;
const MONITOR_HEADER_COL = 0;
const MONITOR_TILE_COLS = MONITOR_COLS - 1;
const MONITOR_TILE_ROWS = MONITOR_ROWS - 2;
const MONITOR_CONTROL_ROW = MONITOR_ROWS - 1;
const MONITOR_TILE_LEFT = 1;
const MONITOR_TILE_RIGHT = MONITOR_TILE_COLS;
const MONITOR_CONTROL_HELP_COL = MONITOR_TILE_LEFT;
const MONITOR_CONTROL_WEST_COL = MONITOR_TILE_LEFT + 2;
const MONITOR_CONTROL_NORTH_COL = MONITOR_TILE_LEFT + 5;
const MONITOR_CONTROL_SOUTH_COL = MONITOR_TILE_RIGHT - 5;
const MONITOR_CONTROL_EAST_COL = MONITOR_TILE_RIGHT - 2;
const MONITOR_CONTROL_CLOSE_COL = MONITOR_TILE_RIGHT;

// 💡 ズームの段階。1マスがzoom×zoomタイルぶんの「ブロック」になる。左上の角(0,0)は
//    座標見出しの交点で常に空きマスだったので、そこをズーム切り替えボタンに使っている
//    (最終行は6要素の左右対称クラスタで埋まっており、ボタンを足すと対称が崩れるため)。
const MONITOR_ZOOM_STEPS = [1, 2, 4, 8];
const MONITOR_LEGEND_MAX = 8;

// 💡 勢力の色(turns.jsのPLAYER_COLORS)を、凡例に出すための「色コード+日本語名」に対応させる表。
//    ■(U+25A0)は矢印ボタンの◀▲▼▶と同じくバニラのフォントで描ける記号(絵文字ではない)。
const MONITOR_COLOR_LABELS = {
    red: "§c赤", blue: "§9青", green: "§2緑", yellow: "§e黄", purple: "§5紫",
    orange: "§6橙", cyan: "§3水色", magenta: "§d桃", light_blue: "§b空色", lime: "§a黄緑",
    white: "§f白",
};

/**
 * このマップで選べるズーム段階を返す。マップ全体が1画面に収まった段階で打ち止めにするため、
 * 小さいマップでは [1] だけ(=ズーム機能が実質無効)になる。
 */
function getAvailableZooms(config) {
    const zooms = [];
    for (const zoom of MONITOR_ZOOM_STEPS) {
        zooms.push(zoom);
        if (Math.ceil(config.width / zoom) <= MONITOR_TILE_COLS
            && Math.ceil(config.height / zoom) <= MONITOR_TILE_ROWS) break;
    }
    return zooms;
}

/** ズーム段階ごとの、1画面に映るマス数(cols/rows)と、それが覆うタイル数(spanX/spanZ)。 */
function getMonitorSpan(config, zoom) {
    const cols = Math.min(MONITOR_TILE_COLS, Math.ceil(config.width / zoom));
    const rows = Math.min(MONITOR_TILE_ROWS, Math.ceil(config.height / zoom));
    return { cols, rows, spanX: cols * zoom, spanZ: rows * zoom };
}

/**
 * configと表示範囲の左上タイル座標(viewTx/viewTz、省略時はマップ中央)から、
 * モニターが映すタイル範囲を導出する。ui.jsのopenMapViewMenuと同じclamp方式。
 * zoomが1より大きい場合、1マスはzoom×zoomタイルぶんのブロックになる。
 */
function getMonitorViewport(config, viewTx, viewTz, zoom = 1) {
    const { cols, rows, spanX, spanZ } = getMonitorSpan(config, zoom);
    const maxTx = Math.max(0, config.width - spanX);
    const maxTz = Math.max(0, config.height - spanZ);
    const defaultTx = Math.floor((config.width - spanX) / 2);
    const defaultTz = Math.floor((config.height - spanZ) / 2);
    const viewStartTx = Math.max(0, Math.min(maxTx, viewTx ?? defaultTx));
    const viewStartTz = Math.max(0, Math.min(maxTz, viewTz ?? defaultTz));
    return { cols, rows, spanX, spanZ, viewStartTx, viewStartTz };
}

/** (centerTx, centerTz)が画面の中央に来るような表示範囲の左上座標(clampはviewport側で行う)。 */
function getStartForCenter(config, centerTx, centerTz, zoom) {
    const { spanX, spanZ } = getMonitorSpan(config, zoom);
    return { tx: centerTx - Math.floor(spanX / 2), tz: centerTz - Math.floor(spanZ / 2) };
}

/**
 * 1マスぶんのタイルを、モニターの1セルの見た目(アイコン・名前・簡易ロア)に
 * 変換する。優先順は都市(city_*、白枠)>戦闘ユニット(unit_*、黒枠)>所有マス(owner_*)>
 * 地形(terrain_*)。どれも「所有者の色」を塗るだけの単色スウォッチで、枠の色だけで種類を
 * 描き分けている。施設・区域・宗教ユニットはアイコンを変えずロア側に載せる
 * (色分け以外の情報をアイコンに足すと、勢力図としての読み取りやすさが落ちるため)。
 * ui.jsのopenCombatUnitMoveMenuMonitor(移動先をモニター風グリッドから選ぶUI)からも
 * そのまま流用するため、export している。
 */
export function describeMonitorTile(tile) {
    const terrainLabel = TERRAIN_TYPES[tile.type]?.label ?? tile.type;
    const lore = [`§7座標: (${tile.tx}, ${tile.tz})`, `§7地形: ${terrainLabel}`];
    if (tile.ownerId) lore.push(`§b所有: ${resolveCivName(tile.ownerId) ?? "?"}`);
    if (tile.facility) lore.push(`§a[Facility] ${tile.facility.label ?? tile.facility.id}`);
    if (tile.district) lore.push(`§3[District] ${tile.district.label ?? tile.district.id}`);
    else if (tile.underDistrictConstruction) lore.push("§3[District] 建設中");
    if (tile.combatUnit) {
        const u = tile.combatUnit;
        lore.push(`§c[Unit] ${resolveCivName(u.ownerId) ?? "?"}の${u.label ?? u.id ?? "戦闘ユニット"} (HP ${Math.max(0, Math.round(u.hp ?? u.maxHp ?? 0))}/${u.maxHp ?? 0})`);
    }
    if (tile.religiousUnit) {
        const u = tile.religiousUnit;
        lore.push(`§d[Missionary] ${resolveCivName(u.ownerId) ?? "?"}の${u.label ?? "宗教ユニット"}`);
    }

    if (tile.city) {
        const color = tile.ownerId ? getPlayerColor(tile.ownerId) : "white";
        return {
            icon: `textures/ui/monitor/city_${color}`,
            name: `§e[City] ${tile.city.name ?? "都市"}${tile.city.isCapital ? " §6(首都)" : ""}`,
            lore,
        };
    }
    if (tile.combatUnit) {
        // 💡 戦闘ユニットのいるマスは unit_*(そのユニットの所有者の色+黒枠)で描く。
        //    枠の色で都市(白枠)と描き分ける仕組み。優先順は都市の下・領土の塗りの上で、
        //    下地の地形/領土の色はあえて上書きする(中立地を進軍してくる軍が勢力図に出るように)。
        const u = tile.combatUnit;
        const color = u.ownerId ? getPlayerColor(u.ownerId) : "white";
        return {
            icon: `textures/ui/monitor/unit_${color}`,
            name: `§c[Unit] ${resolveCivName(u.ownerId) ?? "?"}の${u.label ?? u.id ?? "戦闘ユニット"}`,
            lore,
        };
    }
    if (tile.ownerId) {
        const color = getPlayerColor(tile.ownerId);
        return { icon: `textures/ui/monitor/owner_${color}`, name: `§f${terrainLabel}`, lore };
    }
    return { icon: pickTerrainIcon(tile.type), name: `§8${terrainLabel}`, lore };
}

/** Mapの中で最も多かったキーを返す(同数なら先に数えたほうを優先)。 */
function pickDominantKey(counts) {
    let bestKey = null;
    let bestCount = 0;
    for (const [key, count] of counts) {
        if (count > bestCount) { bestKey = key; bestCount = count; }
    }
    return bestKey;
}

/**
 * 縮小表示(zoom>1)のときの1マス。(tx0, tz0)を左上とするzoom×zoomタイルを1つにまとめ、
 * 都市があればその色、無ければ最も多くのマスを持つ勢力の色、どこの領土でもなければ
 * 最も多い地形の色で描く。ロアには範囲・勢力の内訳・都市/ユニット数を載せる。
 * 範囲内にタイルが1つも無い場合はnull(空きマスのまま)。
 */
function describeMonitorBlock(tiles, tx0, tz0, zoom, config) {
    const txEnd = Math.min(config.width, tx0 + zoom);
    const tzEnd = Math.min(config.height, tz0 + zoom);
    const ownerCounts = new Map();
    const terrainCounts = new Map();
    const unitOwnerCounts = new Map();
    const cities = [];
    let tileCount = 0;
    let unitCount = 0;

    for (let tz = tz0; tz < tzEnd; tz++) {
        for (let tx = tx0; tx < txEnd; tx++) {
            const tile = tiles[`${tx},${tz}`];
            if (!tile) continue;
            tileCount++;
            if (tile.ownerId) ownerCounts.set(tile.ownerId, (ownerCounts.get(tile.ownerId) ?? 0) + 1);
            terrainCounts.set(tile.type, (terrainCounts.get(tile.type) ?? 0) + 1);
            if (tile.city) cities.push({ city: tile.city, ownerId: tile.ownerId });
            if (tile.combatUnit) {
                unitCount++;
                const unitOwnerId = tile.combatUnit.ownerId;
                if (unitOwnerId) unitOwnerCounts.set(unitOwnerId, (unitOwnerCounts.get(unitOwnerId) ?? 0) + 1);
            }
        }
    }
    if (!tileCount) return null;

    const dominantTerrain = pickDominantKey(terrainCounts);
    const lore = [
        `§7範囲: (${tx0}, ${tz0}) 〜 (${txEnd - 1}, ${tzEnd - 1})`,
        `§7地形: ${TERRAIN_TYPES[dominantTerrain]?.label ?? dominantTerrain} ほか`,
    ];
    // 💡 縮小表示ではアイコンが「支配的な1勢力」の色にしかならないため、
    //    誰と誰がその一帯を分け合っているかはロアの内訳で補う。
    const owners = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [ownerId, count] of owners.slice(0, 3)) {
        lore.push(`§b${resolveCivName(ownerId) ?? "?"}: ${count}マス`);
    }
    if (owners.length > 3) lore.push(`§7ほか ${owners.length - 3} 勢力`);
    if (unitCount) lore.push(`§c[Unit] 戦闘ユニット ${unitCount}`);

    if (cities.length) {
        // 💡 1つのブロックに複数の都市が入りうるので、首都があれば首都を代表にする。
        const main = cities.find((c) => c.city.isCapital) ?? cities[0];
        const color = main.ownerId ? getPlayerColor(main.ownerId) : "white";
        const extra = cities.length > 1 ? ` §7+${cities.length - 1}` : "";
        return {
            icon: `textures/ui/monitor/city_${color}`,
            name: `§e[City] ${main.city.name ?? "都市"}${main.city.isCapital ? " §6(首都)" : ""}${extra}`,
            lore,
        };
    }
    // 💡 等倍表示と同じ優先順(都市>戦闘ユニット>領土>地形)。縮小表示でも戦線がどこに
    //    あるかが見えるように、都市の無いブロックはユニットを最も多く置いている勢力の色+黒枠にする。
    const dominantUnitOwner = pickDominantKey(unitOwnerCounts);
    if (dominantUnitOwner) {
        return {
            icon: `textures/ui/monitor/unit_${getPlayerColor(dominantUnitOwner)}`,
            name: `§c[Unit] ${resolveCivName(dominantUnitOwner) ?? "?"}の部隊 ${unitOwnerCounts.get(dominantUnitOwner)}`,
            lore,
        };
    }
    const dominantOwner = pickDominantKey(ownerCounts);
    if (dominantOwner) {
        return {
            icon: `textures/ui/monitor/owner_${getPlayerColor(dominantOwner)}`,
            name: `§f${resolveCivName(dominantOwner) ?? "?"}`,
            lore,
        };
    }
    return {
        icon: pickTerrainIcon(dominantTerrain),
        name: `§8${TERRAIN_TYPES[dominantTerrain]?.label ?? dominantTerrain}`,
        lore,
    };
}

/**
 * 「首都へ」で飛ぶ先。操作中の国家(getActiveCivId)の首都、無ければ最初に見つかった自国の都市。
 * 都市を1つも持っていなければnull。commands.jsの首都探索と同じく、共有の検索ヘルパーは無いので
 * ここでタイルを走査する(モニターを開いた時とボタンを押した時にしか呼ばれない)。
 */
function findHomeTile(tiles, civId) {
    let firstCity = null;
    for (const key in tiles) {
        const tile = tiles[key];
        if (tile.ownerId !== civId || !tile.city) continue;
        const [tx, tz] = key.split(",").map(Number);
        if (tile.city.isCapital) return { tx, tz, isCapital: true };
        firstCity ??= { tx, tz, isCapital: false };
    }
    return firstCity;
}

/**
 * 使い方ボタンのロアに載せる凡例(どの色がどの勢力か)。マスの色分けは
 * turns.jsのplayerColors(参加順に割り当て)なので、参加者一覧をそのまま並べる。
 */
function buildLegendLore() {
    const turn = getTurnState();
    const order = turn?.playerOrder ?? [];
    const colors = turn?.playerColors ?? {};
    const lore = [];
    for (const civId of order) {
        if (lore.length >= MONITOR_LEGEND_MAX) {
            lore.push(`§7ほか ${order.length - MONITOR_LEGEND_MAX} 勢力`);
            break;
        }
        const color = colors[civId] ?? "white";
        lore.push(`${MONITOR_COLOR_LABELS[color] ?? "§f"}■§r §7${resolveCivName(civId) ?? "?"}`);
    }
    return lore;
}

/**
 * 勢力図を、モニター専用の自作UI画面で一覧表示する(OP専用のテスト機能)。
 * 先頭行/先頭列にタイルのtx/tz座標を数字で表示し、最終行の移動ボタン(西・北・南・東)を
 * 押すと表示範囲を1画面ぶんずらす。左上の角はズーム切り替え、マスのタップは
 * 等倍なら中央寄せ・縮小表示中ならズームイン(ファイル冒頭の【操作】を参照)。
 * 補助リソースパックが無効な場合はマーカー文字列付きの普通のフォームとして表示される
 * (見た目が崩れるだけで壊れない)。
 * @param {number} [viewTx] 表示範囲の左上のタイルX座標(省略時はマップ中央)
 * @param {number} [viewTz] 表示範囲の左上のタイルZ座標(省略時はマップ中央)
 */
export async function openMapMonitorMenu(realPlayer, viewTx, viewTz) {
    const config = getMapConfig();
    if (!config) {
        realPlayer.sendMessage("§cマップがまだ生成されていません。");
        return;
    }

    const zooms = getAvailableZooms(config);
    let zoom = zooms[0];
    let curTx = viewTx;
    let curTz = viewTz;

    // 💡 以前は表示のたびに自分自身をawait再帰していたが、パンするたびに未解決のPromiseと
    //    スタックフレームが際限なく積み上がるため、同じ画面を開き直すループに変えてある。
    while (true) {
        const { cols, rows, spanX, spanZ, viewStartTx, viewStartTz } = getMonitorViewport(config, curTx, curTz, zoom);
        curTx = viewStartTx;
        curTz = viewStartTz;
        const tiles = getTiles();
        const monitor = new MonitorFormData().title("Civ Tactics モニター");

        // 💡 タイルは(1,1)を起点に敷く(0行目/0列目は座標見出し、最終行は移動ボタン用に空けてある)。
        //    スロット番号はグリッド全体の幅であるMONITOR_COLSを基準に計算する
        //    (縮んだcolsを基準にすると、実際のグリッド上でマスの位置がズレて詰まってしまう)。
        for (let row = 0; row < rows; row++) {
            const tz = viewStartTz + row * zoom;
            for (let col = 0; col < cols; col++) {
                const tx = viewStartTx + col * zoom;
                let cell;
                if (zoom === 1) {
                    const tile = tiles[`${tx},${tz}`];
                    cell = tile ? describeMonitorTile({ ...tile, tx, tz }) : null;
                } else {
                    cell = describeMonitorBlock(tiles, tx, tz, zoom, config);
                }
                if (!cell) continue;
                monitor.cell((1 + row) * MONITOR_COLS + (1 + col), cell.name, cell.lore, cell.icon);
            }
        }

        // 💡 座標見出し(0行目=列のtx番号、0列目=行のtz番号。テクスチャを持たせないことで
        //    monitor_server_form.jsonのcoord_labelだけが表示される)。縮小表示中は、その列/行が
        //    受け持つ範囲の先頭のタイル座標を出す。
        for (let col = 0; col < cols; col++) {
            monitor.cell(MONITOR_HEADER_ROW * MONITOR_COLS + (1 + col), `§7${viewStartTx + col * zoom}`);
        }
        for (let row = 0; row < rows; row++) {
            monitor.cell((1 + row) * MONITOR_COLS + MONITOR_HEADER_COL, `§7${viewStartTz + row * zoom}`);
        }

        // 💡 左上の角(座標見出しの交点)はズーム切り替え。段階が1つしか無いマップでは
        //    「全体が収まっている」ことだけを伝える案内にする(押しても同じ画面を開き直すだけ)。
        const zoomIndex = zooms.indexOf(zoom);
        const nextZoom = zooms[(zoomIndex + 1) % zooms.length];
        monitor.cell(MONITOR_HEADER_ROW * MONITOR_COLS + MONITOR_HEADER_COL,
            zooms.length > 1 ? `§a[Zoom] 1マス=${zoom}x${zoom}` : "§8[Zoom] 等倍",
            zooms.length > 1
                ? [`§7押すと 1マス=${nextZoom}x${nextZoom} に切り替わります。`, "§7縮小中のマスをタップするとズームインします。"]
                : ["§7このマップは1画面に収まっています。"],
            "minecraft:spyglass");

        // 💡 最終行(MONITOR_CONTROL_ROW)に、タイル範囲(1〜MONITOR_TILE_COLS)を基準に
        //    左右対称に配置した移動ボタンを置く(使い方・西・北・南・東・閉じる)。
        //    現在地の範囲と勢力の色の凡例は使い方ボタンのロアに載せる。
        //    使い方の枠は押しても何も起きない案内欄だったので、操作中の国家の首都へ飛ぶボタンを
        //    兼ねさせている(最終行に枠を足すと6要素の左右対称が崩れ、角はズームで埋まっているため)。
        const controlRowBase = MONITOR_CONTROL_ROW * MONITOR_COLS;
        const home = findHomeTile(tiles, getActiveCivId(realPlayer));
        monitor.cell(controlRowBase + MONITOR_CONTROL_HELP_COL,
            home ? "§a[Home] 首都へ §7/ 使い方" : "§e使い方",
            [
                home
                    ? `§7押すと${home.isCapital ? "首都" : "自国の都市"} (${home.tx}, ${home.tz}) が中央に来ます。`
                    : "§7自国の都市がまだありません。",
                "§7矢印ボタンで表示範囲を移動できます。",
                zoom === 1 ? "§7マスをタップするとそこが中央になります。" : "§7マスをタップするとズームインします。",
                `§7X: ${viewStartTx} 〜 ${Math.min(config.width, viewStartTx + spanX) - 1}`,
                `§7Z: ${viewStartTz} 〜 ${Math.min(config.height, viewStartTz + spanZ) - 1}`,
                ...buildLegendLore(),
            ],
            home ? "minecraft:compass" : "minecraft:book");
        monitor.cell(controlRowBase + MONITOR_CONTROL_WEST_COL, "§b◀ 西へ移動", null, "textures/ui/monitor/arrow_left");
        monitor.cell(controlRowBase + MONITOR_CONTROL_NORTH_COL, "§b▲ 北へ移動", null, "textures/ui/monitor/arrow_up");
        monitor.cell(controlRowBase + MONITOR_CONTROL_SOUTH_COL, "§b▼ 南へ移動", null, "textures/ui/monitor/arrow_down");
        monitor.cell(controlRowBase + MONITOR_CONTROL_EAST_COL, "§b▶ 東へ移動", null, "textures/ui/monitor/arrow_right");
        monitor.cell(controlRowBase + MONITOR_CONTROL_CLOSE_COL, "§c閉じる", null, "minecraft:barrier");

        const res = await monitor.show(realPlayer);
        if (res.canceled || res.selection === undefined) return;

        const selRow = Math.floor(res.selection / MONITOR_COLS);
        const selCol = res.selection % MONITOR_COLS;

        if (selRow === MONITOR_CONTROL_ROW) {
            switch (selCol) {
                case MONITOR_CONTROL_HELP_COL:
                    // 首都(無ければ自国の最初の都市)を中央に。縮尺はそのまま変えない。
                    if (home) ({ tx: curTx, tz: curTz } = getStartForCenter(config, home.tx, home.tz, zoom));
                    break;
                case MONITOR_CONTROL_WEST_COL: curTx = viewStartTx - spanX; break;
                case MONITOR_CONTROL_NORTH_COL: curTz = viewStartTz - spanZ; break;
                case MONITOR_CONTROL_SOUTH_COL: curTz = viewStartTz + spanZ; break;
                case MONITOR_CONTROL_EAST_COL: curTx = viewStartTx + spanX; break;
                case MONITOR_CONTROL_CLOSE_COL: return; // 閉じる
            }
            continue; // 使い方欄をタップした場合も同じ範囲を再表示
        }

        if (selRow === MONITOR_HEADER_ROW && selCol === MONITOR_HEADER_COL) {
            // ズーム切り替え。今映っている範囲の中心を保ったまま縮尺だけを変える。
            const centerTx = viewStartTx + Math.floor(spanX / 2);
            const centerTz = viewStartTz + Math.floor(spanZ / 2);
            zoom = nextZoom;
            ({ tx: curTx, tz: curTz } = getStartForCenter(config, centerTx, centerTz, zoom));
            continue;
        }

        // 💡 マスのタップ。等倍ならそのマスを中央に置き直し(矢印より細かいパン)、縮小表示中なら
        //    そのブロックを中心に1段階ズームインする。座標見出しの行/列をタップした場合は
        //    タイル範囲外なので、何も変えずに同じ範囲を再表示する。
        const tileCol = selCol - 1;
        const tileRow = selRow - 1;
        if (tileCol >= 0 && tileCol < cols && tileRow >= 0 && tileRow < rows) {
            const centerTx = viewStartTx + tileCol * zoom + Math.floor(zoom / 2);
            const centerTz = viewStartTz + tileRow * zoom + Math.floor(zoom / 2);
            if (zoom > 1) zoom = zooms[Math.max(0, zoomIndex - 1)];
            ({ tx: curTx, tz: curTz } = getStartForCenter(config, centerTx, centerTz, zoom));
        }
    }
}

// mapMonitor.js
// マップ全体の状況(所有者・都市・地形)を、チェストUIの見た目を借りない専用の自作UI画面
// (monitorForm.js / development_resource_packs/testapia_ui の ui/monitor_server_form.json)で
// 一覧表示するモニター画面。以前はワールドに実際にブロックを設置して常時表示する形だったが、
// ワールドを恒久的に改変してしまう(マップ再生成のたびに追従処理が要る、他プレイヤーの
// 視界を塞ぐ等)ため、メニューから開くUIに置き換えた。
//
// 【mapview(ui.jsのopenMapViewMenu)との役割分担】
// mapviewはチェストUIの見た目(§18)で9×5マスを詳細ロア(座標・産出量・資源・ユニット有無)
// 付きでパン移動しながら見る「精査用」ビューア。こちらのモニターは詳細ロアを持たず、
// 単色スウォッチで勢力図を「一目で見る」ための軽量なスナップショットで、開くたびに現在の
// 状態を再取得して表示する(常時同期は行わない)。パン移動はmapviewと同じ「最終行を移動用
// ボタン専用に確保し、押すたびに表示範囲を1画面ぶんずらして自分自身を開き直す」方式
// (ActionFormDataはリクエスト/レスポンス型で、ドラッグ操作のような連続入力は取れないため)。
import { getMapConfig, getTiles } from "./state.js";
import { TERRAIN_TYPES } from "./mapGen.js";
import { getPlayerColor } from "./turns.js";
import { resolveCivName } from "./civs.js";
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

/**
 * configと表示範囲の左上タイル座標(viewTx/viewTz、省略時はマップ中央)から、
 * モニターが映すタイル範囲を導出する。ui.jsのopenMapViewMenuと同じclamp方式。
 */
function getMonitorViewport(config, viewTx, viewTz) {
    const cols = Math.min(MONITOR_TILE_COLS, config.width);
    const rows = Math.min(MONITOR_TILE_ROWS, config.height);
    const maxTx = Math.max(0, config.width - cols);
    const maxTz = Math.max(0, config.height - rows);
    const defaultTx = Math.floor((config.width - cols) / 2);
    const defaultTz = Math.floor((config.height - rows) / 2);
    const viewStartTx = Math.max(0, Math.min(maxTx, viewTx ?? defaultTx));
    const viewStartTz = Math.max(0, Math.min(maxTz, viewTz ?? defaultTz));
    return { cols, rows, viewStartTx, viewStartTz };
}

/**
 * 1マスぶんのタイルを、モニターの1セルの見た目(アイコン・名前・簡易ロア)に
 * 変換する。優先順はui.jsのdescribeMapViewTileと同じ(都市>所有マス>地形)だが、こちらは
 * 「一目で勢力図を見る」用途のため詳細ロア(産出量・資源・ユニット)までは持たない。
 * ui.jsのopenCombatUnitMoveMenuMonitor(移動先をモニター風グリッドから選ぶUI)からも
 * そのまま流用するため、export している。
 */
export function describeMonitorTile(tile) {
    const terrainLabel = TERRAIN_TYPES[tile.type]?.label ?? tile.type;
    const lore = [`§7座標: (${tile.tx}, ${tile.tz})`, `§7地形: ${terrainLabel}`];
    if (tile.ownerId) lore.push(`§b所有: ${resolveCivName(tile.ownerId) ?? "?"}`);

    if (tile.city) {
        const color = tile.ownerId ? getPlayerColor(tile.ownerId) : "white";
        return {
            icon: `textures/ui/monitor/city_${color}`,
            name: `§e[City] ${tile.city.name ?? "都市"}${tile.city.isCapital ? " §6(首都)" : ""}`,
            lore,
        };
    }
    if (tile.ownerId) {
        const color = getPlayerColor(tile.ownerId);
        return { icon: `textures/ui/monitor/owner_${color}`, name: `§f${terrainLabel}`, lore };
    }
    return { icon: pickTerrainIcon(tile.type), name: `§8${terrainLabel}`, lore };
}

/**
 * 勢力図を、モニター専用の自作UI画面で一覧表示する(OP専用のテスト機能)。
 * 先頭行/先頭列にタイルのtx/tz座標を数字で表示し、最終行の移動ボタン(西・北・南・東)を
 * 押すと表示範囲を1画面ぶんずらして自分自身を開き直す(mapviewと同じ、押すたびに再表示する
 * パン方式)。タイル自体をタップした場合は何も起きず同じ範囲を再表示するだけ(読み取り専用の
 * スナップショット)。補助リソースパックが無効な場合はマーカー文字列付きの普通のフォームとして
 * 表示される(見た目が崩れるだけで壊れない)。
 * @param {number} [viewTx] 表示範囲の左上のタイルX座標(省略時はマップ中央)
 * @param {number} [viewTz] 表示範囲の左上のタイルZ座標(省略時はマップ中央)
 */
export async function openMapMonitorMenu(realPlayer, viewTx, viewTz) {
    const config = getMapConfig();
    if (!config) {
        realPlayer.sendMessage("§cマップがまだ生成されていません。");
        return;
    }

    const { cols, rows, viewStartTx, viewStartTz } = getMonitorViewport(config, viewTx, viewTz);
    const tiles = getTiles();
    const monitor = new MonitorFormData().title("Civ Tactics モニター");
    // 💡 タイルは(1,1)を起点に敷く(0行目/0列目は座標見出し、最終行は移動ボタン用に空けてある)。
    //    スロット番号はグリッド全体の幅であるMONITOR_COLSを基準に計算する
    //    (縮んだcolsを基準にすると、実際のグリッド上でマスの位置がズレて詰まってしまう)。
    for (let row = 0; row < rows; row++) {
        const tz = viewStartTz + row;
        for (let col = 0; col < cols; col++) {
            const tx = viewStartTx + col;
            const tile = tiles[`${tx},${tz}`];
            if (!tile) continue;
            const { icon, name, lore } = describeMonitorTile({ ...tile, tx, tz });
            monitor.cell((1 + row) * MONITOR_COLS + (1 + col), name, lore, icon);
        }
    }

    // 💡 座標見出し(0行目=列のtx番号、0列目=行のtz番号。テクスチャを持たせないことで
    //    monitor_server_form.jsonのcoord_labelだけが表示される)。左上の角(0,0)は空欄のまま。
    for (let col = 0; col < cols; col++) {
        monitor.cell(MONITOR_HEADER_ROW * MONITOR_COLS + (1 + col), `§7${viewStartTx + col}`);
    }
    for (let row = 0; row < rows; row++) {
        monitor.cell((1 + row) * MONITOR_COLS + MONITOR_HEADER_COL, `§7${viewStartTz + row}`);
    }

    // 💡 最終行(MONITOR_CONTROL_ROW)に、タイル範囲(1〜MONITOR_TILE_COLS)を基準に
    //    左右対称に配置した移動ボタンを置く(使い方・西・北・南・東・閉じる)。
    //    現在地の範囲は使い方ボタンのロアに載せる。
    const controlRowBase = MONITOR_CONTROL_ROW * MONITOR_COLS;
    monitor.cell(controlRowBase + MONITOR_CONTROL_HELP_COL, "§e使い方", [
        "§7矢印ボタンで表示範囲を移動できます。",
        `§7X: ${viewStartTx} 〜 ${Math.min(config.width, viewStartTx + cols) - 1}`,
        `§7Z: ${viewStartTz} 〜 ${Math.min(config.height, viewStartTz + rows) - 1}`,
    ], "minecraft:book");
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
            case MONITOR_CONTROL_WEST_COL: await openMapMonitorMenu(realPlayer, viewStartTx - cols, viewStartTz); return;
            case MONITOR_CONTROL_NORTH_COL: await openMapMonitorMenu(realPlayer, viewStartTx, viewStartTz - rows); return;
            case MONITOR_CONTROL_SOUTH_COL: await openMapMonitorMenu(realPlayer, viewStartTx, viewStartTz + rows); return;
            case MONITOR_CONTROL_EAST_COL: await openMapMonitorMenu(realPlayer, viewStartTx + cols, viewStartTz); return;
            case MONITOR_CONTROL_CLOSE_COL: return; // 閉じる
        }
    }
    await openMapMonitorMenu(realPlayer, viewStartTx, viewStartTz); // マスや使い方欄をタップした場合は同じ範囲を再表示
}

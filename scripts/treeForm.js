// treeForm.js
// 研究/社会制度ツリー専用の自作UI画面(progressTree.js が使う)を表示するための TreeFormData。
// 実体は chestForms.js / monitorForm.js と同じ仕組み(ActionFormDataのタイトル文字列に
// マーカーを仕込み、development_resource_packs/testapia_ui 側のUI定義(ui/server_form.json→
// ui/tree_server_form.json)がそれを検知して専用レイアウトに差し替える)。
//
// モニターUIとの違いは「セルが横長(TREE_CELL_W×TREE_CELL_H)で、アイコンの下に項目名と
// コストを常時表示する」「テクスチャパスが textures/ui/tree/ で始まるセルは、枠もラベルも
// 描かずにセル全面へ接続線の画像だけを描く(ノード同士をつなぐ線)」の2点。どちらも
// リソースパック側(ui/tree_server_form.json)の判定なので、このクラス自体はマーカー文字列と
// グリッドサイズを差し替えるだけの薄いラッパー。
//
// 💡 TREE_COLS/TREE_ROWS は development_resource_packs/testapia_ui/ui/tree_server_form.json の
//    $tree_grid_size と、TREE_CELL_W/TREE_CELL_H は同ファイルの cell_panel の size と、
//    それぞれ必ず一致させること(接続線テクスチャもセルと同じ52×32pxで作ってあるため、
//    サイズを変える場合は textures/ui/tree/*.png も作り直す必要がある。
//    生成スクリプトは development_resource_packs/testapia_ui/tools/gen_tree_lines.ps1)。

import { GridFormData } from "./gridFormData.js";

export const TREE_COLS = 7;
export const TREE_ROWS = 9;
export const TREE_CELL_W = 52;
export const TREE_CELL_H = 32;

// 💡 ui/server_form.json が検知するマーカー文字列。チェストUI("§c§h§e§s§t...")・
//    モニターUI("§m§o§n§i§t§o§r...")と衝突しない専用の合言葉。
const TREE_MARKER = "§t§r§e§e§r";

export class TreeFormData extends GridFormData {
    constructor() {
        super(TREE_MARKER, TREE_COLS * TREE_ROWS);
    }

    /**
     * slot(0始まり、TREE_COLS×TREE_ROWS未満、行優先順)にセルを置く。
     * name の1行目が項目名、lore の各行がその下に続けて常時表示される(ホバー時のツールチップ
     * にも同じ文字列が出る)。texture がバニラのアイテム/ブロックのtypeIdならその3Dアイコン、
     * textures/ui/tree/ 配下のパスなら「接続線」としてセル全面に描画される。
     */
    cell(slot, name, lore, texture) {
        return this.setSlot(slot, name, lore, texture);
    }
}

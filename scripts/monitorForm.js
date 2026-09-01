// monitorForm.js
// マップモニター専用の「チェストUIではない自作UI」を表示するためのMonitorFormData。
// 実体はchestForms.jsのChestFormDataと同じ仕組み(ActionFormDataのタイトル文字列に
// マーカーを仕込み、development_resource_packs/testapia_ui側のUI定義(ui/server_form.json→
// ui/monitor_server_form.json)がそれを検知して、チェストの木目パネルではなく専用の
// 暗い画面ベゼル(monitor_background)+マス目状のセル(monitor_cell)で描く独自レイアウトに
// 差し替える。アイコンの解決方式(バニラアイテム/ブロックのtypeIdは実物の3Dアイコン、
// それ以外の文字列はテクスチャパスとして通常画像描画)はchestForms.jsと共通。
//
// チェストUIと違い、個数バッジ・耐久度バー・プレイヤーの実インベントリ表示は最初から
// 使わない設計(モニターは読み取り専用のスナップショットのため)ため、それらの機能は
// 実装していない。グリッドサイズは development_resource_packs/testapia_ui/ui/
// monitor_server_form.json 側に $monitor_grid_size として固定で焼き込んである
// (MONITOR_COLS/MONITOR_ROWSと必ず一致させること。変更する場合は両方を揃える)。
//
// 土台の仕組み(マーカー仕込み・アイコン解決・スロット管理)はchestForms.jsのChestFormDataと
// 共通のため、gridFormData.jsのGridFormDataに切り出してある。このクラスはモニター用の
// マーカー文字列・グリッドサイズだけを差し替える薄いラッパー。

import { GridFormData } from "./gridFormData.js";

export const MONITOR_COLS = 15;
export const MONITOR_ROWS = 10;

// 💡 development_resource_packs/testapia_ui/ui/server_form.json が検知するマーカー文字列。
//    チェストUIの "§c§h§e§s§t..." と衝突しない専用の合言葉。
const MONITOR_MARKER = "§m§o§n§i§t§o§r§r";

export class MonitorFormData extends GridFormData {
    constructor() {
        super(MONITOR_MARKER, MONITOR_COLS * MONITOR_ROWS);
    }

    /**
     * slot(0始まり、MONITOR_COLS×MONITOR_ROWS未満、行優先順)に、テクスチャ付きのマスを置く。
     * texture にはバニラのアイテム/ブロックのtypeId、またはリソースパック内のテクスチャパス
     * (例: "textures/ui/xxx")を渡せる(typeIds.jsの対応表に無い場合は後者として扱われる)。
     * name/loreはホバー時のツールチップとしてのみ表示される(常時表示のラベルは持たない)。
     */
    cell(slot, name, lore, texture) {
        return this.setSlot(slot, name, lore, texture);
    }
}

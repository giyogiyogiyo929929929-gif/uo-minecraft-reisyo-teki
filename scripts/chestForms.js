// chestForms.js
// メニューを「チェストのアイテムを選ぶ」見た目で表示するための ChestFormData。
// 実体は ActionFormData(server_form)そのものだが、タイトル文字列に特殊なマーカー
// (§c§h§e§s§t§5§4§r など)を仕込むことで、development_resource_packs/testapia_ui 側の
// UI定義(ui/server_form.json)がそれを検知し、通常のフォームの代わりにチェスト風の
// パネル(ui/chest_server_form.json)を表示する。このリソースパックが有効になっていない
// ワールドでは、マーカー文字列がそのまま(色付きの記号として)見えてしまう普通のフォームに
// なるだけで、クラッシュ等はしない。
//
// 出典: Chest-UI (https://github.com/Herobrine643928/Chest-UI) — Herobrine64#3928, LeGend077
// ライセンス: CC BY 4.0。このファイルは元実装(BP/scripts/extensions/forms.js の
// ChestFormData)を、本プロジェクトのメニュー用途に合わせて簡略化した独自の再実装
// (FurnaceFormData・プレイヤーの実インベントリ表示機能は不要なため削除)。
// 詳細は development_resource_packs/testapia_ui/CREDITS.md を参照。
//
// 実体の仕組み(マーカー仕込み・アイコン解決・スロット管理)は monitorForm.js の
// MonitorFormData と共通のため、gridFormData.js の GridFormData に切り出してある。
// このクラスはチェストUI向けのサイズ表・個数バッジ用プレフィックスだけを差し替える薄い
// ラッパー。

import { GridFormData } from "./gridFormData.js";

// 💡 チェストの見た目(スロット数)。既定は「大チェスト」相当の54マス
//    (development_resource_packs/testapia_ui/ui/_global_variables.json で有効化している
//    レイアウトと対応させる必要がある。増やしたい場合は両方を揃えて変更すること)。
const CHEST_UI_SIZES = new Map([
    ["small", ["§c§h§e§s§t§2§7§r", 27]],
    ["large", ["§c§h§e§s§t§5§4§r", 54]],
]);

// 💡 "stack#01dur#00§r" は、チェストUI側のリソースパックが個数バッジ・耐久度バーを
//    描画するために読み取る固定長のプレフィックス。メニュー用途ではどちらも使わないため
//    「個数1・ダメージ無し」を表す固定値にしている(表示上は見えない)。
const CHEST_BADGE_PREFIX = "stack#01dur#00§r";

export class ChestFormData extends GridFormData {
    constructor(size = "large") {
        const sizing = CHEST_UI_SIZES.get(size) ?? CHEST_UI_SIZES.get("large");
        super(sizing[0], sizing[1], CHEST_BADGE_PREFIX);
    }

    /**
     * slot(0始まり、コンストラクタで決めたスロット数未満)にアイテム風のボタンを配置する。
     * texture にはバニラのアイテム/ブロックのtypeId(例: "minecraft:diamond")を渡す
     * (typeIds.js の対応表に無いtypeIdを渡した場合は、通常のテクスチャパスとして扱われ、
     * 3D描画やエンチャント光彩は付かない)。範囲外のslotは無視する。
     */
    button(slot, itemName, lore, texture) {
        return this.setSlot(slot, itemName, lore, texture);
    }
}

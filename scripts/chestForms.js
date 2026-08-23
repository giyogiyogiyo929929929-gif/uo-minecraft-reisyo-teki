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

import { ActionFormData } from "@minecraft/server-ui";
import { typeIdToID, typeIdToDataId } from "./typeIds.js";

// 💡 チェストの見た目(スロット数)。既定は「大チェスト」相当の54マス
//    (development_resource_packs/testapia_ui/ui/_global_variables.json で有効化している
//    レイアウトと対応させる必要がある。増やしたい場合は両方を揃えて変更すること)。
const CHEST_UI_SIZES = new Map([
    ["small", ["§c§h§e§s§t§2§7§r", 27]],
    ["large", ["§c§h§e§s§t§5§4§r", 54]],
]);

export class ChestFormData {
    #titleText;
    #buttonArray;

    constructor(size = "large") {
        const sizing = CHEST_UI_SIZES.get(size) ?? CHEST_UI_SIZES.get("large");
        this.#titleText = { rawtext: [{ text: sizing[0] }] };
        this.#buttonArray = Array(sizing[1]).fill(["", undefined]);
        this.slotCount = sizing[1];
    }

    title(text) {
        this.#titleText.rawtext.push({ text });
        return this;
    }

    /**
     * slot(0始まり、コンストラクタで決めたスロット数未満)にアイテム風のボタンを配置する。
     * texture にはバニラのアイテム/ブロックのtypeId(例: "minecraft:diamond")を渡す
     * (typeIds.js の対応表に無いtypeIdを渡した場合は、通常のテクスチャパスとして扱われ、
     * 3D描画やエンチャント光彩は付かない)。範囲外のslotは無視する。
     */
    button(slot, itemName, lore, texture) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= this.slotCount) return this;
        const id = typeIdToDataId.get(texture) ?? typeIdToID.get(texture);
        // 💡 "stack#01dur#00§r" は、チェストUI側のリソースパックが個数バッジ・耐久度バーを
        //    描画するために読み取る固定長のプレフィックス。メニュー用途ではどちらも使わないため
        //    「個数1・ダメージ無し」を表す固定値にしている(表示上は見えない)。
        const buttonRawtext = { rawtext: [{ text: "stack#01dur#00§r" }, { text: itemName ?? "" }] };
        if (Array.isArray(lore)) {
            for (const line of lore) buttonRawtext.rawtext.push({ text: `\n${line}` });
        }
        this.#buttonArray[slot] = [buttonRawtext, id === undefined ? texture : id * 65536];
        return this;
    }

    show(player) {
        const form = new ActionFormData().title(this.#titleText);
        for (const [text, icon] of this.#buttonArray) form.button(text, icon?.toString());
        return form.show(player);
    }
}

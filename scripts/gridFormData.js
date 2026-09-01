// gridFormData.js
// 「ActionFormData(server_form)のタイトル文字列に専用マーカーを仕込み、
// development_resource_packs/testapia_ui 側のUI定義がそれを検知して、通常のフォームの
// 代わりにグリッド状の専用レイアウト(チェスト風パネル/マップモニター画面など)を表示する」
// という仕組みの共通実装。ChestFormData(chestForms.js)・MonitorFormData(monitorForm.js)は
// どちらもこの土台の上に、マーカー文字列・スロット数・バッジプレフィックスだけを差し替えた
// 薄いラッパー(以前はこのクラスの中身をまるごとコピーして2つ持っていた)。

import { ActionFormData } from "@minecraft/server-ui";
import { typeIdToID, typeIdToDataId } from "./typeIds.js";

export class GridFormData {
    #titleText;
    #cellArray;
    #badgePrefix;

    /**
     * @param {string} marker リソースパック側のUI定義が検知するマーカー文字列
     * @param {number} slotCount グリッドの総スロット数
     * @param {string} [badgePrefix] 各セルの先頭に付ける固定プレフィックス
     *   (チェストUIの個数バッジ・耐久度バー用の"stack#01dur#00§r"など。不要なら空文字)
     */
    constructor(marker, slotCount, badgePrefix = "") {
        this.#titleText = { rawtext: [{ text: marker }] };
        this.#cellArray = Array(slotCount).fill(["", undefined]);
        this.#badgePrefix = badgePrefix;
        this.slotCount = slotCount;
    }

    title(text) {
        this.#titleText.rawtext.push({ text });
        return this;
    }

    /**
     * slot(0始まり、コンストラクタで決めたスロット数未満)にテクスチャ付きのマスを置く。
     * texture にはバニラのアイテム/ブロックのtypeId、またはリソースパック内のテクスチャパス
     * (例: "textures/ui/xxx")を渡せる(typeIds.jsの対応表に無い場合は後者として扱われる)。
     * name/loreはホバー時のツールチップとしてのみ表示される。範囲外のslotは無視する。
     */
    setSlot(slot, name, lore, texture) {
        if (!Number.isInteger(slot) || slot < 0 || slot >= this.slotCount) return this;
        const id = typeIdToDataId.get(texture) ?? typeIdToID.get(texture);
        const cellRawtext = { rawtext: [{ text: this.#badgePrefix }, { text: name ?? "" }] };
        if (Array.isArray(lore)) {
            for (const line of lore) cellRawtext.rawtext.push({ text: `\n${line}` });
        }
        this.#cellArray[slot] = [cellRawtext, id === undefined ? texture : id * 65536];
        return this;
    }

    show(player) {
        const form = new ActionFormData().title(this.#titleText);
        for (const [text, icon] of this.#cellArray) form.button(text, icon?.toString());
        return form.show(player);
    }
}

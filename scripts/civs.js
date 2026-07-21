// civs.js
// ソロテスト用に、OPが自分ひとりで複数の「国家」を操作できるようにするための身元管理モジュール。
//
// 【考え方】
// ・ゲーム内の「国家」は本来 実プレイヤー(Player) と1:1だったが、ここに「テスト国家(仮想国家)」
//   という、実エンティティを持たない国家IDを追加できるようにする。
// ・OPは自分が追加したテスト国家に「操作を切り替える」ことができ、切り替え中はチャットコマンド・
//   メニュー操作のすべてがそのテスト国家として実行される(領有・都市・外交・研究などすべて)。
// ・実際にブロックを設置したりマップ上を移動するのはOP自身の体なので、テスト国家として
//   行動したいマスには物理的に歩いて移動してから操作する(いわば「一人二役」)。
// ・テスト国家のセーブデータ(研究・外交など)は、実体を持たないため world 側にID別の名前空間で
//   保存する(実プレイヤーの場合は今まで通りプレイヤー本体に保存し、既存セーブとの互換性を保つ)。

import { world } from "@minecraft/server";

const VIRTUAL_CIVS_PROPERTY = "civ:virtualCivs";
const ACTIVE_CIV_PROPERTY = "civ:activeCivByController";

function getVirtualCivs() {
    const raw = world.getDynamicProperty(VIRTUAL_CIVS_PROPERTY);
    if (typeof raw !== "string") return [];
    try {
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    } catch {
        return [];
    }
}

function saveVirtualCivs(list) {
    world.setDynamicProperty(VIRTUAL_CIVS_PROPERTY, JSON.stringify(list));
}

function getActiveCivMap() {
    const raw = world.getDynamicProperty(ACTIVE_CIV_PROPERTY);
    if (typeof raw !== "string") return {};
    try {
        const map = JSON.parse(raw);
        return map && typeof map === "object" ? map : {};
    } catch {
        return {};
    }
}

function saveActiveCivMap(map) {
    world.setDynamicProperty(ACTIVE_CIV_PROPERTY, JSON.stringify(map));
}

export function getVirtualCivById(id) {
    return getVirtualCivs().find(c => c.id === id) ?? null;
}

/** OPが、ソロテスト用に自分で操作できる国家をもう一つ追加する。 */
export function addVirtualCiv(controllerPlayer, name) {
    const civs = getVirtualCivs();
    const id = `npc_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const civName = (name ?? "").trim() || `テスト国家${civs.length + 1}`;
    civs.push({ id, name: civName, controllerId: controllerPlayer.id });
    saveVirtualCivs(civs);
    return { id, name: civName };
}

/** この実プレイヤーが操作できる国家(自分自身＋自分が追加したテスト国家)の一覧を返す。 */
export function getControllableCivs(realPlayer) {
    const list = [{ id: realPlayer.id, name: realPlayer.name, isVirtual: false }];
    for (const civ of getVirtualCivs()) {
        if (civ.controllerId === realPlayer.id) list.push({ id: civ.id, name: civ.name, isVirtual: true });
    }
    return list;
}

/** 現在この実プレイヤーが「操作中」の国家IDを取得する(未設定なら自分自身の国家)。 */
export function getActiveCivId(realPlayer) {
    return getActiveCivMap()[realPlayer.id] ?? realPlayer.id;
}

/** 操作中の国家を切り替える。自分自身か、自分が追加したテスト国家にしか切り替えられない。 */
export function setActiveCivId(realPlayer, civId) {
    if (civId !== realPlayer.id) {
        const civ = getVirtualCivById(civId);
        if (!civ || civ.controllerId !== realPlayer.id) {
            return { ok: false, message: "§cその国家を操作する権限がありません。" };
        }
    }
    const map = getActiveCivMap();
    map[realPlayer.id] = civId;
    saveActiveCivMap(map);
    return { ok: true };
}

/** 国家IDから表示名を解決する(実プレイヤー優先、次にテスト国家。どちらにも無ければnull)。 */
export function resolveCivName(civId) {
    for (const p of world.getAllPlayers()) {
        if (p.id === civId) return p.name;
    }
    return getVirtualCivById(civId)?.name ?? null;
}

/**
 * 指定した国家IDのための、プレイヤー風の入れ物(id / name / getDynamicProperty / setDynamicProperty /
 * sendMessage)を返す。ターン開始処理など、「操作中の実プレイヤー」という文脈が無い場所
 * (playerOrder を直接ループするような場所)から国家データを読み書きするために使う。
 * ・実プレイヤーの国家IDなら、そのプレイヤー本体をそのまま返す(既存セーブとの互換性を保つ)。
 * ・テスト国家(仮想)なら、world側にID別の名前空間で保存する軽量な入れ物を返す。
 * ・どちらにも該当しない場合(実プレイヤーが現在オフラインなど)は null を返す。
 *   💡 オフラインの実プレイヤーのデータは、そのプレイヤーの実エンティティ上にしか保存できない
 *      (Bedrock Script APIの制約上、オフラインプレイヤーの DynamicProperty は読み書きできない)。
 *      ここで world 側の代替ストレージへフォールバックしてしまうと、そのプレイヤーが再ログインした
 *      際に「本来のデータ」と「オフライン中に書かれたデータ」が食い違ってしまうため、あえて null を
 *      返して呼び出し側で処理をスキップさせる(オフライン中はそのターンの恩恵を受けられない)。
 */
export function getCivStorageHandle(civId) {
    const realPlayer = world.getAllPlayers().find(p => p.id === civId);
    if (realPlayer) return realPlayer;

    const civ = getVirtualCivById(civId);
    if (!civ) return null;

    return {
        id: civId,
        name: civ.name,
        getDynamicProperty: (key) => world.getDynamicProperty(`civ:npc:${civId}:${key}`),
        setDynamicProperty: (key, value) => world.setDynamicProperty(`civ:npc:${civId}:${key}`, value),
        sendMessage: (text) => {
            // テスト国家自身にはメッセージ送信先(実体)が無いため、操作しているOPへ代わりに届ける。
            const controller = civ.controllerId ? world.getAllPlayers().find(p => p.id === civ.controllerId) : null;
            controller?.sendMessage(`§7[${civ.name}] §r${text}`);
        },
    };
}

/** プロキシ越しでも実プレイヤー本体を取り出すためのヘルパー。 */
export function getRealPlayer(player) {
    return player?.__realPlayer ?? player;
}

/**
 * 実プレイヤーを、その時点で「操作中」の国家として振る舞わせる Player 風のラッパーを返す。
 * id / name / getDynamicProperty / setDynamicProperty はその国家のものに差し替え、
 * それ以外(位置情報・送信メッセージ・権限・インベントリなど)はすべて実プレイヤー本体に委譲する。
 *
 * 💡 以前は Proxy で実装していたが、Player.id など一部のプロパティがネイティブ側で
 *    書き換え不可(non-configurable)として定義されており、get トラップで別の値を返すと
 *    "TypeError: proxy: inconsistent get" で落ちることが判明した。
 *    そのため Proxy はやめ、実プレイヤーをプロトタイプチェーンに繋いだ素の JS オブジェクトを
 *    作り、id / name / getDynamicProperty / setDynamicProperty だけを自前のプロパティとして
 *    定義する方式にしている(それ以外のメンバーはプロトタイプ経由で実プレイヤーの値がそのまま
 *    見える。メソッド呼び出し時の this は実プレイヤー本体になるため、ネイティブ側の内部チェックも
 *    問題ない)。
 *
 * 💡 UIフォーム(ActionFormData など)の .show() には、このラッパーではなく
 *    getRealPlayer() で取り出した実プレイヤー本体を渡すこと。
 *
 * 操作中の国家が自分自身の場合は、余計なラップをせず実プレイヤーをそのまま返す。
 */
export function getActingPlayer(realPlayer) {
    const activeId = getActiveCivId(realPlayer);
    if (activeId === realPlayer.id) return realPlayer;

    const civ = getVirtualCivById(activeId);
    if (!civ) return realPlayer;

    // 💡 ターゲットを実プレイヤーではなく「空オブジェクト {}」に指定してProxy不変式エラーを回避
    return new Proxy({}, {
        get(target, prop) {
            // 1. 仮想プレイヤー用にオーバーライドする項目
            if (prop === "id") return civ.id;
            if (prop === "name") return civ.name;
            if (prop === "__realPlayer") return realPlayer;

            if (prop === "getDynamicProperty") {
                return (key) => world.getDynamicProperty(`civ:npc:${civ.id}:${key}`);
            }
            if (prop === "setDynamicProperty") {
                return (key, val) => world.setDynamicProperty(`civ:npc:${civ.id}:${key}`, val);
            }

            // 2. 実プレイヤーからプロパティ/メソッドを取得
            const value = Reflect.get(realPlayer, prop);

            // メソッド（sendMessage, teleport など）は this を realPlayer に固定して返す
            if (typeof value === "function") {
                return value.bind(realPlayer);
            }

            return value;
        },
        set(target, prop, value) {
            realPlayer[prop] = value;
            return true;
        },
        has(target, prop) {
            if (prop === "id" || prop === "name" || prop === "__realPlayer") return true;
            return prop in realPlayer;
        }
    });
}
// diplomacy.js
// 🤝 外交関係(不可侵条約・同盟・戦争)と申請・破棄を管理するモジュール
//
// 【関係の状態遷移】
//   none(関係なし) --宣戦布告(declareWar)--> war(戦争)
//   none --提案/承認(sendRequest+acceptRequest)--> pact(不可侵条約) --同上--> alliance(同盟)
//   war --提案/承認(sendRequest(type:"peace")+acceptRequest)--> none (=講和)
//   pact/alliance --解消(breakRelation、相手の承諾不要)--> none
//   pact/alliance --宣戦布告(declareWar)--> war (=同盟や不可侵条約を破っての開戦)
// 戦争中は新たな不可侵条約・同盟を提案できない(sendRequestが拒否する。まず講和を提案して
// 承認されてから提案し直す)。講和(戦争状態の終了)は不可侵条約・同盟の解消(breakRelation、
// 一方的に成立)とは異なり、「送っただけで即成立」だと都合が良すぎるため、他の外交提案と
// 同じ申請→承認の流れにしている(breakRelationは戦争状態を扱わない。§9参照)。
// 試合の設定(state.js の getMatchSettings().peaceEnabled)が無効な場合、講和の提案・承認は
// どちらも拒否される(不可侵条約・同盟の解消は常に可能。この設定はあくまで「一度始まった
// 戦争を終わらせられるか」だけを制御する)。

import { getCivStorageHandle } from "./civs.js"
import { getMatchSettings } from "./state.js"

const DIPLOMACY_KEY = "civ:diplomacy";

// 💡 外交提案/関係種別の表示名。以前はcombat.jsのUNIT_CLASS_LABELSと同じことを、
//    こことui.js側の複数箇所で個別のternary chainとして書いており、一部(openCivDiplomacyDetail)
//    はpeaceケースの追加漏れが起きていた。1箇所にまとめて全呼び出し元から参照する。
export const RELATION_REQUEST_TYPE_LABELS = { pact: "不可侵条約", alliance: "同盟", peace: "講和" };

/** 外交提案/関係種別(pact/alliance/peace)の表示名を取得する(未知の値ならそのまま返す)。 */
export function getRelationTypeLabel(type) {
    return RELATION_REQUEST_TYPE_LABELS[type] ?? type ?? "不明";
}

/**
 * プレイヤー/文明の外交データを取得
 */
function getState(handle) {
    if (!handle) return { nonAggression: [], alliances: [], wars: [], requests: [] };
    try {
        const raw = handle.getDynamicProperty?.(DIPLOMACY_KEY);
        if (typeof raw === "string") {
            const parsed = JSON.parse(raw);
            return {
                nonAggression: Array.isArray(parsed.nonAggression) ? parsed.nonAggression : [],
                alliances: Array.isArray(parsed.alliances) ? parsed.alliances : [],
                wars: Array.isArray(parsed.wars) ? parsed.wars : [],
                requests: Array.isArray(parsed.requests) ? parsed.requests : [],
            };
        }
    } catch {
        // 保存データのパース失敗時は初期値を返す
    }
    return { nonAggression: [], alliances: [], wars: [], requests: [] };
}

/**
 * プレイヤー/文明の外交データを保存 (ReferenceError 回避のため内部定義)
 */
function saveState(handle, state) {
    if (!handle?.setDynamicProperty) return;
    try {
        handle.setDynamicProperty(DIPLOMACY_KEY, JSON.stringify(state));
    } catch (e) {
        // 必要に応じてログ出力等
    }
}

/** 外交データのリセット */
export function resetDiplomacy(handle) {
    saveState(handle, { nonAggression: [], alliances: [], wars: [], requests: [] });
}

/** 協定を直接締結する関数 (互換性用) */
export function signAgreement(handle, target, type) {
    const state = getState(handle);
    const targetId = typeof target === "string" ? target : target?.id;
    if (!targetId) return;

    const isPact = type === "pact" || type === "nonAggression";
    const isAlliance = type === "alliance" || type === "alliances";

    if (isPact) {
        state.nonAggression = state.nonAggression ?? [];
        if (!state.nonAggression.includes(targetId)) state.nonAggression.push(targetId);
    } else if (isAlliance) {
        state.alliances = state.alliances ?? [];
        if (!state.alliances.includes(targetId)) state.alliances.push(targetId);
    }
    saveState(handle, state);

    if (typeof target !== "string" && target?.id && handle?.id) {
        const targetState = getState(target);
        if (isPact) {
            targetState.nonAggression = targetState.nonAggression ?? [];
            if (!targetState.nonAggression.includes(handle.id)) targetState.nonAggression.push(handle.id);
        } else if (isAlliance) {
            targetState.alliances = targetState.alliances ?? [];
            if (!targetState.alliances.includes(handle.id)) targetState.alliances.push(handle.id);
        }
        saveState(target, targetState);
    }
}

/**
 * 2国間の現在の関係を取得
 * @returns {"none" | "pact" | "alliance" | "war"}
 */
export function getRelation(fromHandle, targetCivId) {
    const state = getState(fromHandle);
    if ((state.wars ?? []).includes(targetCivId)) return "war";
    if ((state.alliances ?? []).includes(targetCivId)) return "alliance";
    if ((state.nonAggression ?? []).includes(targetCivId)) return "pact";
    return "none";
}

/**
 * 相手に宣戦布告する。即座に双方を戦争状態にし、結んでいた不可侵条約・同盟があれば
 * 同時に破棄する(=同盟や不可侵条約を破っての開戦も可能)。承認・拒否のような
 * 相手側の意思確認は不要(宣戦布告は一方的に成立する)。
 */
export function declareWar(fromHandle, toHandle) {
    const targetId = toHandle?.id;
    if (!targetId || !fromHandle?.id) return { ok: false, message: "§c対象が見つかりません。" };
    if (fromHandle.id === targetId) return { ok: false, message: "§c自国には宣戦布告できません。" };

    const myState = getState(fromHandle);
    if ((myState.wars ?? []).includes(targetId)) {
        return { ok: false, message: `§cすでに【${toHandle.name ?? targetId}】と戦争状態です。` };
    }

    myState.nonAggression = (myState.nonAggression ?? []).filter(id => id !== targetId);
    myState.alliances = (myState.alliances ?? []).filter(id => id !== targetId);
    myState.wars = myState.wars ?? [];
    myState.wars.push(targetId);
    saveState(fromHandle, myState);

    const targetState = getState(toHandle);
    targetState.nonAggression = (targetState.nonAggression ?? []).filter(id => id !== fromHandle.id);
    targetState.alliances = (targetState.alliances ?? []).filter(id => id !== fromHandle.id);
    targetState.wars = targetState.wars ?? [];
    if (!targetState.wars.includes(fromHandle.id)) targetState.wars.push(fromHandle.id);
    saveState(toHandle, targetState);

    return { ok: true, message: `§4【${fromHandle.name ?? fromHandle.id}】が【${toHandle.name ?? targetId}】に宣戦布告しました！` };
}

/** 届いている申請一覧を取得 */
export function getRequestsFor(handle) {
    const state = getState(handle);
    return state.requests ?? [];
}

/**
 * 外交提案（申請）を送信。type は "pact"(不可侵条約) / "alliance"(同盟) / "peace"(講和)。
 * 💡 peaceは他の2つと前提条件が逆(戦争状態でなければ提案できない、diplomacyEnabledではなく
 *    peaceEnabledを見る)なので、ここで分岐する。以前はbreakRelationで戦争状態を一方的に
 *    (相手の承諾無しに)即終了できたが、「送ったら即講和」は都合が良すぎるため、他の外交提案
 *    (不可侵条約・同盟)と同じ申請→承認の流れに統一した。
 */
export function sendRequest(fromHandle, toHandle, type) {
    const relation = getRelation(fromHandle, toHandle?.id);
    if (type === "peace") {
        if (relation !== "war") {
            return { ok: false, message: "§c戦争状態の相手にしか講和を提案できません。" };
        }
        if (!getMatchSettings().peaceEnabled) {
            return { ok: false, message: "§cこの試合では講和(戦争状態の解消)が無効に設定されています。" };
        }
    } else {
        if (!getMatchSettings().diplomacyEnabled) {
            return { ok: false, message: "§cこの試合では不可侵条約・同盟が無効に設定されています。" };
        }
        if (relation === "war") {
            return { ok: false, message: "§c戦争状態の相手には提案できません。先に講和を提案してください。" };
        }
    }

    const toState = getState(toHandle);
    const requests = toState.requests ?? [];

    const fromId = fromHandle.id;
    const fromName = fromHandle.name ?? "不明な国家";

    if (requests.some(r => r.fromId === fromId && r.type === type)) {
        return { ok: false, message: "§cすでに同じ提案を送信済みです。" };
    }

    requests.push({
        id: `${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        fromId,
        fromName,
        type,
        timestamp: Date.now()
    });

    toState.requests = requests;
    saveState(toHandle, toState);

    const typeLabel = getRelationTypeLabel(type);
    return { ok: true, message: `§a【${typeLabel}】の提案を送信しました。相手の承諾をお待ちください。` };
}

/** 外交提案を承認 */
export function acceptRequest(myHandle, fromHandle, requestId) {
    const myState = getState(myHandle);
    const req = (myState.requests ?? []).find(r => r.id === requestId);
    if (!req) return { ok: false, message: "§c該当する申請が見つかりません。" };

    const targetId = fromHandle.id;

    // 💡 講和(peace)は戦争状態(wars配列)を解消するだけで、不可侵条約・同盟とは別枠の扱い
    //    (diplomacyEnabledではなくpeaceEnabledで許可判定する)。
    if (req.type === "peace") {
        if (!getMatchSettings().peaceEnabled) {
            return { ok: false, message: "§cこの試合では講和(戦争状態の解消)が無効に設定されています。(提案は拒否するか、設定を有効にしてから承認してください)" };
        }

        myState.wars = (myState.wars ?? []).filter(id => id !== targetId);
        myState.requests = (myState.requests ?? []).filter(r => r.id !== requestId);
        saveState(myHandle, myState);

        const targetState = getState(fromHandle);
        targetState.wars = (targetState.wars ?? []).filter(id => id !== myHandle.id);
        saveState(fromHandle, targetState);

        return { ok: true, message: `§a【${req.fromName}】と講和しました(戦争状態を終了)。` };
    }

    if (!getMatchSettings().diplomacyEnabled) {
        return { ok: false, message: "§cこの試合では不可侵条約・同盟が無効に設定されています。(提案は拒否するか、設定を有効にしてから承認してください)" };
    }

    myState.nonAggression = myState.nonAggression ?? [];
    myState.alliances = myState.alliances ?? [];

    if (req.type === "pact") {
        if (!myState.nonAggression.includes(targetId)) myState.nonAggression.push(targetId);
    } else if (req.type === "alliance") {
        if (!myState.alliances.includes(targetId)) myState.alliances.push(targetId);
    }

    myState.requests = (myState.requests ?? []).filter(r => r.id !== requestId);
    saveState(myHandle, myState);

    const targetState = getState(fromHandle);
    targetState.nonAggression = targetState.nonAggression ?? [];
    targetState.alliances = targetState.alliances ?? [];

    if (req.type === "pact") {
        if (!targetState.nonAggression.includes(myHandle.id)) targetState.nonAggression.push(myHandle.id);
    } else if (req.type === "alliance") {
        if (!targetState.alliances.includes(myHandle.id)) targetState.alliances.push(myHandle.id);
    }
    saveState(fromHandle, targetState);

    const typeLabel = getRelationTypeLabel(req.type);
    return { ok: true, message: `§a【${req.fromName}】との【${typeLabel}】を締結しました！` };
}

/** 外交提案を拒否 */
export function rejectRequest(myHandle, requestId) {
    const myState = getState(myHandle);
    const req = (myState.requests ?? []).find(r => r.id === requestId);
    if (!req) return { ok: false, message: "§c該当する申請が見つかりません。" };

    myState.requests = (myState.requests ?? []).filter(r => r.id !== requestId);
    saveState(myHandle, myState);

    const typeLabel = getRelationTypeLabel(req.type);
    return { ok: true, message: `§7【${req.fromName}】からの【${typeLabel}】の提案を拒否しました。` };
}

/**
 * 不可侵条約・同盟の一方的な解消・破棄(相手の承諾は不要)。戦争状態(war)はここでは扱わない
 * ── 講和(戦争状態の終了)は一方的に成立させず、sendRequest(type: "peace")→acceptRequestの
 * 申請・承認制にしている(送っただけで即講和が成立するのは都合が良すぎるため)。
 */
export function breakRelation(myHandle, targetHandle) {
    const myState = getState(myHandle);
    const targetState = getState(targetHandle);

    const targetId = targetHandle.id;
    const myId = myHandle.id;

    const currentRel = getRelation(myHandle, targetId);
    if (currentRel === "none") {
        return { ok: false, message: "§c解消する外交関係が存在しません。" };
    }
    if (currentRel === "war") {
        return { ok: false, message: "§c戦争状態は一方的に終了できません。相手に講和を提案し、承諾を待ってください。" };
    }

    myState.nonAggression = (myState.nonAggression ?? []).filter(id => id !== targetId);
    myState.alliances = (myState.alliances ?? []).filter(id => id !== targetId);
    saveState(myHandle, myState);

    targetState.nonAggression = (targetState.nonAggression ?? []).filter(id => id !== myId);
    targetState.alliances = (targetState.alliances ?? []).filter(id => id !== myId);
    saveState(targetHandle, targetState);

    const typeLabel = getRelationTypeLabel(currentRel);
    return { ok: true, message: `§c【${targetHandle.name}】との【${typeLabel}】を解消・破棄しました。` };
}

export function hasDiplomaticAgreement(playerId, otherPlayerId) {
    if (!playerId || !otherPlayerId || playerId === otherPlayerId) return false;
    const handle = getCivStorageHandle(playerId);
    if (!handle) return false;
    const state = getState(handle);
    return state.nonAggression.includes(otherPlayerId) || state.alliances.includes(otherPlayerId);
}

/** 2国が戦争状態かどうか(playerId視点、宣戦布告は双方向に成立するので対称)。 */
export function isAtWar(playerId, otherPlayerId) {
    if (!playerId || !otherPlayerId || playerId === otherPlayerId) return false;
    const handle = getCivStorageHandle(playerId);
    if (!handle) return false;
    return getRelation(handle, otherPlayerId) === "war";
}

/**
 * playerId が territoryOwnerId の領土(所有マス)に進入できるかどうか。
 * 「関係なし」の相手の領土には入れない(宣戦布告した相手・不可侵条約・同盟の相手になら入れる)、
 * というルールの判定に使う(combat.js の canUnitEnterTile から呼ばれる)。
 * 自国の領土・無所属のマス(territoryOwnerIdが無い)は常にtrue。
 */
export function canEnterTerritory(playerId, territoryOwnerId) {
    if (!territoryOwnerId || playerId === territoryOwnerId) return true;
    const handle = getCivStorageHandle(playerId);
    if (!handle) return false;
    return getRelation(handle, territoryOwnerId) !== "none";
}
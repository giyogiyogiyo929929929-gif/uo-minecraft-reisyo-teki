// diplomacy.js
// 🤝 外交関係（不可侵条約・同盟）と申請・破棄を管理するモジュール

import { getCivStorageHandle } from "./civs"

const DIPLOMACY_KEY = "civ:diplomacy";

/**
 * プレイヤー/文明の外交データを取得
 */
function getState(handle) {
    if (!handle) return { nonAggression: [], alliances: [], requests: [] };
    try {
        const raw = handle.getDynamicProperty?.(DIPLOMACY_KEY);
        if (typeof raw === "string") {
            const parsed = JSON.parse(raw);
            return {
                nonAggression: Array.isArray(parsed.nonAggression) ? parsed.nonAggression : [],
                alliances: Array.isArray(parsed.alliances) ? parsed.alliances : [],
                requests: Array.isArray(parsed.requests) ? parsed.requests : [],
            };
        }
    } catch {
        // 保存データのパース失敗時は初期値を返す
    }
    return { nonAggression: [], alliances: [], requests: [] };
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
    saveState(handle, { nonAggression: [], alliances: [], requests: [] });
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
 * @returns {"none" | "pact" | "alliance"}
 */
export function getRelation(fromHandle, targetCivId) {
    const state = getState(fromHandle);
    if ((state.alliances ?? []).includes(targetCivId)) return "alliance";
    if ((state.nonAggression ?? []).includes(targetCivId)) return "pact";
    return "none";
}

/** 届いている申請一覧を取得 */
export function getRequestsFor(handle) {
    const state = getState(handle);
    return state.requests ?? [];
}

/** 外交提案（申請）を送信 */
export function sendRequest(fromHandle, toHandle, type) {
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

    return { ok: true, message: "§a外交提案を送信しました。相手の承諾をお待ちください。" };
}

/** 外交提案を承認 */
export function acceptRequest(myHandle, fromHandle, requestId) {
    const myState = getState(myHandle);
    const req = (myState.requests ?? []).find(r => r.id === requestId);
    if (!req) return { ok: false, message: "§c該当する申請が見つかりません。" };

    const targetId = fromHandle.id;

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

    const typeLabel = req.type === "pact" ? "不可侵条約" : "同盟";
    return { ok: true, message: `§a【${req.fromName}】との【${typeLabel}】を締結しました！` };
}

/** 外交提案を拒否 */
export function rejectRequest(myHandle, requestId) {
    const myState = getState(myHandle);
    const req = (myState.requests ?? []).find(r => r.id === requestId);
    if (!req) return { ok: false, message: "§c該当する申請が見つかりません。" };

    myState.requests = (myState.requests ?? []).filter(r => r.id !== requestId);
    saveState(myHandle, myState);

    const typeLabel = req.type === "pact" ? "不可侵条約" : "同盟";
    return { ok: true, message: `§7【${req.fromName}】からの【${typeLabel}】の提案を拒否しました。` };
}

/** 外交関係（不可侵条約・同盟）の解消・破棄 */
export function breakRelation(myHandle, targetHandle) {
    const myState = getState(myHandle);
    const targetState = getState(targetHandle);

    const targetId = targetHandle.id;
    const myId = myHandle.id;

    const currentRel = getRelation(myHandle, targetId);
    if (currentRel === "none") {
        return { ok: false, message: "§c解消する外交関係が存在しません。" };
    }

    myState.nonAggression = (myState.nonAggression ?? []).filter(id => id !== targetId);
    myState.alliances = (myState.alliances ?? []).filter(id => id !== targetId);
    saveState(myHandle, myState);

    targetState.nonAggression = (targetState.nonAggression ?? []).filter(id => id !== myId);
    targetState.alliances = (targetState.alliances ?? []).filter(id => id !== myId);
    saveState(targetHandle, targetState);

    const typeLabel = currentRel === "pact" ? "不可侵条約" : "同盟";
    return { ok: true, message: `§c【${targetHandle.name}】との【${typeLabel}】を解消・破棄しました。` };
}

export function hasDiplomaticAgreement(playerId, otherPlayerId) {
    if (!playerId || !otherPlayerId || playerId === otherPlayerId) return false;
    const handle = getCivStorageHandle(playerId);
    if (!handle) return false;
    const state = getState(handle);
    return state.nonAggression.includes(otherPlayerId) || state.alliances.includes(otherPlayerId);
}
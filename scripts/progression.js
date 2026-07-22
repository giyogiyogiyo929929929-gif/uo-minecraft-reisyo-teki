// プレイヤー単位の研究・社会制度の進行を管理する。

export const TECHNOLOGIES = {
    animalHusbandry: { label: "畜産", cost: 10, prerequisites: [] },
    mining: { label: "採掘", cost: 10, prerequisites: [] },
    astrology: { label: "占星術", cost: 10, prerequisites: [] },
    // 💡 弓術: 弓兵の生産に必要。前提条件として畜産が必要。
    archery: { label: "弓術", cost: 15, prerequisites: ["animalHusbandry"] },
    // 💡 陶磁器: 前提条件なし。取得後、都市に穀物庫(食料生産量+1、住居+2)を建設できるようになる。
    pottery: { label: "陶磁器", cost: 10, prerequisites: [] },
};

export const CIVICS = {
    codeOfLaws: { label: "法典", cost: 10, prerequisites: [], effect: "すべての都市の食料生産量+1" },
    // 💡 使節団の前提条件に法典を追加。
    emissaries: { label: "使節団", cost: 10, prerequisites: ["codeOfLaws"], effect: "不可侵条約を締結可能" },
    diplomacy: { label: "外交", cost: 15, prerequisites: ["emissaries"], effect: "同盟を締結可能" },
};

const CONFIG = {
    technology: {
        property: "civ:technologyProgress",
        legacyPointsProperty: "science",
        label: "技術",
        pointsLabel: "科学力",
        defs: TECHNOLOGIES,
    },
    civic: {
        property: "civ:civicProgress",
        legacyPointsProperty: "culture",
        label: "社会制度",
        pointsLabel: "文化力",
        defs: CIVICS,
    },
};

function getConfig(kind) {
    return CONFIG[kind] ?? null;
}

function blankState() {
    return { activeId: null, progress: 0, carry: 0, completed: [] };
}

/** 旧来の science/culture 値があれば、初回のみ繰越ポイントとして移行する。 */
export function getProgressState(player, kind) {
    const config = getConfig(kind);
    if (!config) return blankState();

    const raw = player.getDynamicProperty(config.property);
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            return {
                activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
                progress: Number(parsed.progress) || 0,
                carry: Number(parsed.carry) || 0,
                completed: Array.isArray(parsed.completed) ? parsed.completed : [],
            };
        } catch {
            // 壊れた保存値は安全な初期状態へ戻す。
        }
    }

    const state = blankState();
    state.carry = Number(player.getDynamicProperty(config.legacyPointsProperty)) || 0;
    saveProgressState(player, kind, state);
    return state;
}

export function saveProgressState(player, kind, state) {
    const config = getConfig(kind);
    if (!config) return;
    player.setDynamicProperty(config.property, JSON.stringify(state));
    // 既存の表示用プロパティにも、現在使えるポイントを反映して互換性を保つ。
    player.setDynamicProperty(config.legacyPointsProperty, state.activeId ? state.progress : state.carry);
}

/** 新しいゲーム開始時にプレイヤーの研究進行を初期化する。 */
export function resetProgress(player, kind) {
    const state = blankState();
    saveProgressState(player, kind, state);
}

export function getDefinition(kind, id) {
    return getConfig(kind)?.defs[id] ?? null;
}

export function hasCompletedProgress(player, kind, id) {
    return getProgressState(player, kind).completed.includes(id);
}

export function getDefinitions(kind) {
    return getConfig(kind)?.defs ?? {};
}

export function getKindLabel(kind) {
    return getConfig(kind)?.label ?? "";
}

export function getPointsLabel(kind) {
    return getConfig(kind)?.pointsLabel ?? "";
}

function prerequisitesMet(state, def) {
    return (def.prerequisites ?? []).every(id => state.completed.includes(id));
}

function completeIfReady(state, def) {
    if (state.progress < def.cost) return false;
    state.carry += state.progress - def.cost;
    state.progress = 0;
    state.completed.push(state.activeId);
    state.activeId = null;
    return true;
}

/**
 * 研究または社会制度の取得を開始する。繰越ポイントは直ちに適用される。
 */
export function startProgress(player, kind, id) {
    const config = getConfig(kind);
    const def = getDefinition(kind, id);
    if (!config || !def) return { ok: false, message: "§c不明な項目です。" };

    const state = getProgressState(player, kind);
    if (state.activeId) return { ok: false, message: `§c現在${getKindLabel(kind)}【${getDefinition(kind, state.activeId)?.label ?? state.activeId}】を進行中です。` };
    if (state.completed.includes(id)) return { ok: false, message: `§c【${def.label}】はすでに取得済みです。` };
    if (!prerequisitesMet(state, def)) return { ok: false, message: "§c前提条件を満たしていません。" };

    state.activeId = id;
    state.progress = state.carry;
    state.carry = 0;
    const completedImmediately = completeIfReady(state, def);
    saveProgressState(player, kind, state);

    if (completedImmediately) {
        return { ok: true, completed: true, message: `§a${getKindLabel(kind)}【${def.label}】を取得しました！` };
    }
    return { ok: true, completed: false, message: `§e${getKindLabel(kind)}【${def.label}】を開始しました。 (${state.progress}/${def.cost} ${getPointsLabel(kind)})` };
}

/** ターン開始時に人口由来のポイントを加算し、完了時は余剰を繰越へ保存する。 */
export function grantProgressPoints(player, kind, amount) {
    const state = getProgressState(player, kind);
    const gained = Math.max(0, Number(amount) || 0);
    if (!state.activeId) {
        state.carry += gained;
        saveProgressState(player, kind, state);
        return null;
    }

    const def = getDefinition(kind, state.activeId);
    if (!def) {
        state.activeId = null;
        state.carry += state.progress + gained;
        state.progress = 0;
        saveProgressState(player, kind, state);
        return null;
    }

    state.progress += gained;
    if (completeIfReady(state, def)) {
        saveProgressState(player, kind, state);
        return `§a${getKindLabel(kind)}【${def.label}】を取得しました！ 余剰${getPointsLabel(kind)}: ${state.carry}`;
    }

    saveProgressState(player, kind, state);
    return `§7${getKindLabel(kind)}【${def.label}】: +${gained} ${getPointsLabel(kind)} (${state.progress}/${def.cost})`;
}
// プレイヤー単位の研究・社会制度の進行を管理する。

export const TECHNOLOGIES = {
    animalHusbandry: { label: "畜産", cost: 10, prerequisites: [], effect: "弓術の前提条件になる" },
    mining: { label: "採掘", cost: 10, prerequisites: [], effect: "施設「採石場」を解放。製錬技術の前提条件になる" },
    // 💡 占星術: 前提条件なし。取得後、都市にオベリスク(信仰力+4)を建設できるようになる。
    astrology: { label: "占星術", cost: 10, prerequisites: [], effect: "建造物「オベリスク」・区域「聖地」を解放" },
    // 💡 弓術: 弓兵の生産に必要。前提条件として畜産が必要。
    archery: { label: "弓術", cost: 15, prerequisites: ["animalHusbandry"], effect: "ユニット「弓兵」を解放" },
    // 💡 陶磁器: 前提条件なし。取得後、都市に穀物庫(食料生産量+1、住居+2)を建設できるようになる。
    pottery: { label: "陶磁器", cost: 10, prerequisites: [], effect: "建造物「穀物庫」を解放。筆記の前提条件になる" },
    // 💡 製錬技術: 前提は採掘。取得後、鉄のあるマスに施設「鍛冶場」を建設できるようになる。
    smelting: { label: "製錬技術", cost: 100, prerequisites: ["mining"], effect: "施設「鍛冶場」を解放。徒弟制度の前提条件になる" },
    // 💡 徒弟制度: 前提は製錬技術。取得後、区域「工業地帯」を配置できるようになる。
    apprenticeship: { label: "徒弟制度", cost: 300, prerequisites: ["smelting"], effect: "区域「工業地帯」を解放" },
    // 💡 筆記: 前提は陶磁器。取得後、区域「キャンパス」を配置できるようになる。
    writing: { label: "筆記", cost: 20, prerequisites: ["pottery"], effect: "区域「キャンパス」を解放" },
    // 💡 青銅器: 前提は採掘。取得後、ユニット「槍兵」を生産できるようになる。鉄器の前提条件にもなる。
    bronzeWorking: { label: "青銅器", cost: 30, prerequisites: ["mining"], effect: "ユニット「槍兵」を解放。鉄器の前提条件になる" },
    // 💡 騎乗: 前提は畜産。取得後、ユニット「騎兵」を生産できるようになる。
    horsebackRiding: { label: "騎乗", cost: 30, prerequisites: ["animalHusbandry"], effect: "ユニット「騎兵」を解放" },
    // 💡 航海術: 前提は陶磁器。取得後、水上マスに施設「港」を設置できるようになる。造船術の前提条件にもなる。
    sailing: { label: "航海術", cost: 25, prerequisites: ["pottery"], effect: "施設「港」を解放。造船術の前提条件になる" },
    // 💡 貨幣経済: 前提は陶磁器。取得後、建造物「市場」を生産できるようになる(社会制度「商業」も別途必要)。
    currency: { label: "貨幣経済", cost: 30, prerequisites: ["pottery"], effect: "建造物「市場」を解放(社会制度「商業」も必要)" },
    // 💡 教育: 前提は筆記。取得後、キャンパス上に建造物「図書館」を建設できるようになる。
    education: { label: "教育", cost: 40, prerequisites: ["writing"], effect: "キャンパスの建造物「図書館」を解放" },
    // 💡 鉄器: 前提は青銅器・製錬技術。取得後、ユニット「剣士」を生産できるようになる。
    ironWorking: { label: "鉄器", cost: 120, prerequisites: ["bronzeWorking", "smelting"], effect: "ユニット「剣士」を解放" },
    // 💡 造船術: 前提は航海術。取得後、ユニット「巡洋艦」を生産できるようになる。
    shipBuilding: { label: "造船術", cost: 90, prerequisites: ["sailing"], effect: "ユニット「巡洋艦」を解放" },
    // 💡 工学: 前提は徒弟制度。取得後、ユニット「カタパルト」を生産できるようになる。
    engineering: { label: "工学", cost: 150, prerequisites: ["apprenticeship"], effect: "ユニット「カタパルト」を解放" },
    // 💡 機械工学: 前提は工学。取得後、ユニット「重装弓兵」を生産できるようになる。
    machinery: { label: "機械工学", cost: 220, prerequisites: ["engineering"], effect: "ユニット「重装弓兵」を解放" },
    // 💡 石工術: 前提は採掘。取得後、都市に建造物「防壁」を建設できるようになる(§13参照)。
    masonry: { label: "石工術", cost: 80, prerequisites: ["mining"], effect: "建造物「防壁」を解放" },
};

export const CIVICS = {
    codeOfLaws: { label: "法典", cost: 10, prerequisites: [], effect: "すべての都市の食料生産量+1" },
    // 💡 使節団の前提条件に法典を追加。
    emissaries: { label: "使節団", cost: 10, prerequisites: ["codeOfLaws"], effect: "不可侵条約を締結可能" },
    diplomacy: { label: "外交", cost: 15, prerequisites: ["emissaries"], effect: "同盟を締結可能" },
    // 💡 政治哲学: 前提は法典。軍制改革・神権政治への橋渡し役の社会制度。
    politicalPhilosophy: { label: "政治哲学", cost: 20, prerequisites: ["codeOfLaws"], effect: "軍制改革・神権政治の前提条件になる" },
    // 💡 軍制改革: 前提は政治哲学。取得後、建造物「訓練場」を生産できるようになる。
    militaryTradition: { label: "軍制改革", cost: 35, prerequisites: ["politicalPhilosophy"], effect: "建造物「訓練場」を解放" },
    // 💡 神権政治: 前提は政治哲学。取得後、聖地上に建造物「大聖堂」を建設できるようになる。
    theocracy: { label: "神権政治", cost: 35, prerequisites: ["politicalPhilosophy"], effect: "聖地の建造物「大聖堂」を解放" },
    // 💡 商業: 前提は使節団。取得後、建造物「市場」を生産できるようになる(技術「貨幣経済」も別途必要)。
    commerce: { label: "商業", cost: 20, prerequisites: ["emissaries"], effect: "建造物「市場」を解放(技術「貨幣経済」も必要)" },
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

// 同じターン中に研究画面・ターン処理などから何度も同じDynamic Propertyを
// 取得しないよう、プレイヤーID+種別ごとに進行状態をメモリへ保持する。
// Dynamic Propertyへの保存は saveProgressState() に集約しているため、状態変更時も
// キャッシュと永続データがずれない。
const progressStateCache = new Map();
// 直前に永続化した値も保持し、状態が変化していない saveProgressState() では
// Dynamic Property へのJSON化・書き込みを省略する。
const progressStateRawCache = new Map();
const legacyPointsCache = new Map();

function getConfig(kind) {
    return CONFIG[kind] ?? null;
}

function blankState() {
    return { activeId: null, progress: 0, carry: 0, completed: [] };
}

function getCacheKey(player, kind) {
    return `${player?.id ?? "unknown"}:${kind}`;
}

/** 旧来の science/culture 値があれば、初回のみ繰越ポイントとして移行する。 */
export function getProgressState(player, kind) {
    const config = getConfig(kind);
    if (!config) return blankState();

    const cacheKey = getCacheKey(player, kind);
    const cached = progressStateCache.get(cacheKey);
    if (cached) return cached;

    const raw = player.getDynamicProperty(config.property);
    if (typeof raw === "string") {
        try {
            const parsed = JSON.parse(raw);
            const state = {
                activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
                progress: Number(parsed.progress) || 0,
                carry: Number(parsed.carry) || 0,
                completed: Array.isArray(parsed.completed) ? parsed.completed : [],
            };
            progressStateCache.set(cacheKey, state);
            progressStateRawCache.set(cacheKey, raw);
            const legacy = state.activeId ? state.progress : state.carry;
            legacyPointsCache.set(cacheKey, legacy);
            return state;
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

    const cacheKey = getCacheKey(player, kind);
    const raw = JSON.stringify(state);
    if (progressStateRawCache.get(cacheKey) !== raw) {
        player.setDynamicProperty(config.property, raw);
        progressStateRawCache.set(cacheKey, raw);
    }

    // 既存の表示用プロパティにも、現在使えるポイントを反映して互換性を保つ。
    // 値が変わっていない場合はDynamic Propertyへの書き込みを省略する。
    const legacyPoints = state.activeId ? state.progress : state.carry;
    if (legacyPointsCache.get(cacheKey) !== legacyPoints) {
        player.setDynamicProperty(config.legacyPointsProperty, legacyPoints);
        legacyPointsCache.set(cacheKey, legacyPoints);
    }
    progressStateCache.set(cacheKey, state);
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

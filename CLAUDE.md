# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Minecraft Bedrock behavior pack ("Civ Tactics") implemented entirely with the `@minecraft/server` Script API. It's a Civilization-style turn-based, tile-based strategy addon: players (or a single operator controlling several virtual civs for solo testing) claim tiles, found cities, produce units/buildings, research tech/civics, run religion and diplomacy systems, fight, and launch missiles, until a win condition is met.

There is no separate client/server split, no build step, and no package manager — `scripts/*.js` are plain ES modules loaded directly by the Bedrock scripting engine per `manifest.json`'s `entry: "scripts/main.js"`.

## Commands

There is no npm/build/lint/test tooling in this repo (no `package.json`). Development loop is:

1. Edit files under `scripts/`.
2. This directory *is* the active `development_behavior_packs` folder, so Minecraft picks up changes on world reload (`/reload` in-game, or exit/re-enter the world).
3. Verify in-game via chat commands (`!civ ...`, see §19 of `README.md`) or the compass-item UI menu.

There are no automated tests; correctness is verified by playing the game in a Bedrock world.

## Primary spec

`README.md` (Japanese) is the authoritative, up-to-date specification of every game system — turn flow, city/population/food/starvation math, worker action points, production, facilities, districts, religion, adjacency bonuses, combat formulas, tech/civic trees, diplomacy, victory conditions, missiles, UI structure, and the full chat command list. **The README is a snapshot; if it disagrees with the code, the code (the `.js` files) wins.** Read the relevant README section before changing a system — the numeric constants and rules (e.g. combat damage formula, starvation thresholds, growth thresholds) live there and are easy to get subtly wrong from code alone.

## Architecture

### Module map (`scripts/`)

| File | Responsibility |
|---|---|
| `main.js` | Entry point: event registration, action-bar HUD (0.5s interval), a short-lived city-yield cache keyed off `getStateVersion()` |
| `state.js` | All persistence: wraps `world` Dynamic Properties with an in-memory cache layer |
| `mapGen.js` | Map generation (terrain/resource placement), chunked `tickingarea` management for maps larger than the assumed simulation range |
| `civs.js` | Identity resolution for real players vs. virtual test civs, and "which civ am I acting as" switching |
| `turns.js` | Turn advancement, per-city yield calculation, victory condition checks, missile impact resolution |
| `production.js` | Production-queue building/unit definitions (`PRODUCTION_DEFS`) and progress |
| `facilities.js` | Facilities: instant-build structures placed on owned tiles (consume worker action points, not the production queue) |
| `districts.js` | Districts: multi-turn structures built on a separate owned tile using city production, plus district-only buildings |
| `religion.js` | Religion founding, religious pressure/followers/majority religion, missionary units |
| `adjacency.js` | Generic adjacency-bonus engine shared by buildings/facilities/districts |
| `combat.js` | Melee/ranged combat-strength selection, damage formula, counterattack rules |
| `diplomacy.js` | Non-aggression pacts and alliances |
| `progression.js` | Technology and civic tree progress |
| `commands.js` | Chat command parsing and the action handlers behind both commands and the UI |
| `ui.js` | All `ActionFormData`-based menus, paginated where lists can get long |

### State & persistence model

Everything lives in `world` Dynamic Properties (there is no external DB):

- `civ:mapConfig` — map origin/size/tile size (JSON).
- `civ:turn` — `{ turnNumber, playerOrder, currentIndex, started }`.
- `civ:tiles_row_<z>` — one Dynamic Property **per map row**, holding a JSON object of `{ [tx]: tileData }` for that row. Tiles are addressed elsewhere as a flat map keyed by `"tx,tz"` strings.
- Per-civ data (research, diplomacy, capital flags, etc.) is namespaced by civ ID so virtual test civs — which have no in-world entity — can persist state too.

`state.js` is the only module that touches Dynamic Properties directly; everything else goes through its `getTiles/setTile/setTiles/getMapConfig/getTurnState/...` accessors. It maintains an in-memory cache (`tilesCache`, `tileRowsRawCache`, etc.) so hot paths (UI refreshed every 10 ticks, yield calculations) don't re-read/re-serialize the whole map every call. Key invariants when touching this file or adding new persisted state:

- `setTiles`/`setTile` diff the new JSON against the cached raw string per row and skip the `world.setDynamicProperty` call if unchanged — avoid reintroducing unconditional writes.
- `stateVersion` is bumped only when something actually changed on disk; `main.js`'s city-yield cache and any future derived-data cache should invalidate off `getStateVersion()`, not off wall-clock time alone.
- Bedrock Script API cannot read/write Dynamic Properties on **offline** players — code that touches per-player state must tolerate/skip offline targets (see `civs.js` / `isCivControllable`).

### Tile data shape

A tile object (value in the `civ:tiles_row_*` maps) accumulates optional sub-objects as game systems act on it: `type`, `resource`, `ownerId`/`ownerName`, `foodYield`/`productionYield` (base), `city` (present only on the tile that *is* a city), `belongsToCityKey` (for non-city tiles assigned to a city), `facility`, `district`/`underDistrictConstruction`, `combatUnit`, `religiousUnit`. Combat units and religious units are independent layers on the same tile (`tile.combatUnit` vs `tile.religiousUnit`) and generally don't interact directly.

### Layered construction systems

Three distinct ways things get built, easy to conflate:

1. **Production queue** (`production.js`) — one item at a time per city, uses the city's own tile, costed in accumulated production points (`city.production = { id, progress, cost }`), carries over on cancel (`productionCarry`).
2. **Facilities** (`facilities.js`) — instant placement on any owned, empty tile; costs one worker *action point* (not a whole worker), not production points.
3. **Districts** (`districts.js`) — multi-turn build on a separate owned tile, funded by the owning city's production points via a second, parallel queue (`city.districtConstruction`), mutually exclusive with facilities on the same tile, and blocks new production-queue *buildings* (not units) in that city while in progress.

### Adjacency bonus engine

`adjacency.js` is a generic engine used by buildings, facilities, and districts alike: each bonus rule declares a `match` predicate over neighboring tiles (helpers: `matchesTerrain`, `matchesResource`, `matchesBuilding`, `matchesAnyCity`) and a `yieldPerMatch`. Adding a new adjacency bonus to any structure type is a data-only change — `getBuildingAdjacencyYields()` / `getFacilityAdjacencyYields()` feed automatically into `turns.js`'s `getCityCurrentYields`. Prefer extending via this system over hand-rolling per-structure neighbor-scanning code.

### UI/text conventions

Minecraft Bedrock's default font cannot render most Unicode emoji (they show as blank tofu boxes). **Never use emoji in player-visible strings** — chat messages (`reply`/`world.sendMessage`), action-bar text, or `ActionFormData`/`ModalFormData` titles/bodies/buttons. Use bracket tags instead, matching the existing convention (`[Worker]`, `[Food]`, `[Prod]`, `[Missile]`, `[Faith]`, `[Combat]`, `[District]`, ...) — `§`-prefixed Minecraft color codes are not emoji and are fine to use freely. Emoji in source comments (e.g. the `💡` note-marker convention) are developer-only and never reach the player, so they're unaffected by this rule.

### Performance conventions

Recent history in this repo (see git log) is dominated by perf work around Dynamic Property I/O and per-tick recomputation. When touching hot paths (the 10-tick HUD loop in `main.js`, per-turn city yield calculation in `turns.js`, tile lookups):

- Read state through `state.js`'s cached accessors rather than calling `world.getDynamicProperty` directly.
- Cache derived/computed results keyed on `getStateVersion()` (see `cityYieldCache` in `main.js`) instead of recomputing every tick, but keep the cache bound to a tick-count TTL as a safety net for out-of-band mutations.
- When indexing collections that are scanned repeatedly (e.g. civs by ID), build the index once and reuse it rather than `.find()`-ing on every access.

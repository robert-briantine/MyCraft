// Sauvegarde du monde sur le disque.
//
// Le relief est régénéré à l'identique depuis la graine (les minerais eux-mêmes
// sont tirés d'un hachage des coordonnées, jamais de Math.random()), donc le
// fichier ne contient que ce que le joueur a changé : les blocs dont il a écrit
// la valeur et l'endroit où il se tenait. Un monde entier tient ainsi en
// quelques kilo-octets et peut être réécrit toutes les deux secondes sans jamais
// peser sur la boucle de rendu.
//
// Deux hôtes partagent ce module : le navigateur passe par Express (server.js),
// la version bureau écrit dans son propre dossier de données via Rust.

export const SAVE_VERSION = 1;
export const AUTOSAVE_INTERVAL_MS = 2000;
export const DEFAULT_SLOT = 'default';

const SLOT_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;
export const MAX_NAME_LENGTH = 48;
// Un fichier corrompu ou tronqué ne doit pas pouvoir faire allouer une table
// démesurée au chargement.
const MAX_EDIT_CELLS = 2_000_000;
const MAX_COORD = 1e7;
// Le monde fait CHUNK_HEIGHT cubes, mais le joueur peut voler au-dessus et tomber
// sous le vide : la position acceptée au rechargement est plus large que le relief.
const MIN_Y = -64;
const MAX_Y = 4096;

function normalizeSlot(raw) {
  const slot = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return SLOT_PATTERN.test(slot) ? slot : DEFAULT_SLOT;
}

/**
 * Transforme un nom saisi par le joueur en nom de fichier sûr. Les lettres accentuées
 * sont conservées (un monde « Château du Lac » reste lisible dans le sélecteur) mais
 * ni séparateur, ni point, ni deux-points ne peut passer : le résultat ne peut donc
 * pas sortir du dossier des sauvegardes. Renvoie null si rien n'est exploitable.
 */
export function slugify(rawName) {
  if (typeof rawName !== 'string') return null;
  const slug = rawName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accents détachés -> base ASCII quand elle existe
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
  return SLOT_PATTERN.test(slug) ? slug : null;
}

/** Nom propre pour l'affichage ; null si rien de valide n'a été saisi. */
export function cleanWorldName(rawName) {
  if (typeof rawName !== 'string') return null;
  const name = rawName.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name.length >= 1 ? name : null;
}

/**
 * Serialise l'état persistant. `edits` est la Map "x,y,z" -> blockId du monde ;
 * les clés sont découpées une seule fois et écrites en tableau plat de quatruples,
 * format le plus compact et le plus rapide à relire.
 */
export function encodeSave({ seed, name, player, edits }) {
  const cells = [];
  for (const [key, id] of edits) {
    const first = key.indexOf(',');
    const second = key.indexOf(',', first + 1);
    if (second < 0) continue;
    cells.push(+key.slice(0, first), +key.slice(first + 1, second), +key.slice(second + 1), id);
  }
  return JSON.stringify({
    version: SAVE_VERSION,
    seed,
    // Nom d'affichage, distinct du slot qui doit rester un nom de fichier sûr.
    // Placé dans l'en-tête pour qu'un listage n'ait jamais à lire le diff.
    name: cleanWorldName(name),
    savedAt: Date.now(),
    // Redondant avec edits.length / 4, mais placé dans l'en-tête : lister les mondes
    // enregistrés lit les premières octets du fichier, jamais le diff entier.
    cells: cells.length / 4,
    player: {
      x: round3(player.x),
      y: round3(player.y),
      z: round3(player.z),
      yaw: round4(player.yaw),
      pitch: round4(player.pitch),
    },
    edits: cells,
  });
}

/**
 * Relit un contenu écrit sur le disque. Tout ce qui vient du disque est suspect :
 * structure, bornes et identifiants de bloc sont vérifiés, et un fichier illisible
 * rend simplement null (le jeu repart alors d'un monde neuf) au lieu de casser le
 * chargement.
 */
export function decodeSave(text, { isValidBlock, height = 64 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.version !== SAVE_VERSION) return null;

  const edits = new Map();
  const cells = Array.isArray(raw.edits) ? raw.edits : [];
  if (cells.length % 4 !== 0) return null;
  const limit = Math.min(cells.length, MAX_EDIT_CELLS * 4);
  for (let i = 0; i < limit; i += 4) {
    const x = cells[i], y = cells[i + 1], z = cells[i + 2], id = cells[i + 3];
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) || !Number.isInteger(id)) continue;
    if (Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) continue;
    if (y < MIN_Y || y >= Math.max(MIN_Y, height)) continue;
    if (isValidBlock && !isValidBlock(id)) continue;
    edits.set(`${x},${y},${z}`, id);
  }

  const p = raw.player && typeof raw.player === 'object' ? raw.player : {};
  const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const player = {
    x: finite(p.x, 8.5),
    y: finite(p.y, 40),
    z: finite(p.z, 8.5),
    yaw: finite(p.yaw, 0),
    pitch: finite(p.pitch, 0),
  };
  if (Math.abs(player.x) > MAX_COORD || Math.abs(player.z) > MAX_COORD) {
    player.x = 8.5; player.z = 8.5;
  }
  player.y = Math.min(MAX_Y, Math.max(MIN_Y, player.y));

  return {
    seed: Number.isFinite(raw.seed) ? raw.seed : null,
    name: typeof raw.name === 'string' ? raw.name.slice(0, MAX_NAME_LENGTH) : null,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    player,
    edits,
  };
}

/**
 * Remplace le nom d'affichage d'un document déjà sérialisé (le renommage d'un
 * monde passe par là, sans repasser par le jeu). Renvoie null si le texte n'est
 * pas un document de sauvegarde exploitable.
 */
export function setNameInSave(text, name) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  raw.name = cleanWorldName(name);
  return JSON.stringify(raw);
}

/**
 * Choisit le magasin selon l'hôte. `slot` isole plusieurs mondes (et permet aux
 * tests d'écrire leur propre fichier sans toucher à celui du joueur).
 */
export function createSaveStore({ slot = DEFAULT_SLOT, tauriCore = null } = {}) {
  const safeSlot = normalizeSlot(slot);

  if (tauriCore) {
    return {
      mode: 'desktop',
      slot: safeSlot,
      // `slot` explicite sert au renommage d'un monde qui n'est pas celui en jeu.
      async load(slot = safeSlot) {
        const target = normalizeSlot(slot);
        const text = await tauriCore.invoke('load_world', { slot: target });
        return typeof text === 'string' ? text : null;
      },
      // `slot` explicite permet le renommage : on écrit le même état sous un nouveau
      // nom de fichier, puis on efface l'ancien.
      async save(text, slot = safeSlot) {
        const target = normalizeSlot(slot);
        await tauriCore.invoke('save_world', { slot: target, payload: text });
        return text.length;
      },
      async clear(slot = safeSlot) {
        const target = normalizeSlot(slot);
        return tauriCore.invoke('clear_world', { slot: target });
      },
      async list() {
        const metas = await tauriCore.invoke('list_worlds');
        return Array.isArray(metas) ? metas : [];
      },
    };
  }

  const endpoint = `/world-save?slot=${encodeURIComponent(safeSlot)}`;
  return {
    mode: 'web',
    slot: safeSlot,
    async load(slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-save?slot=${encodeURIComponent(target)}`, { cache: 'no-store' });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
    // `slot` explicite permet le renommage : on écrit le même état sous un nouveau
    // nom de fichier, puis on efface l'ancien.
    async save(text, slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-save?slot=${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return text.length;
    },
    // Dernier recours pendant la fermeture de l'onglet : sendBeacon est le seul
    // envoi garanti survivant au démontage de la page.
    saveSoon(text) {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return false;
      return navigator.sendBeacon(endpoint, new Blob([text], { type: 'application/json' }));
    },
    async clear(slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-save?slot=${encodeURIComponent(target)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      return res.status !== 404;
    },
    async list() {
      const res = await fetch('/world-saves', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const metas = await res.json();
      return Array.isArray(metas) ? metas : [];
    },
  };
}

function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

function round4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

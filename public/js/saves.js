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

import { cadrerRequete, lireReponse, OPS, STATUTS } from './geom-cadre.js';

export const SAVE_VERSION = 1;
export const AUTOSAVE_INTERVAL_MS = 2000;
export const DEFAULT_SLOT = 'default';

const SLOT_PATTERN = /^[\p{L}\p{N}_-]{1,32}$/u;
export const MAX_NAME_LENGTH = 48;
// Un fichier corrompu ou tronqué ne doit pas pouvoir faire allouer une table
// démesurée au chargement.
const MAX_EDIT_CELLS = 2_000_000;
// L'eau qui coule n'écrit que autour de la brèche du joueur ; au-delà de quelques dizaines
// de milliers de cellules, le fichier n'est plus un diff mais une inondation écrite à la main.
const MAX_FLUX_CELLS = 200_000;
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
 *
 * `monde` est la fiche de génération (parts de forêt, de désert, rayon de l'île…).
 * Elle voyage avec le monde parce que le fichier ne porte que le diff du joueur : sans
 * elle, un monde créé avec une île de 900 cubes se régénérerait sur les constantes par
 * défaut et les blocs posés par le joueur se retrouveraient ailleurs.
 *
 * `flux` porte les distances de l'**eau de passage** (tableau plat de quatruples, comme
 * `edits`). Une cellule d'eau absente de cette table est une source pérenne — mer, rivière,
 * seau posé par le joueur — donc seule l'eau qui coule a quelque chose à écrire : un monde
 * où personne n'a percé la nappe ne porte pas du tout le champ.
 */
export function encodeSave({ seed, name, player, edits, monde = null, flux = null }) {
  const cells = [];
  for (const [key, id] of edits) {
    const first = key.indexOf(',');
    const second = key.indexOf(',', first + 1);
    if (second < 0) continue;
    cells.push(+key.slice(0, first), +key.slice(first + 1, second), +key.slice(second + 1), id);
  }
  let fluxCells = null;
  if (flux && typeof flux[Symbol.iterator] === 'function') {
    const plats = [];
    for (const [key, niv] of flux) {
      const first = key.indexOf(',');
      const second = key.indexOf(',', first + 1);
      if (second < 0) continue;
      plats.push(+key.slice(0, first), +key.slice(first + 1, second), +key.slice(second + 1), niv | 0);
    }
    if (plats.length > 0) fluxCells = plats;
  }
  return JSON.stringify({
    version: SAVE_VERSION,
    seed,
    monde: monde && typeof monde === 'object' ? monde : null,
    // Nom d'affichage, distinct du slot qui doit rester un nom de fichier sûr.
    // Placé dans l'en-tête pour qu'un listage n'ait jamais à lire le diff.
    name: cleanWorldName(name),
    savedAt: Date.now(),
    // Redondant avec edits.length / 4, mais placé dans l'en-tête : lister les mondes
    // enregistrés lit les premières octets du fichier, jamais le diff entier.
    cells: cells.length / 4,
    ...(fluxCells ? { fluxCells: fluxCells.length / 4 } : {}),
    player: {
      x: round3(player.x),
      y: round3(player.y),
      z: round3(player.z),
      yaw: round4(player.yaw),
      pitch: round4(player.pitch),
    },
    edits: cells,
    ...(fluxCells ? { flux: fluxCells } : {}),
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

  // Les distances de l'eau qui coule. Un fichier plus ancien n'en porte pas : la table
  // reste vide, ce qui est exactement le bon état — tout nage alors comme une source.
  // Une distance à zéro serait une source déguisée en filet, donc une eau promise à
  // sécher ; elle est écartée plutôt que corrigée, parce qu'un fichier qui en écrit une
  // n'est pas un fichier qu'on veut compléter à l'aveugle.
  const flux = new Map();
  const fluxCells = Array.isArray(raw.flux) ? raw.flux : [];
  if (fluxCells.length % 4 === 0) {
    const limiteFlux = Math.min(fluxCells.length, MAX_FLUX_CELLS * 4);
    for (let i = 0; i < limiteFlux; i += 4) {
      const x = fluxCells[i], y = fluxCells[i + 1], z = fluxCells[i + 2], niv = fluxCells[i + 3];
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) continue;
      if (!Number.isInteger(niv) || niv < 1 || niv > 255) continue;
      if (Math.abs(x) > MAX_COORD || Math.abs(z) > MAX_COORD) continue;
      if (y < 0 || y >= Math.max(MIN_Y, height)) continue;
      flux.set(`${x},${y},${z}`, niv);
    }
  }

  return {
    seed: Number.isFinite(raw.seed) ? raw.seed : null,
    // Renvoyé tel quel : la fiche appartient au jeu, qui la nettoie avec ses propres
    // bornes (`clampMonde`). Le magasin n'a rien à en savoir, et un fichier écrit par
    // une version plus ancienne du jeu n'en porte simplement pas.
    monde: raw.monde && typeof raw.monde === 'object' && !Array.isArray(raw.monde) ? raw.monde : null,
    name: typeof raw.name === 'string' ? raw.name.slice(0, MAX_NAME_LENGTH) : null,
    savedAt: Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    player,
    edits,
    flux,
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
 * Un envoi binaire se paie deux fois plus vite quand on le donne à Chromium sous forme de
 * Blob que d'un Uint8Array : mesuré le 2026-11-17, 57 ms contre 196 ms pour 15 Mo sur
 * localhost — le tampon typé passe par une copie de plus avant d'atteindre la socket.
 */
const corpsEnvoyable = (octets) => (octets instanceof Uint8Array ? new Blob([octets]) : octets);

/**
 * Choisit le magasin selon l'hôte. `slot` isole plusieurs mondes (et permet aux
 * tests d'écrire leur propre fichier sans toucher à celui du joueur).
 */
export function createSaveStore({ slot = DEFAULT_SLOT, tauriCore = null } = {}) {
  const safeSlot = normalizeSlot(slot);

  // Voie binaire du magasin de géométrie — voir le commentaire du bloc géométrie plus bas.
  async function geometrieBrute(op, target, { a = 0, b = 0, corps = null } = {}) {
    const reponse = await tauriCore.invoke('geom_brut', cadrerRequete({ op, slot: target, a, b, corps }));
    return lireReponse(reponse);
  }

  let binaireVerifie = null;
  async function sonderGeometrieBrute() {
    if (binaireVerifie !== null) return binaireVerifie;
    try {
      const r = await geometrieBrute(OPS.sonder, safeSlot);
      binaireVerifie = r.statut === STATUTS.ok && r.a === 1;
    } catch (e) {
      console.warn('Voie binaire indisponible pour la géométrie, repli base64 :', e.message);
      binaireVerifie = false;
    }
    return binaireVerifie;
  }

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
      // ---- cache d'île ----
      // Le binaire voyage en base64 : les commandes Tauri existantes échangent des
      // chaînes, et un aller-retour JSON sur 21 Mo d'entiers coûtait bien plus cher.
      async loadIsland(slot = safeSlot) {
        const target = normalizeSlot(slot);
        const texte = await tauriCore.invoke('load_island', { slot: target });
        if (typeof texte !== 'string' || texte.length === 0) return null;
        return base64VersOctets(texte);
      },
      async saveIsland(octets, slot = safeSlot) {
        const target = normalizeSlot(slot);
        const bytes = await tauriCore.invoke('save_island', { slot: target, payload: octetsVersBase64(octets) });
        return typeof bytes === 'number' ? bytes : octets.length;
      },
      async clearIsland(slot = safeSlot) {
        const target = normalizeSlot(slot);
        return tauriCore.invoke('clear_island', { slot: target });
      },
      async islandMeta(slot = safeSlot) {
        const target = normalizeSlot(slot);
        const meta = await tauriCore.invoke('island_meta', { slot: target });
        return meta && typeof meta === 'object' ? meta : null;
      },
      // ---- géométrie prête pour la carte -------------------------------------
      // Deux transports, départagés une seule fois par session :
      //  · **binaire** — une trame MCGF porte les paramètres *devant* les octets, et le
      //    payload est le tampon lui-même. C'est la seule façon d'obtenir un corps brut de
      //    Tauri (`process-ipc-message-fn.js` ne regarde que le payload) ; elle rend
      //    possible l'ajout partiel, donc de ne plus payer la taille du fichier à chaque lot.
      //  · **base64** — le filet d'origine, conservé parce que le repli `postMessage` de
      //    Tauri (et Android) ne sait pas envoyer de brut : le sondage tranche, pas une
      //    supposition sur la plateforme.
      // Le format est partagé avec Rust dans `public/js/geom-cadre.js`.
      async loadGeometry(slot = safeSlot) {
        const target = normalizeSlot(slot);
        if (await sonderGeometrieBrute()) {
          try {
            const r = await geometrieBrute(OPS.lire, target);
            return r.corps.length ? r.corps : null;   // `a === 0` : pas encore de cache
          } catch (e) {
            if (e.conflit) return null;
            throw e;
          }
        }
        const texte = await tauriCore.invoke('load_geometry', { slot: target });
        if (typeof texte !== 'string' || texte.length === 0) return null;
        return base64VersOctets(texte);
      },
      async saveGeometry(octets, slot = safeSlot) {
        const target = normalizeSlot(slot);
        if (await sonderGeometrieBrute()) {
          // La réécriture complète reste le filet du jeu (cache disparu, désaccord) : elle
          // doit au moins voyager en octets, sinon elle coûte 433 ms de fil principal à
          // 100 Mo — mesuré le 2026-11-17, c'était exactement la saccade du joueur.
          const r = await geometrieBrute(OPS.ecrire, target, { corps: octets });
          return r.a;
        }
        const bytes = await tauriCore.invoke('save_geometry', { slot: target, payload: octetsVersBase64(octets) });
        return typeof bytes === 'number' ? bytes : octets.length;
      },
      async clearGeometry(slot = safeSlot) {
        const target = normalizeSlot(slot);
        return tauriCore.invoke('clear_geometry', { slot: target });
      },
      // Ajouter au lieu de réécrire : la voie qui manque au bureau depuis le début. Un
      // désaccord sur l'état du disque se rend comme sur le web — `{ conflict }`, pas
      // d'exception — pour que le jeu reprenne sa voie complète sans interrompre la
      // publication. Sans le binaire, on retrouve le comportement d'avant : refus poli.
      async appendGeometry(octets, base, slot = safeSlot) {
        const target = normalizeSlot(slot);
        if (!(await sonderGeometrieBrute())) return { conflict: true, status: 0 };
        try {
          const r = await geometrieBrute(OPS.ajouter, target, { a: base, corps: octets });
          return { success: true, bytes: r.a };
        } catch (e) {
          if (e.conflit) return { conflict: true, status: e.motif || 'conflit' };
          throw e;
        }
      },
      async putGeometryHead(octets, slot = safeSlot, offset = 0) {
        const target = normalizeSlot(slot);
        if (!(await sonderGeometrieBrute())) return { conflict: true, status: 0 };
        try {
          await geometrieBrute(OPS.poserTete, target, { a: offset, corps: octets });
          return { success: true };
        } catch (e) {
          if (e.conflit) return { conflict: true, status: e.motif || 'conflit' };
          throw e;
        }
      },
      // Le magasin a ses octets sous la main : il copie le corps, le jeu n'envoie que sa
      // table. Impossible en base64 — il faudrait relire, encoder et renvoyer le fichier.
      async migrateGeometry(region, { attendu, debut }, slot = safeSlot) {
        const target = normalizeSlot(slot);
        if (!(await sonderGeometrieBrute())) return { conflict: true, status: 0 };
        try {
          const r = await geometrieBrute(OPS.migrer, target, { a: attendu, b: debut, corps: region });
          return { success: true, bytes: r.a };
        } catch (e) {
          if (e.conflit) return { conflict: true, status: e.motif || 'conflit' };
          throw e;
        }
      },
      async geometryMeta(slot = safeSlot) {
        const target = normalizeSlot(slot);
        const meta = await tauriCore.invoke('geometry_meta', { slot: target });
        return meta && typeof meta === 'object' ? meta : null;
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
    // ---- cache d'île -------------------------------------------------------
    // `onProgres` reçoit les octets déjà reçus et le total annoncé : la lecture de
    // vingt et un méga-octets se juge à l'œil, pas à une barre qui reste à zéro.
    async loadIsland(slot = safeSlot, onProgres = null) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-island?slot=${encodeURIComponent(target)}`, { cache: 'no-store' });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const annonce = Number(res.headers.get('Content-Length')) || 0;
      if (!res.body || typeof res.body.getReader !== 'function' || !onProgres) {
        const b = await res.arrayBuffer();
        if (onProgres) onProgres(b.byteLength, annonce || b.byteLength);
        return new Uint8Array(b);
      }
      const lecteur = res.body.getReader();
      const morceaux = [];
      let recus = 0;
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) break;
        morceaux.push(value);
        recus += value.length;
        onProgres(recus, annonce || recus);
      }
      const tous = new Uint8Array(recus);
      let o = 0;
      for (const m of morceaux) { tous.set(m, o); o += m.length; }
      return tous;
    },
    async saveIsland(octets, slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-island?slot=${encodeURIComponent(target)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: octets,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return octets.length;
    },
    async clearIsland(slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-island?slot=${encodeURIComponent(target)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      return res.status !== 404;
    },
    async islandMeta(slot = safeSlot) {
      const mondes = await this.list();
      const cible = mondes.find((m) => m.slot === normalizeSlot(slot));
      return cible && cible.ile ? cible.ile : null;
    },
    // ---- géométrie prête pour la carte ---------------------------------------
    // Pas de progression ici : contrairement à l'île (21 Mo d'un coup au démarrage), ce
    // fichier se lit tronçon par tronçon pendant que le joueur joue déjà.
    async loadGeometry(slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-geometry?slot=${encodeURIComponent(target)}`, { cache: 'no-store' });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async saveGeometry(octets, slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-geometry?slot=${encodeURIComponent(target)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: corpsEnvoyable(octets),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return octets.length;
    },
    // ---- publication par ajout (voir `EcrivainGeom.publierMorcele`) -------------------
    // Le fichier déjà sur le serveur n'est plus réécrit : on lui colle des blocs à la fin,
    // puis on repose l'en-tête — même longueur, donc écrit par-dessus l'ancien. Un 409/413
    // n'est pas une panne mais un désaccord sur l'état du disque : le jeu bascule alors sur
    // la réécriture complète, d'où le `{ conflict }` plutôt que l'exception.
    async appendGeometry(octets, base, slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-geometry/append?slot=${encodeURIComponent(target)}&base=${base}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: corpsEnvoyable(octets),
      });
      if (res.status === 409 || res.status === 413) return { conflict: true, status: res.status };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return { success: true, bytes: json.bytes };
    },
    async putGeometryHead(octets, slot = safeSlot, offset = 0) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-geometry/tete?slot=${encodeURIComponent(target)}&offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: corpsEnvoyable(octets),
      });
      if (res.status === 400 || res.status === 409) return { conflict: true, status: res.status };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { success: true };
    },
    // Rattraper un ancien gabarit d'en-tête sans renvoyer le corps : le serveur copie ses
    // propres octets, on ne lui envoie que la table. Un `PUT` de 618 Mo est impossible depuis
    // le navigateur (`ERR_BLOB_OUT_OF_MEMORY`, onglet écrasé avec la vue nue) — mesuré le
    // 2026-11-17 sur le cache du joueur.
    async migrateGeometry(region, { attendu, debut }, slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(
        `/world-geometry/migrer?slot=${encodeURIComponent(target)}&attendu=${attendu}&debut=${debut}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: corpsEnvoyable(region),
        });
      if (res.status === 400 || res.status === 409 || res.status === 413) return { conflict: true, status: res.status };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => ({}));
      return { success: true, bytes: json.bytes };
    },
    async clearGeometry(slot = safeSlot) {
      const target = normalizeSlot(slot);
      const res = await fetch(`/world-geometry?slot=${encodeURIComponent(target)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      return res.status !== 404;
    },
    async geometryMeta(slot = safeSlot) {
      const mondes = await this.list();
      const cible = mondes.find((m) => m.slot === normalizeSlot(slot));
      return cible && cible.geom ? cible.geom : null;
    },
  };
}

// Base64 sans dépendance ni boucle par caractère : `btoa`/`atob` existent dans le
// navigateur comme dans Node, mais sur des chaînes de 28 Mo il faut découper pour ne
// pas dépasser les limites d'application de `String.fromCharCode`.
const PAS_B64 = 0x8000;

function octetsVersBase64(octets) {
  if (!(octets instanceof Uint8Array)) throw new Error('attendu des octets');
  let texte = '';
  for (let i = 0; i < octets.length; i += PAS_B64) {
    texte += String.fromCharCode.apply(null, octets.subarray(i, i + PAS_B64));
  }
  return btoa(texte);
}

function base64VersOctets(texte) {
  const bin = atob(texte);
  const octets = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) octets[i] = bin.charCodeAt(i);
  return octets;
}

function round3(v) {
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0;
}

function round4(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0;
}

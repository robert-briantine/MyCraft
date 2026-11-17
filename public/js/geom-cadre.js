/**
 * Trames du magasin de géométrie côté bureau.
 *
 * Tauri ne sait envoyer des octets bruts que quand la charge utile d'`invoke` EST un
 * tampon typé : `process-ipc-message-fn.js` regarde le payload seul et, s'il est brut,
 * pose `Content-Type: application/octet-stream` ; sinon tout passe par `JSON.stringify`,
 * et un `Uint8Array` niché dans un objet devient `Array.from(...)` — soit ~4 fois plus
 * d'octets et une conversion sur le fil principal. Les petits paramètres (`slot`, `base`,
 * `offset`) ne peuvent donc pas voyager à côté du binaire : ils sont encadrés DEVANT lui.
 *
 * Le format est volontairement stupide (entiers little-endian, aucune dépendance) pour se
 * laisser relire côté Rust sans désérialiseur. Toute retouche ici doit être mirée dans
 * `src-tauri/src/world.rs` ; les deux côtés se jugent sur les mêmes vecteurs dorés
 * (`tests/geom-bureau.mjs` et les tests unitaires Rust).
 *
 * Requête                          Réponse
 * ───────                          ───────
 * 0..4   'MCGF'                    0..4   'MCGF'
 * 4      version = 1               4      version = 1
 * 5      opération                 5      opération reprise
 * 6..8   u16 longueur du slot      6      statut (0 ok · 1 conflit · 2 erreur)
 * 8..16  u64 champ A               7..8   réservé
 * 16..24 u64 champ B               8..16  u64 champ A (taille du fichier après l'opération)
 * 24..32 réservé                   16..24 u64 champ B (réservé)
 * 32..   slot en ASCII             24..   charge utile (lecture seule)
 * ...    charge utile
 */

export const CADRE_MAGIC = [0x4d, 0x43, 0x47, 0x46];   // 'MCGF'
export const CADRE_VERSION = 1;
export const TETE_REQUETE = 32;
export const TETE_REPONSE = 24;
export const MAX_SLOT_LEN = 32;                        // même garde que `validate_slot` côté Rust

export const OPS = {
  sonder: 0,     // la voie binaire est-elle réellement disponible ?
  lire: 1,       // lire tout le fichier
  ecrire: 2,     // réécriture complète (filet de sécurité, coûteux)
  ajouter: 3,    // coller des blocs à la fin si le fichier mesure exactement `a`
  poserTete: 4,  // reposer l'en-tête à `a` sans tronquer
  migrer: 5,     // recopier le corps chez le magasin, table fournie en corps
};

export const STATUTS = { ok: 0, conflit: 1, erreur: 2 };

/** Un désaccord sur l'état du disque n'est pas une panne : le jeu bascule alors sur l'autre voie. */
export class CadreErreur extends Error {
  constructor(message, { conflit = false, motif = '' } = {}) {
    super(message);
    this.nom = 'CadreErreur';
    this.conflit = conflit;
    this.motif = motif;
  }
}

function verifierSlot(slot) {
  if (typeof slot !== 'string' || slot.length === 0 || slot.length > MAX_SLOT_LEN) {
    throw new CadreErreur(`nom de monde invalide : ${JSON.stringify(slot)}`);
  }
  for (let i = 0; i < slot.length; i++) {
    const c = slot.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) throw new CadreErreur(`nom de monde non ASCII : ${JSON.stringify(slot)}`);
  }
  return slot;
}

/**
 * Emballe une requête. `corps` est copié après l'en-tête : l'appelant garde sa copie,
 * ce qui évite qu'un tampon réutilisé pendant l'aller-retour IPC n'écrive autre chose.
 */
export function cadrerRequete({ op, slot, a = 0, b = 0, corps = null }) {
  if (!Number.isInteger(op) || op < 0 || op > 255) throw new CadreErreur(`opération invalide : ${op}`);
  const nom = verifierSlot(slot);
  const octetsNom = new TextEncoder().encode(nom);
  if (octetsNom.length !== nom.length) throw new CadreErreur(`nom de monde non ASCII : ${JSON.stringify(slot)}`);
  for (const [nomChamp, v] of [['a', a], ['b', b]]) {
    if (!Number.isInteger(v) || v < 0) throw new CadreErreur(`champ ${nomChamp} invalide : ${v}`);
  }
  const queue = corps ? corps.length : 0;
  const tampon = new Uint8Array(TETE_REQUETE + octetsNom.length + queue);
  const vue = new DataView(tampon.buffer);
  for (let i = 0; i < 4; i++) tampon[i] = CADRE_MAGIC[i];
  tampon[4] = CADRE_VERSION;
  tampon[5] = op;
  vue.setUint16(6, octetsNom.length, true);
  vue.setBigUint64(8, BigInt(a), true);
  vue.setBigUint64(16, BigInt(b), true);
  tampon.set(octetsNom, TETE_REQUETE);
  if (corps) tampon.set(corps, TETE_REQUETE + octetsNom.length);
  return tampon;
}

/** Relit une réponse. Un en-tête qui ne ressemble à rien est une erreur, jamais un conflit. */
export function lireReponse(octets) {
  if (!(octets instanceof Uint8Array)) {
    // `invoke` rend un ArrayBuffer quand la réponse n'est ni JSON ni texte : on l'accepte.
    if (octets instanceof ArrayBuffer) octets = new Uint8Array(octets);
    else throw new CadreErreur(`réponse d'un type inattendu : ${Object.prototype.toString.call(octets)}`);
  }
  if (octets.length < TETE_REPONSE) throw new CadreErreur(`réponse trop courte (${octets.length} o)`);
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  for (let i = 0; i < 4; i++) {
    if (octets[i] !== CADRE_MAGIC[i]) throw new CadreErreur('réponse sans signature MCGF');
  }
  if (octets[4] !== CADRE_VERSION) throw new CadreErreur(`version de trame ${octets[4]} non reconnue`);
  const op = octets[5];
  const statut = octets[6];
  const a = Number(vue.getBigUint64(8, true));
  const b = Number(vue.getBigUint64(16, true));
  const corps = octets.subarray(TETE_REPONSE);
  if (statut === STATUTS.conflit) {
    throw new CadreErreur(`le disque dit autre chose (op ${op})`, { conflit: true });
  }
  if (statut !== STATUTS.ok) throw new CadreErreur(`mag refusé (op ${op}, statut ${statut})`);
  return { op, statut, a, b, corps };
}

/** Fabrique une réponse — sert au magasin Rust et aux faux noyaux des suites. */
export function cadrerReponse({ op, statut = STATUTS.ok, a = 0, b = 0, corps = null }) {
  const queue = corps ? corps.length : 0;
  const tampon = new Uint8Array(TETE_REPONSE + queue);
  const vue = new DataView(tampon.buffer);
  for (let i = 0; i < 4; i++) tampon[i] = CADRE_MAGIC[i];
  tampon[4] = CADRE_VERSION;
  tampon[5] = op;
  tampon[6] = statut;
  vue.setBigUint64(8, BigInt(a), true);
  vue.setBigUint64(16, BigInt(b), true);
  if (corps) tampon.set(corps, TETE_REPONSE);
  return tampon;
}

/** Décompose une requête — même usage : Rust d'un côté, faux noyaux de test de l'autre. */
export function lireRequete(octets) {
  if (octets instanceof ArrayBuffer) octets = new Uint8Array(octets);
  if (!(octets instanceof Uint8Array)) throw new CadreErreur('requête d’un type inattendu');
  if (octets.length < TETE_REQUETE) throw new CadreErreur(`requête trop courte (${octets.length} o)`);
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  for (let i = 0; i < 4; i++) {
    if (octets[i] !== CADRE_MAGIC[i]) throw new CadreErreur('requête sans signature MCGF');
  }
  if (octets[4] !== CADRE_VERSION) throw new CadreErreur(`version de trame ${octets[4]} non reconnue`);
  const longueurNom = vue.getUint16(6, true);
  if (longueurNom === 0 || longueurNom > MAX_SLOT_LEN) {
    throw new CadreErreur(`longueur de nom invraisemblable (${longueurNom})`);
  }
  if (octets.length < TETE_REQUETE + longueurNom) throw new CadreErreur('nom de monde tronqué');
  const slot = new TextDecoder('utf-8', { fatal: true }).decode(octets.subarray(TETE_REQUETE, TETE_REQUETE + longueurNom));
  return {
    op: octets[5],
    slot,
    a: Number(vue.getBigUint64(8, true)),
    b: Number(vue.getBigUint64(16, true)),
    corps: octets.subarray(TETE_REQUETE + longueurNom),
  };
}

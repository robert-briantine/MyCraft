// Géométrie des tronçons sur le disque, dans la forme même que réclame la carte graphique.
//
// Le maillage coûte cher et se répète : mesuré le 2026-11-16, `rebuildChunk` demande
// 6,94 ms par tronçon, alors que reposer les mêmes tampons dans une géométrie n'en coûte
// que 0,29 — vingt-quatre fois moins. La différence, c'est tout ce que le mailleur relit
// du terrain, recalcule de lumière et reconstruit de triangles pour un résultat qui ne
// change pas d'un bit tant que personne n'a touché au tronçon.
//
// Ce fichier écrit donc les tampons **tels qu'ils sont en mémoire** : six tableaux typés
// par mailleur, posés à des décalages alignés sur quatre octets, compressés tronçon par
// tronçon. Un bloc relu se décompresse et rend des vues directement utilisables — aucune
// recopie, aucune conversion, aucun tri — ce qui est exactement le « quasi prêt pour le
// transfert » visé : il ne reste que l'envoi lui-même à la carte.
//
// Comme pour l'île, tout ce qui vient du disque est suspect : signature, version, graine,
// fiche de génération, dimensions, version du mailleur et signature d'atlas sont vérifiés
// avant qu'un seul tableau ne soit posé sur la scène. Un cache qui ne correspond plus à
// rien n'est pas corrigé, il est jeté — le jeu sait tout reconstruire, seulement plus
// lentement.

export const GEOM_VERSION = 2;
const MAGIC = [0x4d, 0x43, 0x47, 0x31];               // 'MCG1'
const EN_TETE_FIXE = 9;                                // magic + version + uint32 taille de tête
const ALIGNEMENT = 4;                                  // vue float32 directement posable

/**
 * Une ligne de la table des décalages, majorée. Mesuré le 2026-11-17 sur le fichier plein
 * du joueur (23 024 lignes) : 92 octets en moyenne, 100 au pire. On garde 128 — la marge
 * couvre une empreinte qui s'allongerait — et l'en-tête est **réservé** à cette taille dès
 * la création du fichier : sa longueur ne change plus jamais, donc le corps ne bouge plus
 * jamais non plus. Publier devient alors une pure addition : quelques blocs collés à la fin
 * du fichier, et quelques lignes collées à la fin de la table.
 *
 * Sans ça, chaque publication renvoyait l'intégralité du fichier — mesuré le 2026-11-17 :
 * 1 496 ms d'envoi pour 15 Mo déjà en boîte, publié tous les douze tronçons. C'est ce qui
 * faisait « le rendu saccadé » du joueur.
 */
const LIGNE_MAJOREE = 128;
const CAPACITE_DEFAUT = 1024;                          // monde sans bornes connues : on grossira par doubles
const RESERVE_MIN = 1024;                              // un petit fichier doit déjà pouvoir grossir
const PLAFOND_RESERVE = 0.25;                          // garde-fou, voir `_dimensionnerTete`
const FERMETURE = ']}';                                // la table se termine toujours là, à poste fixe

export const CODEC_BRUT = 'brut';
export const CODEC_DEFLATE = 'deflate';
export const CODECS = [CODEC_DEFLATE, CODEC_BRUT];

// Les trois seaux du mailleur, dans l'ordre où le jeu les crée. Le numéro est gravé dans
// le fichier : changer l'ordre des seaux sans incrémenter MAILLE_VERSION peindrait du
// verre sur de la pierre.
export const MATS = ['opaque', 'trans', 'glow'];

// Un mailleur par seau, donc jamais plus de trois ; les plafonds laissent de la marge
// sans autoriser un fichier truqué à faire allouer des centaines de méga-octets.
const MAX_MAILLEURS = 4;
const MAX_SOMMETS = 200_000;
const MAX_INDICES = 300_000;

/**
 * Les cinq attributs, dans l'ordre écrit sur le disque, **quantifiés**. Mesuré le
 * 2026-11-16 sur les tampons réels du mailleur (574 452 sommets de champ rendu) : les
 * normales sont toutes axiales (574 452 sur 574 452 exactement sur un axe), les uv tiennent
 * dans [0,031 ; 0,969], la couleur dans [0 ; 1] et la lampe dans [0 ; 0,94]. Aucun canal
 * ne sature donc sous 8 bits, et la position se dit au 1/256 de cube depuis l'origine du
 * mailleur — biais bien en dessous du pixel. Le float32 coûtait 52 octets par sommet, ce
 * gabarit en coûte 17 : trois fois moins d'octets à compresser, à écrire et à relire.
 *
 * `normalise` dit au lecteur de poser la vue telle quelle sur un attribut GPU marqué
 * normalisé : l'entier devient la fraction attendue sans passer par le CPU. Seule la
 * position se paie une déquantification (quelques microsecondes, contre 6,94 ms au mailleur).
 */
const ATTRIBUTS = [
  { nom: 'position', type: Uint16Array, composantes: 3, code: 'grille' },
  { nom: 'normal', type: Int8Array, composantes: 3, code: 'norme', normalise: true },
  { nom: 'uv', type: Uint16Array, composantes: 2, code: 'unitaire', normalise: true },
  { nom: 'color', type: Uint8Array, composantes: 3, code: 'unitaire', normalise: true },
  { nom: 'aLampe', type: Uint8Array, composantes: 1, code: 'unitaire', normalise: true },
];
// mat(1) + bourrage(3) + sommets(4) + indices(4) + origine du mailleur (3 × float32)
const TETE_MAILLEUR = 24;
export const PAS_POSITION = 256;                       // graduations par cube : 1/256 de cube

/**
 * Décalages des attributs dans le corps d'un mailleur de `n` sommets, et taille totale du
 * corps. Chaque bloc est calé sur quatre octets : les normales pèsent trois octets par
 * sommet, donc sans ce calage les uv — des uint16 — tomberaient sur un offset impair et
 * la vue serait impossible (`RangeError`, vérifié à la relecture). L'écrivain et le
 * lecteur partagent cette seule fonction : ils ne peuvent plus se décaler l'un de l'autre.
 */
function planCorps(n) {
  const decalages = [];
  let corps = 0;
  for (const a of ATTRIBUTS) {
    corps = aligner(corps);
    decalages.push(corps);
    corps += n * a.composantes * a.type.BYTES_PER_ELEMENT;
  }
  return { decalages, corps: aligner(corps) };
}

// ---------------------------------------------------------------- compression ---------

const deflateDispo = typeof CompressionStream === 'function';
const inflateDispo = typeof DecompressionStream === 'function';

/** Lit un flux jusqu'au bout en un seul tampon. */
async function pomper(readable) {
  const lecteur = readable.getReader();
  const morceaux = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await lecteur.read();
      if (done) break;
      morceaux.push(value);
      total += value.byteLength;
    }
  } catch (e) {
    // Un lecteur qu'on abandonne retient son transformateur : on rend ce qui est dû.
    try { await lecteur.cancel(); } catch (e2) { /* déjà fermé */ }
    throw e;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const m of morceaux) { out.set(m, o); o += m.byteLength; }
  return out;
}

/** Au-delà de ce délai, un transformateur qui n'a rien rendu est tenu pour pendu. */
export const GARDE_TRANSCODAGE_MS = 8000;

class TranscodageSuspendu extends Error {
  constructor(nom) { super(`transcodage suspendu (${nom})`); this.nom = nom; this.suspendu = true; }
}

const sommeil = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fait traverser un bloc à un transformateur de compression. Écriture et lecture partent
 * **en parallèle** : attendre la fin de l'écriture avant de commencer à lire se bloque sur
 * la pression inverse dès que le bloc dépasse le tampon interne (mesuré le 2026-11-16 :
 * 479 Ko suspendus sans fin dans Chromium, alors que Node absorbait la même taille sans
 * broncher — d'où un test Node vert sur un chemin pourtant mort dans le jeu).
 *
 * Le parallélisme ne suffit pas à rendre le chemin sûr : le transformateur rend sa copie
 * par tâches postées sur le fil principal, donc un appelant qui monopolise ce fil — mesuré
 * le 2026-11-16 avec une sonde enchaînant vingt-quatre tranches de mailleur de 300 ms sans
 * jamais rendre la main — voit le flux se taire indéfiniment, et `publierGeometrie`, qui
 * attend ce mot, fige toute la file (`enCours` vrai pour toujours, 81 tronçons publiés puis
 * plus rien). La garde borne ce silence : l'appelant décide, il ne peut plus être otage.
 */
async function transcoder(Createur, octets) {
  const nom = Createur === CompressionStream ? 'déflate' : 'inflate';
  const uneFois = async () => {
    const flux = new Createur('deflate-raw');
    const ecrivain = flux.writable.getWriter();
    const ecriture = ecrivain.write(octets).then(() => ecrivain.close()).catch(() => {});
    const lu = await pomper(flux.readable);
    await ecriture;
    return lu;
  };
  const garde = (promesse) => Promise.race([
    promesse,
    sommeil(GARDE_TRANSCODAGE_MS).then(() => { throw new TranscodageSuspendu(nom); }),
  ]);
  try {
    return await garde(uneFois());
  } catch (e) {
    if (!e || !e.suspendu) throw e;
    return garde(uneFois());                      // un second essai : le pendu est rare
  }
}

async function compresser(octets) {
  if (!deflateDispo) return octets;
  return transcoder(CompressionStream, octets);
}

async function decompesser(octets, longueurAttendue) {
  if (!inflateDispo) return null;
  try {
    const obtenu = await transcoder(DecompressionStream, octets);
    return obtenu.byteLength === longueurAttendue ? obtenu : null;
  } catch (e) {
    return null;                                        // corps truqué : trou, pas exception
  }
}

// ------------------------------------------------------------------ utilitaires -------

/** Empreinte FNV-1a en hexadécimal : sert à vérifier qu'un bloc décrit bien l'état actuel. */
export function hachage(texte) {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Même empreinte sur des octets bruts (les pixels d'un atlas, par exemple). */
export function hachageOctets(octets) {
  let h = 0x811c9dc5;
  for (let i = 0; i < octets.length; i++) {
    h ^= octets[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Clé d'empreinte de la fiche : insensible à l'ordre des réglages, sensible aux valeurs. */
export function cleFiche(monde) {
  if (!monde || typeof monde !== 'object') return 'default';
  return hachage(Object.keys(monde).sort().map((k) => `${k}=${JSON.stringify(monde[k])}`).join('&'));
}

const aligner = (n) => (n + ALIGNEMENT - 1) & ~(ALIGNEMENT - 1);
const cle = (cx, cz) => `${cx},${cz}`;

// ------------------------------------------------------------- sérialisation ----------

/**
 * Écrit les mailleurs d'un tronçon dans un tampon, aligné pour que la lecture rende des
 * vues sur les mêmes octets. Les canaux sont quantifiés (voir `ATTRIBUTS`) : le fichier
 * porte ce que la carte graphique sait lire directement, pas le confort intermédiaire du
 * CPU. L'origine du mailleur voyage dans son en-tête, d'où une position rendue au 1/256
 * de cube près sans bord ni échelle à deviner.
 */
export function serialiserMaillages(maillages) {
  if (!Array.isArray(maillages) || maillages.length === 0 || maillages.length > MAX_MAILLEURS) {
    throw new Error(`attendu entre 1 et ${MAX_MAILLEURS} mailleurs`);
  }
  let taille = 0;
  const plans = [];
  for (const m of maillages) {
    const n = m.position ? m.position.length / 3 : 0;
    const ni = m.index ? m.index.length : 0;
    if (n < 3 || ni < 3 || n > MAX_SOMMETS || ni > MAX_INDICES) {
      throw new Error(`mailleur invalide : ${n} sommets, ${ni} indices`);
    }
    const tete = TETE_MAILLEUR;
    const { decalages, corps: corpsAttributs } = planCorps(n);
    const offIdx = aligner(corpsAttributs);             // bourrage avant les uint16
    const corps = offIdx + ni * 2;
    const bloc = aligner(tete + corps);
    plans.push({ m, n, ni, tete, decalages, offIdx, bloc });
    taille += bloc;
  }
  const sortie = new Uint8Array(taille);
  const dv = new DataView(sortie.buffer);
  let o = 0;
  for (const p of plans) {
    const idxMat = MATS.indexOf(p.m.mat ?? '');
    if (idxMat < 0) throw new Error(`seau inconnu : ${p.m.mat}`);
    dv.setUint8(o, idxMat);
    dv.setUint32(o + 4, p.n, true);
    dv.setUint32(o + 8, p.ni, true);
    // Origine = borne basse réelle du mailleur : deux sommets égaux à l'entrée gardent la
    // même valeur à la sortie, donc les faces d'un même tronçon restent parfaitement cousues.
    const pos = p.m.position;
    const origine = [Infinity, Infinity, Infinity];
    for (let i = 0; i < pos.length; i += 3) {
      for (let k = 0; k < 3; k++) if (pos[i + k] < origine[k]) origine[k] = pos[i + k];
    }
    for (let k = 0; k < 3; k++) {
      if (!Number.isFinite(origine[k])) throw new Error('position non bornée');
      dv.setFloat32(o + 12 + k * 4, origine[k], true);
    }
    for (let k = 0; k < ATTRIBUTS.length; k++) {
      const a = ATTRIBUTS[k];
      const src = p.m[a.nom];
      if (!src || src.length !== p.n * a.composantes) {
        throw new Error(`attribut ${a.nom} : attendu ${p.n * a.composantes}, eu ${src ? src.length : 0}`);
      }
      // Le mailleur produit du float32 ; rien d'autre ne se quantifie. Un tampon d'un
      // autre type est une erreur de l'appelant, pas une variante à deviner.
      if (!(src instanceof Float32Array)) throw new Error(`attribut ${a.nom} : attendu du float32`);
      const cible = new a.type(p.n * a.composantes);
      if (a.code === 'grille') {
        const etendue = (65535 + 1) / PAS_POSITION;
        for (let i = 0; i < src.length; i++) {
          const k = i % 3;
          const v = Math.round((src[i] - origine[k]) * PAS_POSITION);
          if (v < 0 || v > 65535) {
            throw new Error(`position hors mailleur (${v}) : étendue attendue sous ${etendue} cubes`);
          }
          cible[i] = v;
        }
      } else if (a.code === 'norme') {
        for (let i = 0; i < src.length; i++) {
          const v = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
          cible[i] = Math.round(v * 127);
        }
      } else {
        const plein = a.type === Uint16Array ? 65535 : 255;
        for (let i = 0; i < src.length; i++) {
          const v = src[i] < 0 ? 0 : src[i] > 1 ? 1 : src[i];
          cible[i] = Math.round(v * plein);
        }
      }
      sortie.set(new Uint8Array(cible.buffer, cible.byteOffset, cible.byteLength), o + p.tete + p.decalages[k]);
    }
    sortie.set(new Uint8Array(p.m.index.buffer, p.m.index.byteOffset, p.m.index.byteLength),
      o + p.tete + p.offIdx);
    o += p.bloc;
  }
  return sortie;
}

/**
 * Relit des mailleurs depuis un tampon. Les tableaux rendus sont des **vues** sur ce
 * tampon : c'est tout l'intérêt du format, poser ces vues sur des attributs GPU ne coûte
 * qu'une copie vers la carte, pas une seconde copie côté CPU. Les canaux marqués
 * `normalise` se posent tels quels — l'entier devient la fraction dans le pipeline. La
 * position demande une déquantification (`dequantifierPositions`), quelques microsecondes.
 */
export function deserialiserMaillages(tampon, offset = 0, longueur = tampon.byteLength - offset) {
  if (!tampon || longueur < TETE_MAILLEUR) return null;
  const base = tampon.byteOffset + offset;
  if (base % ALIGNEMENT !== 0) return null;             // vue float32 impossible : fichier douteux
  const dv = new DataView(tampon.buffer, base, longueur);
  const maillages = [];
  let o = 0;
  while (o + TETE_MAILLEUR <= longueur) {
    const idxMat = dv.getUint8(o);
    const n = dv.getUint32(o + 4, true);
    const ni = dv.getUint32(o + 8, true);
    if (idxMat >= MATS.length || n < 3 || ni < 3 || n > MAX_SOMMETS || ni > MAX_INDICES) return null;
    const origine = [dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true), dv.getFloat32(o + 20, true)];
    if (!origine.every(Number.isFinite)) return null;   // en-tête sal : mieux vaut repeindre
    const { decalages, corps: corpsAttributs } = planCorps(n);
    const attributs = [];
    for (let k = 0; k < ATTRIBUTS.length; k++) {
      const a = ATTRIBUTS[k];
      const octets = n * a.composantes * a.type.BYTES_PER_ELEMENT;
      if (o + TETE_MAILLEUR + decalages[k] + octets > longueur) return null;
      const vue = new a.type(tampon.buffer, base + o + TETE_MAILLEUR + decalages[k], n * a.composantes);
      attributs.push({ nom: a.nom, tableau: vue, itemSize: a.composantes, normalise: !!a.normalise });
    }
    const offIdx = aligner(corpsAttributs);
    const octetsIdx = ni * 2;
    if (o + TETE_MAILLEUR + offIdx + octetsIdx > longueur) return null;
    const index = new Uint16Array(tampon.buffer, base + o + TETE_MAILLEUR + offIdx, ni);
    maillages.push({ mat: MATS[idxMat], attributs, index, origine });
    o += TETE_MAILLEUR + aligner(offIdx + octetsIdx);
  }
  return o === longueur && maillages.length > 0 ? maillages : null;
}

/**
 * Remet les positions entières en float32. Le seul canal qui ne se pose pas tel quel, et
 * encore à bon compte : mesuré sur un mailleur de champ, cette boucle se compte en
 * microsecondes quand le mailleur en coûte 6 940.
 */
export function dequantifierPositions(vue, origine) {
  const sortie = new Float32Array(vue.length);
  for (let i = 0; i < vue.length; i += 3) {
    sortie[i] = origine[0] + vue[i] / PAS_POSITION;
    sortie[i + 1] = origine[1] + vue[i + 1] / PAS_POSITION;
    sortie[i + 2] = origine[2] + vue[i + 2] / PAS_POSITION;
  }
  return sortie;
}

// ------------------------------------------------------------------ en-tête -----------

/**
 * Vérifie l'en-tête d'un fichier lu sur le disque. `attendu` porte {chunkSize, height,
 * seed, monde, mailleVersion, atlasSignature} : tout ce qui doit correspondre pour que
 * des triangles écrits hier soient encore ceux d'aujourd'hui.
 */
export function lireEnTete(octets, attendu = {}) {
  if (!octets || octets.length < EN_TETE_FIXE) return { ok: false, motif: 'fichier vide ou tronqué' };
  for (let i = 0; i < 4; i++) {
    if (octets[i] !== MAGIC[i]) return { ok: false, motif: 'signature absente' };
  }
  if (octets[4] !== GEOM_VERSION) return { ok: false, motif: `version ${octets[4]} inconnue` };
  const dv = new DataView(octets.buffer, octets.byteOffset, octets.length);
  const tailleTete = dv.getUint32(5, true);
  if (tailleTete < 16 || EN_TETE_FIXE + tailleTete > octets.length) {
    return { ok: false, motif: 'en-tête tronqué' };
  }
  let tete;
  try {
    tete = JSON.parse(new TextDecoder().decode(octets.subarray(EN_TETE_FIXE, EN_TETE_FIXE + tailleTete)));
  } catch (e) {
    return { ok: false, motif: 'en-tête illisible' };
  }
  if (!tete || typeof tete !== 'object' || !Array.isArray(tete.entrees)) return { ok: false, motif: 'en-tête sans entrées' };
  if (tete.chunkSize !== attendu.chunkSize || tete.height !== attendu.height) {
    return { ok: false, motif: `tronçons différents (${tete.chunkSize}×${tete.height})` };
  }
  if (attendu.seed != null && JSON.stringify(tete.seed) !== JSON.stringify(attendu.seed)) {
    return { ok: false, motif: 'graine différente' };
  }
  if (attendu.monde != null && tete.fiche !== cleFiche(attendu.monde)) return { ok: false, motif: 'fiche de génération différente' };
  if (attendu.mailleVersion != null && tete.mailleVersion !== attendu.mailleVersion) {
    return { ok: false, motif: `mailleur v${attendu.mailleVersion} ≠ v${tete.mailleVersion}` };
  }
  if (attendu.atlasSignature != null && tete.atlasSignature !== attendu.atlasSignature) {
    return { ok: false, motif: 'atlas différent' };
  }
  // Les décalages doivent décrire un corps qui existe vraiment dans le fichier : c'est la
  // seule défense contre un fichier tronqué ou dont la table aurait été salie. Deux blocs
  // ne peuvent pas se marcher dessus, mais aucun ordre n'est exigé entre eux : la
  // publication par ajout écrit les blocs neufs à la fin du fichier, quand bien même leur
  // clé trierait avant ceux d'hier.
  if ((EN_TETE_FIXE + tailleTete) % ALIGNEMENT !== 0) return { ok: false, motif: 'corps mal aligné' };
  const bornes = [];
  for (const e of tete.entrees) {
    if (!Number.isInteger(e.o) || !Number.isInteger(e.l) || !Number.isInteger(e.n)) return { ok: false, motif: 'entrée mal formée' };
    if (e.l < 0 || e.o < EN_TETE_FIXE + tailleTete || e.o + e.l > octets.length) return { ok: false, motif: 'bloc hors fichier' };
    bornes.push([e.o, e.o + e.l]);
  }
  bornes.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < bornes.length; i++) {
    if (bornes[i][0] < bornes[i - 1][1]) return { ok: false, motif: 'blocs qui se chevauchent' };
  }
  return { ok: true, tete, tailleTete, debutCorps: EN_TETE_FIXE + tailleTete };
}

// ------------------------------------------------------------------ écrivain ----------

/**
 * Construit le fichier. `existant` reprend un fichier déjà sur le disque : ses blocs sont
 * conservés tels quels (ils ont déjà été compressés) et seuls les nouveaux sont écrits,
 * ce qui permet de publier petit après petit sans jamais remailler ce qui est en boîte.
 */
export class EcrivainGeom {
  constructor({ chunkSize, height, seed, monde = null, mailleVersion = 1, atlasSignature = null,
    codec = CODEC_DEFLATE, maxOctets = Infinity, existant = null, attendu = null,
    capaciteEntrees = CAPACITE_DEFAUT } = {}) {
    if (!Number.isInteger(chunkSize) || !Number.isInteger(height)) throw new Error('géométrie de tronçon manquante');
    this.chunkSize = chunkSize;
    this.height = height;
    this.seed = seed;
    this.fiche = cleFiche(monde);
    this.mailleVersion = mailleVersion;
    this.atlasSignature = atlasSignature;
    this.codec = CODECS.includes(codec) && (codec === CODEC_BRUT || deflateDispo) ? codec : CODEC_BRUT;
    this.maxOctets = maxOctets;
    this.cree = Date.now();
    /** @type {Map<string, {c:number[],o:number,l:number,n:number,s:number,v:number,e:string|null,brut:Uint8Array|null}>} */
    this.entrees = new Map();
    // Le budget se compte sur ce que le disque va porter, donc sur les blocs compressés ;
    // le brut ne sert qu'à borner la mémoire le temps d'une écriture.
    this.octetsCompresse = 0;
    /** Clefs dont les octets n'ont pas encore atteint le serveur (`publierMorcele` les réclame). */
    this.nouveaux = new Set();
    /** La table déjà gravée sur le serveur, sans bourrage ni pied — on ne la renvoie jamais. */
    this.tableTexte = this._prefixe();
    /** Longueur en octets de `tableTexte` : jugée une fois, tenue à jour à chaque lot. */
    this.tableOctets = new TextEncoder().encode(this.tableTexte).byteLength;
    /** Combien de lignes la table gravée porte déjà : décide de la virgule qui les sépare. */
    this.lignes = 0;
    this.capacite = Math.max(16, Math.floor(capaciteEntrees) || CAPACITE_DEFAUT);
    this.tailleTeteFixe = this._dimensionnerTete();
    /** Taille physique du fichier tel qu'on le croit sur le serveur, ou null s'il n'existe pas. */
    this.base = null;
    /** Où commençait le corps dans le fichier trouvé chez le serveur (null si fichier neuf). */
    this.debutOriginal = null;
    /** Le fichier en boîte a-t-il l'en-tête réservé qui permet d'ajouter sans rien déplacer ? */
    this.appendable = false;
    if (existant) {
      const att = attendu || { chunkSize, height, seed, monde, mailleVersion, atlasSignature };
      const r = lireEnTete(existant, att);
      if (!r.ok) throw new Error(`cache existant refusé : ${r.motif}`);
      for (const e of r.tete.entrees) {
        this.entrees.set(cle(e.c[0], e.c[1]), {
          ...e,
          // Vue sur le tampon lu, pas copie : ce même tampon est déjà tenu par `CacheGeom`
          // pour décompresser à la demande. Mesuré le 2026-11-17 sur le cache plein du
          // joueur : 588 Mo doublés en RAM par cette seule copie, et l'onglet tombait au
          // premier envoi.
          brut: existant.subarray(e.o, e.o + e.l),
        });
        this.octetsCompresse += e.l;
      }
      this.base = existant.length;
      this.debutOriginal = EN_TETE_FIXE + r.tailleTete;
      // On ne peut ajouter à la table que si l'on sait reproduire exactement ce que le
      // serveur en a reçu : d'où la relecture du texte écrit plutôt que sa reconstruction.
      const ecrite = EcrivainGeom._tableEcrite(existant, r);
      if (r.tailleTete === this.tailleTeteFixe && ecrite !== null) {
        this._poserTable(ecrite);
        this.lignes = this.entrees.size;
        this.appendable = true;
      }
    }
  }

  /**
   * Longueur fixe de l'en-tête JSON (bourrage compris). Elle est bornée par le budget
   * disque — réserver plus d'un quart du budget pour des tables de décalages n'aurait
   * aucun sens sur un petit cache — et ne descend jamais sous `RESERVE_MIN`, pour qu'un
   * fichier neuf puisse grossir sans être réécrit immédiatement.
   */
  _dimensionnerTete() {
    const socle = 320;                                  // chunkSize, height, seed, fiche, codec…
    const vise = LIGNE_MAJOREE * Math.max(16, this.capacite) + socle;
    const plafond = Number.isFinite(this.maxOctets)
      ? Math.max(RESERVE_MIN, Math.floor(this.maxOctets * PLAFOND_RESERVE))
      : Infinity;
    let t = Math.min(Math.max(vise, RESERVE_MIN), Math.max(RESERVE_MIN, plafond));
    t = Math.max(t, socle + LIGNE_MAJOREE * 16);        // toujours la place de seize lignes
    while ((EN_TETE_FIXE + t) % ALIGNEMENT !== 0) t++;
    return t;
  }

  aLeTroncon(cx, cz) { return this.entrees.has(cle(cx, cz)); }

  /**
   * Ajoute (ou remplace) le tronçon. Les tampons fournis ne sont pas conservés : ils sont
   * copiés dans le bloc compressé immédiatement, ce qui rend l'appelant libre de jeter sa
   * géométrie juste après.
   */
  async ajouter(cx, cz, maillages, empreinte = null) {
    return this.ajouterSerialise(cx, cz, serialiserMaillages(maillages), empreinte);
  }

  /**
   * Comme `ajouter`, mais le bloc est déjà sérialisé : le jeu met ses tronçons en file
   * pendant l'image (une copie) et ne paie la compression qu'à la publication.
   */
  async ajouterSerialise(cx, cz, brut, empreinte = null) {
    if (!(brut instanceof Uint8Array)) throw new Error('attendu des octets sérialisés');
    const corps = this.codec === CODEC_DEFLATE ? await compresser(brut) : brut;
    const clef = cle(cx, cz);
    const dejaPris = this.entrees.get(clef);
    // Le budget porte aussi l'en-tête réservé : c'est bien lui que le serveur va stocker.
    // `octetsCompresse`, lui, reste la somme des blocs — c'est ce que le jeu affiche.
    const blocks = this.octetsCompresse - (dejaPris ? dejaPris.l : 0) + corps.byteLength;
    if (EN_TETE_FIXE + this.tailleTeteFixe + blocks > this.maxOctets) {
      throw new Error(`budget disque atteint (${this.maxOctets} octets pour ${EN_TETE_FIXE + this.tailleTeteFixe + blocks})`);
    }
    let sommets = 0;
    let mailleurs = 0;
    let o = 0;
    const dv = new DataView(brut.buffer, brut.byteOffset, brut.byteLength);
    while (o + TETE_MAILLEUR <= brut.byteLength) {
      const n = dv.getUint32(o + 4, true);
      const ni = dv.getUint32(o + 8, true);
      sommets += n;
      mailleurs++;
      const offIdx = planCorps(n).corps;                // mêmes calages qu'à l'écriture
      o += TETE_MAILLEUR + aligner(offIdx + ni * 2);
    }
    this.entrees.set(clef, {
      c: [cx, cz], o: 0, l: corps.byteLength, n: brut.byteLength,
      s: mailleurs, v: sommets, e: empreinte, brut: corps,
    });
    this.octetsCompresse = blocks;
    this.nouveaux.add(clef);
    return brut.byteLength;
  }

  /** Retire un tronçon du fichier (quand le joueur édite : son bloc devient faux). */
  retirer(cx, cz) {
    const e = this.entrees.get(cle(cx, cz));
    if (!e) return false;
    this.octetsCompresse -= e.l;
    this.nouveaux.delete(cle(cx, cz));
    return this.entrees.delete(cle(cx, cz));
  }

  get taille() { return this.entrees.size; }

  /** Les entrées dans l'ordre gravé ; les décalages y sont lus tels qu'ils sont posés. */
  _lignes() {
    return [...this.entrees.values()]
      .map((e) => ({ c: e.c, o: e.o, l: e.l, n: e.n, s: e.s, v: e.v, e: e.e, brut: e.brut }))
      .sort((a, b) => (a.c[1] - b.c[1]) || (a.c[0] - b.c[0]));
  }

  /**
   * Le début de l'en-tête, immuable pour la vie de l'écrivain : tout ce qui précède le
   * `[` de la table. Il ne change jamais, donc ce que le serveur en a reçu reste valable
   * et on n'en renvoie jamais un octet.
   */
  _prefixe() {
    const { chunkSize, height, seed, fiche, mailleVersion, atlasSignature, codec, cree } = this;
    return `${JSON.stringify({ chunkSize, height, seed, fiche, mailleVersion, atlasSignature, codec, cree }).slice(0, -1)},"entrees":[`;
  }

  /** La ligne d'une entrée dans la table. */
  static _ligne(e) {
    return JSON.stringify({ c: e.c, o: e.o, l: e.l, n: e.n, s: e.s, v: e.v, e: e.e });
  }

  /**
   * La région d'en-tête complète : la table, du bourrage, puis `]}` **à poste fixe**. C'est
   * ce pied fixe qui permet d'écrire de nouvelles lignes en les collant à la suite des
   * anciennes, sans jamais rien déplacer sur le serveur. Renvoie null quand la table déborde
   * de la place réservée — l'appelant agrandit alors (`publier`) ou reprend la voie longue.
   */
  _region(tableTexte, encodeur) {
    const table = encodeur.encode(tableTexte);           // une seule passe, pas trois
    const manque = this.tailleTeteFixe - table.byteLength - FERMETURE.length;
    if (manque < 0) return null;
    const out = new Uint8Array(this.tailleTeteFixe);
    out.set(table, 0);
    out.fill(0x20, table.byteLength, table.byteLength + manque);
    out.set(encodeur.encode(FERMETURE), table.byteLength + manque);
    return out;
  }

  /**
   * Pose la table et mémorise sa longueur en octets. La voie d'ajout juge ensuite si elle
   * tient dans la place réservée à partir de ce nombre : sans lui, elle devrait réencoder
   * les 4,35 Mo de table à chaque lot — mesuré le 2026-11-17 comme l'essentiel de l'image
   * à 584 ms qui saccadait le rendu du joueur.
   */
  _poserTable(texte) {
    this.tableTexte = texte;
    this.tableOctets = new TextEncoder().encode(texte).byteLength;
    return texte;
  }

  /** Ce que la région d'un fichier déjà écrit annonce comme table, sans bourrage ni pied. */
  static _tableEcrite(octets, r) {
    const texte = new TextDecoder().decode(octets.subarray(EN_TETE_FIXE, r.debutCorps));
    const ferme = texte.lastIndexOf(FERMETURE);
    if (ferme < 0) return null;
    const corps = texte.slice(0, ferme).replace(/ +$/, '');
    return corps.startsWith('{') && corps.includes('"entrees":[') ? corps : null;
  }

  /** Un bloc publié dont la mémoire s'est défaite (le fichier du serveur le porte). */
  get aCorpsManquants() {
    for (const e of this.entrees.values()) if (!e.brut) return true;
    return false;
  }

  /**
   * Le fichier entier, d'un seul tenant. Voie coûteuse — elle paie la taille du fichier à
   * chaque fois — donc réservée à la création, au changement de gabarit d'en-tête et aux
   * reprises interrompues. Le chemin courant est `publierMorcele`.
   */
  async publier() {
    const encodeur = new TextEncoder();
    for (;;) {
      if (this.aCorpsManquants) {
        throw new Error('des blocs publiés ne sont plus en mémoire : recharger le fichier avant de tout réécrire');
      }
      const debut = EN_TETE_FIXE + this.tailleTeteFixe;
      const lignes = this._lignes();
      let o = debut;
      for (const x of lignes) { x.o = o; o += aligner(x.l); }
      const table = `${this._prefixe()}${lignes.map((x) => EcrivainGeom._ligne(x)).join(',')}`;
      const teteOctets = this._region(table, encodeur);
      if (teteOctets === null) {
        // La table ne tient plus dans la place réservée : on la double. Le corps sera
        // décalé d'autant, ce qui est le prix d'une table plus grande qu'annoncée — mais
        // avec une capacité annoncée par le jeu (nombre de tronçons de l'île), ça n'arrive
        // qu'aux mondes dont on ne connaît pas les bornes.
        this.capacite = this.capacite * 2 + 16;
        this.tailleTeteFixe = this._dimensionnerTete();
        this.appendable = false;
        continue;
      }
      const out = new Uint8Array(o);
      out.set(MAGIC, 0);
      out[4] = GEOM_VERSION;
      new DataView(out.buffer).setUint32(5, this.tailleTeteFixe, true);
      out.set(teteOctets, EN_TETE_FIXE);
      for (const x of lignes) out.set(x.brut, x.o);
      this._poserTable(table);
      this.lignes = lignes.length;
      return out;
    }
  }

  /**
   * Ce qu'il faut **ajouter** au fichier déjà sur le serveur pour y loger les tronçons
   * neufs, sans rien déplacer de ce qui y est : les blocs à coller à la fin du fichier, et
   * les lignes de table à coller à la fin de la table (à un décalage près, le pied `]}`
   * attendant à poste fixe). C'est le chemin courant, et il ne coûte que ce qui est neuf.
   *
   * Renvoie null quand il faut tout réécrire : pas de fichier, en-tête d'un autre gabarit,
   * ou table trop grande pour la place réservée.
   */
  publierMorcele() {
    if (!this.appendable || !Number.isInteger(this.base) || !this.nouveaux.size) return null;
    const attendues = [];
    for (const clef of this.nouveaux) {
      const e = this.entrees.get(clef);
      if (e && e.brut) attendues.push(e);
    }
    if (!attendues.length) return null;
    const encodeur = new TextEncoder();
    let o = this.base;
    for (const e of attendues) { e.o = o; o += aligner(e.l); }
    const separateur = this.lignes ? ',' : '';
    const suite = `${separateur}${attendues.map((e) => EcrivainGeom._ligne(e)).join(',')}`;
    const suiteOctets = encodeur.encode(suite);
    // La place réservée se juge sur des longueurs, jamais en réécrivant l'en-tête : avant
    // cela, chaque lot fabriquait les 4,35 Mo de table + bourrage trois fois (mesuré le
    // 2026-11-17 : l'image à 584 ms que le joueur sentait comme une saccade).
    if (this.tableOctets + suiteOctets.byteLength + FERMETURE.length > this.tailleTeteFixe) {
      this.appendable = false;
      return null;
    }
    const append = new Uint8Array(o - this.base);
    let p = 0;
    for (const e of attendues) {
      append.set(e.brut, p);
      p += aligner(e.l);
    }
    return {
      append, base: this.base, nouvelleTaille: o, suite, suiteOctets: suiteOctets.byteLength,
      table: { offset: EN_TETE_FIXE + this.tableOctets, octets: suiteOctets },
      // Les octets tels qu'envoyés : `marquerAjout` ne libère que ceux-là, au cas où le
      // tronçon aurait été recuit pendant l'aller-retour au serveur.
      paquets: attendues.map((e) => ({ clef: cle(e.c[0], e.c[1]), brut: e.brut })),
    };
  }

  /**
   * Le serveur a écrit ces blocs et ces lignes : leur copie en mémoire ne sert plus à rien.
   * C'est ce qui empêche un onglet qui grave l'île entière de retenir 588 Mo de blocs
   * compressés — mesure du 2026-11-17, l'onglet du joueur tombait au premier envoi.
   */
  marquerAjout(morcele, nouvelleTaille) {
    for (const { clef, brut } of morcele.paquets) {
      const e = this.entrees.get(clef);
      if (e && e.brut === brut) e.brut = null;
      this.nouveaux.delete(clef);
    }
    // La table gravée, c'est la table de départ + toutes les suites acceptées. On ne la
    // reconstruit pas : sa longueur suffit à poser la suite suivante au bon octet.
    this.tableOctets += Number.isInteger(morcele.suiteOctets) ? morcele.suiteOctets
      : new TextEncoder().encode(morcele.suite || '').byteLength;
    this.lignes += morcele.paquets.length;
    if (Number.isInteger(nouvelleTaille)) this.base = nouvelleTaille;
    this.appendable = true;
  }

  /** Une réécriture complète vient d'atteindre le serveur : plus rien n'est en attente. */
  marquerReecriture(taille) {
    for (const e of this.entrees.values()) e.brut = null;
    this.nouveaux.clear();
    this.base = Number.isInteger(taille) ? taille : null;
    this.appendable = this.base !== null;
  }

  /**
   * Ce qu'il faut envoyer à un serveur qui a DÉJÀ le corps sous la main pour rattraper un
   * ancien gabarit d'en-tête : la région d'en-tête seule, bourrage et pied compris. Le
   * corps, lui, ne voyage pas — mesuré le 2026-11-17 sur le cache du joueur : renvoyer
   * 592 Mo fait échouer le réseau (`ERR_BLOB_OUT_OF_MEMORY`) et tuer l'onglet quand on
   * passe la vue `Uint8Array` nue ; pendant ce temps le serveur, lui, copie ces octets en
   * quelques secondes puisqu'ils sont déjà sur son disque.
   *
   * La table migrée n'annonce que les blocs déjà chez le serveur — ce qui est neuf part
   * juste après par `publierMorcele`, l'en-tête étant alors au gabarit réservé. Renvoie
   * null quand le corps n'est pas un ruban contigu qu'un seul décalage suffit à déplacer :
   * inventer des décalages faux serait pire que de attendre.
   */
  preparerMigration() {
    if (this.appendable || !Number.isInteger(this.base) || !Number.isInteger(this.debutOriginal)) {
      this.motifMigration = !Number.isInteger(this.base) || !Number.isInteger(this.debutOriginal)
        ? 'aucun fichier en boîte à migrer' : '';
      return null;
    }
    if (this.debutOriginal < EN_TETE_FIXE || this.debutOriginal >= this.base) {
      this.motifMigration = 'corps de cache vide';
      return null;
    }
    const encodeur = new TextEncoder();
    for (;;) {
      const debut = EN_TETE_FIXE + this.tailleTeteFixe;
      const shift = debut - this.debutOriginal;
      const enPlace = [...this.entrees.values()]
        .filter((e) => !this.nouveaux.has(cle(e.c[0], e.c[1])))
        .map((e) => ({ c: e.c, o: e.o, l: e.l, n: e.n, s: e.s, v: e.v, e: e.e }))
        .sort((a, b) => (a.c[1] - b.c[1]) || (a.c[0] - b.c[0]));
      // Le serveur ne fera QUE copier le corps d'un bloc à l'autre, distances comprises :
      // ce qui compte, c'est que chaque ligne annoncée tombe DANS la région copiée. Un trou
      // entre deux blocs n'a aucune importance — et l'exiger était une erreur mesurée le
      // 2026-11-17 : un tronçon que le joueur repeint laisse son ancien bloc orphelin sur
      // place, et la garde de contiguïté refusait alors de migrer le cache entier du joueur
      // (25 blocs posés suffisaient), le condamnant à une réécriture impossible.
      const fin = this.base;
      const horsCorps = [];
      const deplaces = [];
      for (const x of enPlace) {
        if (x.o < this.debutOriginal || x.o + aligner(x.l) > fin) {
          horsCorps.push(`${x.c[0]},${x.c[1]} annoncé à ${x.o}+${aligner(x.l)}`);
          if (horsCorps.length >= 3) break;
        }
        deplaces.push([cle(x.c[0], x.c[1]), x.o + shift]);
        x.o += shift;
      }
      if (!horsCorps.length) {
        const tableTexte = `${this._prefixe()}${enPlace.map((x) => EcrivainGeom._ligne(x)).join(',')}`;
        const region = this._region(tableTexte, encodeur);
        if (region !== null) {
          // L'en-tête complet, signature comprise : le serveur ne connaît pas le format, il
          // pose ces octets tels quels à poste fixe et vérifie seulement qu'ils se présentent bien.
          const tete = new Uint8Array(EN_TETE_FIXE + region.length);
          tete.set(MAGIC, 0);
          tete[4] = GEOM_VERSION;
          new DataView(tete.buffer).setUint32(5, this.tailleTeteFixe, true);
          tete.set(region, EN_TETE_FIXE);
          this.motifMigration = '';
          return {
            region: tete, attendu: this.base, debut, tableTexte, deplaces,
            nouveauTaille: debut + (this.base - this.debutOriginal), annonces: enPlace.length,
          };
        }
      } else {
        this.motifMigration = `bloc annoncé hors du corps copié [${this.debutOriginal}, ${fin}) : ${horsCorps.join(' · ')}`;
        return null;
      }
      // La table déborde de la place réservée : on la double, comme `publier`.
      this.capacite = this.capacite * 2 + 16;
      this.tailleTeteFixe = this._dimensionnerTete();
    }
  }

  /** Le serveur a copié le corps et posé la table : l'écrivain y croit aux mêmes conditions. */
  marquerMigration(morceau, tailleServeur) {
    for (const [clef, nouvelO] of morceau.deplaces) {
      const e = this.entrees.get(clef);
      if (e) e.o = nouvelO;
    }
    this._poserTable(morceau.tableTexte);
    this.lignes = morceau.annonces;
    this.base = Number.isInteger(tailleServeur) ? tailleServeur : morceau.nouveauTaille;
    this.debutOriginal = null;
    this.appendable = true;
  }

  /**
   * Oublie les entrées dont la mémoire n'a plus les octets et que le fichier est incapable
   * de rendre (il a disparu entre-temps). Sans ça, une seule publication ratée laisserait
   * l'écrivain avec des trous irréparables et refuserait d'écrire quoi que ce soit ensuite.
   */
  jeterCorpsSansMemoire() {
    let jetes = 0;
    for (const [clef, e] of [...this.entrees]) {
      if (e.brut) continue;
      this.entrees.delete(clef);
      this.nouveaux.delete(clef);
      this.octetsCompresse -= e.l;
      jetes++;
    }
    this.base = null;
    this.appendable = false;
    return jetes;
  }

  /**
   * Rend aux blocs déjà publiés les octets que le serveur en porte, pour que la voie
   * complète reste possible après un ajout interrompu. Une entrée dont le fichier ne dit
   * plus la même chose est retirée de l'écrivain : le four la recuira plutôt que d'écrire
   * un mensonge sur la scène.
   */
  completerDepuis(octets, attendu = null) {
    const r = lireEnTete(octets, attendu || {
      chunkSize: this.chunkSize, height: this.height, seed: this.seed,
      mailleVersion: this.mailleVersion, atlasSignature: this.atlasSignature,
    });
    if (!r.ok) throw new Error(`rechargement du cache refusé : ${r.motif}`);
    let combles = 0;
    const vus = new Set();
    for (const e of r.tete.entrees) {
      const clef = cle(e.c[0], e.c[1]);
      vus.add(clef);
      const mien = this.entrees.get(clef);
      if (!mien || mien.brut) continue;
      if (mien.l !== e.l || mien.n !== e.n) {
        this.entrees.delete(clef);
        this.nouveaux.delete(clef);
        this.octetsCompresse -= mien.l;
        continue;
      }
      mien.brut = octets.subarray(e.o, e.o + e.l);
      combles++;
    }
    for (const [clef, mien] of [...this.entrees]) {
      if (!vus.has(clef) && !mien.brut) {
        this.entrees.delete(clef);
        this.nouveaux.delete(clef);
        this.octetsCompresse -= mien.l;
      }
    }
    this.base = octets.length;
    const ecrite = EcrivainGeom._tableEcrite(octets, r);
    this.appendable = r.tailleTete === this.tailleTeteFixe && ecrite !== null;
    if (ecrite !== null) {
      this._poserTable(ecrite);
      this.lignes = r.tete.entrees.length;
    }
    return combles;
  }
}

// -------------------------------------------------------------------- cache -----------

/**
 * Lecture d'un fichier de géométrie. Les blocs restent compressés tant qu'on ne les
 * demande pas ; `rechauffer` décompresse quelques tronçons d'avance et les garde en main,
 * parce que décompresser dans la frame coûterait plus cher que le maillage qu'on évite.
 */
export class CacheGeom {
  constructor(octets, tete, debutCorps, attendu) {
    this.octets = octets;
    this.tete = tete;
    this.debutCorps = debutCorps;
    this.attendu = attendu;
    this.parClef = new Map();
    for (const e of tete.entrees) this.parClef.set(cle(e.c[0], e.c[1]), e);
    this.codec = tete.codec === CODEC_BRUT ? CODEC_BRUT : CODEC_DEFLATE;
    /** @type {Map<string, {maillages: Array, empreinte: string|null}>} */
    this.enMain = new Map();
    this.limitesMain = 12;
    this.statistiques = { demandes: 0, touches: 0, ratees: 0, decompresse: 0, refuses: 0 };
  }

  static depuis(octets, attendu) {
    const r = lireEnTete(octets, attendu);
    return r.ok ? new CacheGeom(octets, r.tete, r.debutCorps, attendu) : null;
  }

  aLeTroncon(cx, cz) { return this.parClef.has(cle(cx, cz)); }

  /** L'empreinte inscrite au moment de l'écriture, pour comparer avec l'état du jeu. */
  empreinteDu(cx, cz) {
    const e = this.parClef.get(cle(cx, cz));
    return e ? e.e : null;
  }

  /** Comme `pret`, mais sans toucher à la récence : pour un simple état des lieux. */
  estChaud(cx, cz) { return this.enMain.has(cle(cx, cz)); }

  /** Le tronçon est-il déjà décompressé et prêt à être posé ? */
  pret(cx, cz) {
    const clef = cle(cx, cz);
    const d = this.enMain.get(clef);
    if (!d) return null;
    // Consulter, c'est encore utiliser. Sans ce coup de pouce la « file chaude » reste un
    // FIFO : le bloc lu pour un tronçon lointain évinçait celui que le mailleur allait
    // réclamer deux tours plus bas (mesuré 51 poses sur 127 tronçons connus du champ).
    this.enMain.delete(clef);
    this.enMain.set(clef, d);
    return d.maillages;
  }

  /** Décompresse un tronçon s'il ne l'est pas déjà. Renvoie les mailleurs ou null. */
  async charger(cx, cz) {
    const clef = cle(cx, cz);
    const chaud = this.enMain.get(clef);
    if (chaud) {
      this.statistiques.touches++;
      this.enMain.delete(clef);
      this.enMain.set(clef, chaud);
      return chaud.maillages;
    }
    const e = this.parClef.get(clef);
    if (!e) { this.statistiques.ratees++; return null; }
    this.statistiques.demandes++;
    const tranche = this.octets.subarray(e.o, e.o + e.l);
    const brut = this.codec === CODEC_BRUT ? tranche : await decompesser(tranche, e.n);
    if (!brut) { this.statistiques.refuses++; return null; }
    const maillages = deserialiserMaillages(brut, 0, brut.byteLength);
    if (!maillages) { this.statistiques.refuses++; this.parClef.delete(clef); return null; }
    // Les vues pointent sur `brut` : il faut le garder vivant aussi longtemps que les
    // tableaux, d'où le stockage ensemble dans l'entrée chaude.
    this.enMain.set(clef, { maillages, brut });
    while (this.enMain.size > this.limitesMain) {
      const plusAncienne = this.enMain.keys().next().value;
      this.enMain.delete(plusAncienne);
    }
    this.statistiques.decompresse++;
    return maillages;
  }

  /** Réchauffe plusieurs tronçons d'avance, sans dépasser `max` décompressions. */
  async preparer(liste, { max = 6 } = {}) {
    let faites = 0;
    for (const [cx, cz] of liste) {
      if (faites >= max) break;
      if (!this.aLeTroncon(cx, cz) || this.estChaud(cx, cz)) continue;
      if (await this.charger(cx, cz)) faites++;
    }
    return faites;
  }

  stats() {
    return { ...this.statistiques, troncons: this.parClef.size, enMain: this.enMain.size, codec: this.codec };
  }
}

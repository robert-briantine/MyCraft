// Représentation de l'île sur le disque.
//
// Le relief se régénère à l'identique depuis la graine, mais il coûte cher : mesuré le
// 2026-11-16 sur l'île par défaut (rayon 1600, 31 416 tronçons), la génération demande
// 18 ms en moyenne par tronçon, soit **neuf minutes et demie** pour toute l'île. C'est
// ce temps que supprime ce fichier : une fois l'île cuite, un tronçon se relit en une
// fraction de milliseconde et le terrain n'a plus le temps d'apparaître sous les pieds
// du joueur.
//
// Ni DOM ni Three.js ici : le format, ses garde-fous et ses codecs sont jugés par
// `tests/ile.mjs` en Node, exactement comme le jeu les utilisera.
//
// Trois codecs, choisi à l'écriture selon ce que sait faire l'hôte :
//   « deflate » — un flux DEFLATE par tranche de 64 tronçons : 695 octets par tronçon
//     mesurés (21 Mo pour l'île), 0,13 ms par tronçon quand la tranche est relue d'un bloc.
//     La relecture étant asynchrone (streams natifs), le jeu réchauffe les tranches
//     d'avance ; un tronçon dont la tranche n'est pas prête retombe sur la génération.
//   « rle »     — suites de valeurs identiques parcourues **par colonne** (le calcaire
//     s'empile, l'air au-dessus du relief aussi) : 2 394 octets par tronçon (72 Mo),
//     mais chaque tronçon se relit seul, sans CompressionStream, en 38 µs.
//   « brut »    — même cadre sans compression ; dernier recours, jamais choisi volontairement.

export const ILE_MAGIC = 'MCI1';
export const ILE_VERSION = 1;
export const SLAB_CHUNKS = 64;          // tronçons par tranche comprimée
export const MAX_ILE_BYTES = 256 * 1024 * 1024;
const MAX_BORNE_TRONCONS = 4096;        // nx, nz bornés : un en-tête truqué ne doit pas faire allouer 16 Go
const TETE_LONGUEUR_MAX = 4 * 1024 * 1024;
const TRANCHES_EN_MAIN = 6;             // taille du LRU de tranches décompressées
export const TRANCHES_MAX = 12;         // plafond absolu : 12 × 2 Mo, jamais plus

// Marge au-delà du rayon de l'île : la plage, les brisants et ce que le joueur voit
// depuis le rivage. Au-delà, le cache laisse un trou et le flot habituel reprend la main.
export const MARGE_ILE = 4;             // en tronçons, soit 64 cubes

export const CODEC_DEFLATE = 'deflate';
export const CODEC_RLE = 'rle';
export const CODEC_BRUT = 'brut';
const CODECS = [CODEC_DEFLATE, CODEC_RLE, CODEC_BRUT];

/** Ce que sait faire cet hôte : le DEFLATE natif si la plateforme le fournit. */
export function codecParDefaut() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'
    ? CODEC_DEFLATE
    : CODEC_RLE;
}

// ---- empreinte de la fiche ------------------------------------------------

function clesTriees(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(clesTriees).join(',') + ']';
  return '{' + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${clesTriees(o[k])}`).join(',') + '}';
}

/**
 * Clé stable d'un monde : graine + fiche + géométrie des tronçons. Un cache n'est
 * valide que pour le monde qui l'a fabriqué — une fiche changée (rayon d'île, part de
 * forêt) dessine un autre relief, et relire l'ancien mettrait les blocs posés par le
 * joueur sur un terrain qu'il n'a jamais vu.
 */
export function cleFiche({ seed, monde, chunkSize, height }) {
  return `${seed}|${chunkSize}x${height}|${clesTriees(monde || {})}`;
}

// ---- bornes de l'île ------------------------------------------------------

/**
 * Fenêtre de tronçons tenue sur le disque : le carré circonscrit au disque de l'île
 * augmenté de `MARGE_ILE`, avec le test d'appartenance qui évite de cuire les quatre
 * coins de mer pour rien. Un monde « continent » n'a pas de rayon : on borne alors sur
 * le carré constructible que le jeu passe en `coteContinent`.
 */
export function bornesIle({ ile, rayonIle, coteContinent = 640 }, chunkSize, marge = MARGE_ILE) {
  const demi = ile ? rayonIle + marge * chunkSize : coteContinent / 2 + marge * chunkSize;
  const n = Math.ceil(demi / chunkSize);
  const rayon = ile ? rayonIle + marge * chunkSize : null;
  return {
    cx: -n, cz: -n, nx: 2 * n, nz: 2 * n, rayon, chunkSize,
    contient(cx, cz) {
      if (cx < this.cx || cz < this.cz || cx >= this.cx + this.nx || cz >= this.cz + this.nz) return false;
      if (this.rayon == null) return true;
      const x = cx * chunkSize + chunkSize / 2;
      const z = cz * chunkSize + chunkSize / 2;
      return x * x + z * z <= this.rayon * this.rayon;
    },
  };
}

// ---- codecs ---------------------------------------------------------------

async function deflate(octets) {
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter();
  w.write(octets);
  w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function inflate(flux, longueur) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(flux);
  w.close();
  const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  if (out.length !== longueur) throw new Error(`flux tronqué : ${out.length} ≠ ${longueur}`);
  return out;
}

/** Suites de valeurs identiques le long de chaque colonne (y d'abord). */
export function encoderColonnes(d, chunkSize, height) {
  const cells = chunkSize * chunkSize;
  const octets = [];
  for (let c = 0; c < cells; c++) {
    let prev = d[c];
    let n = 0;
    for (let y = 0; y <= height; y++) {
      const v = y < height ? d[c + y * cells] : -2;   // sentinelle : vide la dernière suite
      if (v === prev) { n++; continue; }
      octets.push(prev);
      if (n < 255) octets.push(n);
      else {
        octets.push(255);
        let r = n - 255;
        while (r >= 255) { octets.push(255); r -= 255; }
        octets.push(r);
      }
      prev = v;
      n = 1;
    }
  }
  return Uint8Array.from(octets);
}

/** Relecture exacte d'`encoderColonnes` : les écritures suivent la même colonne. */
export function decoderColonnes(flux, sortie, chunkSize, height) {
  const cells = chunkSize * chunkSize;
  let i = 0;
  for (let c = 0; c < cells; c++) {
    let y = 0;
    while (y < height) {
      if (i >= flux.length) throw new Error('flux RLE épuisé');
      const v = flux[i++];
      let b = flux[i++];
      let n = b;
      while (b === 255) { b = flux[i++]; n += b; }
      if (y + n > height) throw new Error('suite hors de la colonne');
      for (let k = 0; k < n; k++) sortie[c + (y + k) * cells] = v;
      y += n;
    }
  }
  return sortie;
}

// ---- bitmap des présences -------------------------------------------------

function encoderPresent(b, n) {
  const octets = new Uint8Array(Math.ceil(n / 8));
  for (let i = 0; i < n; i++) if (b[i]) octets[i >> 3] |= 1 << (i & 7);
  let texte = '';
  for (let i = 0; i < octets.length; i++) texte += String.fromCharCode(octets[i]);
  return typeof btoa === 'function' ? btoa(texte) : Array.from(octets).join(',');
}

function decoderPresent(texte, n) {
  const b = new Uint8Array(n);
  if (typeof texte === 'string' && texte.indexOf(',') < 0) {
    let bin;
    try {
      bin = typeof atob === 'function' ? atob(texte) : null;
      if (bin === null) return null;
    } catch (e) {
      return null;                                    // bitmap illisible : le cache sera refusé
    }
    for (let i = 0; i < n; i++) {
      const o = bin.charCodeAt(i >> 3);
      if (o & (1 << (i & 7))) b[i] = 1;
    }
    return b;
  }
  const tab = String(texte == null ? '' : texte).split(',');
  for (let i = 0; i < n; i++) b[i] = Number(tab[i]) ? 1 : 0;
  return b;
}

// ---- écriture -------------------------------------------------------------

/**
 * Écrivain incrémental du fichier d'île. Les tronçons doivent lui être confiés **dans
 * l'ordre de parcours** (ligne par ligne, z puis x) : c'est ce rang qui retrouve un
 * tronçon dans sa tranche, sans table supplémentaire. Une cuisson étalée sur plusieurs
 * minutes n'a ainsi à tenir en mémoire que les tranches déjà comprimées — vingt et un
 * méga-octets — et non les neuf cent quatre-vingt-deux mégaoctets de brut.
 */
export class EcrivainIle {
  constructor({ chunkSize, height, seed, monde, bornes, codec = codecParDefaut(), slabChunks = SLAB_CHUNKS }) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) throw new Error('chunkSize invalide');
    if (!Number.isInteger(height) || height <= 0) throw new Error('height invalide');
    if (!(bornes.nx > 0) || !(bornes.nz > 0) || bornes.nx > MAX_BORNE_TRONCONS || bornes.nz > MAX_BORNE_TRONCONS)
      throw new Error('fenêtre de tronçons invalide');
    if (!CODECS.includes(codec)) throw new Error(`codec ${codec} inconnu`);
    Object.assign(this, {
      chunkSize, height, seed, monde, bornes, codec, slabChunks,
      volume: chunkSize * chunkSize * height,
      present: new Uint8Array(bornes.nx * bornes.nz),
      tranches: [],
      morceaux: [],
      poidsCorps: 0,
      file: [],
      poidsFile: 0,
      rang: 0,
      dernierIndice: -1,
    });
  }

  async _evacuer() {
    const file = this.file;
    if (file.length === 0) return;
    const { chunkSize, height, codec } = this;
    const concat = new Uint8Array(this.poidsFile);
    let o = 0;
    for (const d of file) { concat.set(d, o); o += d.length; }
    let corps;
    if (codec === CODEC_DEFLATE) {
      corps = await deflate(concat);
    } else if (codec === CODEC_RLE) {
      // Chaque tronçon garde son bloc RLE, précédé d'une table de décalages : relire un
      // tronçon n'impose pas de relire ses voisins.
      const blocs = file.map((d) => encoderColonnes(d, chunkSize, height));
      const tableLongueur = (blocs.length + 1) * 4;
      const table = new Uint8Array(tableLongueur);
      const vue = new DataView(table.buffer);
      let p = 0;
      blocs.forEach((b, k) => { vue.setUint32(k * 4, p, true); p += b.length; });
      vue.setUint32(blocs.length * 4, p, true);
      corps = new Uint8Array(tableLongueur + p);
      corps.set(table, 0);
      let q = tableLongueur;
      for (const b of blocs) { corps.set(b, q); q += b.length; }
    } else {
      corps = concat;
    }
    this.tranches.push({ o: this.poidsCorps, l: corps.length, n: file.length });
    this.morceaux.push(corps);
    this.poidsCorps += corps.length;
    file.length = 0;
    this.poidsFile = 0;
  }

  /** Enregistre un tronçon (ou un trou si `data` est null). Dans l'ordre de parcours. */
  async ajouter(cx, cz, data) {
    const i = cx - this.bornes.cx;
    const j = cz - this.bornes.cz;
    if (i < 0 || j < 0 || i >= this.bornes.nx || j >= this.bornes.nz) throw new Error(`tronçon hors fenêtre ${cx},${cz}`);
    const indice = j * this.bornes.nx + i;
    if (indice <= this.dernierIndice) throw new Error(`tronçons demandés hors ordre (${indice} après ${this.dernierIndice})`);
    // Une trouée interrompt la tranche en cours : les présents se numérotent donc dans
    // l'ordre de parcours, trous exclus.
    if (this.file.length && !data) await this._evacuer();
    this.dernierIndice = indice;
    if (!data) { this.present[indice] = 0; return false; }
    if (!(data instanceof Uint8Array) || data.length !== this.volume)
      throw new Error(`tronçon ${cx},${cz} de ${data && data.length} octets, attendu ${this.volume}`);
    this.present[indice] = 1;
    this.file.push(data);
    this.poidsFile += data.length;
    this.rang++;
    if (this.file.length >= this.slabChunks) await this._evacuer();
    return true;
  }

  /** Termine et rend le fichier. Rappelable : l'état reste intact pour un nouvel ajout. */
  async publier() {
    await this._evacuer();
    const tete = {
      magic: ILE_MAGIC,
      version: ILE_VERSION,
      codec: this.codec,
      chunkSize: this.chunkSize,
      height: this.height,
      seed: this.seed,
      ficheKey: cleFiche({ seed: this.seed, monde: this.monde, chunkSize: this.chunkSize, height: this.height }),
      bornes: { cx: this.bornes.cx, cz: this.bornes.cz, nx: this.bornes.nx, nz: this.bornes.nz },
      slabChunks: this.slabChunks,
      volume: this.volume,
      tranches: this.tranches,
      present: encoderPresent(this.present, this.present.length),
      cree: Date.now(),
    };
    const teteOctets = new TextEncoder().encode(JSON.stringify(tete));
    if (teteOctets.length > TETE_LONGUEUR_MAX) throw new Error('en-tête trop volumineux');
    const fichier = new Uint8Array(9 + teteOctets.length + this.poidsCorps);
    fichier.set([0x4d, 0x43, 0x49, 0x31], 0);            // 'MCI1'
    fichier[4] = ILE_VERSION;
    new DataView(fichier.buffer).setUint32(5, teteOctets.length, true);
    fichier.set(teteOctets, 9);
    let o = 9 + teteOctets.length;
    for (const m of this.morceaux) { fichier.set(m, o); o += m.length; }
    return fichier;
  }
}

/**
 * Cuit le fichier d'île d'un tenant. `donnerTroncon(cx, cz)` rend le contenu brut d'un
 * tronçon, ou null pour un tronçon non encore fabriqué : il reste trou, et le flot
 * habituel s'en chargera. C'est ce qui permet de publier un cache partiel puis de le
 * compléter plus tard.
 *
 * Les tronçons hors disque ne sont même pas demandés.
 */
export async function encoderIle({
  chunkSize, height, seed, monde, bornes, donnerTroncon,
  codec = codecParDefaut(), slabChunks = SLAB_CHUNKS, onTroncon = null,
}) {
  const ecrivain = new EcrivainIle({ chunkSize, height, seed, monde, bornes, codec, slabChunks });
  for (let j = 0; j < bornes.nz; j++) {
    for (let i = 0; i < bornes.nx; i++) {
      const cx = bornes.cx + i;
      const cz = bornes.cz + j;
      if (!bornes.contient(cx, cz)) continue;
      const d = await donnerTroncon(cx, cz);
      const pris = await ecrivain.ajouter(cx, cz, d);
      if (onTroncon) onTroncon(ecrivain.rang, pris);
    }
  }
  return ecrivain.publier();
}

// ---- lecture --------------------------------------------------------------

/**
 * Relit et **vérifie** un fichier venu du disque : signature, version, dimensions,
 * correspondance avec le monde en cours, continuité des tranches dans le fichier. Un
 * refus s'exprime par un motif lisible, pour que le jeu puisse dire au joueur pourquoi
 * il recuit son île.
 */
export function lireEnTete(octets, { seed, monde, chunkSize, height } = {}) {
  if (!(octets instanceof Uint8Array)) return { ok: false, motif: 'fichier absent' };
  if (octets.length < 9) return { ok: false, motif: 'fichier trop court' };
  if (octets.length > MAX_ILE_BYTES) return { ok: false, motif: `fichier de ${octets.length} octets refusé` };
  if (octets[0] !== 0x4d || octets[1] !== 0x43 || octets[2] !== 0x49 || octets[3] !== 0x31)
    return { ok: false, motif: 'signature inconnue' };
  if (octets[4] !== ILE_VERSION) return { ok: false, motif: `version ${octets[4]} non reconnue` };
  const vue0 = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const longueurTete = vue0.getUint32(5, true);
  if (longueurTete > TETE_LONGUEUR_MAX || 9 + longueurTete > octets.length)
    return { ok: false, motif: 'en-tête hors fichier' };
  let meta;
  try {
    meta = JSON.parse(new TextDecoder().decode(octets.subarray(9, 9 + longueurTete)));
  } catch (e) {
    return { ok: false, motif: 'en-tête illisible' };
  }
  if (!meta || meta.magic !== ILE_MAGIC) return { ok: false, motif: 'en-tête sans signature' };
  if (meta.version !== ILE_VERSION) return { ok: false, motif: `version ${meta.version} non reconnue` };
  if (!CODECS.includes(meta.codec)) return { ok: false, motif: `codec ${meta.codec} inconnu` };
  if (meta.chunkSize !== chunkSize || meta.height !== height)
    return { ok: false, motif: `tronçons ${meta.chunkSize}×${meta.height} ≠ ${chunkSize}×${height}` };
  if (seed !== undefined && seed !== null && meta.seed !== seed) return { ok: false, motif: 'graine différente' };
  if (monde !== undefined && meta.ficheKey !== cleFiche({ seed: meta.seed, monde, chunkSize, height }))
    return { ok: false, motif: 'fiche de génération différente' };

  const b = meta.bornes;
  if (!b || !Number.isInteger(b.cx) || !Number.isInteger(b.cz)
    || !(b.nx > 0) || !(b.nz > 0) || b.nx > MAX_BORNE_TRONCONS || b.nz > MAX_BORNE_TRONCONS)
    return { ok: false, motif: 'bornes invalides' };
  const volume = meta.chunkSize * meta.chunkSize * meta.height;
  if (meta.volume !== volume) return { ok: false, motif: 'volume de tronçon incohérent' };
  if (!Number.isInteger(meta.slabChunks) || meta.slabChunks < 1) return { ok: false, motif: 'tranches mal dimensionnées' };
  if (!Array.isArray(meta.tranches) || meta.tranches.length === 0) return { ok: false, motif: 'aucune tranche' };
  if (meta.tranches.length > b.nx * b.nz) return { ok: false, motif: 'trop de tranches' };

  const debutCorps = 9 + longueurTete;
  let attendu = 0;
  for (const t of meta.tranches) {
    if (!Number.isInteger(t.o) || !Number.isInteger(t.l) || !Number.isInteger(t.n) || t.o < 0 || t.l < 0 || t.n < 1)
      return { ok: false, motif: 'tranche mal formée' };
    if (t.o !== attendu) return { ok: false, motif: 'tranches discontinues' };
    if (debutCorps + attendu + t.l > octets.length) return { ok: false, motif: 'tranche hors fichier' };
    attendu += t.l;
  }
  const present = decoderPresent(meta.present, b.nx * b.nz);
  if (!present) return { ok: false, motif: 'table de présences illisible' };
  return { ok: true, meta, debutCorps, present, volume };
}

/**
 * Cache en mémoire d'une île cuite : le fichier entier tient en RAM **compressé**
 * (21 Mo pour l'île par défaut) et un tronçon se relit à la demande. Tout décompresser
 * d'un coup coûterait 982 Mo — impossible dans un onglet, et inutile puisque relire une
 * tranche entière coûte 0,13 ms par tronçon.
 */
export class CacheIle {
  /**
   * `attendu` porte { seed, monde, chunkSize, height } : un fichier n'est exploitable
   * que s'il décrit exactement le monde en cours de jeu. Sans ces prétentions, aucune
   * vérification n'est possible et le cache est refusé — jamais accepté à l'aveugle.
   */
  constructor(octets, attendu = {}) {
    const lu = lireEnTete(octets, attendu);
    if (!lu.ok) { this.valide = false; this.motif = lu.motif; return; }
    this.valide = true;
    this.motif = null;
    this.meta = lu.meta;
    this.debutCorps = lu.debutCorps;
    this.present = lu.present;
    this.octets = octets;
    this.chunkSize = lu.meta.chunkSize;
    this.height = lu.meta.height;
    this.volume = lu.volume;
    this.bornes = lu.meta.bornes;
    this._tranches = lu.meta.tranches;
    this._lru = new Map();
    // Réchauffements en vol, par numéro de tranche : voir `rechauffer`.
    this._enCours = new Map();
    this.lues = 0;
    this.tombéesFroides = 0;
    // Rang de présence cumulé : sans cette table, retrouver le rang d'un tronçon
    // coûterait un balayage complet du bitmap à chaque demande (40 000 itérations).
    const rangs = new Int32Array(this.present.length + 1);
    for (let i = 0; i < this.present.length; i++) rangs[i + 1] = rangs[i] + (this.present[i] ? 1 : 0);
    this._rangs = rangs;

    // Concordance rang → (tranche, position dans la tranche). On ne peut pas diviser le
    // rang par `slabChunks` : une publication anticipée laisse une tranche partielle au
    // milieu du fichier, et toutes les suivantes se décaleraient d'autant.
    const cuit = rangs[this.present.length];
    // Capacité de la file chaude : réglable parce qu'elle doit couvrir ce que le joueur
    // voit. À 6 tranches, un champ de rayon 4 en demande 7 — mesuré — et la cuisson du
    // champ s'évinçait elle-même : les tronçons du bord retombaient sur le bruit alors
    // que le fichier les connaît (`froides=11`, 5 régénérations pour 49 tronçons).
    this.limitesMain = TRANCHES_EN_MAIN;
    this._slabDeRang = new Int32Array(cuit);
    this._pasDansSlab = new Int32Array(cuit);
    let r = 0;
    for (let no = 0; no < this._tranches.length; no++) {
      const n = this._tranches[no].n;
      for (let k = 0; k < n; k++, r++) {
        if (r >= cuit) { this.valide = false; this.motif = 'trop de tronçons dans les tranches'; return; }
        this._slabDeRang[r] = no;
        this._pasDansSlab[r] = k;
      }
    }
    if (r !== cuit) { this.valide = false; this.motif = 'tranches et présences ne concordent pas'; return; }
  }

  /** null si le fichier n'est pas exploitable pour ce monde (le motif reste sur l'objet refusé). */
  static depuis(octets, attendu) {
    const c = new CacheIle(octets, attendu);
    return c.valide ? c : null;
  }

  convient({ seed, monde, chunkSize, height }) {
    return lireEnTete(this.octets, { seed, monde, chunkSize, height });
  }

  indiceDe(cx, cz) {
    const i = cx - this.bornes.cx;
    const j = cz - this.bornes.cz;
    if (i < 0 || j < 0 || i >= this.bornes.nx || j >= this.bornes.nz) return -1;
    return j * this.bornes.nx + i;
  }

  aLeTroncon(cx, cz) {
    const k = this.indiceDe(cx, cz);
    return k >= 0 && this.present[k] === 1;
  }

  /** Index de la tranche qui porte ce tronçon, ou -1. Sert au réchauffement anticipé. */
  trancheDe(cx, cz) {
    const k = this.indiceDe(cx, cz);
    if (k < 0 || this.present[k] !== 1) return -1;
    return this._slabDeRang[this._rangs[k]];
  }

  chaude(no) { return this._lru.has(no); }

  _corpsTranche(no) {
    const t = this._tranches[no];
    return this.octets.subarray(this.debutCorps + t.o, this.debutCorps + t.o + t.l);
  }

  /** Décompresse une tranche et la garde en main. Renvoie false si le codec manque. */
  async rechauffer(no) {
    if (!this.valide || this.meta.codec !== CODEC_DEFLATE) return false;
    const dejaLa = this._lru.get(no);
    if (dejaLa !== undefined) {
      // Une tranche qu'on relit est la dernière à évincer : l'ordre d'insertion de la Map
      // fait foi de récence, on la repousse donc en queue. Sans ce rappel, la file était
      // pur FIFO et les tranches du champ, pourtant lues en boucle, partaient derrière
      // une flânerie lointaine — le bord revenait alors du bruit.
      this._lru.delete(no);
      this._lru.set(no, dejaLa);
      return true;
    }
    // Soixante-quatre tronçons logent dans une tranche et peuvent la réclamer coup sur
    // coup : sans ce verrou, chacun décompressait les 2 Mo pour lui-même et empilait sa
    // clé dans la file, dont l'éviction effaçait alors des tranches vivantes (mesuré
    // 5 tranches en main pour 7 clés — le champ entier retombait sur le bruit).
    const enVol = this._enCours.get(no);
    if (enVol) return enVol;
    const t = this._tranches[no];
    if (!t) return false;
    const promesse = (async () => {
      try {
        const pleine = await inflate(this._corpsTranche(no), t.n * this.volume);
        this._lru.set(no, pleine);
        while (this._lru.size > this.limitesMain) {
          const doyen = this._lru.keys().next().value;
          if (doyen === no) break;               // jamais on n'évince ce qu'on vient d'installer
          this._lru.delete(doyen);
        }
        return true;
      } catch (e) {
        return false;
      } finally {
        this._enCours.delete(no);
      }
    })();
    this._enCours.set(no, promesse);
    return promesse;
  }

  /** Contenu brut d'un tronçon, ou null : absent du cache, ou tranche pas encore prête. */
  troncon(cx, cz) {
    if (!this.valide) return null;
    const k = this.indiceDe(cx, cz);
    if (k < 0 || this.present[k] !== 1) return null;
    const rang = this._rangs[k];
    const no = this._slabDeRang[rang];
    const dansTranche = this._pasDansSlab[rang];
    const t = this._tranches[no];
    if (!t || dansTranche >= t.n) return null;

    const sortie = new Uint8Array(this.volume);
    if (this.meta.codec === CODEC_BRUT) {
      sortie.set(this._corpsTranche(no).subarray(dansTranche * this.volume, (dansTranche + 1) * this.volume));
    } else if (this.meta.codec === CODEC_RLE) {
      const tete = this.octets.subarray(this.debutCorps + t.o, this.debutCorps + t.o + (t.n + 1) * 4);
      const vue = new DataView(tete.buffer, tete.byteOffset, tete.byteLength);
      const debut = (t.n + 1) * 4 + vue.getUint32(dansTranche * 4, true);
      const fin = (t.n + 1) * 4 + vue.getUint32((dansTranche + 1) * 4, true);
      try {
        decoderColonnes(this._corpsTranche(no).subarray(debut, fin), sortie, this.chunkSize, this.height);
      } catch (e) {
        return null;                                    // bloc abîmé : le jeu régénérera ce tronçon
      }
    } else {
      const pleine = this._lru.get(no);
      if (!pleine) { this.tombéesFroides++; return null; }
      sortie.set(pleine.subarray(dansTranche * this.volume, (dansTranche + 1) * this.volume));
    }
    this.lues++;
    return sortie;
  }

  /** Ce qu'on affiche au joueur : combien de tronçons tiennent sur le disque. */
  stats() {
    return {
      troncons: this._rangs[this.present.length],
      fenetre: this.present.length,
      octets: this.octets.length,
      codec: this.meta.codec,
      tranches: this._tranches.length,
      lues: this.lues,
      froides: this.tombéesFroides,
    };
  }
}

/**
 * Réchauffe les tranches qui couvrent une liste de tronçons, en amont du maillage.
 * Appelé avant d'entrer en jeu et à chaque changement de région : une fois la tranche
 * en poche, servir ses 64 tronçons ne coûte plus qu'une copie.
 */
export async function preparerTranches(cache, listeTroncons, { max = 8 } = {}) {
  if (!cache || !cache.valide || cache.meta.codec !== CODEC_DEFLATE) return 0;
  const nos = new Set();
  for (const [cx, cz] of listeTroncons) {
    const no = cache.trancheDe(cx, cz);
    if (no >= 0 && !cache._lru.has(no)) nos.add(no);
  }
  // Réchauffer plus de tranches que la file n'en peut tenir, c'est évincer ce qu'on vient
  // de décompresser : la capacité suit donc la demande — celles qui sont déjà en main
  // comprises — sous le plafond mémoire absolu.
  const besoin = cache._lru.size + nos.size;
  if (besoin > cache.limitesMain) cache.limitesMain = Math.min(TRANCHES_MAX, besoin);
  let faits = 0;
  for (const no of nos) {
    if (faits >= max) break;
    if (await cache.rechauffer(no)) faits++;
    else break;                                         // codec capricieux : on s'arrête là
  }
  return faits;
}

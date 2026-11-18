import * as THREE from '../vendor/three/three.module.js';
import { PointerLockControls } from '../vendor/three/examples/jsm/controls/PointerLockControls.js';
import { createTextureAtlas } from './textures.js';
import { createSaveStore, encodeSave, decodeSave, setNameInSave, slugify, cleanWorldName, AUTOSAVE_INTERVAL_MS } from './saves.js';
import { createVillageGen, VILLAGE } from './village.js';
import { createBiomeGen } from './biomes.js';
import { SimplexNoise } from './noise.js';
import { createTerrain, RELIEF } from './terrain.js';
import {
  MONDE_DEFAULTS, MONDE_FIELDS, clampMonde, memesMondes, mondeSeeds, mondeStorageKey,
  reliefOverrides, biomesOverrides, villageOverrides,
} from './world-config.js';
import { createMondePreview } from './world-preview.js';
import { creerEclairage, LAMPE_PORTEE, PLANCHER_NUIT, PLANCHER_PIECE, COUVERTE_MINCE, SEUIL_MUR, PORTEE_CIEL } from './eclairage.js';
import { CacheIle, EcrivainIle, bornesIle, preparerTranches, codecParDefaut, TRANCHES_MAX } from './ile.js';
import { CacheGeom, EcrivainGeom, serialiserMaillages, lireEnTete, dequantifierPositions, hachage as hachageGeom, hachageOctets } from './geom-disque.js';
import { creerEau, EAU } from './eau.js';
import {
  etatDuCiel, creerHorloge, heureAffichee, bornerDuree,
  DUREE_JOUR_DEFAUT, DUREE_JOUR_BORNES, HEURE_DEPART,
} from './ciel.js';
import { creerMeteo, habillerCiel, METEO_MODES } from './meteo.js';

// ===================== CONSTANTS =====================
const CHUNK_SIZE = 16;
// Porté de 64 à 80 le 2026-11-09 pour que les catégories hautes d'immeuble tiennent :
// quatorze étages au pas de `floorPitch`, c'est quarante-quatre cubes de corps plus le
// toit, et le seuil d'une tour de centre-bourg se pose déjà à vingt-cinq cubes.
// Porté de 80 à 128 le 2026-11-11, quand les appartements ont reçu 4 cubes d'air sous
// plafond (baies de 4×4) : l'étage passe de 3 à 5 cubes, quatorze étages en demandent
// soixante-douze, et un seuil de centre-bourg à vingt-six cubes n'a plus de marge à 80.
const CHUNK_HEIGHT = 128;
const GRAVITY = 30;
const JUMP_SPEED = 10;
const MOVE_SPEED = 8;
// Le vol libre n'est plus une touche : il s'est décomposé en deux gestes distincts
// (voir l'en-tête du contrôleur aérien). `FLY_SPEED` et `FLY` ne survivent que pour le
// survol de debug que les suites posent sur `player.flyMode`.
const FLY_SPEED = 20;
const FLY = false;

// ---- contrôleur aérien ------------------------------------------------------
// Trois gestes, trois effets, aucune ambiguïté avec la nage (dans l'eau, Espace reste
// le coup de palme et rien de tout ceci ne s'allume) :
//  - une pression au sol **saute** ;
//  - un **maintien** en l'air allume les réacteurs — on monte tant que la touche tient,
//    on retombe dès qu'on la lâche ;
//  - une **seconde pression** en l'air ouvre le plané : la trajectoire suit le regard,
//    Z (ou W) pousse le gaz, S le réduit — le nez décide de l'altitude, l'allure de la
//    portance. Une nouvelle pression rompt le plané et on redescend.
const JET_SPEED = 9;            // montée des réacteurs (cubes/s), sans jauge
const PLANE_MIN = 4;            // allure minimale du planeur
const PLANE_DEFAUT = 14;        // allure à l'ouverture du plané
const PLANE_MAX = 34;           // allure maximale au gaz
const PLANE_THRUST = 16;        // cubes/s gagnés ou perdus par seconde de touche tenue
const PLANE_LIFT_SPEED = 16;    // au-delà de cette allure, le planeur ne perd plus de hauteur
const PLANE_SINK_MAX = 7;       // perte d'altitude à l'arrêt complet (cubes/s)

// Player collider: axis aligned box, camera sits at eye level.
const PLAYER_HALF_WIDTH = 0.3;
const PLAYER_HEIGHT = 1.8;
const EYE_HEIGHT = 1.62;
const STEP_HEIGHT = 1.0;      // auto climb for single blocks
const MAX_SUBSTEP = 0.2;      // swept movement granularity, keeps fast falls from tunnelling
const COLLIDE_EPS = 1e-3;
const GROUND_PROBE = 0.06;    // how far below the feet we look for ground
const TERMINAL_VELOCITY = 60;
const KILL_Y = -24;           // below this the player fell out of the world

// ---- nage -------------------------------------------------------------------
// Entrer dans l'eau change de contrôleur, pas seulement de gravité. Trois choses le
// définissent et aucune ne se déduit du code de la marche :
//  - le corps est **rappelé à la ligne de flottaison** et s'y tient, la tête hors de
//    l'eau : sans ce rappel, un nageur coule doucement au fond et n'en revient qu'au
//    prix d'un Espace maintenu ;
//  - l'élan **se dissipe** au lieu de s'interrompre net comme contre un mur ;
//  - Espace et Majuscule ne sautent plus : ils montent et coulent, et sortir de l'eau
//    se hisse jusqu'à deux cubes de berge (`SWIM_STEP`), là où la marche n'en franchit
//    qu'un.
const SWIM_SPEED = 4.4;       // déplacement horizontal dans l'eau (~0,55 × la marche)
const SWIM_UP = 4.6;          // vitesse de remontée sur Espace
const SWIM_DOWN = 3.6;        // vitesse de plongée sur Majuscule
// Flottaison : un ressort amorti tient le corps à la ligne, et plus bas l'eau ne vous
// éjecte plus. L'ancien rappel tout-ou-rien (24 vers le haut sous la ligne, 8 vers le
// bas au-dessus, avec une bande morte de 0,05 cube) orbite autour de l'équilibre sans
// jamais s'y poser : mesuré le 2026-11-08, ±0,016 cube à ~12 Hz au repos — le « petit
// tremblement » vu en surface — et 4,6 cubes/s de remontée dès qu'on lâche Majuscule,
// ce qui empêchait de rester au fond. La vitesse n'est plus intégrée à coups d'accélération :
// elle **rejoint** une vitesse visée, d'où l'absence de rebond.
const FLOT_BAND = 2.5;        // cubes sous la ligne où le corps est encore tenu par le ressort
const FLOT_GAIN = 7;          // raideur du ressort de surface : vitesse visée = écart × gain
const FLOT_RAISE = 3.4;       // plafond de la remontée dans le bandeau
const FLOT_DRIFT = 1.4;       // loin de la ligne, on remonte doucement au lieu de fuser
const VERT_RESPONSE = 10;     // réponse verticale vers la vitesse visée (1/s)
const WATER_DRAG_XZ = 4;      // amortissement horizontal
const FLOAT_SUBMERGED = 1.0;  // cubes du corps sous l'eau au repos (sur PLAYER_HEIGHT)
const SWIM_STEP = 2;          // hauteur de berge qu'un nageur peut escalader
const SWIM_REACH = 0.35;      // le coup de palme qui hisse au-dessus d'un ressaut juste trop haut
// La lave est `liquid` comme l'eau — c'est ce qui la rend translucide et non solide —
// mais elle ne se nage pas : on s'y enfonce à vitesse bornée, sans chute libre.
const LAVE_CHUTE = -2.5;      // plafond de descente dans la lave
// Assiette de flottaison, réglable au clavier (+ et -) : cubes du corps sous l'eau au
// repos. Le minimum laisse la tête largement hors de l'eau, le maximum plonge jusqu'à
// avoir les cheveux dessous sans aller jusqu'au fond.
const ASSIETTE_MIN = 0.6;
const ASSIETTE_MAX = PLAYER_HEIGHT + 0.6;
const ASSIETTE_PAS = 0.2;

// ---- configurable view depth (start-screen settings) ----
const SETTINGS_STORAGE_KEY = 'mincraft_settings';
const MIN_RENDER_DISTANCE = 2;
const MAX_RENDER_DISTANCE = 32;
const DEFAULT_RENDER_DISTANCE = 4;
const CHUNK_STREAM_BUDGET = 16;   // cells generated synchronously when the slider moves
// Le même geste borné en **temps**, pas seulement en nombre de cellules : mesuré
// 2026-11-16, seize cellules à la portée maximale coûtent 250-290 ms sous le logiciel de
// rendu des tests (et davantage quand d'autres onglets tournent), ce qui veut dire que la
// promesse du commentaire ci-dessous — « un saut à 32 ne doit pas verrouiller l'onglet » —
// n'était tenue que par chance. Une cellule coûte ici ce qu'elle coûte ; seule la durée de
// la tranche est garantie.
const CHUNK_JUMP_MS = 24;         // wall-clock ceiling for that same synchronous slice
const WORLD_BOOT_BUDGET = 169;    // 13×13 cells built synchronously under the player
const CHUNK_FRAME_MS = 10;        // wall-clock ceiling for world building per frame
// Le mailleur ne prend plus une tranche fixe : il prend **la marge laissée par l'image**.
// Mesuré le 2026-11-17 sur la traversée froide/chaude, le p95 du temps d'image atteint
// 93 ms pendant qu'on avance ; les 10 ms fixes s'ajoutaient alors à une image déjà
// saturée et fabriquaient leur propre sacade. À 60 images/s la formule rend exactement
// les 10 ms d'avant, donc le comportement connu du jeu est gardé tel quel.
const CIBLE_IMAGE_MS = 16.7;      // une image à 60 Hz : en dessous, on peut oser mailler
const BUDGET_MAILLE_MIN_MS = 2;   // jamais zéro : si l'image est chère pour une autre raison
                                  // (remplissage, autre onglet), couper le flot n'y changerait
                                  // rien et le monde ne se chargerait plus du tout
const BUDGET_MAILLE_MAX_MS = 20;  // deux fois l'ancienne tranche, pour rattraper le pop-in
                                  // plus vite tant que l'image a de la place
// Netteté : le rendu se paie en pixels, et c'est le seul plafond que le joueur ne pouvait
// pas toucher. Sans réglage le jeu prenait `min(devicePixelRatio, 2)`, ce qui sur un Windows
// à 150 % rend 2,25 fois plus de pixels qu'à 1× — mesuré +37 % d'images par seconde rien
// qu'en redescendant de ×2 à ×1 (12,1 → 16,6 i/s sous rasteriseur logiciel). « native » est
// très exactement l'ancien comportement, donc personne ne perd son image en mettant à jour.
const NETTETES = ['native', '1', '0.75', '0.5'];
const NETTETE_DEFAUT = 'native';
const PLAFOND_PIXELS_PAR_IMAGE = 2;   // jamais au-delà de ce que le jeu faisait avant ce réglage
const CHUNK_MESH_WATERMARK = 64;  // stop generating when this many chunks await meshing
// Part du tri offerte à la direction du regard : un tronçon droit devant est compté
// comme s'il était un peu plus proche. Sans ce biais, le joueur qui vole au planeur
// creuse son propre trou : mesuré le 2026-11-15 sur trois vols appariés de dix-huit
// secondes à 34 cubes/s et rayon 8, il manquait un tronçon dans l'axe du regard sur
// 58 à 100 % des images ; avec 0,3, sur 12 à 37 %, pour 1,7 image/s perdue. Le réglage
// a été poussé jusqu'à 0,5 — le trou tombe alors sous 8 % des images, mais au prix de
// 5,5 i/s : trois fois plus cher pour un gain marginal. Ce qui ne se reverra jamais
// (derrière le joueur) ne mange donc plus le créneau d'image.
const BIAIS_DEVANT = 0.3;
// ---- budget mémoire des mailleurs ----
// Un tronçon maillé coûte 330 Ko de tampons sommets (mesuré le 2026-11-16 : cinq
// attributs float32 pour ~6 600 sommets, index uint16 compris — 51 o/sommet). Les
// jeter dès qu'ils sortent du champ se paie cher : mesuré le même jour, faire retomber
// la profondeur de 12 à 2 puis la remonter coûte **2 129 reconstructions de mailleurs**
// pour un rendu strictement identique — 5 à 7 secondes de calcul et le pop-in que le
// joueur voit en faisant demi-tour. On garde donc ce qui a déjà été maillé tant que la
// note totale tient sous un plafond, et on n'évince que ce qu'il faut, du plus ancien
// hors de vue.
//
// Le plafond se lit sur le navigateur quand il le dit (`performance.memory`) ; sinon on
// reste au défaut ci-dessous plutôt que de deviner avec `navigator.deviceMemory`, qui
// annonce la barrette du poste (32 Go mesurés ici) et non ce qu'un onglet peut tenir.
// Deux gouvernails, dans cet ordre : la fraction du tas **autorisé**, puis le plafond.
// Mesuré le 2026-11-16 sur ce poste : `jsHeapSizeLimit` = 4 192 Mo pour l'onglet (la RAM
// système ne change rien à ce chiffre, c'est V8 qui le borne), 130 Mo usés au démarrage.
// À 0,35 de la limite cela donne 1 467 Mo, sous le plafond — donc c'est bien la fraction
// qui gouverne sur un gros onglet, et le plafond qui sert de garde-fou sur les petits.
// Note : la note ne compte que les tampons sommets ; objets Three et copie GPU ajoutent
// 10 à 20 % en pratique, d'où la marge laissée sous la moitié du tas.
const QUOTA_GEOMETRIE_DEFAUT = 384 * 1024 * 1024;   // ~1 160 tronçons gardés à chaud
const QUOTA_GEOMETRIE_PLANCHER = 96 * 1024 * 1024;  // sous ce seuil, autant évincer sec
const QUOTA_GEOMETRIE_PLAFOND = 1536 * 1024 * 1024; // ~4 360 tronçons : le disque entier à r=32
const QUOTA_GEOMETRIE_FRACTION = 0.35;              // part du tas *autorisé* laissée aux géométries
// Garde-fou d'urgence : au-delà de cette part du tas occupée, on ne discute plus l'éviction.
const PRESSION_TAS = 0.75;
const QUOTA_REFRESH_MS = 1000;                      // `performance.memory` n'a pas besoin de l'être plus
// Au-delà de `radius + GARDE_HORS_VUE`, on jette quoi qu'en dise le budget : la table
// des tronçons doit rester bornée quand le joueur court dans une seule direction.
const GARDE_HORS_VUE = 8;
// Le nombre de couronnes qu'on continue de tenir à la scène au-delà de la portée réglée.
// Une seule constante, partagée avec le four de fond (`cuireIleGeometrie`) et son lâcher
// (`_lacherTronconCuit`) : mesuré le 2026-11-16 dans le monde du joueur à profondeur 8,
// le rangeur rattachait jusqu'à `radius + 2` pendant que le four ne se défendait que
// jusqu'à `radius + 1`. La couronne du milieu était donc peinte par l'un et taillée hors
// scène par l'autre — 36 repeintures à chaque demi-tour sur place, toutes à `dist ==
// radius + 2`, dont 11 derrière un tronçon que le four venait de mailler. Ce que la
// caméra voit, le four n'y touche pas ; c'est la même frontière, pas deux voisines.
const MARGE_CHAMP_RENDU = 2;
// Le champ rendu est un carré `(2r+1)²`; la brume, elle, ferme un cercle à
// `r·16·0,98`. Mesuré le 2026-11-18 sur un coin vierge à profondeur 12: **29 % des
// mailles et 31 % des triangles** pendaient à la scène au-delà de la brume pleine — payés
// au maillage (2,5–3,2 ms pièce), au tas, au tri caché du four et au frustum, pour rendre
// exactement ce que la brume peignait déjà. On ne maille donc ni n'accroche ce que la
// brume efface: la frontière devient le carré **et** le disque. La marge couvre l'assiette
// d'un arbre dont le tronc est juste dedans et la cime derrière la brume. Jugée sur la
// brume **sèche** (`brumeSere.far`), jamais `scene.fog.far`: l'averse serre la brume vers
// l'intérieur, et une frontière qui la suivrait culotterait la couronne à chaque averse
// pour la repeindre à chaque éclaircie.
const MARGE_BRUME = 1;

// ---- géométrie déjà prête pour la carte, sur le disque ----
// Un tronçon repeint coûte 6,94 ms au mailleur ; reposer ses tampons depuis un fichier
// n'en coûte que 0,29 (mesuré le 2026-11-16, 40 tronçons, 329 972 sommets). Le cache
// d'île économise la génération du terrain, celui-ci économise le maillage — et il ne
// sert à rien si sa forme change : **incrémenter `MAILLE_VERSION` dès que la sortie du
// mailleur change** (attribut ajouté, seau renommé, uv recalculés), sinon un monde
// retrouverait des triangles d'hier peints avec les règles d'avant-hier.
const MAILLE_VERSION = 1;
// Taille du fichier : **calculée, plus réglée**. Ce chiffre borne ce que le disque accepte,
// jamais ce que l'onglet garde en mémoire (c'est le quota ci-dessus qui gouverne). La règle
// est celle du quota de géométrie : une part du tas **autorisé**
// (`performance.memory.jsHeapSizeLimit`), jamais du tas *libre* — assise sur le libre elle
// s'auto-réprimerait en se remplissant, et pire qu'en mémoire : changer la taille du cache
// ici jette le fichier relu et repart de zéro (`reglerBudgetGeom`). Le tas gouverne pourtant
// bien un fichier, parce que ses octets y transitent — blocs compressés en file, ~420 Ko
// pièce — et que le serveur les relit entiers avant de les valider.
//
// Mesuré le 2026-11-16 : un tronçon quantifié et compressé pèse 23,6 Ko, l'île par défaut
// (~31 400 tronçons) demande donc ~740 Mo. À 0,25 du tas, un onglet Chrome de 4 096 Mo — le
// chiffre relevé sur ce poste — reçoit 1 024 Mo : exactement le palier qui laissait la place
// de prétailler l'île entière. Un petit onglet descend à son échelle et le four s'arrête en
// le disant (`sature` + motif) plutôt que de promettre un fichier que le navigateur ne peut
// pas charrier. Le plafond reste sous celui que le serveur accepte de lire en mémoire
// (`MAX_GEOM_BYTES` = 2 304 Mo) : lui promettre plus, c'est garantir un 400 à la première
// publication.
const GEOM_BUDGET_FRACTION = 0.25;
const GEOM_BUDGET_PLANCHER_MO = 128;          // ~5 400 tronçons : le proche reste chaud
const GEOM_BUDGET_PLAFOND_MO = 2048;          // sous MAX_GEOM_BYTES du serveur
const GEOM_BUDGET_DEFAUT_MO = 1024;           // navigateur muet sur son tas (Safari, headless)
// Le chiffre ne bouge plus une fois posé : une taille de cache qui oscille serait une
// taille de cache qui se vide. Seule la reprise en main des suites le fait varier.
const geomBudget = { mo: 0, force: null, source: '' };

/** Part du tas autorisé laissée au fichier de triangles, en mégaoctets. */
function dimensionnerBudgetGeom() {
  if (geomBudget.force !== null) return geomBudget.force;
  if (geomBudget.mo) return geomBudget.mo;
  const m = typeof performance !== 'undefined' && performance.memory ? performance.memory : null;
  if (m && Number.isFinite(m.jsHeapSizeLimit) && m.jsHeapSizeLimit > 0) {
    const limiteMo = m.jsHeapSizeLimit / 1048576;
    geomBudget.mo = Math.min(GEOM_BUDGET_PLAFOND_MO,
      Math.max(GEOM_BUDGET_PLANCHER_MO, Math.round(limiteMo * GEOM_BUDGET_FRACTION)));
    geomBudget.source = `${Math.round(limiteMo)} Mo de tas autorisé`;
  } else {
    geomBudget.mo = GEOM_BUDGET_DEFAUT_MO;
    geomBudget.source = 'défaut — navigateur muet sur son tas';
  }
  return geomBudget.mo;
}
/** Ce que le fichier a droit d'occuper, en octets (0 = cache éteint). */
function budgetGeomOctets() {
  return (geomBudget.force !== null ? geomBudget.force : dimensionnerBudgetGeom()) * 1048576;
}
// Cuisson de fond : ce qu'on prête au mailleur par image quand le joueur a déjà son
// champ sous les pieds. Assez pour tailler un tronçon par image, pas assez pour que
// l'image déborde pendant qu'on joue.
const CUISSON_FOND_MS = 5;
// Le crédit du four quand le joueur a demandé lui-même de graver l'île depuis le menu.
// L'écran d'accueil est opaque et ne rend rien : ce temps ne vole aucune image, et c'est
// ce qui fait passer la cadence de 8,6 à 19,6 tronçons/s (mesuré le 2026-11-16 sur six
// fenêtres de 60 s — l'île entière en 29 min au lieu de 66). Il reste borné pour que la
// barre se rafraîchisse et que le menu réponde au clic.
const CUISSON_PRECUISON_MS = 300;
const CUISSON_PUBLIER_A = 48;             // des octets déjà payés attendent moins longtemps
// Halos d'éditions dont dépend la lumière d'un tronçon : une lanterne posée à trois
// cubes éclaire les murs du voisin, donc son empreinte doit porter au-delà de ses bords.
const GEOM_HALO_CHUNKS = 2;
// Files d'attente de cuisson : au-delà, on publie sans attendre l'autosauvegarde, et on
// cesse d'empiler des blocs compressés en mémoire (32 × ~420 Ko copiés, soit ~13 Mo
// transient — la file doit rester plus légère que ce qu'elle évite de recalculer).
const GEOM_PUBLIER_A = 12;
const GEOM_PUBLIER_APRES_MS = 5000;
const GEOM_EN_ATTENTE_MAX = 32;
// Au-delà de cette taille, changer le gabarit de l'en-tête (passer à la table réservée qui
// permet d'ajouter sans rien déplacer) ne se paie plus : c'est le serveur qui copie ses
// propres octets (`POST /world-geometry/migrer`). On ne laisse quand même pas cette
// réécriture tomber sous le joueur — 618 Mo de table et de copie, ce n'est pas une pause
// de deux millisecondes. Elle attend le repos, voile posé.
const MIGRATION_CACHE_HORS_REPOS_OCTETS = 32 * 1024 * 1024;
// Et au-delà de celle-ci, la réécriture complète est interdite : le navigateur ne sait pas
// envoyer un tel corps (mesuré le 2026-11-17 : `ERR_BLOB_OUT_OF_MEMORY` à 592 Mo, onglet
// écrasé avec la vue nue). Le cache reste lisible ; le vider le refait par ajouts.
const PLAFOND_ENVOI_NAVIGATEUR_OCTETS = 128 * 1024 * 1024;
// Deux tentatives de migration ne se suivent pas de près : juger si elle est possible coûte
// vingt millisecondes sur les 23 024 lignes du cache du joueur (mesuré le 2026-11-17), ce
// qui ferait un pic toutes les images derrière le voile si un refus faisait réessayer tout
// de suite. Le refus reste affiché, il est juste rejugé toutes les vingt secondes.
const MIGRATION_ESPACE_MS = 20000;
// Combien de temps un tronçon que le fichier sait peindre a le droit d'attendre sa
// décompression avant qu'on se résolve à le mailler. Le délai doit couvrir la profondeur
// de la file de réchauffement, pas seulement une décompression : à 400 ms les tronçons
// pressés expiraient derrière l'anticipation et étaient mailles pour rien (85 sur 141).
// Une décompression coûte moins d'un millième du maillage évité ; le plafond n'existe que
// pour un fichier muet ou corrompu.
const ATTENTE_DISQUE_MS = 1200;
// Le temps qu'on laisse à la lecture du fichier de géométrie pour précéder le premier
// maillage d'un monde. Le maillage coûte 6,9 ms par tronçon et le disque les sait déjà
// peindre : peindre pendant cette attente est du travail perdu (mesuré 130 reconstructions
// sur 154 payées pendant ce seul intervalle). Au-delà du plafond, un serveur muet ne doit
// pas immobiliser le monde — on maille comme si le cache n'existait pas.
const ATTENTE_CACHE_GEOM_MS = 1500;
// Parois de référence pour juger une première publication (voir `majMurs`) : quatre
// tampons partagés par tout le monde plutôt qu'un jeu alloué à chaque tronçon maillé.
const PLAN_VIDE = {
  w: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
  e: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
  n: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
  s: new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT),
};
// Les quatre parois d'un tronçon, dans l'ordre où le maillage les lit (`mursSemences`).
const MURS_QUATRE = ['w', 'e', 'n', 's'];
// Les voisins dont la lumière cuite d'un tronçon hérite : les quatre cloisons et les
// quatre coins, le maillage lisant les deux avant de peindre.
const VOISINS_PROCHES = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

// ---- fiche du monde (écran de génération) ----
// Le slot se lit dans l'URL : c'est lui qui porte l'identité du monde, donc c'est lui
// qui choisit la fiche de génération. La fiche vit dans `localStorage` sous une clé par
// monde ET dans le fichier de sauvegarde ; ici on ne lit que le magasin local, parce
// que le relief doit être posé avant le premier tronçon, donc avant que la disquette
// ait répondu. La relecture du fichier garde un œil sur l'écart (voir `bootWorld`).
const SAVE_PARAMS = new URLSearchParams(window.location.search);
const SAVE_SLOT = SAVE_PARAMS.get('world') || 'default';
// `?ile=ignorer` court-circuite le cache d'île (lecture comme cuisson). Les suites qui
// ne jugent pas le chargement s'en servent : sans lui, chacune attendrait neuf minutes
// la première cuisson de son monde jetable.
const ILE_MODE = (SAVE_PARAMS.get('ile') || 'auto').toLowerCase();
// `?geom=ignorer` court-circuite le cache de géométrie dans les deux sens : ni lecture,
// ni écriture. Les suites qui ne jugent pas le maillage s'en servent — sans lui, elles
// publieraient dans le fichier du monde des triangles que leurs contrôles visuels
// n'auraient jamais eu l'intention de vérifier.
const GEOM_MODE = (SAVE_PARAMS.get('geom') || 'auto').toLowerCase();
// `?precuire=ignorer` tient le four de fond éteint pour la session. Le joueur veut l'île
// entière taillée, mais les suites qui comptent les passages au mailleur ne peuvent pas
// juger leurs compteurs pendant qu'un four en taille d'autres à côté : elles l'éteignent,
// comme elles éteignent déjà le cache d'île et le cache de triangles.
const PRECUIRE_MODE = (SAVE_PARAMS.get('precuire') || 'auto').toLowerCase();

function lireFicheDuMonde(slot) {
  try {
    const brut = localStorage.getItem(mondeStorageKey(slot));
    return clampMonde(brut ? JSON.parse(brut) : null);
  } catch (e) {
    // Une fiche illisible n'est pas un motif de ne pas jouer : le monde d'aujourd'hui.
    return clampMonde(null);
  }
}

const MONDE = lireFicheDuMonde(SAVE_SLOT);

// ---- world persistence ----
// The whole terrain is a pure function of these seeds, so the disk only ever has
// to carry the player's diff. Recording them in the save file is what makes a
// future seed change detectable instead of silently mangling saved worlds.
// Elles dérivent de la graine saisie à l'écran de génération (`mondeSeeds`) ; la
// dérivation est calée pour que la graine par défaut rende exactement les graines
// d'hier — 42, 123, 777, 999 — et qu'un monde ancien se régénère à l'identique.
const WORLD_SEEDS = mondeSeeds(MONDE.graine);
const WORLD_LOAD_TIMEOUT_MS = 5000;   // never hold the start screen hostage to a dead store
const PLAYER_SAVE_MOVE_SQ = 0.25 * 0.25; // how far the player must travel to warrant a write

// Two hosts share the game: the Express dev server and the Tauri desktop build,
// which has no server and keeps everything in its own application-data folder.
const tauriGlobal = window.__TAURI__;
const tauriCore = tauriGlobal ? tauriGlobal.core : null;

function clampRenderDistance(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return DEFAULT_RENDER_DISTANCE;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RENDER_DISTANCE;
  return Math.min(MAX_RENDER_DISTANCE, Math.max(MIN_RENDER_DISTANCE, Math.round(n)));
}

function loadSettings() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null'); } catch (e) { raw = null; }
  const stored = raw && typeof raw === 'object' ? raw : {};
  return {
    renderDistance: clampRenderDistance(stored.renderDistance),
    // La durée de la journée se règle comme la profondeur de champ ; à son défaut le
    // monde tourne à la cadence du projet, et un réglage absent du disque n'y change rien.
    dureeJour: bornerDuree(stored.dureeJour ?? DUREE_JOUR_DEFAUT),
    // La météo se règle comme la durée du jour : « auto » laisse le monde tirer ses
    // averses, les deux autres positions rendent le joueur maître du ciel.
    meteo: METEO_MODES.includes(stored.meteo) ? stored.meteo : 'auto',
    // Netteté du rendu. Une valeur hors liste (réglage d'un autre appareil, fichier édité
    // à la main) retombe sur « native », c'est-à-dire sur ce que le jeu faisait avant.
    netrete: NETTETES.includes(String(stored.netrete)) ? String(stored.netrete) : NETTETE_DEFAUT,
  };
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      renderDistance: settings.renderDistance,
      dureeJour: settings.dureeJour,
      meteo: settings.meteo,
      netrete: settings.netrete,
    }));
  } catch (e) {
    /* private mode: the setting simply does not survive */
  }
}

const settings = loadSettings();

// Block type IDs
const BLOCK = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, WOOD: 4,
  LEAVES: 5, SAND: 6, WATER: 7, PLANKS: 8, BRICK: 9,
  COAL: 10, IRON: 11, GOLD: 12, DIAMOND: 13,
  SNOW: 14, GRIT: 15, COBBLE: 16, GLASS: 17,
  MOSS: 18, LAVA: 19, OBSIDIAN: 20,
  LAMP_POST: 21, LAMP_GLOW: 22,
  // Quatre appliques murales, une par face d'adossement — le monde ne porte aucune
  // rotation de bloc, l'orientation vit donc dans l'identifiant.
  LAMP_WALL_O: 23, LAMP_WALL_E: 24, LAMP_WALL_N: 25, LAMP_WALL_S: 26,
};

// Block metadata.
//   solid    -> stops the player (glass and leaves do, water and lava do not)
//   opaque   -> hides neighbour faces and casts ambient occlusion
//   pass     -> 'opaque' | 'translucent' | 'cutout' (alpha tested foliage)
//   tiles    -> atlas tile names per face family
//   box      -> sub-cube geometry [x0,y0,z0,x1,y1,z1] in 0..1; the mesher draws that
//               box instead of the full cube, which is what lets a lamp post read as a
//               post. Box blocks are never culled by their neighbours.
//   emissive -> rendered with its own unlit material: it carries its light and stays
//               bright at midnight (a Lambert surface would just go grey with ambient)
//   breakable-> cassable alors que le bloc ne bloque pas la marche : le rayon de visée
//               s'y arrête quand même. Sans ce drapeau, une applique murale — non solide
//               par construction — serait impossible à viser donc à détruire.
const T = (side, top = side, bottom = side) => ({ side, top, bottom });

const BLOCK_INFO = {
  [BLOCK.GRASS]:     { name: 'Herbe',      colors: [0x4a8f3c, 0x8b6f47, 0x4a8f3c], solid: true,  opaque: true,  tiles: T('grass_side', 'grass_top', 'dirt') },
  [BLOCK.DIRT]:      { name: 'Terre',      colors: [0x8b6f47], solid: true,  opaque: true,  tiles: T('dirt') },
  [BLOCK.STONE]:     { name: 'Pierre',     colors: [0x888888], solid: true,  opaque: true,  tiles: T('stone') },
  [BLOCK.WOOD]:      { name: 'Bois',       colors: [0x6b4423], solid: true,  opaque: true,  tiles: T('log_side', 'log_top', 'log_top') },
  [BLOCK.LEAVES]:    { name: 'Feuilles',   colors: [0x2d5a27], solid: true,  opaque: false, pass: 'cutout', tiles: T('leaves') },
  [BLOCK.SAND]:      { name: 'Sable',      colors: [0xd4c48a], solid: true,  opaque: true,  tiles: T('sand') },
  [BLOCK.WATER]:     { name: 'Eau',        colors: [0x3a6fbf], solid: false, opaque: false, pass: 'translucent', liquid: true, tiles: T('water') },
  [BLOCK.PLANKS]:    { name: 'Planches',   colors: [0xa08050], solid: true,  opaque: true,  tiles: T('planks') },
  [BLOCK.BRICK]:     { name: 'Briques',    colors: [0x8b3a2f], solid: true,  opaque: true,  tiles: T('brick') },
  [BLOCK.COAL]:      { name: 'Charbon',    colors: [0x333333], solid: true,  opaque: true,  tiles: T('coal_ore') },
  [BLOCK.IRON]:      { name: 'Fer',        colors: [0xb8a080], solid: true,  opaque: true,  tiles: T('iron_ore') },
  [BLOCK.GOLD]:      { name: 'Or',         colors: [0xd4af37], solid: true,  opaque: true,  tiles: T('gold_ore') },
  [BLOCK.DIAMOND]:   { name: 'Diamant',    colors: [0x5ce8e8], solid: true,  opaque: true,  tiles: T('diamond_ore') },
  [BLOCK.SNOW]:      { name: 'Neige',      colors: [0xf0f0f0], solid: true,  opaque: true,  tiles: T('snow_side', 'snow_top', 'dirt') },
  [BLOCK.GRIT]:      { name: 'Gravier',    colors: [0x6b6b6b], solid: true,  opaque: true,  tiles: T('gravel') },
  [BLOCK.COBBLE]:    { name: 'Rocher',     colors: [0x707070], solid: true,  opaque: true,  tiles: T('cobble') },
  [BLOCK.GLASS]:     { name: 'Verre',      colors: [0xaaddff], solid: true,  opaque: false, pass: 'translucent', tiles: T('glass') },
  [BLOCK.MOSS]:      { name: 'Mousse',     colors: [0x3a6b35], solid: true,  opaque: true,  tiles: T('moss') },
  [BLOCK.LAVA]:      { name: 'Lave',       colors: [0xff4500], solid: false, opaque: false, pass: 'translucent', liquid: true, tiles: T('lava') },
  [BLOCK.OBSIDIAN]:  { name: 'Obsidienne', colors: [0x1a1a2e], solid: true,  opaque: true,  tiles: T('obsidian') },
  // Le lampadaire est un bloc en deux parties, cassables et posables séparément : le
  // pied de fonte (un quart de cube de section) et la lanterne qui le coiffe. La
  // lanterne est émissive — elle porte sa lumière — et c'est `eclairage.js` qui cuit
  // son halo dans les sommets des blocs qu'elle entoure.
  [BLOCK.LAMP_POST]: { name: 'Pied de lampadaire', colors: [0x3a3f47], solid: true, opaque: false, tiles: T('lamp_post'), box: [0.4, 0, 0.4, 0.6, 1, 0.6] },
  [BLOCK.LAMP_GLOW]: { name: 'Lanterne', colors: [0xffb733], solid: true, opaque: false, emissive: true, tiles: T('lamp_glow'), box: [0.28, 0.02, 0.28, 0.72, 0.86, 0.72] },
  // Appliques murales — demandé le 2026-11-11 : « dans les immeubles tu mis les lumières
  // devant les portes, il faudrait ajouter une lumière qui soit mise sur les murs pour
  // éviter de bloquer le passage ». Un candélabre occupe **toute sa case** à la marche —
  // la collision se juge à la cellule, pas à la boîte fine du poteau — donc dans un
  // couloir d'immeuble de deux cubes il condamnait le seuil des portes. L'applique est
  // scellée au mur et n'est **pas solide** : on passe à travers, comme l'eau. Elle reste
  // cassable grâce à `breakable`, qui la rend visible au rayon de visée malgré son
  // absence de solidité (l'eau et la lave, elles, traversent le rayon).
  // Les quatre boîtes s'adossent chacune à une face, dans l'ordre de MURALE_DIRS : ouest,
  // est, nord, sud. Une applique saillit de 0.32 hors du mur et occupe le haut de la case,
  // à hauteur de lampe — jamais le cube entier, qui lui barrerait le passage.
  ...Object.fromEntries([
    [[0, 0.62, 0.28, 0.32, 0.98, 0.72], BLOCK.LAMP_WALL_O],
    [[0.68, 0.62, 0.28, 1, 0.98, 0.72], BLOCK.LAMP_WALL_E],
    [[0.28, 0.62, 0, 0.72, 0.98, 0.32], BLOCK.LAMP_WALL_N],
    [[0.28, 0.62, 0.68, 0.72, 0.98, 1], BLOCK.LAMP_WALL_S],
  ].map(([boite, id], face) => [id, {
    name: 'Applique murale', colors: [0xffcb5e],
    solid: false, opaque: false, breakable: true, emissive: true,
    tiles: T('lamp_wall'), box: boite,
    // Une applique est un seul objet pour le joueur : la face qui la colle au mur se lit
    // sur le voisin au moment de la pose (`appliqueOriente`), donc les trois autres
    // identifiants ne sont que des variantes de la première et n'ont rien à faire au
    // catalogue — quatre icônes identiques ne laisseraient que deviner laquelle choisir.
    variant: face > 0,
  }])),
};

for (const info of Object.values(BLOCK_INFO)) {
  if (!info.pass) info.pass = 'opaque';
}

// Matériaux qui comptent comme de la roche pour l'éclairage : une cellule coiffée de
// l'un d'eux est sous terre, une cellule coiffée de planches ou de brique est une pièce.
const ROCHE_NATURELLE = new Set([
  BLOCK.STONE, BLOCK.DIRT, BLOCK.GRASS, BLOCK.COBBLE, BLOCK.GRIT, BLOCK.SAND,
  BLOCK.SNOW, BLOCK.MOSS, BLOCK.OBSIDIAN, BLOCK.COAL, BLOCK.IRON, BLOCK.GOLD, BLOCK.DIAMOND,
]);

// Les blocs qui portent un halo : la lanterne du candélabre et les quatre appliques
// murales. Une seule liste, sinon le maillage cuit le halo des unes et oublie celui des
// autres — `estLampe`, `lampesAutour` et le ré-emmaillage de `setBlocksBulk` doivent
// connaître les mêmes identifiants.
const LANTERNE_IDS = new Set([
  BLOCK.LAMP_GLOW, BLOCK.LAMP_WALL_O, BLOCK.LAMP_WALL_E, BLOCK.LAMP_WALL_N, BLOCK.LAMP_WALL_S,
]);
const estLanterne = (id) => LANTERNE_IDS.has(id);
// Les quatre appliques, dans l'ordre de leurs faces d'adossement (−x, +x, −z, +z).
const APPLIQUES = [BLOCK.LAMP_WALL_O, BLOCK.LAMP_WALL_E, BLOCK.LAMP_WALL_N, BLOCK.LAMP_WALL_S];
const MURALE_DIRS = [[-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]];

// Hotbar contents are player-editable through the inventory and persisted.
const HOTBAR_SIZE = 9;
const HOTBAR_STORAGE_KEY = 'mincraft_hotbar';
const DEFAULT_HOTBAR = [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.WOOD, BLOCK.PLANKS, BLOCK.BRICK, BLOCK.SAND, BLOCK.GLASS, BLOCK.DIAMOND];

// Every block type, grouped for the palette header rows.
const BLOCK_GROUPS = [
  { label: 'NATUREL', ids: [BLOCK.GRASS, BLOCK.DIRT, BLOCK.STONE, BLOCK.COBBLE, BLOCK.SAND, BLOCK.GRIT, BLOCK.SNOW, BLOCK.MOSS] },
  { label: 'CONSTRUCTION', ids: [BLOCK.WOOD, BLOCK.PLANKS, BLOCK.BRICK, BLOCK.GLASS, BLOCK.OBSIDIAN] },
  // Les quatre faces d'adossement ne forment qu'un seul meuble dans la palette : le monde
  // ne porte aucune rotation de bloc, donc c'est le mur visé qui choisit l'identifiant
  // (voir World.appliqueOriente). Proposer quatre icônes serait demander au joueur de
  // choisir une orientation qu'il ne peut pas voir d'avance.
  { label: 'ÉCLAIRAGE', ids: [BLOCK.LAMP_POST, BLOCK.LAMP_GLOW, BLOCK.LAMP_WALL_O] },
  { label: 'VÉGÉTAUX', ids: [BLOCK.LEAVES] },
  { label: 'MINERAIS', ids: [BLOCK.COAL, BLOCK.IRON, BLOCK.GOLD, BLOCK.DIAMOND] },
  { label: 'LIQUIDES', ids: [BLOCK.WATER, BLOCK.LAVA] },
];
// Le catalogue posable : chaque bloc qui n'est pas une variante déclarée doit tenir sa
// case en palette, sinon il devient introuvable pour le joueur. Les faces d'adossement
// d'une applique en sont l'exemple — une seule icône, la pose lit le mur pour choisir la
// face — tout en restant cassables et reconnues par le halo.
const ALL_BLOCKS = Object.keys(BLOCK_INFO).map(Number).filter((id) => !BLOCK_INFO[id].variant);

function loadHotbar() {
  try {
    const raw = localStorage.getItem(HOTBAR_STORAGE_KEY);
    if (!raw) return DEFAULT_HOTBAR.slice();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== HOTBAR_SIZE) return DEFAULT_HOTBAR.slice();
    return parsed.map((id) => (BLOCK_INFO[id] ? id : BLOCK.DIRT));
  } catch (e) {
    return DEFAULT_HOTBAR.slice();
  }
}

// ==================== NOISE ====================
// Le bruit simplex est dans `noise.js` : c'est la seule copie du projet depuis que
// celle-ci a cessé d'être dupliquée ici et dans un module mort.
const worldNoise = new SimplexNoise(WORLD_SEEDS.terrain);
const caveNoise = new SimplexNoise(WORLD_SEEDS.caves);
// Le plafond des boyaux, tiré d'un bruit distinct : sans lui `isCave` creusait la colonne
// du socle jusqu'à trois cubes de la surface, et chaque grotte devenait un puits de jour.
// Mesuré avant ce correctif, le fond d'une galerie à six cubes sous la terre tenait 0,87
// de lumière du ciel — aucune mine ne pouvait donc jamais devenir noire.
const caveToitNoise = new SimplexNoise(WORLD_SEEDS.caves + 31);

// ==================== TERRAIN GENERATION ====================
// Le profil du monde — plateaux, sillons plissés, massifs soulevés jusqu'à la neige —
// vit dans `terrain.js`, sans dépendance : les suites Node jugent ainsi exactement le
// relief que le navigateur dessine, et non une copie qui aurait dérivé.

// Les fabriques servent aussi à l'aperçu de l'écran de génération, qui doit juger la
// fiche en cours de réglage et non celle du disque. Elles ne tirent rien au hasard :
// seules la graine et la fiche entrent dans le monde.
function fabriquerRelief(monde, seuils = null) {
  return createTerrain({
    noise: new SimplexNoise(mondeSeeds(monde.graine).terrain),
    chunkHeight: CHUNK_HEIGHT,
    relief: reliefOverrides(monde, { chunkHeight: CHUNK_HEIGHT, seuils }),
  });
}

function fabriquerClimat(monde) {
  const t = fabriquerRelief(monde);
  return createBiomeGen({
    BLOCK, CHUNK_SIZE, CHUNK_HEIGHT,
    heightAt: (x, z) => t.rawHeight(x, z),
    roll: hashRoll,
    saltBase: (mondeSeeds(monde.graine).trees * 7919) | 0,
    seaLevel: t.RELIEF.seaLevel,
  });
}

const apercuDuMonde = createMondePreview({
  creerRelief: (m) => fabriquerRelief(m),
  creerClimat: fabriquerClimat,
  chunkHeight: CHUNK_HEIGHT,
  // La ligne de flottaison ne descend pas sous le plancher du relief et ne monte pas
  // jusqu'à l'altitude où le village commence à bâtir : au-delà, il n'y aurait plus ni
  // plage praticable ni terrain lotissable.
  merBornes: { min: RELIEF.minGround + 2, max: VILLAGE.minGround },
});

// Un monde laissé en l'état ne paie ni l'échantillonnage ni la bissection : c'est le
// cas de tous les mondes déjà enregistrés, antérieurs à cet écran.
const MONDE_SEUILS = memesMondes(MONDE, MONDE_DEFAULTS)
  ? {}
  : apercuDuMonde.seuils(MONDE);

const terrain = fabriquerRelief(MONDE, MONDE_SEUILS);

// La ligne de flottaison vient du relief : c'est lui qui décide où la terre s'arrête,
// le village et les biomes consultent la même valeur.
const SEA_LEVEL = terrain.RELIEF.seaLevel;

function getTerrainHeight(x, z) {
  return terrain.heightAt(x, z);
}

function isCave(x, y, z) {
  if (y < 4 || y > CHUNK_HEIGHT - 4) return false;
  const n = caveNoise.octave(x * 0.04, z * 0.04, 3, 0.5);
  if (n <= 0.35) return false;
  // Le boyau a un toit : sans lui le vide monte jusqu'à la couche de terre et la colonne
  // toute entière sert de conduit à la lumière du ciel, ce qui rendait l'underground
  // méconnaissable — une galerie creusée par le joueur restait en pleine lumière.
  // Le plafond oscille entre douze et trente-quatre cubes et reste toujours sous quatre
  // cubes de roche, jamais visible depuis la surface.
  const toit = Math.min(getTerrainHeight(x, z) - 4,
    12 + Math.round((caveToitNoise.octave(x * 0.02, z * 0.02, 2, 0.5) + 1) * 11));
  return y < toit;
}

/**
 * Le monde a des océans : poser le joueur au fond d'une baie le ferait nageur avant
 * même d'avoir lu l'écran d'accueil. L'apparition cherche donc un repli au sec en
 * anneaux croissants autour du point historique — et assez large pour ne pas être un
 * îlot d'un cube où l'on retombe à l'eau dès qu'on tourne.
 *
 * Les colonnes sont jugées à leurs coordonnées **entières**, comme la génération des
 * tronçons : `heightAt` évalue le bruit de détail à la position exacte, donc sonder
 * (x + 0,5, z + 0,5) répond une valeur qui peut différer de deux cubes de celle du
 * cube réellement posé — et promettre du sec au-dessus d'une colonne noyée.
 */
function findDrySpawn(originX = 8, originZ = 8) {
  const sec = (x, z) => {
    // Le plan d'eau, pas seulement la ligne de flottaison : une rivière court au-dessus
    // de la mer, et y naître serait nageur avant d'avoir lu l'écran d'accueil.
    if (getTerrainHeight(x, z) < terrain.waterTopAt(x, z) + 1) return false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (getTerrainHeight(x + dx, z + dz) < terrain.waterTopAt(x + dx, z + dz) + 1) return false;
    }
    return true;
  };
  if (sec(originX, originZ)) return [originX + 0.5, originZ + 0.5];
  for (let r = 1; r <= 64; r++) {
    for (let d = -r; d <= r; d++) {
      for (const [x, z] of [[originX + d, originZ - r], [originX + d, originZ + r],
        [originX - r, originZ + d], [originX + r, originZ + d]]) {
        if (sec(x, z)) return [x + 0.5, z + 0.5];
      }
    }
  }
  return [originX + 0.5, originZ + 0.5];
}
const SPAWN_XZ = findDrySpawn();

// Every random draw in the generator is a hash of the coordinates, never
// Math.random(): the save file only stores what the player changed, so a chunk
// regenerated on the next launch has to come out cube for cube identical to the
// first one — ores, roads and buildings included. `salt` keeps each family of
// draws (four ore types, lot layout, materials) statistically independent.
function hashRoll(x, y, z, salt) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
        ^ Math.imul(z | 0, 1274126177) ^ Math.imul(salt | 0, 2654435761);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// Roads, houses and apartment blocks live in their own module so they can be
// reasoned about — and unit tested under Node — apart from the renderer. The
// village seed is folded into the hash salts, which is why it is recorded in the
// save file: changing it must not silently reshape saved worlds.
const village = createVillageGen({
  BLOCK,
  CHUNK_SIZE,
  CHUNK_HEIGHT,
  heightAt: getTerrainHeight,
  roll: hashRoll,
  saltBase: (WORLD_SEEDS.buildings * 7919) | 0,
  seaLevel: SEA_LEVEL,
  // Rivières : la voirie et le bâti se jugent contre le plan d'eau local de chaque
  // colonne, pas contre la seule ligne de flottaison.
  waterTopAt: (x, z) => terrain.waterTopAt(x, z),
  // Très hautes montagnes : le village doit savoir où il monte. Ni immeuble ni ville
  // dans ces zones, seulement quelques hameaux (`VILLAGE.hamlet*`).
  alpsAt: (x, z) => terrain.alpsIntensity(x, z),
  // Densité urbaine et catégories d'immeuble réglées à l'écran de génération.
  reglages: villageOverrides(MONDE),
});

// ---- où naît un monde neuf ----
// Un monde qui sort du néant s'ouvre sous la colonnade d'un temple : le joueur découvre
// d'emblée ce que le village sait faire de mieux, et repart de là avec des repères. Un
// monde repris sur disque garde sa position enregistrée, et son point de re-naissance
// reste le repli au sec historique — changer cela téléporterait le joueur loin de chez
// lui à la première chute.
const APPARITION_TEMPLE_RAYONS = 6;   // ± six mailles de temple autour du repli au sec
let mondeVierge = false;               // aucun fichier sur le disque pour ce slot
let apparitionDuMonde = null;          // { x, y(pieds), z, yaw } | null
let apparitionResolue = false;

/** Le monument d'apparition, cherché une seule fois par session (le plan est coûteux). */
function resoudreApparition() {
  if (apparitionResolue) return apparitionDuMonde;
  apparitionResolue = true;
  try {
    apparitionDuMonde = village.apparitionDansTemple(
      SPAWN_XZ[0], SPAWN_XZ[1], APPARITION_TEMPLE_RAYONS);
  } catch (e) {
    // Un monde sans temple reste jouable : le repli au sec fait l'affaire.
    console.warn('Temple d’apparition introuvable :', e);
    apparitionDuMonde = null;
  }
  return apparitionDuMonde;
}

// Forêts, plaines et déserts vivent dans leur propre module, pour la même raison que
// le village : pensés et testés à part du moteur. Le prédicat `isBlocked` reprend la
// voirie et les emprises bâties — rien ne pousse sur une avenue ni dans un mur, et la
// couronne est sondée à ses coins avant d'être plantée.
const biomes = createBiomeGen({
  BLOCK,
  CHUNK_SIZE,
  CHUNK_HEIGHT,
  heightAt: getTerrainHeight,
  roll: hashRoll,
  saltBase: (WORLD_SEEDS.trees * 7919) | 0,
  isBlocked: (wx, wz) => village.blocksVegetation(wx, wz),
  seaLevel: SEA_LEVEL,
  riverAt: (x, z) => terrain.riverAt(x, z),
  // Parts de forêt et de désert réglées à l'écran, converties en seuils de climat par
  // l'étalonnage de l'aperçu.
  reglages: biomesOverrides(MONDE, MONDE_SEUILS),
});

// ==================== TEXTURE ATLAS ====================
const atlas = createTextureAtlas();

// Face table. Corner order is CCW seen from outside so FrontSide culling works,
// and uv follows the corner so textures stay upright on every face.
const FACE_KIND_TOP = 0, FACE_KIND_BOTTOM = 1, FACE_KIND_SIDE = 2;
const FACES = [
  { dir: [1, 0, 0],  kind: FACE_KIND_SIDE,   shade: 0.86, axis: 0,
    corners: [[1,1,0],[1,1,1],[1,0,1],[1,0,0]], uvs: [[0,1],[1,1],[1,0],[0,0]] },
  { dir: [-1, 0, 0], kind: FACE_KIND_SIDE,   shade: 0.86, axis: 0,
    corners: [[0,1,1],[0,1,0],[0,0,0],[0,0,1]], uvs: [[0,1],[1,1],[1,0],[0,0]] },
  { dir: [0, 1, 0],  kind: FACE_KIND_TOP,    shade: 1.00, axis: 1,
    corners: [[1,1,1],[1,1,0],[0,1,0],[0,1,1]], uvs: [[1,0],[1,1],[0,1],[0,0]] },
  { dir: [0, -1, 0], kind: FACE_KIND_BOTTOM, shade: 0.62, axis: 1,
    corners: [[1,0,0],[1,0,1],[0,0,1],[0,0,0]], uvs: [[0,0],[0,1],[1,1],[1,0]] },
  { dir: [0, 0, 1],  kind: FACE_KIND_SIDE,   shade: 0.76, axis: 2,
    corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
  { dir: [0, 0, -1], kind: FACE_KIND_SIDE,   shade: 0.76, axis: 2,
    corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], uvs: [[0,0],[1,0],[1,1],[0,1]] },
];

// Kept above 0.5 so stacked blocks still read as stepped rather than pitch black.
const AO_LEVELS = [0.60, 0.76, 0.88, 1.0];
const TANGENT_AXES = [
  [1, 2], // face along x -> sample in y/z
  [0, 2], // face along y -> sample in x/z
  [0, 1], // face along z -> sample in x/y
];

function tileNameFor(info, kind) {
  if (kind === FACE_KIND_TOP) return info.tiles.top;
  if (kind === FACE_KIND_BOTTOM) return info.tiles.bottom;
  return info.tiles.side;
}

// ==================== WORLD ====================
/**
 * Ajoute à un matériau éclairé le canal de lumière des lanternes : un attribut de
 * sommet `aLampe`, additionné en sortie de fragment après l'éclairage de scène.
 *
 * L'accroche se fait sur `<dithering_fragment>`, un include stable du Lambert qui
 * tombe tout à la fin du shader — plutôt que de toucher à la boucle de lumières, dont
 * la forme change d'une version de Three à l'autre. Si l'include venait à disparaître,
 * le remplacement ne ferait simplement rien : les lampes cesseraient d'éclairer, ce que
 * le contrôle de pixels de la suite `ciel` voit immédiatement.
 *
 * Le halo est **multiplié par le grain de l'atlas** (`mcGrainLampe`) : sans ça, une cave
 * éclairée perd sa texture. La raison est dans l'ordre des opérations — l'ambiante et le
 * soleil multiplient `diffuseColor` (donc la carte), alors que le canal, lui, s'ajoute
 * après tout. Sous un halo assez fort, le pixel devient ce terme additif, plat, et le
 * dessin de la pierre n'y est plus pour rien. Mesuré dans une galerie scellée à minuit,
 * mur à deux cubes d'une lanterne : retirer `map` du matériau divisait le grain par dix
 * sous ambiante seule (1,56 → 0,16) mais seulement par deux sous le halo (0,84 → 0,33) —
 * preuve que l'image était déjà celle du halo, pas de la roche.
 */
function brancherCanalLampe(material, uniforme) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uLampe = uniforme;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aLampe;\nvarying float vLampe;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampe = aLampe;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLampe;\nuniform vec3 uLampe;')
      // Saisi juste après `<map_fragment>`, donc avant `<color_fragment>` : là, `diffuseColor`
      // ne porte encore que la carte d'atlas, pas la couleur de sommet qui écrase tout sous
      // terre. Un matériau sans carte y lit simplement son blanc, le halo reste franc.
      .replace('#include <map_fragment>', '#include <map_fragment>\nvec3 mcGrainLampe = diffuseColor.rgb;')
      .replace('#include <dithering_fragment>',
        '#include <dithering_fragment>\ngl_FragColor.rgb += uLampe * vLampe * '
        + `mix(vec3(1.0), mcGrainLampe / ${CLARTE_ATLAS}, ${GRAIN_LAMPE});`);
  };
  // Deux matériaux qui ne diffèrent que par ce patch doivent quand même deux programmes.
  material.customProgramCacheKey = () => 'lampe';
}

/**
 * Teinte du halo jeté par les lanternes et les appliques — blanche, comme un lampadaire
 * municipal : l'ambre d'une lampe à huile peint la pierre des murs en jaune, ce que le
 * joueur voit aussitôt à minuit. Le globe reste ambré (c'est l'objet qui brille, pas la
 * lumière qu'il projette).
 *
 * Le gain de 0,74 compense la perte de luminance : le canal est additif donc perçu, et
 * (0,2126·1 + 0,7152·0,69 + 0,0722·0,4) = 0,735 était la luminance de l'ancien ambre.
 * Un blanc franc à (1,1,1) éclaircirait le cadre de 14 % — chiffre mesuré sur image,
 * rendu comparé teinte par teinte autour d'une lanterne isolée à minuit.
 */
const TEINTE_LAMPE = 0.74;

/**
 * Part du détail de l'atlas que le halo transporte, dans `brancherCanalLampe`. À zéro, le
 * halo est plat — c'est le défaut signalé (« les textures ont disparu dans les caves quand
 * il y a de la lumière ») : mesuré dans une galerie scellée à minuit, retirer la carte du
 * matériau ne coûtait qu'un grain de 0,84 → 0,33 sous le halo, contre 1,56 → 0,16 sous une
 * lumière qui multiplie l'albédo. Le pixel n'était plus à la roche, il était au halo.
 *
 * La modulation est **divisée par `CLARTE_ATLAS`**, la luminance moyenne de l'atlas (0,372,
 * comptée en parcourant son canevas). Sans cette division, multiplier par une carte qui
 * moyenne à 0,37 éteindrait les lampes des deux tiers — mesuré 50,7 → 29,1 de luminance
 * dans la même galerie. Normalisée, elle rend le grain (0,84 → 2,00, la référence de jour
 * étant 1,56) pour 9 % de lumière seulement (50,7 → 46,2), et 0 % de pixel écrêté.
 */
const GRAIN_LAMPE = 0.7;
const CLARTE_ATLAS = 0.372;

class World {
  constructor(scene) {
    this.scene = scene;
    this.chunks = new Map();
    this.modifiedBlocks = new Map(); // key: "x,y,z" -> blockId (player modifications)
    this.onEdit = null;              // save layer hooks this: the diff just changed
    this._overrideIndex = null;      // chunkKey -> Map(cellIndex -> id), see _indexOverrides
    this._lampIndex = null;          // lanternes posées par le joueur, voir lampesAutour
    this.pendingChunks = 0;          // in-range cells still waiting to be generated
    this.dirtyKeys = new Set();      // chunks awaiting a (re)mesh
    // Comptabilité du budget de géométrie (voir QUOTA_GEOMETRIE_* ci-dessus) : la somme
    // des tampons sommets des tronçons tenus en mémoire, le quota couramment admis, et
    // l'instant où il a été relu pour la dernière fois.
    this.octetsMailles = 0;
    this.quotaGeometrie = QUOTA_GEOMETRIE_DEFAUT;
    this._quotaVu = 0;
    this.quotaForce = null;          // réglage de test : impose un quota sans le navigateur
    // Cache d'île (voir `public/js/ile.js`) : null tant qu'aucun fichier valide n'a été
    // relu pour ce monde. Quand il est là, un tronçon connu arrive tout cuit.
    this.cacheIle = null;
    // ---- géométrie déjà prête pour la carte (voir `public/js/geom-disque.js`) --------
    // Le cache d'île économise la génération du terrain ; celui-ci économise le maillage,
    // trois fois plus cher. Il ne se substitue jamais au mailleur : il l'évite, et seulement
    // quand l'empreinte du tronçon dit que rien n'a bougé depuis l'écriture.
    this.cacheGeom = null;           // fichier relu du disque, null si absent ou périmé
    this.ecrivainGeom = null;        // contenu annoncé du fichier à la prochaine publication
    this.geomEnAttente = new Map();  // cle -> {cx, cz, octets, empreinte} cuits, pas encore publiés
    this.geomACuire = new Set();     // clefs maillées mais sans place en file : à cuire dès qu'il y en a
    this.geomDepuis = 0;             // instant du premier élément en attente
    this._signatureAtlas = null;     // change dès qu'une tuile est remplacée
    this.cuissonIle = null;          // plan de cuisson de toute l'île, voir `demarrerCuissonIle`
    // La pré-cuisson n'est plus un réglage du joueur, mais une suite qui compte les
    // passages au mailleur doit pouvoir l'éteindre pour la session (`precuireIleMaintenant`).
    // `cuissonIle === false` ne suffit pas à le dire : c'est aussi l'état « le four n'a pas
    // pu démarrer », que le voile s'empresse de réarmer (voir la branche `enVeille`).
    this.cuissonIleVoulue = true;
    this._chauffeGeom = null;        // réchauffement en vol : un seul pompateur à la fois
    this._fileChauffe = new Map();   // cle -> [cx, cz], demandes arrivées pendant le pompage
    // Compteurs de test : ce que le mailleur a réellement payé depuis le dernier relevé,
    // et ce que le disque lui a évité. Un cache qui marche doit faire tomber le premier.
    this._rebuilds = 0;
    this._rebuildsDepuisDisque = 0;
    this._geomMotifs = {};           // pourquoi une pose depuis le disque a été refusée
    // La file de maillage est tenue dès ici, pas au premier mot de `bootWorld` : la boucle
    // d'image tourne déjà quand l'amorçage pose le joueur, et 86 tronçons se maillaient
    // pendant ce seul intervalle sans que le disque ait eu son mot à dire. La garde se lève
    // dans le `finally` de `chargerCacheGeom`, y compris quand le réglage est à zéro ; le
    // plafond horaire la lève de toute façon si l'amorçage n'aboutit jamais.
    this.cacheGeomEnCours = GEOM_MODE === 'ignorer' ? 0 : performance.now();
    this._offsetCle = null;          // cached nearest-first offset table, keyed by radius+heading
    this._offsets = [];
    this._centre = null;             // chunk du joueur, pour trier à partir de lui
    this._camX = 0;                  // pied de la caméra, centre du disque de brume
    this._camZ = 0;
    this._brumeCarres = Infinity;    // (far + marge)² : Infinity tant que le ciel n'a pas parlé
    this._dir = { x: 0, z: 0 };      // direction du regard, pour servir l'avant en premier

    // ---- eau courante -------------------------------------------------------
    // Le monde ne stocke que le diff du joueur ; l'eau de passage y a donc sa propre
    // table de distances. Une cellule d'eau absente de cette table est une **source**
    // (mer, rivière, seau posé) : pérenne, cube plein, distance 0. Toute cellule d'eau,
    // source ou de passage, occupe le cube entier.
    this.eauNiveaux = new Map();     // key: "x,y,z" -> distance à la source (1..EAU.PORTEE)
    this._enEau = false;             // garde : l'automate ne doit pas se réveiller lui-même
    this.eau = creerEau({
      height: CHUNK_HEIGHT,
      ID_AIR: BLOCK.AIR,
      ID_EAU: BLOCK.WATER,
      bloc: (x, y, z) => this.getBlock(x, y, z),
      niveau: (x, y, z) => this.eauNiveaux.get(`${x},${y},${z}`) ?? null,
      solide: (x, y, z) => this.isSolid(x, y, z),
      charge: (x, z) => this.chunks.has(this.getChunkKey(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE))),
      ecrire: (cells) => this._ecrireEau(cells),
    });

    this.matOpaque = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: false,
      side: THREE.FrontSide,
    });
    this.matTrans = new THREE.MeshLambertMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.3,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
    // Les blocs qui portent leur lumière (la lanterne) ne doivent pas pâlir avec
    // l'ambiante : un Lambert à minuit rendrait un gris. Matériau non éclairé.
    this.matGlow = new THREE.MeshBasicMaterial({
      map: atlas.texture,
      vertexColors: true,
      transparent: false,
      side: THREE.FrontSide,
    });
    // Le halo des lanternes arrive en addition, après l'éclairage de scène : la couleur
    // de sommet sert d'albédo et porte déjà l'obscurité des grottes, donc une lumière
    // multipliée par cet albédo n'éclairerait jamais une galerie noire. Un attribut
    // propre au maillage (`aLampe`) et un uniforme partagé entre les deux matériaux
    // éclairés font le travail — éteindre les lampes de ville ne coûte qu'une valeur.
    this.uniformeLampe = { value: new THREE.Color().setRGB(TEINTE_LAMPE, TEINTE_LAMPE, TEINTE_LAMPE) };
    brancherCanalLampe(this.matOpaque, this.uniformeLampe);
    brancherCanalLampe(this.matTrans, this.uniformeLampe);
  }

  getChunkKey(cx, cz) {
    return `${cx},${cz}`;
  }

  getBlock(x, y, z) {
    // Check modified blocks first
    const key = `${x},${y},${z}`;
    if (this.modifiedBlocks.has(key)) {
      return this.modifiedBlocks.get(key);
    }

    // Check chunk data
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const chunk = this.chunks.get(this.getChunkKey(cx, cz));
    if (!chunk) return BLOCK.AIR;

    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= CHUNK_HEIGHT) {
      return BLOCK.AIR;
    }

    return chunk.data[lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE] || BLOCK.AIR;
  }

  setBlock(x, y, z, blockId) {
    this.setBlocksBulk([[x, y, z, blockId]]);
  }

  // One remesh per touched chunk instead of one per block: a cuboid fill writes
  // thousands of cells and must not pay for thousands of chunk rebuilds.
  //
  // `options.differe` hands the remesh to the streaming queue instead of paying for it on
  // this frame — what the fluid uses, so a flood creeping over nine chunks cannot stutter.
  // `options.fluide` set to false skips the wake-up call (the fluid's own writes must not
  // re-arm themselves).
  setBlocksBulk(cells, options = {}) {
    const differe = !!options.differe;
    const duJoueur = options.fluide !== false;
    const touched = new Set();
    for (const [x, y, z, blockId] of cells) {
      const avant = this.getBlock(x, y, z);
      const etaitLampe = estLanterne(avant);
      // Une applique posée par le joueur s'oriente toute seule : on choisit la face dont
      // le mur est plein derrière elle, faute de quoi elle flotterait adossée au vide.
      const id = APPLIQUES.includes(blockId) ? this.appliqueOriente(x, y, z, blockId) : blockId;
      this.modifiedBlocks.set(`${x},${y},${z}`, id);
      // Une édition du joueur efface la distance enregistrée : l'eau qu'elle pose est une
      // source, pas un filet en sursis, et rien ne doit rester d'un filet là où le joueur
      // vient de couler du béton. L'automate, lui, écrit ses propres distances (garde
      // `_enEau`) et n'est donc pas concerné par cette tonte.
      if (duJoueur) this.eauNiveaux.delete(`${x},${y},${z}`);
      this._touchedChunks(x, y, z, touched);
      const pleinAvant = avant !== BLOCK.AIR && !!BLOCK_INFO[avant]?.opaque;
      const pleinApres = id !== BLOCK.AIR && !!BLOCK_INFO[id]?.opaque;
      if (pleinAvant !== pleinApres) this._touchLumiere(x, z, touched);
      // Poser ou arracher une lanterne change l'éclairage des tronçons d'à côté, pas
      // seulement de celui qui la porte : son halo porte à neuf cubes, et un tronçon
      // voisin maillé avant resterait clair là où le nouveau-né éteint tout — ou
      // s'obscurcirait pour une lanterne que le joueur vient d'arracher.
      if (estLanterne(id) || etaitLampe) {
        const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) this.markChunkDirty(cx + dx, cz + dz);
        }
      }
    }
    this._overrideIndex = null;
    this._lampIndex = null;          // voir lampesAutour : même cycle de vie que l'index

    // Toute édition réveille le fluide autour d'elle : percer le sable d'une plage est
    // exactement la cellule qu'il faut noyer, et boucher une source est ce qui doit tarir
    // la nappe en aval. L'eau générée avec le relief, elle, ne passe jamais par ici —
    // c'est voulu, elle est déjà à l'équilibre.
    if (options.fluide !== false && !this._enEau) {
      for (const [x, y, z] of cells) this.eau.reveiller(x, y, z);
    }

    for (const key of touched) {
      const comma = key.indexOf(',');
      const cx = +key.slice(0, comma);
      const cz = +key.slice(comma + 1);
      if (differe) this.markChunkDirty(cx, cz);
      else this.rebuildChunk(cx, cz);
    }
    if (touched.size > 0 && this.onEdit) this.onEdit();
    return touched.size;
  }

  /**
   * Écriture groupée d'une vague d'eau. Les distances sont posées **avant** les blocs : le
   * mailleur lit la table des niveaux pour choisir l'épaisseur de chaque filet, et mailler
   * un cube plein que la distance vient rattraper une image plus tard se verrait à l'écran.
   */
  _ecrireEau(cells) {
    for (const [x, y, z, id, niv] of cells) {
      const k = `${x},${y},${z}`;
      if (id === BLOCK.WATER && niv != null) this.eauNiveaux.set(k, niv);
      else this.eauNiveaux.delete(k);
    }
    this._enEau = true;
    try {
      this.setBlocksBulk(cells, { differe: true, fluide: false });
    } finally {
      this._enEau = false;
    }
  }

  // The chunk owning the column, plus any neighbour whose mesher reads across the
  // shared border and would otherwise keep a stale face there.
  _touchedChunks(x, y, z, into) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;

    into.add(this.getChunkKey(cx, cz));
    if (lx === 0) into.add(this.getChunkKey(cx - 1, cz));
    if (lx === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx + 1, cz));
    if (lz === 0) into.add(this.getChunkKey(cx, cz - 1));
    if (lz === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx, cz + 1));
    // Le coin partagé par quatre tronçons : la face verticale du voisin diagonal lit
    // les deux voisins orthogonaux pour son occlusion ambiante.
    if (lx === 0 && lz === 0) into.add(this.getChunkKey(cx - 1, cz - 1));
    if (lx === 0 && lz === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx - 1, cz + 1));
    if (lx === CHUNK_SIZE - 1 && lz === 0) into.add(this.getChunkKey(cx + 1, cz - 1));
    if (lx === CHUNK_SIZE - 1 && lz === CHUNK_SIZE - 1) into.add(this.getChunkKey(cx + 1, cz + 1));
  }

  // Un cube cassé ou posé change l'éclairage bien au-delà de sa colonne : le BFS du
  // ciel ne meurt qu'après `PORTEE_CIEL` cubes à plat. Tout tronçon touchant cette
  // portée a donc quelque chose à relire chez nous — on le met en file plutôt qu'on ne
  // le maille ici, pour qu'un pavé de mille cubes ne paie pas mille remaillages.
  _touchLumiere(x, z, horsFile) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const files = [];
    if (lx < PORTEE_CIEL) files.push([cx - 1, cz]);
    if (lx >= CHUNK_SIZE - PORTEE_CIEL) files.push([cx + 1, cz]);
    if (lz < PORTEE_CIEL) files.push([cx, cz - 1]);
    if (lz >= CHUNK_SIZE - PORTEE_CIEL) files.push([cx, cz + 1]);
    for (const [fx, fz] of files) {
      const cle = this.getChunkKey(fx, fz);
      if (horsFile?.has(cle)) continue;      // déjà reconstruit synchronement
      this.markChunkDirty(fx, fz);
    }
  }

  /**
   * Luminance déjà calculée des quatre tronçons attenants, lue sur la paroi partagée et
   * rendue dans le repère du tronçon qu'on va mailler. Un tronçon hors du flot répond
   * null : la frontière reste close, comme avant ce correctif.
   */
  mursSemences(cx, cz) {
    const plan = (dx, dz, cote) => this.chunks.get(this.getChunkKey(cx + dx, cz + dz))?.murs?.[cote] ?? null;
    const ouest = plan(-1, 0, 'e'), est = plan(1, 0, 'w');
    const nord = plan(0, -1, 's'), sud = plan(0, 1, 'n');
    if (!ouest && !est && !nord && !sud) return null;
    return { ouest, est, nord, sud };
  }

  /**
   * Garde les quatre parois du champ de lumière d'un tronçon et prévient les voisins
   * dont la paroi vient de bouger : sans cet aller-retour, celui qui a maillé en premier
   * gardait la luminance que son voisin avait avant l'édit, et le jour ne traversait
   * jamais la frontière. La garde `SEUIL_MUR` borne la conversation — une paroi ne se
   * rejuge que si elle a réellement changé.
   */
  majMurs(cx, cz, niveau) {
    const chunk = this.chunks.get(this.getChunkKey(cx, cz));
    if (!chunk) return;
    const cells = CHUNK_SIZE * CHUNK_SIZE;
    const mur = (indexeur) => {
      const p = new Uint8Array(CHUNK_SIZE * CHUNK_HEIGHT);
      // `u + y * CHUNK_SIZE` et non `y + u * CHUNK_SIZE` : `y` court jusqu'à
      // CHUNK_HEIGHT pour un pas de CHUNK_SIZE, donc l'autre ordre fait déborder chaque
      // colonne sur la suivante et une paroi ne garde que ses dernières hauteurs.
      for (let u = 0; u < CHUNK_SIZE; u++) {
        for (let y = 0; y < CHUNK_HEIGHT; y++) p[u + y * CHUNK_SIZE] = niveau[indexeur(u, y)];
      }
      return p;
    };
    const avant = chunk.murs;
    // À la première publication, personne n'a encore rien lu de nous : on juge donc
    // contre le néant. Rendre la main sans prévenir laissait le premier maillage —
    // calculé sans les voisins — être lu par eux jusqu'à la fin de la session : mesuré
    // le 2026-11-14, les neuf tronçons d'un quartier n'étaient maillés qu'une fois et
    // une poche scellée gardait 26,6 de bande haute au lieu de 3,6.
    const reference = avant || PLAN_VIDE;
    const murs = {
      w: mur((u, y) => u * CHUNK_SIZE + y * cells),                    // lx = 0
      e: mur((u, y) => (CHUNK_SIZE - 1) + u * CHUNK_SIZE + y * cells), // lx = dernier
      n: mur((u, y) => u + y * cells),                                  // lz = 0
      s: mur((u, y) => u + (CHUNK_SIZE - 1) * CHUNK_SIZE + y * cells), // lz = dernier
    };
    chunk.murs = murs;
    const ecart = (a, b) => {
      let m = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i];
        if (d > m) m = d;
      }
      return m;
    };
    const derives = {};
    for (const cote of MURS_QUATRE) derives[cote] = ecart(murs[cote], reference[cote]);
    // Digest des quatre cloisons, calculé là où elles naissent : l'empreinte du cache de
    // géométrie s'en sert pour savoir si un bloc cuit hier décrit encore la lumière d'ici,
    // sans avoir à relire 32 Ko de parois à chaque pose.
    let dh = 0;
    for (const cote of MURS_QUATRE) dh = (dh + parseInt(hachageOctets(murs[cote]), 16)) >>> 0;
    chunk.digestMurs = dh.toString(16);
    // Un voisin qui n'a jamais été maillé recalculera de toute façon : pas la peine de
    // le remettre en file, ce qui doublerait le travail du premier passage du flot.
    const dejaMaille = (fx, fz) => {
      const c = this.chunks.get(this.getChunkKey(fx, fz));
      return !!c && c.meshes.length > 0;
    };
    const prevenir = (deltaX, deltaZ, cote) => {
      if (derives[cote] <= SEUIL_MUR) return;
      if (!avant && !dejaMaille(cx + deltaX, cz + deltaZ)) return;
      this.markChunkDirty(cx + deltaX, cz + deltaZ);
    };
    prevenir(-1, 0, 'w');
    prevenir(1, 0, 'e');
    prevenir(0, -1, 'n');
    prevenir(0, 1, 's');
  }

  // Replays a save read from disk. It deliberately does not fire onEdit — putting
  // the stored diff back is not a player edit — and queues the remesh instead of
  // rebuilding in place, so a save holding tens of thousands of cubes still costs
  // nothing on the loading frame.
  //
  // `flux` remet les distances de l'eau de passage. Le monde recharge **à l'arrêt** : une
  // inondation interrompue par la fermeture de l'onglet ne reprend pas toute seule, elle
  // attend la prochaine édition du joueur, comme la mer générée attend qu'on la perce.
  applyEdits(edits, flux = null) {
    this.modifiedBlocks = new Map(edits);
    // Une distance ne survit qu'aussi longtemps que la cellule d'eau qui la porte : un
    // fichier bricolé (ou repris après une édition manuelle) ne doit pas laisser traîner
    // de niveau sur un bloc qui n'est plus de l'eau.
    const niveaux = new Map();
    if (flux) {
      const eau = BLOCK.WATER;
      for (const [cle, niv] of flux) {
        if (this.modifiedBlocks.get(cle) === eau) niveaux.set(cle, niv);
      }
    }
    this.eauNiveaux = niveaux;
    this._overrideIndex = null;
    this._lampIndex = null;          // voir lampesAutour : même cycle de vie que l'index
    this.eau.reinitialiser();
    const touched = new Set();
    for (const key of this.modifiedBlocks.keys()) {
      const first = key.indexOf(',');
      const second = key.indexOf(',', first + 1);
      if (second < 0) continue;
      const x = +key.slice(0, first);
      const y = +key.slice(first + 1, second);
      const z = +key.slice(second + 1);
      if (!(y >= 0 && y < CHUNK_HEIGHT)) continue;
      this._touchedChunks(x, y, z, touched);
    }
    for (const key of touched) this._marquerSale(key);
    return this.modifiedBlocks.size;
  }

  // "Nouveau monde": drops every player edit and re-queues the visible meshes.
  clearEdits() {
    this.modifiedBlocks = new Map();
    this.eauNiveaux = new Map();     // l'eau de passage fait partie du diff du joueur
    this._overrideIndex = null;
    this._lampIndex = null;          // voir lampesAutour : même cycle de vie que l'index
    this.eau.reinitialiser();
    for (const key of this.chunks.keys()) this._marquerSale(key);
  }

  // Edits bucketed per chunk, rebuilt once per mutation batch. Walking the whole
  // diff for every chunk rebuild was harmless while it held a handful of blocks;
  // now that a world accumulates its edits across sessions, an unindexed scan
  // would cost O(chunks x edits) on each streaming pass.
  _indexOverrides() {
    if (this._overrideIndex) return this._overrideIndex;
    const index = new Map();
    for (const [key, id] of this.modifiedBlocks) {
      const first = key.indexOf(',');
      const second = key.indexOf(',', first + 1);
      if (second < 0) continue;
      const x = +key.slice(0, first);
      const y = +key.slice(first + 1, second);
      const z = +key.slice(second + 1);
      if (!(y >= 0 && y < CHUNK_HEIGHT)) continue;
      const cx = Math.floor(x / CHUNK_SIZE);
      const cz = Math.floor(z / CHUNK_SIZE);
      const chunkKey = this.getChunkKey(cx, cz);
      let bucket = index.get(chunkKey);
      if (!bucket) {
        bucket = new Map();
        index.set(chunkKey, bucket);
      }
      bucket.set((x - cx * CHUNK_SIZE) + (z - cz * CHUNK_SIZE) * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE, id);
    }
    this._overrideIndex = index;
    return index;
  }

  /**
   * Le corps flotte-t-il dans cette cellule ? Toute cellule d'eau compte : l'automate ne
   * rend plus que des cubes pleins, il n'existe pas de pellicule qui mouillerait le sol
   * sans porter un joueur.
   */
  estNageable(x, y, z) {
    if (y < 0 || y >= CHUNK_HEIGHT) return false;
    return this.getBlock(x, y, z) === BLOCK.WATER;
  }

  isSolid(x, y, z) {
    const block = this.getBlock(x, y, z);
    if (block === BLOCK.AIR) return false;
    const info = BLOCK_INFO[block];
    return !!info.solid;
  }

  isOpaque(x, y, z) {
    const block = this.getBlock(x, y, z);
    if (block === BLOCK.AIR) return false;
    const info = BLOCK_INFO[block];
    return !!info.opaque;
  }

  isLiquid(x, y, z) {
    const info = BLOCK_INFO[this.getBlock(x, y, z)];
    return !!(info && info.liquid);
  }

  /**
   * Ce que le rayon de visée peut atteindre. Un bloc non solide comme l'eau se traverse
   * sans s'arrêter ; une applique murale, elle, doit se laisser viser — sinon rien ne
   * permet jamais de la casser, ni d'en reposer une ailleurs.
   */
  isTargetable(x, y, z) {
    const info = BLOCK_INFO[this.getBlock(x, y, z)];
    return !!(info && (info.solid || info.breakable));
  }

  /**
   * L'identifiant d'applique qu'impose le mur derrière la cellule : la face dont le voisin
   * est plein. Le joueur vise une face, la case visée est toujours l'air collé à cette
   * face, donc le mur trouvé est exactement celui qu'il regardait. À défaut de mur — pose
   * en rase campagne — l'applique garde la face demandée.
   */
  appliqueOriente(x, y, z, demande) {
    for (let i = 0; i < APPLIQUES.length; i++) {
      const [dx, dy, dz] = MURALE_DIRS[i];
      if (this.isSolid(x + dx, y + dy, z + dz)) return APPLIQUES[i];
    }
    return demande;
  }

  generateChunkData(cx, cz) {
    const key = this.getChunkKey(cx, cz);
    if (this.chunks.has(key)) return null;

    // Le cache d'île dispense de bruit quand il connaît ce tronçon : la donnée arrive
    // toute cuite. Un tronçon dont la tranche n'est pas encore décompressée retombe sur
    // la génération habituelle — et sa tranche est réchauffée pour ses soixante-trois
    // voisins, qui ne coûteront plus qu'une copie.
    if (this.cacheIle && this.cacheIle.aLeTroncon(cx, cz)) {
      const cuit = this.cacheIle.troncon(cx, cz);
      if (cuit) {
        this.chunks.set(key, { data: cuit, meshes: [], cx, cz, murs: null, horsVue: 0, aRefaire: false, octets: 0 });
        return this.chunks.get(key);
      }
      const no = this.cacheIle.trancheDe(cx, cz);
      if (no >= 0 && !this.cacheIle.chaude(no)) this.cacheIle.rechauffer(no);
    }

    const data = this.fabriquerDonnees(cx, cz);
    this.chunks.set(key, { data, meshes: [], cx, cz, murs: null, horsVue: 0, aRefaire: false, octets: 0 });
    return this.chunks.get(key);
  }

  /**
   * Le contenu brut d'un tronçon, publié nulle part. La cuisson de l'île en a besoin :
   * passer par `generateChunkData` y laisserait 31 416 tronçons de 32 Ko en mémoire —
   * un gigaoctet — et encombrerait la file de maillage de tout l'océan.
   */
  fabriquerDonnees(cx, cz) {
    const data = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);
    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const cells = CHUNK_SIZE * CHUNK_SIZE;

    // Une seule lecture de bruit par colonne : le relief ressert au remplissage,
    // au revêtement des voiries et à l'assise des bâtiments.
    const heights = new Int16Array(cells);
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        heights[lx + lz * CHUNK_SIZE] = getTerrainHeight(baseX + lx, baseZ + lz);
      }
    }

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        const wx = baseX + lx;
        const wz = baseZ + lz;
        const height = heights[lx + lz * CHUNK_SIZE];
        // Le biome décide du revêtement et de son assise : sable sur le désert et la
        // grève, mousse sous les futaies, herbe ailleurs, neige au-dessus de sa ligne.
        const sol = biomes.surfaceFor(wx, wz, height);
        // Plan d'eau de la colonne : la mer partout, ou le plan local d'une rivière là
        // où un cours passe — il est plus haut que la mer en amont, et c'est ce qui fait
        // un cours d'eau plutôt qu'un simple fossé sec.
        const niveauEau = terrain.waterTopAt(wx, wz);

        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const idx = lx + lz * CHUNK_SIZE + y * cells;

          if (y < height - 3) {
            // Deep: stone
            data[idx] = BLOCK.STONE;
            // Caves
            if (isCave(wx, y, wz)) {
              data[idx] = BLOCK.AIR;
            }
            // Ores (rare)
            else if (y < 16 && hashRoll(wx, y, wz, 1) < 0.002) {
              data[idx] = BLOCK.DIAMOND;
            } else if (y < 24 && hashRoll(wx, y, wz, 2) < 0.005) {
              data[idx] = BLOCK.GOLD;
            } else if (y < 32 && hashRoll(wx, y, wz, 3) < 0.008) {
              data[idx] = BLOCK.IRON;
            } else if (y < 40 && hashRoll(wx, y, wz, 4) < 0.01) {
              data[idx] = BLOCK.COAL;
            }
          } else if (y < height) {
            // Near surface: dirt, or sand through the whole dune of a desert floor
            data[idx] = sol.under;
          } else if (y === height) {
            data[idx] = sol.top;
          } else if (y <= niveauEau) {
            // Eau : de la dernière colonne de sable jusqu'au plan d'eau. La mer suit la
            // ligne de flottaison, la rivière son propre plan. L'eau n'est pas solide et
            // ne coule pas — une nappe est posée colonne par colonne, ce qui laisse les
            // grottes sous le plancher rester sèches.
            data[idx] = BLOCK.WATER;
          }
        }
      }
    }

    // Troncs et couronnes avant la voirie : routes, maisons et ouvrages estampés
    // ensuite reprendront le terrain, et une souche mal placée disparaîtra sous la
    // chaussée plutôt que de pousser dedans.
    biomes.stampVegetation(data, cx, cz);

    village.stampRoads(data, cx, cz);
    village.stampBuilding(data, cx, cz);
    // Ponts et arcs en dernier : ils reprennent le revêtement de la voirie pour le
    // porter en tablier, et leurs plans ont déjà écarté les entrées de bâtiment. En
    // fin de chaîne, l'avenue reste toujours praticable.
    village.stampStructures(data, cx, cz);
    // Les candélabres viennent après tous les ouvrages : ils s'assoient sur le pavé que
    // la voirie vient de poser et renoncent si un arc ou un tablier occupe déjà leur
    // colonne. Avant elle, ils se feraient raser par le garde-tête d'une avenue.
    village.stampLamps(data, cx, cz);

    // `murs` garde la luminance calculée sur les quatre parois du tronçon : c'est ce que
    // les voisins viennent lire quand ils se maillent (voir `mursSemences`). Il naît à
    // null et se remplit au maillage — la donnée brute, elle, se suffit d'elle-même.
    return data;
  }

  generateChunk(cx, cz) {
    if (!this.generateChunkData(cx, cz)) return;
    // Le mailleur ne se paie pas à la génération quand le disque sait déjà peindre : à cet
    // instant précis rien n'a encore pu être décompressé, et mailler ici jetterait le
    // résultat un tour plus bas (mesuré 65 reconstructions sur 105 venues de ce seul chemin).
    // On rend le tronçon sale : `drainerMailles` attendra le bloc, avec son plafond horaire.
    const cache = this.cacheGeom;
    const chunk = this.chunks.get(this.getChunkKey(cx, cz));
    // Deux fenêtres d'attente, même traitement : le fichier n'est pas encore lu (le boot
    // lit le disque après avoir posé le joueur — mesuré 65 reconstructions venues de là),
    // ou il le connaît mais son bloc n'est pas encore décompressé.
    const lectureEnCours = this.cacheGeomEnCours
      && performance.now() - this.cacheGeomEnCours < ATTENTE_CACHE_GEOM_MS;
    if (chunk && chunk.meshes.length === 0 && (lectureEnCours
      || (cache && cache.aLeTroncon(cx, cz) && !cache.estChaud(cx, cz)
        && cache.empreinteDu(cx, cz) === this.empreinteGeom(cx, cz)))) {
      this.markChunkDirty(cx, cz);
      if (cache) this.preparerGeom([[cx, cz]], { max: 4, urgente: true });
      return;
    }
    this.rebuildChunk(cx, cz);
  }

  // Per-chunk snapshot of the player edits inside this chunk, indexed numerically
  // so the mesher never has to build a string key per block.
  collectOverrides(cx, cz) {
    const overrides = new Int16Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT).fill(-1);
    if (this.modifiedBlocks.size === 0) return overrides;
    const bucket = this._indexOverrides().get(this.getChunkKey(cx, cz));
    if (!bucket) return overrides;
    for (const [idx, id] of bucket) overrides[idx] = id;
    return overrides;
  }

  /**
   * Toutes les lanternes dont la portée touche ce tronçon, en coordonnées monde.
   *
   * Deux origines : celles que le village pose le long des avenues — lui seul sait où
   * la voirie passe — et celles posées par le joueur. Celles du village sont vérifiées
   * bloc par bloc avant d'être retenues : une lanterne arrachée par le joueur reste
   * dans le plan du village, et sans ce contrôle son halo survivrait à sa propre casse.
   */
  lampesAutour(cx, cz) {
    const baseX = cx * CHUNK_SIZE, baseZ = cz * CHUNK_SIZE;
    const R = LAMPE_PORTEE + 1;
    const vues = new Set();
    const lampes = [];
    const retenir = (x, y, z) => {
      const k = `${x},${y},${z}`;
      if (vues.has(k)) return;
      vues.add(k);
      lampes.push([x, y, z]);
    };

    // Les listes du village sont des **candidates** : elles énumèrent tout ce qui pourrait
    // porter une lumière dans la zone, quitte à en compter de retirées depuis. Seule la
    // cellule réellement remplie par un luminaire compte ici. Un candélabre est rendu
    // `{ wx, wz, y }` avec `y` au pied du poteau — la lumière vient de la lanterne posée
    // juste au-dessus ; une applique murale n'a pas de pied, sa cellule est déjà la source.
    const source = (l) => {
      const x = l.wx, y = l.murale ? l.y : l.y + 1, z = l.wz;
      if (estLanterne(this.getBlock(x, y, z))) retenir(x, y, z);
    };

    if (village.lampadairesSur) {
      for (const l of village.lampadairesSur(baseX - R, baseZ - R, baseX + CHUNK_SIZE + R, baseZ + CHUNK_SIZE + R)) {
        source(l);
      }
    }
    // Lanternes d'intérieur — pièces de maison, étages d'immeuble, nef des temples. Sans
    // cette seconde liste, une lanterne estampée dans un bâtiment éclairerait les murs
    // du voisinage mais jamais la pièce qui la porte : `lampadairesSur` ne connaît que
    // la voirie.
    if (village.lampesInterieuresSur) {
      for (const l of village.lampesInterieuresSur(baseX - R, baseZ - R, baseX + CHUNK_SIZE + R, baseZ + CHUNK_SIZE + R)) {
        source(l);
      }
    }
    // Appliques murales des couloirs d'immeuble — mêmes candidates, même garde.
    if (village.appliquesMuralesSur) {
      for (const l of village.appliquesMuralesSur(baseX - R, baseZ - R, baseX + CHUNK_SIZE + R, baseZ + CHUNK_SIZE + R)) {
        source(l);
      }
    }
    if (!this._lampIndex) {
      const index = [];
      for (const [clef, id] of this.modifiedBlocks) {
        if (!estLanterne(id)) continue;
        const a = clef.indexOf(','), b = clef.indexOf(',', a + 1);
        if (b < 0) continue;
        index.push([+clef.slice(0, a), +clef.slice(a + 1, b), +clef.slice(b + 1)]);
      }
      this._lampIndex = index;
    }
    for (const [x, y, z] of this._lampIndex) {
      if (Math.abs(x + 0.5 - (baseX + CHUNK_SIZE / 2)) <= CHUNK_SIZE / 2 + R
        && Math.abs(z + 0.5 - (baseZ + CHUNK_SIZE / 2)) <= CHUNK_SIZE / 2 + R) {
        retenir(x, y, z);
      }
    }
    return lampes;
  }

  /** Ce que pèsent les tampons sommets (et l'index) des mailleurs d'un tronçon. */
  _tailleMaillages(chunk) {
    let n = 0;
    for (const mesh of chunk.meshes) {
      const g = mesh.geometry;
      for (const nom in g.attributes) n += g.attributes[nom].array.byteLength;
      if (g.index) n += g.index.array.byteLength;
    }
    return n;
  }

  /** Rend un tronçon à la scène sans rien reconstruire — le retour d'une réserve. */
  _poserMaillages(chunk) {
    for (const mesh of chunk.meshes) this.scene.add(mesh);
  }

  /** Le retire de la scène en gardant ses tampons : visible = dessiné, pas chargé. */
  _retirerMaillages(chunk) {
    for (const mesh of chunk.meshes) this.scene.remove(mesh);
  }

  /** Libère vraiment : c'est le seul chemin qui décroche la géométrie du GPU. */
  _jeterMaillages(chunk) {
    for (const mesh of chunk.meshes) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
    }
    this.octetsMailles -= chunk.octets;
    chunk.octets = 0;
    chunk.meshes = [];
  }

  /**
   * Plafond couramment admis pour la géométrie tenue en mémoire. Le navigateur n'est
   * pas tenu d'exposer son tas (headless l'omet, Safari l'ignore) : on retombe alors
   * sur le défaut, jamais sur `navigator.deviceMemory` qui décrit la barrette, pas
   * l'onglet. Sous pression réelle — tas presque plein — le quota se resserre.
   */
  _rafraichirQuota(maintenant) {
    if (this.quotaForce !== null) return this.quotaForce;
    if (maintenant - this._quotaVu < QUOTA_REFRESH_MS) return this.quotaGeometrie;
    this._quotaVu = maintenant;
    const m = typeof performance !== 'undefined' && performance.memory
      ? performance.memory : null;
    if (m && Number.isFinite(m.jsHeapSizeLimit) && m.jsHeapSizeLimit > 0) {
      // On réserve une part du tas **autorisé**, jamais du tas *libre* : assise sur le
      // libre, la règle s'auto-réprime en se remplissant (mesuré 2026-11-16 à r=32 : quota
      // tombé à 917 Mo pendant que la note montait à 1 299 Mo, donc prêt à évincer ~400 Mo
      // déjà payés au premier demi-tour). Le plafond borne, le plancher garantit, et le
      // garde-fou ci-dessous ne se déclenche que sous vraie pression du tas.
      const limite = m.jsHeapSizeLimit;
      const use = Number.isFinite(m.usedJSHeapSize) ? m.usedJSHeapSize : 0;
      let quota = Math.max(QUOTA_GEOMETRIE_PLANCHER,
        Math.min(QUOTA_GEOMETRIE_PLAFOND, limite * QUOTA_GEOMETRIE_FRACTION));
      if (use > limite * PRESSION_TAS) {
        quota = Math.min(quota, Math.max(QUOTA_GEOMETRIE_PLANCHER, (limite - use) * 0.5));
      }
      this.quotaGeometrie = quota;
    } else {
      this.quotaGeometrie = QUOTA_GEOMETRIE_DEFAUT;
    }
    return this.quotaGeometrie;
  }

  /**
   * **Ce que la caméra est censée voir** : le carré du champ rendu **et** le disque que la
   * brume laisse lire. Un seul prédicat pour les trois sites qui décident de mailler,
   * d'accrocher ou de rendre un tronçon (`_rangerHorsChamp`, `_lacherTronconCuit`, la
   * garde du four) — deux frontières voisines se contrediraient, et le commentaire de
   * `MARGE_CHAMP_RENDU` en garde la facture : 36 repeintures par demi-tour.
   *
   * La distance se prend au **coin le plus proche** de l'assiette, pas au centre : juger
   * au centre avancerait la frontière d'un demi-tronçon (11 cubes à `CHUNK_SIZE = 16`) et
   * culotterait ce qui dépasse encore de la brume.
   */
  _montreACamera(cx, cz) {
    const c = this._centre;
    if (!c) return true;                       // avant la première image : rien à culotter
    if (Math.max(Math.abs(cx - c.pcx), Math.abs(cz - c.pcz)) > c.radius + MARGE_CHAMP_RENDU) return false;
    const CS = CHUNK_SIZE;
    const x0 = cx * CS, z0 = cz * CS;
    const camX = this._camX, camZ = this._camZ;
    const px = camX < x0 ? x0 : (camX > x0 + CS ? x0 + CS : camX);
    const pz = camZ < z0 ? z0 : (camZ > z0 + CS ? z0 + CS : camZ);
    const dx = camX - px, dz = camZ - pz;
    return dx * dx + dz * dz <= this._brumeCarres;
  }

  /**
   * Met les tronçons en réserve, puis libère ce que le budget ne permet plus de garder.
   * Appelé EN TÊTE de `updateChunks` : c'est lui qui décide ce qui a le droit d'être
   * repeint dans la passe de maillage qui suit. Placé après (mesuré 2026-11-16), un
   * tronçon revenant dans le champ n'était repeint qu'à l'appel suivant — deux clichés
   * strictement identiques, 0,0 point de gain.
   *
   * Ce qui sort du champ n'est pas jeté : décroché de la scène, tampons gardés. Un
   * demi-tour ne doit rien recalculer (mesuré 2 129 mailleurs repayés pour rien quand la
   * profondeur retombe de 12 à 2 puis remonte). On ne libère vraiment que quand la note
   * dépasse le quota — et alors du plus ancien hors de vue — ou quand le tronçon est trop
   * loin pour jamais revenir. Seuls les tampons sommets entrent dans la note
   * (330 Ko/tronçon) ; les 32 Ko de données du terrain suivent le tronçon.
   */
  _rangerHorsChamp(pcx, pcz, radius, maintenant) {
    const quota = this._rafraichirQuota(maintenant);
    const reserve = [];
    for (const [key, chunk] of this.chunks) {
      const dist = Math.max(
        Math.abs(chunk.cx - pcx),
        Math.abs(chunk.cz - pcz)
      );
      if (this._montreACamera(chunk.cx, chunk.cz)) {
        if (chunk.horsVue) {
          chunk.horsVue = 0;
          this._poserMaillages(chunk);
          // Soit il a été sali pendant son absence, soit il n'a jamais été peint (né hors
          // champ après un bond du curseur) : dans les deux cas il doit passer au mailleur.
          if (chunk.aRefaire || chunk.meshes.length === 0) {
            chunk.aRefaire = false;
            this.dirtyKeys.add(key);
          }
        }
        continue;
      }
      if (!chunk.horsVue) {
        chunk.horsVue = maintenant;
        this._retirerMaillages(chunk);
      }
      // Un tronçon où le joueur a posé la main porte ses éditions — et donc aussi l'eau
      // que l'automate y a écrite, qui passe par le même chemin (`_ecrireEau` appelle
      // `setBlocksBulk`). Le jeter le ferait renaître vierge aux yeux de l'automate :
      // `charge(x, z)` redevient faux, la case est court-circuitée, et la nappe reste
      // inscrite à la sauvegarde sans jamais couler (mesuré 2026-11-16 à trois cents
      // cubes du joueur : les sept cellules survivaient au rechargement, la vidange ne
      // les touchait plus). Il reste décroché de la scène ; seuls ses tampons pèsent, et
      // l'éviction sous quota, plus bas, peut encore le prendre si l'onglet en a besoin.
      if (dist > radius + GARDE_HORS_VUE && !this._toucheParLeJoueur(key)) {
        this._jeterMaillages(chunk);
        this.chunks.delete(key);
        this.dirtyKeys.delete(key);
        continue;
      }
      if (chunk.octets > 0) reserve.push(chunk);
    }
    if (this.octetsMailles > quota && reserve.length > 0) {
      // Le plus anciennement hors champ saute en premier : c'est ce que le joueur a le
      // moins de chances de revoir. Sous pression le quota reste un plafond dur — sans
      // cela, une carte très travaillée ferait gonfler l'onglet sans limite.
      reserve.sort((a, b) => a.horsVue - b.horsVue);
      for (const chunk of reserve) {
        if (this.octetsMailles <= quota) break;
        this._jeterMaillages(chunk);
        const cle = this.getChunkKey(chunk.cx, chunk.cz);
        this.chunks.delete(cle);
        this.dirtyKeys.delete(cle);
      }
    }
  }

  /** Le joueur a-t-il posé la main sur ce tronçon ? Ses éditions portent aussi son eau. */
  _toucheParLeJoueur(key) {
    return this.modifiedBlocks.size > 0 && this._indexOverrides().has(key);
  }

  // ---- géométrie déjà prête pour la carte ------------------------------------
  // Rien ici ne remplace le mailleur : si une seule clé ne correspond pas, on repart par
  // la construction complète. Ce qui est gagné, c'est le temps — 0,29 ms contre 6,94 ms
  // par tronçon (mesuré le 2026-11-16), soit le prix d'un aller-retour au disque au lieu
  // de celui d'une lecture du terrain, d'un champ de lumière et de 6 600 sommets refaits.

  /** Ce qui doit correspondre pour qu'un triangle écrit hier soit encore celui d'aujourd'hui. */
  attenduGeom() {
    return {
      chunkSize: CHUNK_SIZE, height: CHUNK_HEIGHT, seed: WORLD_SEEDS, monde: MONDE,
      mailleVersion: MAILLE_VERSION, atlasSignature: this.signatureAtlas(),
    };
  }

  /**
   * Emprunte l'atlas : dimensions, noms des tuiles et pixels. Le maillage cuit ses uv
   * d'après la grille des tuiles ; si l'agencement bouge — import de textures, tuile
   * ajoutée — les triangles du disque peindraient la mauvaise image. Le hash des pixels
   * est plus strict qu'il n'en a l'air (changer une image sans changer la grille laisse
   * des uv valides) : on préfère perdre un cache à montrer le mauvais bloc.
   */
  signatureAtlas(force = false) {
    if (this._signatureAtlas !== null && !force) return this._signatureAtlas;
    let s = 'atlas';
    try {
      const c = atlas.canvas;
      s = `${c.width}x${c.height}|${(atlas.tileNames || []).join(',')}`;
      const ctx = c.getContext && c.getContext('2d');
      if (ctx) s += `|${hachageOctets(ctx.getImageData(0, 0, c.width, c.height).data)}`;
    } catch (e) {
      // Canvas tainté ou contexte indisponible : dims et noms suffisent à écarter un doute.
    }
    this._signatureAtlas = hachageGeom(s);
    return this._signatureAtlas;
  }

  /** L'atlas a changé de visage : le fichier du disque ne décrit plus ce monde. */
  atlasAChange() {
    this._signatureAtlas = null;
    this.cacheGeom = null;
    this.ecrivainGeom = null;
    this.geomEnAttente.clear();
  }

  /**
   * Empreinte de tout ce qui peut avoir repeint ce tronçon depuis l'écriture : ses
   * éditions **et** celles du halo, parce qu'une lanterne posée à trois cubes éclaire les
   * murs du voisin. La somme des hash est commutative : l'ordre d'application des éditions
   * (celui du fichier, puis celui du joueur) ne change pas le résultat.
   */
  empreinteGeom(cx, cz) {
    const index = this._indexOverrides();
    let h = 0;
    let n = 0;
    for (let dz = -GEOM_HALO_CHUNKS; dz <= GEOM_HALO_CHUNKS; dz++) {
      for (let dx = -GEOM_HALO_CHUNKS; dx <= GEOM_HALO_CHUNKS; dx++) {
        const bucket = index.get(this.getChunkKey(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const [cell, id] of bucket) {
          h = (h + parseInt(hachageGeom(`${cell}:${id}`), 16)) >>> 0;
          n++;
        }
      }
    }
    // Les éditions du joueur ne suffisent pas à décrire un tronçon : l'automate d'eau,
    // l'estampage du village ou du monument écrivent dans `chunk.data` sans passer par la
    // carte des éditions. Un bloc posé sur cette foi peignait de l'eau disparue ou un
    // pavé arraché (mesuré 5 blocs infidèles sur 8 audités). Le contenu réel entre donc
    // dans l'empreinte, à hauteur de 32 Ko hachés (~0,04 ms), une fois à la cuisson et
    // une fois à la pose.
    const chunk = this.chunks.get(this.getChunkKey(cx, cz));
    const brut = chunk && chunk.data ? hachageOctets(chunk.data) : 'sans-donnees';
    // La lumière cuite d'un tronçon se lit aussi chez ses voisins. Un bloc cuit alors
    // qu'un voisin manquait garde une couleur fausse — le mailleur tient l'absent pour
    // « plein », faute de mieux à lire (mesuré jusqu'à 8,8 % de la couleur cumulée sur un
    // tronçon). La présence du halo entre donc dans l'empreinte.
    //
    // Elle s'arrête là volontairement : y faire entrer l'état de maillage des voisins —
    // leurs cloisons, par exemple — rendrait le bloc inutilisable au premier passage de
    // chaque session, ce voisin n'ayant pas encore été peint ici. Mesuré : la repose
    // tombait à 52/81 et ne décollait ni avec plus de réserve chaude ni avec dix fois
    // plus de temps d'attente. Ce qui n'est pas reproductible d'une visite à l'autre
    // n'a rien à faire dans une empreinte.
    let hVoisins = 0;
    for (const [dx, dz] of VOISINS_PROCHES) {
      const v = this.chunks.get(this.getChunkKey(cx + dx, cz + dz));
      const etat = v ? (v.digestMurs || 'sans-cloisons') : 'absent';
      hVoisins = (hVoisins + parseInt(hachageGeom(`${dx},${dz}:${etat}`), 16)) >>> 0;
    }
    if (n === 0 && brut === 'sans-donnees' && hVoisins === 0) return '0';
    return `${n.toString(16)}-${h.toString(16)}-${brut}-${hVoisins.toString(16)}`;
  }

  /**
   * Repose un tronçon depuis le fichier, sans passer par le mailleur. Ne marche que sur
   * un bloc déjà décompressé (`preparerGeom` s'en charge en arrière-plan) : décompresser
   * dans l'image coûterait plus cher que le maillage qu'on voulait éviter.
   */
  _poserDepuisDisque(chunk) {
    const cache = this.cacheGeom;
    // Compté à chaque refus : « le disque ne sert rien » ne se corrige pas sans savoir
    // lequel des motifs empêche la pose.
    const motif = (nom) => { this._geomMotifs[nom] = (this._geomMotifs[nom] || 0) + 1; return false; };
    if (!cache) return motif('sansCache');            // pas encore chargé (ou monde sans disque)
    if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return motif('reglages');
    if (!cache.aLeTroncon(chunk.cx, chunk.cz)) return motif('absent');
    const maillages = cache.pret(chunk.cx, chunk.cz);
    if (!maillages) return motif('froid');
    if (cache.empreinteDu(chunk.cx, chunk.cz) !== this.empreinteGeom(chunk.cx, chunk.cz)) return motif('empreinte');
    const materiaux = { opaque: this.matOpaque, trans: this.matTrans, glow: this.matGlow };
    for (const m of maillages) {
      const materiau = materiaux[m.mat];
      if (!materiau) return motif('seau');                        // seau inconnu : on ne pose rien
      const geometry = new THREE.BufferGeometry();
      for (const a of m.attributs) {
        // Les canaux normalisés se posent tels quels : l'attribut GPU lit l'entier et le
        // divise lui-même. Seule la position repasse par le CPU, une boucle de lecture.
        const tableau = a.nom === 'position' ? dequantifierPositions(a.tableau, m.origine) : a.tableau;
        geometry.setAttribute(a.nom, new THREE.BufferAttribute(tableau, a.itemSize, !!a.normalise));
      }
      geometry.setIndex(new THREE.BufferAttribute(m.index, 1));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, materiau);
      mesh.renderOrder = m.mat === 'opaque' ? 0 : 1;
      mesh.userData.seau = m.mat;
      this.scene.add(mesh);
      chunk.meshes.push(mesh);
    }
    chunk.octets = this._tailleMaillages(chunk);
    this.octetsMailles += chunk.octets;
    chunk.venuDuDisque = true;     // drapeau de preuve : les suites jugent la provenance
    this._geomMotifs.ok = (this._geomMotifs.ok || 0) + 1;
    return true;
  }

  /**
   * Met le tronçon qui vient d'être maillé en file pour le disque. Les tampons sont
   * copiés immédiatement (~0,05 ms de memcpy pour 420 Ko) : la géométrie reste libre
   * d'être jetée par le quota avant la publication, et la compression attendra hors image.
   */
  _cuissonGeom(cx, cz) {
    if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return;
    const key = this.getChunkKey(cx, cz);
    if (this.geomEnAttente.size >= GEOM_EN_ATTENTE_MAX) {
      // La file est pleine : le tronçon n'est pas perdu, il est inscrit sur la liste
      // d'attente. Dès que la publication l'aura vidée, `cuireCeQuiAttend` viendra y
      // puiser tant que la géométrie est en mémoire — sans quoi une traversée rapide
      // ne laisserait sur le disque que les trente premiers tronçons du voyage.
      this.geomACuire.add(key);
      return;
    }
    const chunk = this.chunks.get(key);
    if (!chunk || chunk.meshes.length === 0) return;
    // Devant un voisin absent, le mailleur n'a rien à lire et le tient pour « plein » :
    // cuire à ce moment-là grave une lumière fausse que le fichier rejouera indéfiniment
    // (mesuré six tronçons infidèles sur huit audités, toujours sur le seul canal couleur).
    // On n'écrit donc qu'une fois les voisins directs installés. Ceux hors du rayon rendu
    // ne viendront jamais et ne peuvent rien retenir ; la liste d'attente est bornée pour
    // qu'un monde en chantier ne s'y empile pas sans fin.
    const centre = this._centre;
    if (centre) {
      const r = settings.renderDistance;
      for (const [dx, dz] of VOISINS_PROCHES) {
        if (Math.max(Math.abs(cx + dx - centre.pcx), Math.abs(cz + dz - centre.pcz)) > r) continue;
        const voisin = this.chunks.get(this.getChunkKey(cx + dx, cz + dz));
        if (!voisin || !voisin.murs) {
          if (this.geomACuire.size < 256) this.geomACuire.add(key);
          return;
        }
      }
    }
    const maillages = [];
    for (const mesh of chunk.meshes) {
      const g = mesh.geometry;
      const nom = mesh.userData.seau;
      if (!nom) return;                                   // mailleur inconnu : rien d'assurable
      maillages.push({
        mat: nom,
        position: g.attributes.position.array,
        normal: g.attributes.normal.array,
        uv: g.attributes.uv.array,
        color: g.attributes.color.array,
        aLampe: g.attributes.aLampe.array,
        index: g.index.array,
      });
    }
    try {
      const octets = serialiserMaillages(maillages);
      if (!this.geomEnAttente.size) this.geomDepuis = performance.now();
      this.geomEnAttente.set(key, {
        cx, cz, octets, empreinte: this.empreinteGeom(cx, cz),
      });
      this.geomACuire.delete(key);
      // Une pleine file de tronçons déjà payés qui attendent le disque, c'est exactement
      // le moment d'écrire : sans ce déclenchement, une traversée rapide remplirait les
      // 32 places puis repartirait les mains vides, faute d'avoir attendu le réveil de
      // l'économise deux secondes plus tard.
      if (this.geomEnAttente.size >= GEOM_PUBLIER_A && this._demanderPublicationGeom) {
        this._demanderPublicationGeom();
      }
    } catch (e) {
      // Un mailleur qui ne se sérialise pas n'est pas motif à casser l'image : le tronçon
      // est simplement absent du fichier, donc repeint la prochaine fois.
      console.warn('Tronçon non cuisable :', cx, cz, e.message);
    }
  }

  /**
   * Puise dans la liste d'attente dès qu'il y a de la place : une copie de tampons par
   * tronçon, seize par tour, soit moins d'une milliseconde. Appelé par l'économise et
   * après chaque publication, jamais pendant une image déjà chargée.
   */
  cuireCeQuiAttend({ max = 16 } = {}) {
    if (GEOM_MODE === 'ignorer' || !budgetGeomOctets() || !this.geomACuire.size) return 0;
    let faits = 0;
    for (const key of this.geomACuire) {
      if (faits >= max || this.geomEnAttente.size >= GEOM_EN_ATTENTE_MAX) break;
      const virgule = key.indexOf(',');
      const cx = +key.slice(0, virgule);
      const cz = +key.slice(virgule + 1);
      this.geomACuire.delete(key);
      if (!this.chunks.has(key)) continue;                // plus en mémoire : à recuire à la repeinture
      this._cuissonGeom(cx, cz);
      faits++;
    }
    return faits;
  }

  /**
   * Plan de cuisson de toute l'île, du plus près du joueur au plus loin. Le tronçon est
   * taillé deux fois, à une couronne d'écart : la première passe pose les cloisons de
   * lumière (sans elles, le mailleur graine contre le néant et grave une luminance fausse
   * que l'empreinte barrerait à la pose), la seconde grave le tronçon alors que son
   * voisinage — à une couronne près, compris le côté extérieur — est déjà jugé.
   *
   * La file est plate et portée par DEUX curseurs, `rang` (ce qui se grave) et `devant`
   * (la frontière des cloisons). Une file par rangées tenait le même coup mais rendait la
   * main sur un budget court sans jamais graver : les deux passes de rattrapage avalaient
   * le crédit d'image avant la gravure, et la rangée avançait quand même (mesuré le
   * 2026-11-16 : 320 tronçons taillés, `faits` resté à zéro, aucun octet au fichier).
   */
  demarrerCuissonIle() {
    if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return false;
    const b = bornesIle(MONDE, CHUNK_SIZE);
    const centre = this._centre || { pcx: 0, pcz: 0 };
    const file = [];
    for (let j = 0; j < b.nz; j++) {
      const cz = b.cz + j;
      for (let i = 0; i < b.nx; i++) {
        const cx = b.cx + i;
        if (!b.contient(cx, cz)) continue;
        const dx = Math.abs(cx - centre.pcx);
        const dz = Math.abs(cz - centre.pcz);
        file.push({ cx, cz, d: Math.max(dx, dz), e: dx + dz });
      }
    }
    if (!file.length) return false;
    // Couronne par couronne, et dans la couronne du plus proche au plus loin du joueur :
    // ce qu'il longe se cuira avant ce qu'il ne verra peut-être jamais.
    file.sort((p, q) => p.d - q.d || p.e - q.e || p.cx - q.cx || p.cz - q.cz);
    // Le four parcourt l'île entière : la file de tranches doit tenir le pas devant lui,
    // sinon chaque tronçon servi retomberait sur le bruit (voir `_tronconPret`).
    if (this.cacheIle) this.cacheIle.limitesMain = TRANCHES_MAX;
    this.cuissonIle = {
      file, rang: 0, devant: 0, lache: 0,
      mailles: new Set(),                 // clefs passées par la première passe
      centre: { pcx: centre.pcx, pcz: centre.pcz },
      attendus: file.length, faits: 0, depuisPublication: 0,
      dernierProgres: performance.now(),
      enMarche: true, sature: false, motif: '', attenteTranche: false,
    };
    return true;
  }

  /** Ce que la cuisson de fond a fait attendre, pour l'affichage comme pour les tests. */
  etatCuissonIle() {
    const s = this.cuissonIle;
    if (!s) return null;
    return {
      faits: s.faits, attendus: s.attendus, enMarche: s.enMarche,
      sature: s.sature, motif: s.motif, reste: s.attendus - s.faits,
      attenteTranche: !!s.attenteTranche,
      // `attenteTranche` est vrai dès le dernier refus, même si quarante tronçons sont
      // passés depuis : affiché tel quel, le panneau crierait « bloqué » pendant que la
      // barre avance (mesuré voile posé : 23,7 tronçons par seconde avec le drapeau levé).
      // Ce n'est une attente à dire au joueur que si plus rien n'avance vraiment.
      attenteProlongee: !!s.attenteTranche && performance.now() - s.dernierProgres > 1500,
    };
  }

  /**
   * La donnée brute de ce tronçon est-elle lue du disque cuit ? Le cache d'île rend le
   * bruit sans prévenir quand la tranche n'est pas décompressée : livré tel quel, le four
   * graverait dans le fichier de triangles un relief fantaisiste que le monde ne connaît
   * pas. On refuse donc le tronçon tant que sa tranche dort, en lançant le réchauffement —
   * `rechauffer` déduplique les appels simultanés, le relancer à chaque image est gratuit.
   */
  _tronconPret(cx, cz) {
    const ci = this.cacheIle;
    if (!ci || !ci.valide || !ci.aLeTroncon(cx, cz)) return true;   // hors île cuite : le bruit fait foi
    const no = ci.trancheDe(cx, cz);
    if (no < 0 || ci.chaude(no)) return true;
    ci.rechauffer(no);
    return false;
  }

  /**
   * Un tronçon lâché par la cuisson de fond : il n'est ni sous les yeux du joueur, ni
   * touché par sa main, ni porteur de triangles, ni en route pour le disque. Sans ce
   * relâchement, parcourir l'île ferait tenir 31 400 tronçons de 32 Ko en mémoire — un
   * gigaoctet pour rien, le fichier les garde déjà. Mais un tronçon dont les octets
   * attendent la publication n'est pas encore sur le disque : le lâcher, ce serait le
   * perdre sans qu'il ait jamais été écrit.
   */
  _lacherTronconCuit(cx, cz) {
    const cle = this.getChunkKey(cx, cz);
    const chunk = this.chunks.get(cle);
    if (!chunk || chunk.meshes.length) return false;
    if (this._toucheParLeJoueur(cle)) return false;
    if (this.geomEnAttente.has(cle) || this.geomACuire.has(cle) || this.dirtyKeys.has(cle)) return false;
    if (this._centre && this._montreACamera(cx, cz)) return false;   // la même frontière que le rangeur
    this.chunks.delete(cle);
    return true;
  }

  /** Rend à la mémoire ce que la frontière a dépassé : trois couronnes derrière elle. */
  _lacherDerriere(s) {
    const borne = s.file[Math.min(s.rang, s.file.length - 1)];
    const limite = borne.d - 3;
    while (s.lache < s.rang && s.file[s.lache].d <= limite) {
      const t = s.file[s.lache++];
      this._lacherTronconCuit(t.cx, t.cz);
    }
  }

  /**
   * Le fichier ne peut plus rien recevoir : arrêter le four. Tailler des tronçons que
   * l'écrivain refusera à chaque publication est du temps de mailleur jeté image après
   * image, et le joueur ne verrait jamais la raison — le motif porte donc la sentence.
   */
  saturerCuissonIle(motif) {
    const s = this.cuissonIle;
    if (!s) return;
    s.enMarche = false;
    s.sature = true;
    s.motif = motif;
  }

  /**
   * Tranche de cuisson de fond, appelée par l'image quand le joueur a déjà son champ
   * sous les pieds. Elle rend la main dès que le budget est épuisé, à n'importe quel
   * endroit de la file : le jeu reste fluide et l'île se taille derrière le joueur.
   */
  cuireIleGeometrie(maxMs = CUISSON_FOND_MS) {
    const s = this.cuissonIle;
    if (!s || !s.enMarche) return 0;
    if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) { s.enMarche = false; return 0; }
    const debut = performance.now();
    let cuits = 0;
    const epuise = () => performance.now() - debut >= maxMs;
    const enBoite = (cx, cz) => !!this.ecrivainGeom?.aLeTroncon(cx, cz) || !!this.cacheGeom?.aLeTroncon(cx, cz);
    // Un tronçon sous les yeux du joueur n'est PAS à cuire par le four : il est déjà tenu
    // par le flot de rendu, qui pose ses triangles à la scène. Tailler là-bas jetterait la
    // géométrie visible (la cuisson de fond maille hors scène) et effacerait le décor sous
    // le nez du joueur — mesuré le 2026-11-16 sur `tests/geom-cache.mjs`, 131 repeintures
    // au second demi-tour de caméra pour un monde pourtant posé. La frontière reste donc
    // celle du rangeur (`_montreACamera`), mais rendue d'UN CRAN : le four s'arrête une
    // couronne avant ce que la caméra montre. Deux factures mesurées pour deux écarts :
    // une couronne de moins ici et le four taille juste derrière le visible, donc le
    // rangeur la rattache et le mailleur la refait (36 repeintures par demi-tour dans le
    // monde du joueur) ; une couronne de trop et `majMurs` — qui avertit les voisins déjà
    // maillés quand les cloisons d'un tronçon naissent — salit un tronçon vu, et le joueur
    // voit le décor se refaire en tournant la tête (16 repeintures par demi-tour mesurées
    // 2026-11-18, dès que la brume, plus serrée que le carré, laisse une couronne à cuire
    // le long des visibles).
    const c = this._centre;
    const voisineDesYeux = (cx, cz) => {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) if (this._montreACamera(cx + dx, cz + dz)) return true;
      }
      return false;
    };
    const sousLesYeux = (cx, cz) => !!c && (this._montreACamera(cx, cz) || voisineDesYeux(cx, cz));
    // Tailler un tronçon hors écran. `horsVue` le signale au draineur : sans ce drapeau,
    // la marque sale laissée chez le voisin par `majMurs` lui ferait repeindre à l'image
    // un tronçon que personne ne regarde — et poser à la scène des triangles déjà au fichier.
    const tailler = (cx, cz, ecrire) => {
      if (sousLesYeux(cx, cz)) return false;
      const cle = this.getChunkKey(cx, cz);
      if (!this.chunks.has(cle) && !this.generateChunkData(cx, cz)) return false;
      const chunk = this.chunks.get(cle);
      if (!chunk) return false;
      chunk.horsVue = 1;
      this.rebuildChunk(cx, cz, { horsScene: true, ecrire });
      this.dirtyKeys.delete(cle);
      cuits++;
      return true;
    };
    try {
      while (!epuise()) {
        if (s.rang >= s.file.length) { s.enMarche = false; break; }
        const cible = s.file[s.rang];
        if (enBoite(cible.cx, cible.cz) || sousLesYeux(cible.cx, cible.cz)) { s.faits++; s.rang++; continue; }
        // Première passe : pousser la frontière des cloisons jusqu'à couvrir la couronne
        // qui entoure la cible. Le curseur `devant` survit entre deux appels, donc un
        // budget court n'empêche plus la gravure — il ne fait que la retarder d'une image.
        let pret = true;
        while (s.devant < s.file.length && s.file[s.devant].d <= cible.d + 1) {
          const t = s.file[s.devant];
          if (!sousLesYeux(t.cx, t.cz) && !this._tronconPret(t.cx, t.cz)) { pret = false; break; }
          const cleT = this.getChunkKey(t.cx, t.cz);
          if (!s.mailles.has(cleT) && tailler(t.cx, t.cz, false)) s.mailles.add(cleT);
          s.devant++;
          if (epuise()) break;
        }
        if (!pret) { s.attenteTranche = true; break; }      // tranche froide : on rend la main
        if (epuise()) break;
        if (!this._tronconPret(cible.cx, cible.cz)) { s.attenteTranche = true; break; }
        if (!enBoite(cible.cx, cible.cz)) tailler(cible.cx, cible.cz, true);
        s.attenteTranche = false;
        s.faits++;
        s.dernierProgres = performance.now();
        s.rang++;
        s.depuisPublication++;
        if (s.depuisPublication >= CUISSON_PUBLIER_A) {
          s.depuisPublication = 0;
          this._demanderPublicationGeom?.();
        }
        this._lacherDerriere(s);
      }
    } catch (e) {
      // Le budget disque est un plafond voulu, pas un accident : on s'arrête proprement
      // et on le dit, plutôt que de compresser des tronçons que le fichier ne peut pas
      // recevoir. Le joueur garde ce qui est déjà écrit.
      s.enMarche = false;
      s.sature = true;
      s.motif = e.message || 'cuisson interrompue';
      console.info('Cuisson de géométrie arrêtée :', s.motif);
    }
    return cuits;
  }

  /** Un bloc devenu faux sort des files d'écriture, mais reste au fichier. */
  _oublierGeom(key) {
    this.geomEnAttente.delete(key);
    this.geomACuire.delete(key);
    // Le fichier n'est pas retiré de l'écrivain : c'est l'empreinte qui fait foi à la
    // pose, pas la présence du bloc. Le retirer ici le faisait disparaître pour toujours
    // dès que le tronçon était sali pendant qu'il était hors champ — sa repeinture attend
    // son retour, et entre-temps plus rien ne le recuit (mesuré le fichier tombé de 81 à
    // 9 tronçons en trois visites). Un bloc périmé ne coûte que des octets ; un bloc
    // absent coûte un maillage.
  }

  /**
   * Décompresse à l'avance les tronçons que le mailleur va réclamer. En arrière-plan et
   * un seul pompateur à la fois : c'est du CPU volé à la frame, et le gain vient
   * justement de ne jamais le faire pendant qu'elle se construit. Les demandes qui
   * arrivent pendant qu'un pompage roule entrent dans sa file au lieu d'être perdues —
   * sinon le premier arrivé accapare tout et les suivants sont maillés pour rien.
   */
  preparerGeom(listeCles, { max = 6, urgente = false } = {}) {
    const cache = this.cacheGeom;
    if (!cache || GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return Promise.resolve(0);
    // Deux niveaux dans la file : ce que le mailleur réclame **maintenant** (0) passe
    // devant ce qu'on anticipe (1). En FIFO pur, un tronçon pressé attendait derrière
    // vingt-quatre blocs lointains et finissait par expirer — donc par être maillé pour
    // rien (mesuré 85 poses manquées sur 141).
    const priorite = urgente ? 0 : 1;
    for (const [cx, cz] of listeCles) {
      if (cache.aLeTroncon(cx, cz) && !cache.estChaud(cx, cz)) this._fileChauffe.set(`${cx},${cz}`, [cx, cz, priorite]);
    }
    if (this._chauffeGeom) return this._chauffeGeom;
    const promesse = this._pomperChauffe(max).then((n) => {
      if (this._chauffeGeom === promesse) this._chauffeGeom = null;
      return n;
    }, () => {
      if (this._chauffeGeom === promesse) this._chauffeGeom = null;
      return 0;
    });
    this._chauffeGeom = promesse;
    return promesse;
  }

  async _pomperChauffe(max) {
    const cache = this.cacheGeom;
    const plafond = max * 4;              // jamais plus de vingt-quatre blocs d'affilée
    let faites = 0;
    while (faites < plafond) {
      // Le plus pressé d'abord ; à égalité, le plus ancien (l'ordre d'insertion d'une Map
      // est stable, et on ne retient que ce qui est strictement plus urgent).
      let cleChoisie = null;
      let choisi = null;
      let priorite = Infinity;
      for (const [k, v] of this._fileChauffe) {
        if (v[2] < priorite) { priorite = v[2]; cleChoisie = k; choisi = v; if (v[2] === 0) break; }
      }
      if (!choisi) break;
      const [cx, cz] = choisi;
      this._fileChauffe.delete(cleChoisie);
      if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) break;   // le joueur a tranché entre-temps
      if (cache.estChaud(cx, cz)) continue;
      if (await cache.charger(cx, cz)) faites++;
    }
    return faites;
  }

  rebuildChunk(cx, cz, { horsScene = false, ecrire = true } = {}) {
    const key = this.getChunkKey(cx, cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.dirtyKeys.delete(key);
    this._jeterMaillages(chunk);
    // Le disque a peut-être déjà ces triangles : vingt-quatre fois moins cher que de les
    // refaire. En cas de doute (empreinte, seau inconnu), on tombe et le mailleur suit.
    if (this._poserDepuisDisque(chunk)) { this._rebuildsDepuisDisque++; return; }
    this._rebuilds++;
    chunk.venuDuDisque = false;

    const baseX = cx * CHUNK_SIZE;
    const baseZ = cz * CHUNK_SIZE;
    const overrides = this.collectOverrides(cx, cz);
    const hasMods = this.modifiedBlocks.size > 0;

    // In-chunk reads go straight to typed arrays; only the border columns pay
    // for a cross chunk lookup.
    const blockAt = (wx, wy, wz) => {
      if (wy < 0 || wy >= CHUNK_HEIGHT) return BLOCK.AIR;
      const lx = wx - baseX;
      const lz = wz - baseZ;
      if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
        const idx = lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE;
        if (hasMods && overrides[idx] >= 0) return overrides[idx];
        return chunk.data[idx] || BLOCK.AIR;
      }
      return this.getBlock(wx, wy, wz);
    };
    const opaqueAt = (wx, wy, wz) => {
      const b = blockAt(wx, wy, wz);
      return b !== BLOCK.AIR && !!BLOCK_INFO[b].opaque;
    };
    // Un tronçon pas encore généré n'est pas du vide : vu d'ici, il est plein. Le champ
    // de lumière doit donc lire « opaque » là où il n'a rien à lire — sinon un tronçon
    // maillé avant ses voisins reçoit le plein jour par des murs qui n'existent pas
    // encore. Mesuré le 2026-11-14, la luminance cuite à six cubes sous la surface
    // valait 0,495 contre 0,037 une fois le voisinage généré : le joueur voyait la
    // couleur des blocs se corriger toute seule en s'approchant. La géométrie, elle,
    // garde `opaqueAt` — dessiner une face vers un voisin absent ne gêne personne.
    const opaquePourLeCiel = (wx, wy, wz) => {
      if (opaqueAt(wx, wy, wz)) return true;
      const lx = wx - baseX, lz = wz - baseZ;
      if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) return false;
      return !this.chunks.has(this.getChunkKey(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)));
    };

    const buckets = {
      opaque: { positions: [], normals: [], uvs: [], colors: [], lumieres: [], indices: [], count: 0 },
      trans:  { positions: [], normals: [], uvs: [], colors: [], lumieres: [], indices: [], count: 0 },
      glow:   { positions: [], normals: [], uvs: [], colors: [], lumieres: [], indices: [], count: 0 },
    };

    // Les deux champs d'éclairage cuits dans les sommets : la lumière du ciel, qui
    // s'éteint au fond des galeries, et le halo des lanternes, qui doit survivre à
    // cette extinction (d'où leur séparation — voir `eclairage.js`). La couverture
    // « bâtiment » vient du village : sans elle, une tour de pierre serait jugée une
    // grotte habitée et ses appartements deviendraient noirs en plein midi.
    // Masque des cellules tenues par un bâtiment, indexé comme les données du tronçon :
    // une table de clés « x,y,z » coûterait des dizaines de milliers de chaînes par
    // remaillage dans un quartier dense, pour répondre à quelques milliers de questions.
    const tenuBati = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * CHUNK_HEIGHT);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const p of village.buildingAt(cx + dx, cz + dz) || []) {
          const bx = (cx + dx) * CHUNK_SIZE + p.x0;
          const bz = (cz + dz) * CHUNK_SIZE + p.z0;
          const yBas = Math.max(0, (p.siteH ?? 0) - 1);
          const yHaut = Math.min(CHUNK_HEIGHT - 1, (p.siteH ?? 0) + (p.height || 6) + 1);
          for (let x = bx; x < bx + p.w; x++) {
            const lx = x - baseX;
            if (lx < 0 || lx >= CHUNK_SIZE) continue;
            for (let z = bz; z < bz + p.d; z++) {
              const lz = z - baseZ;
              if (lz < 0 || lz >= CHUNK_SIZE) continue;
              const base = lx + lz * CHUNK_SIZE;
              for (let y = yBas; y <= yHaut; y++) tenuBati[base + y * CHUNK_SIZE * CHUNK_SIZE] = 1;
            }
          }
        }
      }
    }
    const ecl = creerEclairage({
      CHUNK_SIZE, CHUNK_HEIGHT,
      opaqueAt: opaquePourLeCiel,
      rocheAt: (wx, wy, wz) => ROCHE_NATURELLE.has(blockAt(wx, wy, wz)),
      estLampe: estLanterne,
      estBati: (wx, wy, wz) => {
        const lx = wx - baseX, lz = wz - baseZ;
        if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || wy < 0 || wy >= CHUNK_HEIGHT) return false;
        return tenuBati[lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE] === 1;
      },
    });
    // Le champ de lumière vient aussi des tronçons attenants : sans ces graines, une
    // pièce assise de part et d'autre d'une frontière restait noire du côté où le jour
    // entrait pourtant chez le voisin (mesuré 0,35 à gauche, 0,035 à droite).
    const graines = this.mursSemences(cx, cz);
    const cielDuTroncon = ecl.champCiel(baseX, baseZ, graines);
    this.majMurs(cx, cz, cielDuTroncon.niveau);
    const lampes = this.lampesAutour(cx, cz);
    const halo = ecl.champLampes(lampes, baseX, baseZ);
    const haloEn = (wx, wy, wz) => {
      if (wy < 0 || wy >= CHUNK_HEIGHT) return 0;
      const lx = wx - baseX, lz = wz - baseZ;
      if (lx >= 0 && lx < CHUNK_SIZE && lz >= 0 && lz < CHUNK_SIZE) {
        return halo[lx + lz * CHUNK_SIZE + wy * CHUNK_SIZE * CHUNK_SIZE];
      }
      // La face est donnée au tronçon voisin : sa cellule adjacente vit chez lui et n'est
      // pas dans ce champ. Y lire zéro barrait la cave d'une bande noire tous les
      // CHUNK_SIZE cubes — mesuré le 2026-11-15, les deux faces d'un même pilier sous une
      // applique valaient 0,24 et 0. Jugé sur place plutôt que lu chez le voisin : aucun
      // ordre de maillage ne peut donc laisser la bande en place.
      return ecl.puissanceLampe(lampes, wx, wy, wz);
    };

    // Classic voxel AO: the two side neighbours and the diagonal one sitting on
    // the air side of the face darken the corner they surround.
    const aoLevel = (face, wx, y, wz, corner) => {
      const [a, b] = TANGENT_AXES[face.axis];
      const nx = wx + face.dir[0], ny = y + face.dir[1], nz = wz + face.dir[2];
      const da = corner[a] === 1 ? 1 : -1;
      const db = corner[b] === 1 ? 1 : -1;
      const oa = [0, 0, 0]; oa[a] = da;
      const ob = [0, 0, 0]; ob[b] = db;
      let occ = 0;
      if (opaqueAt(nx + oa[0], ny + oa[1], nz + oa[2])) occ++;
      if (opaqueAt(nx + ob[0], ny + ob[1], nz + ob[2])) occ++;
      if (opaqueAt(nx + oa[0] + ob[0], ny + oa[1] + ob[1], nz + oa[2] + ob[2])) occ++;
      return AO_LEVELS[3 - occ];
    };

    const CUBE = [0, 0, 0, 1, 1, 1];

    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let y = 0; y < CHUNK_HEIGHT; y++) {
          const idx = lx + lz * CHUNK_SIZE + y * CHUNK_SIZE * CHUNK_SIZE;
          const wx = baseX + lx;
          const wz = baseZ + lz;
          let finalBlockId = chunk.data[idx];
          if (hasMods && overrides[idx] >= 0) finalBlockId = overrides[idx];
          if (!finalBlockId) continue;

          const info = BLOCK_INFO[finalBlockId];
          const estBox = !!info.box;
          const boite = estBox ? info.box : CUBE;
          const bucket = info.emissive ? buckets.glow
            : (info.pass === 'opaque' ? buckets.opaque : buckets.trans);
          const cullSameId = info.pass !== 'cutout';

          for (const face of FACES) {
            const nx = wx + face.dir[0];
            const ny = y + face.dir[1];
            const nz = wz + face.dir[2];
            const neighbor = blockAt(nx, ny, nz);

            let visible;
            if (estBox) visible = true;               // une boîte ne se fait pas manger par sa voisine
            else if (neighbor === BLOCK.AIR) visible = true;
            else if (BLOCK_INFO[neighbor].opaque) visible = false;
            else visible = !cullSameId || neighbor !== finalBlockId;
            if (!visible) continue;

            const rect = atlas.uvRect(tileNameFor(info, face.kind));
            // Translucent blocks keep their own tint rather than being darkened
            // twice (the texture already carries the colour). Sub-cube props skip AO
            // too: a quarter-cube post surrounded by air would only pick up noise.
            const faceLight = info.pass === 'opaque' && !estBox ? aoLevel : null;
            // Le bloc qui porte sa lumière n'a rien à recevoir du ciel ni des lampes.
            const clarte = info.emissive ? 1 : cielDuTroncon(nx, ny, nz);
            const lueur = info.emissive ? 0 : haloEn(nx, ny, nz);

            for (let c = 0; c < 4; c++) {
              const corner = face.corners[c];
              const uv = face.uvs[c];
              bucket.positions.push(
                wx + boite[0] + corner[0] * (boite[3] - boite[0]),
                y + boite[1] + corner[1] * (boite[4] - boite[1]),
                wz + boite[2] + corner[2] * (boite[5] - boite[2])
              );
              bucket.normals.push(face.dir[0], face.dir[1], face.dir[2]);
              bucket.uvs.push(
                rect.u0 + uv[0] * (rect.u1 - rect.u0),
                rect.v0 + uv[1] * (rect.v1 - rect.v0)
              );
              const light = face.shade * clarte * (faceLight ? faceLight(face, wx, y, wz, corner) : 1);
              bucket.colors.push(light, light, light);
              bucket.lumieres.push(face.shade * lueur);
            }

            bucket.indices.push(
              bucket.count, bucket.count + 1, bucket.count + 2,
              bucket.count, bucket.count + 2, bucket.count + 3
            );
            bucket.count += 4;
          }
        }
      }
    }

    const materiaux = [
      [buckets.opaque, this.matOpaque, 0, 'opaque'],
      [buckets.trans, this.matTrans, 1, 'trans'],
      [buckets.glow, this.matGlow, 1, 'glow'],
    ];
    for (const [bucket, materiau, ordre, seau] of materiaux) {
      if (bucket.count === 0) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(bucket.normals, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uvs, 2));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(bucket.colors, 3));
      geometry.setAttribute('aLampe', new THREE.Float32BufferAttribute(bucket.lumieres, 1));
      geometry.setIndex(bucket.indices);
      geometry.computeBoundingSphere();

      const mesh = new THREE.Mesh(geometry, materiau);
      mesh.renderOrder = ordre;
      // Le nom du seau voyage avec le mailleur : c'est lui qui dit à quel matériau
      // repartiront ces tampons quand ils reviendront du disque.
      mesh.userData.seau = seau;
      // La cuisson de fond fabrique les mêmes tampons pour le fichier, pas pour l'écran :
      // posés à la scène, ils seraient dessinés avant l'heure et comptés deux fois.
      if (!horsScene) this.scene.add(mesh);
      chunk.meshes.push(mesh);
    }
    // La note est tenue ici, pas à l'éviction : c'est le seul endroit qui sache ce qui
    // vient d'être alloué, et le budget se juge à chaque image.
    chunk.octets = this._tailleMaillages(chunk);
    this.octetsMailles += chunk.octets;
    // Et ce qui vient d'être payé est mis de côté pour le disque : la prochaine partie
    // le reposera sans rien recalculer.
    if (ecrire) this._cuissonGeom(cx, cz);
    // Cuisson de fond : les triangles sont partis vers le fichier, rien ne justifie
    // qu'ils encombrent encore la mémoire ni la scène. La note redescend par le même
    // chemin qu'elle est montée (`_jeterMaillages` déduit `chunk.octets`).
    if (horsScene) this._jeterMaillages(chunk);
  }

  /**
   * Ordre de visite des cellules d'un rayon, reconstruit seulement quand le rayon ou
   * la direction du regard change : à 32 chunks cela fait 4356 entrées, bien trop pour
   * un tri par image. La direction est quantifiée en 32 caps pour la même raison — sans
   * quoi la moindre rotation de souris jetterait la table.
   *
   * Le rang n'est pas la distance seule : un tronçon droit devant est compté comme
   * deux fois plus proche (`BIAIS_DEVANT`). Ce que le joueur ne verra plus jamais passe
   * en dernier, ce qui rend le créneau d'image disponible pour ce qu'il regarde.
   */
  offsetsFor(radius, dirX = 0, dirZ = 0) {
    const norm = Math.hypot(dirX, dirZ);
    const ax = norm > 1e-4 ? dirX / norm : 0;
    const az = norm > 1e-4 ? dirZ / norm : 0;
    const cap = norm > 1e-4 ? Math.round((Math.atan2(az, ax) + Math.PI) * 32 / Math.PI) : -1;
    const cle = `${radius}|${cap}`;
    if (this._offsetCle !== cle) {
      const offsets = [];
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const d = Math.sqrt(dx * dx + dz * dz);
          const cos = d > 0 ? (dx * ax + dz * az) / d : 1;
          offsets.push([dx, dz, d * (1 - BIAIS_DEVANT * cos)]);
        }
      }
      offsets.sort((a, b) => a[2] - b[2]);
      this._offsets = offsets;
      this._offsetCle = cle;
    }
    return this._offsets;
  }

  /**
   * Maille la file prête en commençant par ce que le joueur regarde, et rend le temps
   * qu'il y a passé — sans ce relevé, les deux passes du flot cumuleraient leurs
   * tranches et le budget d'image serait dépassé de 45 % (mesuré 14,5 ms pour 10
   * demandés, 56,7 i/s tombées à 43,3).
   *
   * Le contrôle d'horloge se fait **avant** l'appel coûteux : à ~4,5 ms le maillage,
   * contrôler après coup laissait chaque image déborder d'un tronçon entier.
   */
  drainerMailles(dureeAccordee) {
    const entree = performance.now();
    if (this.dirtyKeys.size === 0 || dureeAccordee <= 0) return 0;
    // Le fichier de géométrie est en cours de lecture : mailler maintenant payerait le
    // mailleur pour des triangles que le disque sait déjà peindre. On tient la file, sous
    // réserve du plafond horaire — un serveur muet ne doit pas immobiliser le monde.
    if (this.cacheGeomEnCours && entree - this.cacheGeomEnCours < ATTENTE_CACHE_GEOM_MS) return 0;
    const echeance = entree + dureeAccordee;
    const c = this._centre;
    const files = [];
    for (const key of this.dirtyKeys) {
      if (!this.chunks.has(key)) { this.dirtyKeys.delete(key); continue; }
      const virgule = key.indexOf(',');
      const cx = +key.slice(0, virgule);
      const cz = +key.slice(virgule + 1);
      let rang = 0;
      if (c && (this._dir.x !== 0 || this._dir.z !== 0)) {
        const dx = cx - c.pcx, dz = cz - c.pcz;
        const d = Math.hypot(dx, dz);
        const cos = d > 0 ? (dx * this._dir.x + dz * this._dir.z) / d : 1;
        rang = d * (1 - BIAIS_DEVANT * cos);
      } else if (c) {
        rang = Math.hypot(cx - c.pcx, cz - c.pcz);
      }
      files.push([rang, cx, cz]);
    }
    files.sort((a, b) => a[0] - b[0]);
    for (const [, cx, cz] of files) {
      if (performance.now() > echeance) return performance.now() - entree;
      const cle = this.getChunkKey(cx, cz);
      const chunk = this.chunks.get(cle);
      if (!chunk) continue;
      // Un tronçon mis en réserve ne se repeint pas pendant qu'il est hors champ : sa
      // peinture attend le retour. Le peindre ici coûterait 2,5–3,2 ms pour un résultat
      // que personne ne voit, et le budget mémoire n'aurait servi à rien.
      // S'y ajoute le tronçon **hors de la frontière rendue qui ignore qu'il est réservé**
      // — il naît avec `horsVue = 0`. Sans cette garde, sous pression mémoire il est maillé
      // (330 Ko), évincé parce qu'il ne se voit pas, recompté manquant à la passe suivante :
      // né mesuré 2026-11-18, quota forcé à 2 Mo, un mailleur payé à chaque passe et la file
      // du flot jamais vide. Mais différer aussi hors pression serait payer deux fois — le
      // pré-maillage d'un tronçon qui entre bientôt en vue est gratuit et rend son
      // accrochage immédiat (mesuré 171 maillages sur une course contre 219 quand on diffère
      // systématiquement). La condition porte donc sur la note, pas sur la seule frontière.
      if (chunk.horsVue || (!this._montreACamera(cx, cz)
          && this.octetsMailles > this._rafraichirQuota(entree))) {
        chunk.aRefaire = true;
        this.dirtyKeys.delete(cle);
        continue;
      }
      // Le disque sait peindre ce tronçon, mais son bloc n'est pas encore décompressé :
      // le mailler maintenant paierait le mailleur pour rien, alors que le résultat est à
      // un tour de boucle. On repousse dans le **temps** plutôt qu'en nombre de tours :
      // `updateChunks` peut tourner une vingtaine de fois entre deux images et trois
      // tours expiraient avant que zlib ait répondu (mesuré 20 poses sur 158 avec un
      // compteur de tours, 80 dès que la réponse a le temps de tomber). Le plafond horaire
      // garde la main : un fichier muet ne fait jamais attendre le joueur sur un écran vide.
      const cache = this.cacheGeom;
      if (cache && !cache.estChaud(cx, cz) && cache.aLeTroncon(cx, cz)
        && cache.empreinteDu(cx, cz) === this.empreinteGeom(cx, cz)) {
        const depuis = chunk.attenteDisqueDepuis || (chunk.attenteDisqueDepuis = entree);
        if (entree - depuis < ATTENTE_DISQUE_MS) {
          this.preparerGeom([[cx, cz]], { max: 4, urgente: true });
          continue;
        }
      }
      chunk.attenteDisqueDepuis = 0;
      this.rebuildChunk(cx, cz);
    }
    return performance.now() - entree;
  }

  // Génère au plus `maxCells` cellules manquantes et s'arrête après `maxMs` d'horloge
  // murale : une grande profondeur de champ se décharge ainsi sur plusieurs images
  // plutôt que de geler l'onglet. `dirX`/`dirZ` portent le regard du joueur — voir
  // `offsetsFor`, qui donne l'ordre de visite.
  //
  // Deux enveloppes, pas une : `maxMs` borne la génération du relief (et protège donc la
  // cadence), `maillageMs` ne borne que la maille et peut ainsi suivre la marge laissée par
  // l'image sans affamer le terrain. Les fusionner coûte cher, mesuré le 2026-11-17 sous
  // rasteriseur logiciel : de r=4 à r=7 (160 tronçons à faire naître), le monde se pose en
  // **31,5 s** avec une enveloppe unique contre **18,8 s** avec deux — soit ×1,7. Ce prix est
  // payé par la garde d'horloge partagée (`performance.now() > started + maxMs`) : rejouée par
  // emballage sans elle, la fusion ne coûtait rien (18,1 s). Par défaut (`maxMs * 0.6`), le
  // comportement reste exactement celui d'avant pour tous les appelants existants.
  updateChunks(playerX, playerZ, maxCells = Infinity, maxMs = Infinity, dirX = 0, dirZ = 0,
               maillageMs = maxMs * 0.6) {
    const started = performance.now();
    const pcx = Math.floor(playerX / CHUNK_SIZE);
    const pcz = Math.floor(playerZ / CHUNK_SIZE);
    const radius = settings.renderDistance;
    this._centre = { pcx, pcz, radius };
    // Le disque de la brume, une fois par appel : `_montreACamera` est interrogé des
    // centaines de fois par image et ne doit pas lire l'objet brume à chaque fois. Jugé sur
    // la brume sèche, jamais `scene.fog.far` (voir `MARGE_BRUME`). Tant que le ciel n'a
    // pas parlé, on ne culotte rien.
    this._camX = playerX;
    this._camZ = playerZ;
    this._brumeCarres = Number.isFinite(brumeSere.far) && brumeSere.far > 0
      ? (brumeSere.far + MARGE_BRUME * CHUNK_SIZE) ** 2
      : Infinity;
    const norm = Math.hypot(dirX, dirZ);
    this._dir.x = norm > 1e-4 ? dirX / norm : 0;
    this._dir.z = norm > 1e-4 ? dirZ / norm : 0;
    // Rangement d'abord : il décide de ce qui a le droit d'être repeint ci-dessous.
    this._rangerHorsChamp(pcx, pcz, radius, started);
    const offsets = this.offsetsFor(radius, dirX, dirZ);
    // Le disque se lit en arrière-plan. Deux files de réchauffement, dans l'ordre
    // d'urgence : les tronçons **à repeindre** que le fichier connaît (leur maillage est
    // déjà programmé pour cette image), puis les tronçons connus encore vierges — ceux-là
    // n'ont pas encore demandé leur tour, mais décompresser à l'avance coûte une fraction
    // du maillage qu'on évite ainsi. Les tronçons absents du fichier sont exclus des deux :
    // ils n'ont rien à attendre de là et voleraient du CPU à ceux qui comptent.
    if (this.cacheGeom && !this._chauffeGeom) {
      const cache = this.cacheGeom;
      // `estChaud` et non `pret` : un simple état des lieux n'a pas à se faire passer pour
      // un usage, sinon ce balayage du proche vers le loin recyclerait la file chaude en
      // faisant croire que les blocs lointains sont les plus récents — et ce sont les
      // proches qu'on évincerait en premier.
      const aRepeindre = [];
      const aAnticiper = [];
      // L'anticipation ne court pas plus vite que la consommation : le mailleur n'avale
      // qu'une poignée de tronçons par image, et remplir toute la réserve de blocs lointains
      // évincerait les blocs proches avant leur tour. La moitié de la réserve reste donc
      // libre pour les tronçons déjà réclamés par le drain.
      const placeLibre = Math.max(0, cache.limitesMain - this._fileChauffe.size);
      const plafondAnticipation = Math.min(12, Math.floor(placeLibre / 2));
      for (const [dx, dz] of offsets) {
        const cx = pcx + dx;
        const cz = pcz + dz;
        if (!cache.aLeTroncon(cx, cz) || cache.estChaud(cx, cz)) continue;
        if (this.dirtyKeys.has(this.getChunkKey(cx, cz))) {
          if (aRepeindre.length < 8) aRepeindre.push([cx, cz]);
        } else if (aAnticiper.length < plafondAnticipation) {
          aAnticiper.push([cx, cz]);
        }
        if (aRepeindre.length >= 8 && aAnticiper.length >= plafondAnticipation) break;
      }
      // `offsetsFor` visite du plus proche au plus loin : les urgents passent devant, et
      // ils entrent dans la file avec la priorité haute — un tronçon que le drain attend
      // ne doit jamais attendre derrière une anticipation.
      if (aRepeindre.length) this.preparerGeom(aRepeindre, { max: 6, urgente: true });
      if (aAnticiper.length) this.preparerGeom(aAnticiper, { max: 6 });
    }

    // Deux enveloppes distinctes et **indépendantes**, chacune comptée sur sa propre
    // consommation :
    //  - `maxMs` borne la **génération** (le réglage historique, celui qui protège la cadence
    //    et qui, seul, gouvernait les deux passes avant le 2026-11-17) ;
    //  - `partMaille` borne la **maille**, partagée entre les deux passages de
    //    `drainerMailles` — sinon chacun consomme sa part et l'image déborde.
    // Les séparer est tout l'enjeu : une seule enveloppe adaptative retarde la naissance du
    // relief de ×1,7 (voir la signature). Compter chaque passe sur son propre temps est la
    // moitié qui fait le prix : bornée par l'heure absolue d'entrée, la génération s'arrête dès
    // que la maille a consommé l'enveloppe — c'est exactement ce que coûte la garde partagée,
    // et ce que ne reproduit pas une fusion qui laisserait à la maille sa propre horloge.
    const partMaille = Math.max(0, Number.isFinite(maillageMs) ? maillageMs : maxMs * 0.6);
    let tempsMaille = 0;
    const tranche = () => partMaille - tempsMaille;

    tempsMaille += this.drainerMailles(tranche());

    let made = 0;
    let pending = 0;
    let tempsGener = 0;
    // Le balayage couvre toujours TOUTES les cellules du rayon, sinon `pendingChunks`
    // voudrait dire « ce que nous avons eu le temps de regarder » et non « ce qui reste
    // à faire » ; seule la génération elle-même est bornée par les seuils et son horloge.
    for (const [dx, dz] of offsets) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      const key = this.getChunkKey(cx, cz);
      if (this.chunks.has(key)) continue;
      pending++;
      if (made >= maxCells) continue;
      if (this.dirtyKeys.size > CHUNK_MESH_WATERMARK) continue;
      if (tempsGener >= maxMs) continue;
      made++; // failures consume budget too, so a bad cell cannot spin forever
      const debutCellule = performance.now();
      const ne = this.generateChunkData(cx, cz);
      tempsGener += performance.now() - debutCellule;
      if (ne) {
        // Le tronçon né et ses quatre voisins : chacun doit redessiner la frontière que
        // cette naissance vient de changer. Différer le maillage « jusqu'aux voisins » a
        // été mesuré le 2026-11-15 : cela doublait les repeintures (618 → 1278 sur un
        // vol de dix-huit secondes) sans jamais en supprimer une seule — deux tronçons
        // adjacents ne peuvent pas se mailler après l'autre.
        this.markChunkDirty(cx, cz);
        this.markChunkDirty(cx - 1, cz);
        this.markChunkDirty(cx + 1, cz);
        this.markChunkDirty(cx, cz - 1);
        this.markChunkDirty(cx, cz + 1);
      }
    }

    tempsMaille += this.drainerMailles(tranche());

    this.pendingChunks = pending + this.dirtyKeys.size;
    return { generated: made, pending: this.pendingChunks };
  }

  markChunkDirty(cx, cz) {
    this._marquerSale(this.getChunkKey(cx, cz));
  }

  /**
   * Met un tronçon à repeindre — ou l'inscrit comme tel s'il est hors champ. Un tronçon
   * réservé ne doit PAS entrer dans `dirtyKeys` : il n'est pas à l'image, le mailler
   * maintenant coûterait 2,5–3,2 ms pour rien, et le compter là ferait grimper
   * `pendingChunks` d'un travail différé (mesuré le 2026-11-16 : la file remontait entre
   * deux repesintes à la portée maximale, 3 977 → 3 981, parce que chaque naissance
   * marquait ses voisins réservés).
   */
  _marquerSale(key) {
    // Ce qui doit être repeint ne peut plus venir du disque : le bloc écrit hier n'est
    // plus celui de maintenant. On le retire des deux files avant même de savoir si le
    // tronçon est chargé — un tronçon évincé porte encore son bloc sur le disque.
    this._oublierGeom(key);
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    if (chunk.horsVue) chunk.aRefaire = true;
    else this.dirtyKeys.add(key);
  }

  // Repaints the atlas tiles of a block type (custom texture upload).
  setBlockTexture(blockId, source) {
    const info = BLOCK_INFO[blockId];
    if (!info) return false;
    const names = new Set([info.tiles.side, info.tiles.top, info.tiles.bottom]);
    let ok = false;
    for (const n of names) ok = atlas.overrideTile(n, source) || ok;
    if (ok) this.atlasAChange();      // les uv du disque ne désignent plus la même image
    return ok;
  }

  restoreBlockTexture(blockId) {
    const info = BLOCK_INFO[blockId];
    if (!info) return false;
    const names = new Set([info.tiles.side, info.tiles.top, info.tiles.bottom]);
    let ok = false;
    for (const n of names) ok = atlas.restoreTile(n) || ok;
    if (ok) this.atlasAChange();
    return ok;
  }
}

// ==================== PLAYER ====================
class Player {
  constructor(camera, world, controls, hotbar) {
    this.camera = camera;
    this.world = world;
    this.controls = controls;
    this.hotbar = hotbar;
    this.velocity = new THREE.Vector3();
    this.onGround = false;
    this.nage = false;        // le corps est dans l'eau : contrôleur de nage
    this.sousLEau = false;    // et la tête dessous : teinte d'immersion
    // Combien du corps reste sous l'eau au repos, réglé au clavier (+ et -). Portée
    // par le joueur plutôt que par une constante : on garde son assiette tant qu'on nage.
    this.assiette = FLOAT_SUBMERGED;
    this.flyMode = FLY;
    // ---- contrôleur aérien (voir les constantes en tête de module) ----
    this.planant = false;       // le second appui d'Espace a ouvert le plané
    this.reacteurs = false;     // Espace tenu en l'air : les réacteurs tiennent la montée
    this.vitesseVol = PLANE_DEFAUT;   // allure du planeur, dosée par Z et S
    this.espaceTenu = false;    // état de la touche à l'image précédente (détection d'appui)
    this.attendRelache = false; // l'appui qui a ouvert/rompu le plané ne doit pas allumer les réacteurs
    this.spawnPoint = new THREE.Vector3(8, 0, 8);
    // Placement only: the saved position now arrives asynchronously from disk and
    // bootWorld() owns the chunk building, so the constructor must not stream.
    this.placeAtSpawn();
  }

  // The hotbar is the single source of truth for what the player holds.
  get selectedBlock() { return this.hotbar.selectedBlock(); }
  get selectedSlot() { return this.hotbar.selected; }

  // ---- geometry helpers -------------------------------------------------
  get feetY() { return this.camera.position.y - EYE_HEIGHT; }
  setEye(x, y, z) { this.camera.position.set(x, y + EYE_HEIGHT, z); }
  setFeet(y) { this.camera.position.y = y + EYE_HEIGHT; }

  // Does the collider overlap a solid voxel when placed with its feet at `feet`?
  collides(x, feet, z) {
    const hw = PLAYER_HALF_WIDTH;
    const minX = Math.floor(x - hw + COLLIDE_EPS);
    const maxX = Math.floor(x + hw - COLLIDE_EPS);
    const minY = Math.floor(feet + COLLIDE_EPS);
    const maxY = Math.floor(feet + PLAYER_HEIGHT - COLLIDE_EPS);
    const minZ = Math.floor(z - hw + COLLIDE_EPS);
    const maxZ = Math.floor(z + hw - COLLIDE_EPS);

    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (this.world.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  // Used to refuse placing a block inside the player.
  intersectsBlock(bx, by, bz) {
    const p = this.camera.position;
    const feet = this.feetY;
    const hw = PLAYER_HALF_WIDTH;
    return (
      p.x + hw > bx + COLLIDE_EPS && p.x - hw < bx + 1 - COLLIDE_EPS &&
      p.z + hw > bz + COLLIDE_EPS && p.z - hw < bz + 1 - COLLIDE_EPS &&
      feet + PLAYER_HEIGHT > by + COLLIDE_EPS && feet < by + 1 - COLLIDE_EPS
    );
  }

  // Push the collider out of terrain it spawned inside of.
  settle() {
    const p = this.camera.position;
    // Un corps qu'on ressort d'un bloc ne doit pas en repartir en plané. La mémoire de
    // l'appui d'Espace, elle, se garde : `settle` tourne dès que le collider frotte une
    // paroi — un nageur qui remonte une berge y passe une dizaine de fois par seconde, et
    // effacer cette mémoire lui rendait les réacteurs en pleine longueur de nage.
    this.planant = false;
    this.reacteurs = false;
    let feet = this.feetY;
    if (!this.collides(p.x, feet, p.z)) {
      this.velocity.y = 0;
      return true;
    }
    for (let i = 0; i < 64; i++) {
      feet += 0.1;
      if (!this.collides(p.x, feet, p.z)) {
        this.setFeet(feet);
        this.velocity.set(0, 0, 0);
        this.onGround = true;
        return true;
      }
    }
    this._teleportToSpawn();
    return false;
  }

  _spawnXZ() {
    return [SPAWN_XZ[0], SPAWN_XZ[1]];
  }

  /**
   * Le point où le joueur est posé quand on le remet à l'apparition. Sur un monde neuf,
   * c'est l'intérieur du temple le plus proche ; `getTerrainHeight` n'a rien à dire de
   * cet endroit — le sol y est une dalle estampée, plusieurs cubes au-dessus du relief.
   * Renvoie le niveau des pieds, comme le reste du module.
   */
  _spawnPoint() {
    if (mondeVierge) {
      const t = resoudreApparition();
      if (t) return t;
    }
    const [sx, sz] = this._spawnXZ();
    return { x: sx, y: getTerrainHeight(sx, sz) + 1, z: sz };
  }

  // Drops the player on the surface at the spawn point without touching the world.
  placeAtSpawn() {
    const p = this._spawnPoint();
    this.setEye(p.x, p.y, p.z);
    if (Number.isFinite(p.yaw)) {
      // Le visiteur se réveille face à l'autel, pas dos à lui.
      this.camera.rotation.order = 'YXZ';
      this.camera.rotation.set(0, p.yaw, 0, 'YXZ');
    }
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.coupeLeVol();
  }

  /** Un déplacement brutal rend réacteurs et plané sans objet : on oublie tout. */
  coupeLeVol() {
    this.planant = false;
    this.reacteurs = false;
    this.attendRelache = false;
    this.vitesseVol = PLANE_DEFAUT;
    // Une touche encore tenue ne doit pas compter comme un appui neuf à la reprise.
    // (Le dictionnaire de touches est branché sur les contrôles après le joueur : d'où
    // la lecture prudente, sinon la page meurt au démarrage.)
    this.espaceTenu = !!this.controls?.keys?.Space;
  }

  _teleportToSpawn() {
    const p = this._spawnPoint();
    // chunks around the spawn may have been unloaded while the player was away
    this.world.updateChunks(p.x, p.z, WORLD_BOOT_BUDGET);
    this.placeAtSpawn();
  }

  respawn() {
    this._teleportToSpawn();
    this.settle();
  }

  // What lands in the save file: eye position plus the look direction, so a
  // resumed session opens facing the same way it was left.
  saveState() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    const p = this.camera.position;
    return { x: p.x, y: p.y, z: p.z, yaw: e.y, pitch: e.x };
  }

  // The ground has to exist before the player is dropped on it: landing in an
  // ungenerated chunk would fall straight through to KILL_Y, hence the synchronous
  // build under the feet followed by settle() for edits saved inside the terrain.
  restoreFromSave(state) {
    if (!state) return false;
    this.setEye(state.x, state.y, state.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.quaternion.setFromEuler(new THREE.Euler(state.pitch, state.yaw, 0, 'YXZ'));
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.world.updateChunks(state.x, state.z, WORLD_BOOT_BUDGET);
    this.settle();
    return true;
  }

  // ---- nage ---------------------------------------------------------------
  /**
   * Où en est le corps par rapport à l'**eau** : c'est ce qui choisit le contrôleur.
   * `surface` est la première colonne non liquide au-dessus du joueur, autrement dit
   * le plan d'eau vers lequel la flottaison le ramène. Seule l'eau compte : la lave
   * aussi est `liquid`, mais y flotter tiendrait le joueur suspendu au-dessus d'un
   * bain de lave au lieu de le laisser s'y enfoncer lentement. Toute cellule d'eau porte
   * un corps (`estNageable`) : l'automate ne rend que des cubes pleins, on nage donc
   * aussi bien dans une flaque de sept cubes de long que dans l'océan.
   */
  waterState() {
    const p = this.camera.position;
    const feet = this.feetY;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    const eau = (y) => this.world.estNageable(bx, y, bz);
    const pieds = eau(Math.floor(feet + 0.2));
    const poitrine = eau(Math.floor(feet + 0.9));
    const tete = eau(Math.floor(feet + PLAYER_HEIGHT - 0.2));
    if (!pieds && !poitrine && !tete) return { nage: false, tete: false, surface: 0 };
    let y = Math.floor(pieds ? feet + 0.2 : (poitrine ? feet + 0.9 : feet + PLAYER_HEIGHT - 0.2));
    while (y < CHUNK_HEIGHT && eau(y)) y++;
    return { nage: true, tete, surface: y };
  }

  /** Le corps trempe-t-il dans la lave ? (plafond de chute, pas de flottaison) */
  dansLaLave() {
    const p = this.camera.position;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    const lave = (y) => this.world.getBlock(bx, y, bz) === BLOCK.LAVA;
    const feet = this.feetY;
    return lave(Math.floor(feet + 0.2)) || lave(Math.floor(feet + 0.9))
      || lave(Math.floor(feet + PLAYER_HEIGHT - 0.2));
  }

  /** Règle l'assiette de flottaison (+ et - au clavier) et renvoie la valeur retenue. */
  regleAssiette(pas) {
    this.assiette = Math.min(ASSIETTE_MAX, Math.max(ASSIETTE_MIN, this.assiette + pas));
    return this.assiette;
  }

  /** Le corps repose-t-il sur le lit ? Au fond, on ne vous éjecte pas vers la surface. */
  toucheLeFond() {
    const p = this.camera.position;
    return this.collides(p.x, this.feetY - 0.35, p.z);
  }

  /**
   * Le contrôleur de l'eau. La vitesse verticale **rejoint** une vitesse visée au lieu
   * d'être intégrée à coups d'accélération : le rappel tout-ou-rien d'avance ne
   * s'asseyait jamais sur l'équilibre et faisait trembler le joueur à la surface. Trois
   * régimes, et c'est leur découpage qui répond aux deux plaintes — « je coule au lieu
   * de flotter » et « je ne peux pas rester au fond » :
   *
   *  - à la ligne (dans `FLOT_BAND`) : un ressort amorti tient le corps à `surface −
   *    assiette`, sans rebond ni oscillation ;
   *  - plus bas, en pleine eau : dérive lente vers la surface — on n'y est pas aspiré,
   *    on peut donc y travailler ;
   *  - posé sur le lit : rien ne soulève, on reste au fond sans tenir Majuscule.
   */
  applyWater(deltaTime, eau) {
    const cible = eau.surface - this.assiette;
    const ecart = cible - this.feetY;
    let vise;
    if (this.controls.keys['Space']) vise = SWIM_UP;
    else if (this.controls.keys['ShiftLeft']) vise = -SWIM_DOWN;
    else if (ecart > FLOT_BAND) vise = this.toucheLeFond() ? 0 : FLOT_DRIFT;
    else vise = Math.max(-FLOT_RAISE, Math.min(FLOT_RAISE, ecart * FLOT_GAIN));
    const alpha = 1 - Math.exp(-VERT_RESPONSE * deltaTime);
    this.velocity.y += (vise - this.velocity.y) * alpha;
    this.velocity.x *= Math.exp(-WATER_DRAG_XZ * deltaTime);
    this.velocity.z *= Math.exp(-WATER_DRAG_XZ * deltaTime);
    this.velocity.y = Math.min(SWIM_UP, Math.max(-SWIM_DOWN, this.velocity.y));
  }

  update(deltaTime) {
    const pos = this.camera.position;

    // Movement input relative to where the camera looks (flattened on XZ).
    const direction = new THREE.Vector3();
    this.controls.getDirection(direction);
    // L'aplatissement ne vaut que pour la marche : le planeur, lui, suit le regard à
    // trois dimensions, donc l'inclinaison de la caméra est ce qui monte et descend.
    const regard = direction.clone();
    direction.y = 0;
    if (direction.lengthSq() > 0) direction.normalize();

    const right = new THREE.Vector3();
    right.crossVectors(direction, new THREE.Vector3(0, 1, 0)).normalize();

    const moveInput = new THREE.Vector3();
    if (this.controls.keys['KeyW'] || this.controls.keys['KeyZ']) moveInput.add(direction);
    if (this.controls.keys['KeyS']) moveInput.sub(direction);
    if (this.controls.keys['KeyD'] || this.controls.keys['KeyQ']) moveInput.add(right);
    if (this.controls.keys['KeyA']) moveInput.sub(right);
    if (moveInput.lengthSq() > 0) moveInput.normalize();

    const eau = this.flyMode ? { nage: false, tete: false, surface: 0 } : this.waterState();
    this.nage = eau.nage;
    this.sousLEau = eau.tete;

    // ---- les trois gestes d'Espace ----------------------------------------
    // Un appui se reconnaît au passage faux→vrai entre deux images : sans cette
    // distinction, maintenir la touche ouvrirait le plané sitôt les réacteurs éteints.
    const tenu = !!this.controls.keys['Space'] && !this.flyMode;
    const appuie = tenu && !this.espaceTenu;
    this.espaceTenu = tenu;
    if (!tenu) this.attendRelache = false;
    if (eau.nage) this.planant = false;   // sous l'eau, Espace reste le coup de palme
    let venaitDeSauter = false;
    if (appuie && !this.flyMode) {
      if (eau.nage) {
        // L'appui appartient au coup de palme. Sans ce garde, le corps qui franchit la
        // ligne d'eau touche tenue s'allumait en réacteurs : la sortie de rivière
        // devenait un décollage et plus personne ne se hissait sur la berge.
        this.attendRelache = true;
      } else if (this.onGround) {
        this.velocity.y = JUMP_SPEED;     // une pression saute
        this.onGround = false;
        venaitDeSauter = true;            // cette image garde l'élan du saut
      } else if (this.planant) {
        this.planant = false;             // en vol, la même pression rompt le plané
        this.attendRelache = true;        // et ne doit pas rallumer les réacteurs
      } else {
        this.planant = true;              // seconde pression en l'air : on ouvre le plané
        this.attendRelache = true;
      }
    }
    // Les réacteurs tiennent la montée tant que la touche est tenue ; ils ne s'allument
    // ni au sol (c'est le saut), ni en plané, ni dans l'eau, ni l'image du saut — sinon
    // l'élan de JUMP_SPEED serait écrasé par celui des réacteurs dès le décollage.
    this.reacteurs = tenu && !this.attendRelache && !this.planant && !venaitDeSauter
      && !this.onGround && !eau.nage && !this.flyMode;

    if (this.planant && !eau.nage && !this.flyMode) {
      // Le planeur : Z (ou W) pousse le gaz, S le réduit, et le **regard tient la
      // trajectoire** — nez vers le haut on prend de l'altitude, nez vers le bas on en
      // perd, tout l'air venant de l'allure dosée au gaz. La portance reste liée à
      // l'avancement : nez à l'horizontale et sous l'allure de sustentation, on coule
      // doucement au lieu de tomber, ce qui interdit le vol stationnaire gratuit.
      if (this.controls.keys['KeyZ'] || this.controls.keys['KeyW']) this.vitesseVol += PLANE_THRUST * deltaTime;
      if (this.controls.keys['KeyS']) this.vitesseVol -= PLANE_THRUST * deltaTime;
      this.vitesseVol = Math.min(PLANE_MAX, Math.max(PLANE_MIN, this.vitesseVol));
      const portance = Math.min(1, this.vitesseVol / PLANE_LIFT_SPEED);
      this.velocity.set(
        regard.x * this.vitesseVol,
        regard.y * this.vitesseVol - PLANE_SINK_MAX * (1 - portance),
        regard.z * this.vitesseVol,
      );
    } else {
      const speed = this.flyMode ? FLY_SPEED : (eau.nage ? SWIM_SPEED : MOVE_SPEED);
      this.velocity.x = moveInput.x * speed;
      this.velocity.z = moveInput.z * speed;

      if (!this.flyMode) {
        if (eau.nage) {
          this.applyWater(deltaTime, eau);
        } else {
          this.velocity.y -= GRAVITY * deltaTime;
          this.velocity.y = Math.max(this.velocity.y, -TERMINAL_VELOCITY);
          // Dans la lave on s'enfonce, on ne tombe pas : le plafond supprime la vitesse
          // terminale dès que le corps touche le bain.
          if (this.dansLaLave()) this.velocity.y = Math.max(this.velocity.y, LAVE_CHUTE);
          if (this.reacteurs) this.velocity.y = JET_SPEED;
        }
      } else {
        if (this.controls.keys['Space']) this.velocity.y = FLY_SPEED;
        else if (this.controls.keys['ShiftLeft']) this.velocity.y = -FLY_SPEED;
        else this.velocity.y = 0;
      }
    }

    this.moveWithCollision(this.velocity.clone().multiplyScalar(deltaTime));

    // Posé, le planeur n'a plus de raison d'être : on marche, et un nouvel Espace saute.
    if (this.onGround) { this.planant = false; this.reacteurs = false; }

    if (this.feetY < KILL_Y) this.respawn();
    // Position persistence is driven by the autosave tick in animate(), which
    // writes the whole world diff and the player state together.
  }

  // Moves one axis at a time in small substeps, snapping flush against the
  // blocking face instead of stopping mid-air (which used to leave the player
  // floating a fraction of a block away from walls).
  moveWithCollision(delta) {
    const pos = this.camera.position;

    // A block placed inside the player, or a stale saved position, must not
    // make every subsequent move report a collision.
    if (this.collides(pos.x, this.feetY, pos.z)) this.settle();

    this.moveY(delta.y);
    this.moveHorizontal(0, delta.x);
    this.moveHorizontal(2, delta.z);

    if (!this.flyMode) {
      const feet = this.feetY;
      this.onGround = this.velocity.y <= 0 && this.collides(pos.x, feet - GROUND_PROBE, pos.z);
    } else {
      this.onGround = false;
    }
  }

  moveY(delta) {
    if (delta === 0) return;
    const pos = this.camera.position;
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / MAX_SUBSTEP));
    const inc = delta / steps;

    for (let i = 0; i < steps; i++) {
      const feet = this.feetY;
      const candidate = feet + inc;
      if (!this.collides(pos.x, candidate, pos.z)) {
        this.setFeet(candidate);
        continue;
      }
      if (inc < 0) {
        // landed: rest exactly on top of the blocking block
        this.setFeet(Math.floor(candidate) + 1);
        this.onGround = true;
      } else {
        // head bumped the underside of a block
        this.setFeet(Math.floor(candidate + PLAYER_HEIGHT) - PLAYER_HEIGHT);
      }
      this.velocity.y = 0;
      return;
    }
  }

  moveHorizontal(axis, delta) {
    if (delta === 0) return;
    const pos = this.camera.position;
    const key = axis === 0 ? 'x' : 'z';
    const steps = Math.max(1, Math.ceil(Math.abs(delta) / MAX_SUBSTEP));
    const inc = delta / steps;

    for (let i = 0; i < steps; i++) {
      const feet = this.feetY;
      const candidate = pos[key] + inc;
      const candX = axis === 0 ? candidate : pos.x;
      const candZ = axis === 2 ? candidate : pos.z;

      if (!this.collides(candX, feet, candZ)) {
        pos[key] = candidate;
        continue;
      }

      // Auto step up onto a single block while walking on the ground. A swimmer gets
      // two plus a stroke's reach: coming out of the sea onto the beach must never be
      // a wall. The resting levels are whole numbers (block top + 1), so the ladder is
      // anchored on the first one at or above the feet — anchoring it on `floor(feet)`
      // loses a rung whenever the feet rest a hair under the block top they stand on
      // (30.999999999999996 for a top at 31), which turned every stair tread into a
      // wall and left the swimmer — never exactly on the float line — stuck in the sea.
      if (!this.flyMode && (this.onGround || this.nage)) {
        const portee = this.nage ? SWIM_STEP + SWIM_REACH : STEP_HEIGHT;
        const assise = Math.ceil(feet - COLLIDE_EPS);
        let gravi = false;
        for (let raised = assise; raised - feet <= portee + COLLIDE_EPS; raised++) {
          if (raised <= feet + COLLIDE_EPS) continue;
          if (!this.collides(pos.x, raised, pos.z) && !this.collides(candX, raised, candZ)) {
            this.setFeet(raised);
            pos[key] = candidate;
            gravi = true;
            break;
          }
        }
        if (gravi) continue;
      }

      if (inc > 0) {
        pos[key] = Math.floor(candidate + PLAYER_HALF_WIDTH) - PLAYER_HALF_WIDTH - COLLIDE_EPS;
      } else {
        pos[key] = Math.floor(candidate - PLAYER_HALF_WIDTH) + 1 + PLAYER_HALF_WIDTH + COLLIDE_EPS;
      }
      this.velocity[key] = 0;
      return;
    }
  }

  getLookTarget() {
    const pos = this.camera.position;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    const dist = 6;
    return pos.clone().add(dir.multiplyScalar(dist));
  }
}

// ==================== BLOCK ICONS / HOTBAR / INVENTORY ====================
// Icons come straight out of the world atlas so the HUD always matches what
// actually gets placed.
function drawBlockIcon(canvas, blockId) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(atlas.tileCanvas(BLOCK_INFO[blockId].tiles.side), 0, 0);
}

class Hotbar {
  constructor() {
    this.container = document.getElementById('hotbar');
    this.stripContainer = document.getElementById('inventory-hotbar');
    this.blocks = loadHotbar();
    this.selected = 0;
    this.slots = [];
    this.stripSlots = [];
    this.build();
  }

  build() {
    this.container.innerHTML = '';
    this.stripContainer.innerHTML = '';
    this.slots = [];
    this.stripSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      this.slots.push(this.makeSlot(i, false));
      this.stripSlots.push(this.makeSlot(i, true));
    }
    this.select(this.selected);
  }

  makeSlot(index, inInventory) {
    const slot = document.createElement('div');
    slot.className = 'hotbar-slot';
    slot.dataset.index = index;

    const num = document.createElement('span');
    num.className = 'slot-num';
    num.textContent = index + 1;
    slot.appendChild(num);

    const preview = document.createElement('canvas');
    preview.width = 16;
    preview.height = 16;
    slot.appendChild(preview);
    drawBlockIcon(preview, this.blocks[index]);

    if (inInventory) {
      slot.title = `Cibler l'emplacement ${index + 1}`;
      slot.addEventListener('click', () => this.select(index));
      this.stripContainer.appendChild(slot);
    } else {
      this.container.appendChild(slot);
    }
    return slot;
  }

  select(index) {
    const i = ((index % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    this.selected = i;
    for (const list of [this.slots, this.stripSlots]) {
      list.forEach((slot, k) => slot.classList.toggle('active', k === i));
    }
    return this.blocks[i];
  }

  cycle(dir) { return this.select(this.selected + (dir >= 0 ? 1 : -1)); }

  selectedBlock() { return this.blocks[this.selected]; }

  assign(index, blockId) {
    if (!BLOCK_INFO[blockId]) return false;
    const i = Math.max(0, Math.min(HOTBAR_SIZE - 1, index | 0));
    this.blocks[i] = blockId;
    drawBlockIcon(this.slots[i].querySelector('canvas'), blockId);
    drawBlockIcon(this.stripSlots[i].querySelector('canvas'), blockId);
    localStorage.setItem(HOTBAR_STORAGE_KEY, JSON.stringify(this.blocks));
    return true;
  }

  // Called after an atlas tile is repainted (custom texture upload).
  render() {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      drawBlockIcon(this.slots[i]?.querySelector('canvas'), this.blocks[i]);
      drawBlockIcon(this.stripSlots[i]?.querySelector('canvas'), this.blocks[i]);
    }
  }

  reset() {
    this.blocks = DEFAULT_HOTBAR.slice();
    this.build();
    this.select(0);
  }
}

class Inventory {
  constructor(hotbar, controls, blocker, keys, lockPointer) {
    this.hotbar = hotbar;
    this.controls = controls;
    this.blocker = blocker;
    this.keys = keys;
    this.lockPointer = lockPointer;
    this.root = document.getElementById('inventory');
    this.grid = document.getElementById('inventory-grid');
    this.cells = new Map();
    this.visible = false;
    this.build();
    document.getElementById('inv-close').addEventListener('click', () => this.hide());
  }

  build() {
    this.grid.innerHTML = '';
    this.cells.clear();
    for (const group of BLOCK_GROUPS) {
      const head = document.createElement('div');
      head.className = 'inv-section';
      head.textContent = group.label;
      this.grid.appendChild(head);

      for (const id of group.ids) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'inv-cell';
        cell.dataset.block = String(id);
        cell.title = `${BLOCK_INFO[id].name} — affecter à l'emplacement actif`;

        const canvas = document.createElement('canvas');
        canvas.width = 16;
        canvas.height = 16;
        drawBlockIcon(canvas, id);
        cell.appendChild(canvas);

        const label = document.createElement('span');
        label.textContent = BLOCK_INFO[id].name;
        cell.appendChild(label);

        cell.addEventListener('click', () => this.pick(id));
        this.grid.appendChild(cell);
        this.cells.set(id, cell);
      }
    }
    this.markEquipped();
  }

  // Left click puts the block into the active slot and holds it right away.
  pick(blockId) {
    if (!this.hotbar.assign(this.hotbar.selected, blockId)) return false;
    this.hotbar.select(this.hotbar.selected);
    this.markEquipped();
    return true;
  }

  markEquipped() {
    const equipped = new Set(this.hotbar.blocks);
    for (const [id, cell] of this.cells) cell.classList.toggle('equipped', equipped.has(id));
  }

  // Re-draw every palette icon from the atlas (custom texture upload changed a tile).
  repaintIcons() {
    for (const [id, cell] of this.cells) {
      const canvas = cell.querySelector('canvas');
      if (canvas) drawBlockIcon(canvas, id);
    }
  }

  isOpen() { return this.visible; }

  toggle() { if (this.visible) this.hide(); else this.show(); }

  show() {
    this.visible = true;
    this.root.classList.add('open');
    // The start/pause screen would otherwise cover the palette; hide() puts it
    // back through relock() if the pointer lock cannot be re-acquired.
    this.blocker.style.display = 'none';
    this.markEquipped();
    // the palette needs the cursor, so give the pointer lock back to the page
    if (this.controls.isLocked) this.controls.unlock();
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.root.classList.remove('open');
    // never resume play with a key still held down from the menu
    for (const k of Object.keys(this.keys)) this.keys[k] = false;
    this.relock();
  }

  relock() {
    const restore = () => {
      if (!this.controls.isLocked && !this.visible) this.blocker.style.display = 'flex';
    };
    const pending = this.lockPointer();
    // Refused for lack of user activation: hand the screen back right away instead
    // of leaving the page with neither the game nor the start screen under foot.
    if (pending && typeof pending.catch === 'function') pending.catch(restore);
    setTimeout(restore, 300); // engines where requestPointerLock returns nothing
  }
}

// ==================== MAIN GAME ====================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 30, 60);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

// Fog and the far plane have to follow the configured view depth: too little fog
// and chunks pop in un-blurred at the edge, too much and a short distance just
// greys out. Both are derived from the same number so they never disagree.
//
// Le départ du voile était pris à 45 % et sa fin à 85 % de la portée : mesuré à midi,
// toute le relief au-delà de la moitié du champ rendu rendait la seule couleur de brume
// — l'utilisateur voyait « des cubes tous blancs à l'horizon ». Le brouillard ne garde
// que sa vraie tâche, dissoudre la lisière ; le milieu du champ garde ses matières.
// Le référentiel « temps sec » est gardé à part : l'averse resserre la brume autour de
// ces deux valeurs (`majCiel`) et doit les retrouver exactement quand elle se retire,
// sans quoi un réglage de profondeur de champ fait après une pluie hériterait du ciel bas.
const brumeSere = { near: 30, far: 60 };
function applyFogForDistance(radius) {
  brumeSere.near = Math.max(6, radius * CHUNK_SIZE * 0.62);
  brumeSere.far = radius * CHUNK_SIZE * 0.98;
  scene.fog.near = brumeSere.near;
  scene.fog.far = brumeSere.far;
  camera.far = Math.max(200, radius * CHUNK_SIZE * 2);
  camera.updateProjectionMatrix();
}
applyFogForDistance(settings.renderDistance);

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setSize(window.innerWidth, window.innerHeight);

/** Le ratio que vaut un réglage de netteté — « native » est l'ancien `min(devicePixelRatio, 2)`. */
function ratioNetrete(reglage = settings.netrete) {
  const plafond = Math.min(window.devicePixelRatio || 1, PLAFOND_PIXELS_PAR_IMAGE);
  if (reglage === NETTETE_DEFAUT) return plafond;
  const n = Number(reglage);
  return Number.isFinite(n) && n > 0 ? Math.min(n, plafond) : plafond;
}

function appliquerNetrete() {
  renderer.setPixelRatio(ratioNetrete());
}

appliquerNetrete();
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.72);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfff4e0, 0.5);
sunLight.position.set(50, 100, 50);
scene.add(sunLight);

// ==================== CIEL, SOLEIL ET LANTERNES ====================
// Le modèle du ciel est pur (`ciel.js`) ; tout ici se contente de le consommer. Rien
// n'est re-maillé pour faire la nuit : l'heure ne pilote que les lumières de scène, la
// brume et les objets du ciel. Les deux canaux cuits dans les sommets (obscurité des
// grottes, halo des lanternes) sont indépendants de l'heure, sauf l'uniforme qui allume
// ou éteint les lanternes.
const horloge = creerHorloge({ duree: settings.dureeJour });
let etatCiel = etatDuCiel(horloge.heure());

// Les objets du ciel suivent la caméra et se paient le luxe d'un test de profondeur
// désactivé avec un ordre de rendu négatif : ils sont peints avant le terrain, qui les
// recouvre — le soleil se couche donc derrière une colline au lieu de la traverser.
const PLANETE_CIEL = new THREE.Group();
PLANETE_CIEL.renderOrder = -10;
scene.add(PLANETE_CIEL);

const domeGeo = new THREE.SphereGeometry(1, 32, 16);
// Les shaders maison écrivent `gl_FragColor` à la main : Three n'y insère jamais
// l'encodage de sortie que reçoivent les matériaux built-in. Les couleurs passées en
// uniforme sont pourtant déjà converties en linéaire par ColorManagement — écrites
// telles quelles dans un framebuffer sRGB, elles rendent deux fois trop sombre
// (mesuré : #808080 → 55,55,55 et #9dc3e4 → 86,139,198 au lieu de 128,128,128 et
// 157,195,228). La brume des tronçons, elle, suit le bon pipeline et garde sa valeur.
// C'est tout l'écart du « tout est blanc à l'horizon » : le relief lointain se peignait
// à luminance ~148 contre ~112 pour le ciel qui le surmonte, la bande d'horizon
// devenant l'élément le plus clair de l'image. Ces deux shaders doivent donc encoder
// comme le reste de la scène.
const GLSL_VERS_SRGB = /* glsl */`
  vec3 versSRGB(vec3 c) {
    vec3 v = clamp(c, 0.0, 1.0);
    return mix(v * 12.92, pow(v, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(vec3(0.0031308), v));
  }`;
const domeUniformes = {
  uZenith: { value: new THREE.Color(0x87ceeb) },
  uHorizon: { value: new THREE.Color(0xcfe6f5) },
  uDirectionSoleil: { value: new THREE.Vector3(0, 1, 0) },
  uHalo: { value: 0 },
};
const dome = new THREE.Mesh(domeGeo, new THREE.ShaderMaterial({
  uniforms: domeUniformes,
  side: THREE.BackSide,
  depthWrite: false,
  depthTest: false,
  fog: false,
  vertexShader: /* glsl */`
    varying vec3 vDir;
    void main() {
      vDir = normalize(position);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uZenith;
    uniform vec3 uHorizon;
    uniform vec3 uDirectionSoleil;
    uniform float uHalo;
    varying vec3 vDir;
    ${GLSL_VERS_SRGB}
    void main() {
      float t = clamp(vDir.y * 1.35 + 0.08, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(t, 0.65));
      // Le renard autour de l'astre : un lavis chaud, serré contre lui et d'amplitude
      // bornée. Large (pow(face, 6)) et franc (×0,85), il blanchissait toute la bande
      // d'horizon dès que le soleil la frôlait — une centaine de degrés de ciel partait
      // au blanc, ce que l'utilisateur décrivait comme « à l'horizon tout est blanc ».
      float face = max(dot(normalize(vDir), normalize(uDirectionSoleil)), 0.0);
      col += uHalo * pow(face, 18.0) * vec3(0.55, 0.30, 0.13);
      gl_FragColor = vec4(versSRGB(col), 1.0);
    }`,
}));
dome.renderOrder = -10;
PLANETE_CIEL.add(dome);

const disqueGeo = new THREE.CircleGeometry(1, 40);
// Rayons apparents des astres, en radians — l'échelle est recalculée avec la distance
// pour qu'ils gardent cette taille quelle que soit la profondeur de champ réglée.
const RAYON_SOLEIL_APPARENT = 0.034;
const RAYON_LUNE_APPARENTE = 0.0277;
function faireDisque(couleur, opacite) {
  const m = new THREE.Mesh(disqueGeo, new THREE.MeshBasicMaterial({
    color: couleur, transparent: true, opacity: opacite,
    // Test de profondeur **activé** : un matériau transparent est peint après tout le
    // relief opaque, donc sans test il flotterait au-dessus des toits et de la roche
    // (mesuré : un mur plein à six cubes laissait passer 38 % de pixels lunaires).
    // Les astres sont placés juste sous le plan lointain dans `majCiel`, si bien que
    // n'importe quel bloc est plus près qu'eux et les masque — « à l'infini », ici.
    depthWrite: false, depthTest: true, fog: false, side: THREE.DoubleSide,
  }));
  m.renderOrder = -9;
  PLANETE_CIEL.add(m);
  return m;
}
const disqueSoleil = faireDisque(0xfff2cc, 1);
const disqueLune = faireDisque(0xd8e2ff, 0.92);
disqueSoleil.name = 'soleil';
disqueLune.name = 'lune';

// Étoiles : une calotte fixe, tirée au même hachage que le reste du monde pour qu'un
// rechargement ne redessine pas un ciel différent.
const etoiles = (() => {
  const N = 700;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // Répartition quasi uniforme sur la sphère haute, par angles tirés au hasard déterministe.
    const azimut = hashRoll(i, 1, 3, 71) * Math.PI * 2;
    const hauteur = Math.acos(1 - hashRoll(i, 2, 5, 73) * 1.05);
    const rayon = 1;
    pos[i * 3] = Math.sin(hauteur) * Math.cos(azimut) * rayon;
    pos[i * 3 + 1] = Math.cos(hauteur) * rayon;
    pos[i * 3 + 2] = Math.sin(hauteur) * Math.sin(azimut) * rayon;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffffff, size: 2.2, sizeAttenuation: false,
    // Même règle que les disques : sans test de profondeur, les étoiles traversent la
    // roche et les toits, le ciel nocturne se peignant par-dessus le monde.
    transparent: true, opacity: 0, depthWrite: false, depthTest: true, fog: false,
  }));
  pts.renderOrder = -9;
  pts.visible = false;
  PLANETE_CIEL.add(pts);
  return pts;
})();

// Nuages : une nappe continue, pas des cubes. Deux plans horizontaux tendus au-dessus
// du monde et tendus d'un dessin de bouffissures douces, peint une fois pour toutes
// dans un canevas. Un plan texturé plutôt qu'une couche de voxels, pour trois raisons :
// la forme d'un nuage n'a aucune raison d'être cubique, deux triangles par couche coûtent
// moins qu'un tronçon entier, et le ciel n'a rien à partager avec le monde — un nuage
// que le joueur pourrait creuser n'a pas de sens.
const NUAGE_TEXELLE = 256;   // résolution du dessin, en pixels

// Les trois écritures de ciel. Un seul dessin partagé par les deux couches donnait un
// motif unique répété à deux altitudes (mesuré le 2026-11-18 : les deux nappes portaient
// la même texture, même `uuid`). Chaque forme règle combien d'amas tiennent sur la tuile,
// de lobes compte chaque amas, leur rayon, leur éclat de cœur, l'étirement horizontal et
// — pour le stratus — le nombre de bandes sur lesquelles les amas se rangent.
const FORMES_NUAGE_DESSIN = {
  cumulus: { amas: 17, lobes: [4, 9], rayon: [0.05, 0.10], coeur: [0.32, 0.56], etirement: 1, bandes: 0 },
  // Nappes basses et continues : des amas aplatis dix fois plus larges que hauts, alignés
  // en quatre rubans, et un cœur moins franc — un stratus n'a pas de bourrelet.
  stratus: { amas: 12, lobes: [7, 13], rayon: [0.035, 0.06], coeur: [0.20, 0.32], etirement: 3.4, bandes: 4 },
  // Filaments de haute altitude : beaucoup de traits fins, très étirés, peu lumineux.
  cirrus: { amas: 24, lobes: [9, 16], rayon: [0.012, 0.030], coeur: [0.16, 0.28], etirement: 6.5, bandes: 0 },
};

/**
 * Dessine une tuile de ciel déterministe. Chaque halo est peint sur les neuf positions
 * possibles de la tuile, sans quoi la couture d'une répétition se verrait en grille.
 */
function dessinerTuileDeNuages(sel, forme = 'cumulus') {
  const regle = FORMES_NUAGE_DESSIN[forme] || FORMES_NUAGE_DESSIN.cumulus;
  const c = document.createElement('canvas');
  c.width = NUAGE_TEXELLE; c.height = NUAGE_TEXELLE;
  const g = c.getContext('2d');
  g.clearRect(0, 0, NUAGE_TEXELLE, NUAGE_TEXELLE);
  for (let i = 0; i < regle.amas; i++) {
    const ax = hashRoll(i, sel, 1, 4111) * NUAGE_TEXELLE;
    let az = hashRoll(i, sel, 2, 4127) * NUAGE_TEXELLE;
    if (regle.bandes) {
      const pas = NUAGE_TEXELLE / regle.bandes;
      az = Math.round(az / pas) * pas;
    }
    const coeur = regle.coeur[0] + hashRoll(i, sel, 4, 4151) * (regle.coeur[1] - regle.coeur[0]);
    const lobes = regle.lobes[0]
      + Math.floor(hashRoll(i, sel, 3, 4133) * (regle.lobes[1] - regle.lobes[0] + 1));
    for (let k = 0; k < lobes; k++) {
      const ang = hashRoll(i, k, sel + 7, 4177) * Math.PI * 2;
      const ecart = hashRoll(i, k, sel + 11, 4201) * 0.34;
      const r = (regle.rayon[0] + hashRoll(i, k, sel + 13, 4211)
        * (regle.rayon[1] - regle.rayon[0])) * NUAGE_TEXELLE;
      const x = ax + Math.cos(ang) * ecart * NUAGE_TEXELLE;
      const y = az + Math.sin(ang) * ecart * NUAGE_TEXELLE * 0.6;
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++) {
        const px = x + ox * NUAGE_TEXELLE;
        const py = y + oz * NUAGE_TEXELLE;
        const rx = r * regle.etirement;
        if (px < -rx || px > NUAGE_TEXELLE + rx || py < -r || py > NUAGE_TEXELLE + r) continue;
        // L'ellipse se fait par transformation, pas par rayon : un gradient radial suivi
        // d'un `scale` garde son dégradé collé au halo, ce qu'un arc écrasé perdrait.
        g.save();
        g.translate(px, py);
        g.scale(regle.etirement, 1);
        const grad = g.createRadialGradient(0, 0, 0, 0, 0, r);
        grad.addColorStop(0, `rgba(255,255,255,${coeur.toFixed(3)})`);
        grad.addColorStop(0.55, `rgba(255,255,255,${(coeur * 0.45).toFixed(3)})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
// Une tuile par forme, dessinée une seule fois : le ciel change d'écriture au fil du
// temps sans jamais redessiner un canvas image après image.
const ORDRE_FORMES = Object.keys(FORMES_NUAGE_DESSIN);
const NUAGES_TUILES = {};
for (const f of ORDRE_FORMES) NUAGES_TUILES[f] = dessinerTuileDeNuages(1, f);
const NUAGES_TEXTE = NUAGES_TUILES[ORDRE_FORMES[0]];

// Le fondu se juge sur l'élévation du rayon visuel, jamais sur la brume de scène : la
// nappe flotte quatre-vingts cubes au-dessus de la tête, donc tout ce qui frôle
// l'horizon est déjà au-delà du plan lointain. S'en remettre à `fog` reviendrait à
// peindre un voile blanc sur toute la bande d'horizon — exactement le lavage que
// l'utilisateur reprochait au plein jour. L'autre moitié du fondu se cale sur le plan
// lointain de la caméra (`uPortee`) : sans elle, le plan est simplement tronqué par le
// volume de vue et la nappe présente une arête circulaire.
const SHADER_NUAGE = /* glsl */`
  uniform sampler2D uCarte;
  uniform vec3 uCouleur;
  uniform float uOpacite;
  uniform vec3 uCam;
  uniform float uPortee;
  varying vec2 vUv;
  varying vec3 vMonde;
  ${GLSL_VERS_SRGB}
  void main() {
    vec3 dir = vMonde - uCam;
    float l = max(length(dir), 1e-4);
    // Valeur absolue : vu d'en dessous comme d'en dessus, le nuage reste un voile.
    float elevation = abs(dir.y) / l;
    float voile = smoothstep(0.055, 0.34, elevation)
                * (1.0 - smoothstep(uPortee * 0.72, uPortee, l));
    float corps = texture2D(uCarte, vUv).a;
    float a = corps * uOpacite * voile;
    if (a < 0.004) discard;
    // Le cœur dense prend tout son éclat, la bordure reste laiteuse : c'est ce dégradé
    // qui fait un volume plutôt qu'une tache plate collée au ciel.
    gl_FragColor = vec4(versSRGB(uCouleur * (0.82 + 0.18 * corps)), a);
  }`;

function faireNape(nom, altitude, tuile, facteur, vitesse, decalForme = 0) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    uniforms: {
      uCarte: { value: NUAGES_TEXTE },
      uCouleur: { value: new THREE.Color(0xffffff) },
      uOpacite: { value: 0 },
      uCam: { value: new THREE.Vector3() },
      uPortee: { value: 400 },
      // Le tuilage se fait ici et non sur la texture : un ShaderMaterial ne consulte
      // jamais `texture.repeat` ni `texture.offset`, qui ne vivent que dans la matrice
      // `map_transform` des matériaux built-in. Poser l'ancrage sur ces derniers laissait
      // le ciel glisser avec le joueur tout en annonçant une dérive nulle au contrôle.
      uTuile: { value: new THREE.Vector2(1, 1) },
      uDecalage: { value: new THREE.Vector2(0, 0) },
    },
    vertexShader: /* glsl */`
      uniform vec2 uTuile;
      uniform vec2 uDecalage;
      varying vec2 vUv;
      varying vec3 vMonde;
      void main() {
        vUv = uv * uTuile + uDecalage;
        vec4 monde = modelMatrix * vec4(position, 1.0);
        vMonde = monde.xyz;
        gl_Position = projectionMatrix * viewMatrix * monde;
      }`,
    fragmentShader: SHADER_NUAGE,
    transparent: true,
    depthWrite: false,
    // Test de profondeur activé, comme les astres : depuis une grotte ou sous un toit,
    // la roche est plus près qu'elle et doit la masquer.
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
  }));
  // Rotation qui pose le plan à l'horizontale : l'axe local +y part vers −z monde, d'où
  // le signe inversé sur l'axe v dans `majCiel`.
  m.rotation.x = -Math.PI / 2;
  // Un rang sous les astres (-9) : le centre de la nappe est confondu avec la caméra,
  // donc à tri égal Three la peindrait en dernier, par-dessus le soleil.
  m.renderOrder = -10;
  m.name = 'nuages';
  m.userData = { nom, altitude, tuile, facteur, vitesse, decalForme };
  PLANETE_CIEL.add(m);
  return m;
}
const nappes = [
  // Les deux couches se posent **au-dessus du sol sous le joueur**, pas à une altitude
  // absolue : à cent trente cubes de hauteur fixes, le plan lointain de la caméra (deux
  // cents cubes à la portée par défaut) n'en laissait voir qu'une calotte de vingt
  // degrés autour du zénith. En épousant le relief, la nappe basse reste à quatre-vingt
  // quatre cubes au-dessus de la tête et couvre le ciel jusqu'à vingt-cinq degrés.
  //
  // Les vitesses sont celles d'une **dérive de base**, multipliée dans `majCiel` par le
  // vent du monde. Elles ont été relevées d'un facteur deux et demi le 2026-11-18 : à
  // 0,0032 tuile par seconde, la couche basse avançait d'un cube toutes les trois secondes
  // — un ciel peint, pas un ciel qui vit (« fait aussi que les nuages bougent »). La haute
  // reste plus lente que la basse : c'est ce décalage qui donne deux altitudes au lieu d'un
  // seul papier peint.
  faireNape('basse', 84, 96, 1, 0.0075, 0),
  // La couche haute porte toujours une écriture différente de la basse (`decalForme` 1) :
  // des cumulus à quatre-vingts cubes coiffés de filaments à cent trente se lisent comme
  // deux altitudes, deux fois le même dessin se lit comme un seul papier peint.
  faireNape('haute', 130, 152, 0.62, 0.0048, 1),
];

// Dérive des nappes selon le vent. À vent nul il reste une traîne — un ciel immobile se
// remarque dès qu'on lève les yeux ; à vent plein la couche basse file de deux cubes et
// demi par seconde, ce qu'un cumulus à quatre-vingts cubes au-dessus de la tête rend bien.
const NAPPE_SOUFFLE_BASE = 0.35;
const NAPPE_SOUFFLE_VENT = 2.9;

// ==================== PLUIE ====================
// Le modèle de la météo est pur (`meteo.js`), comme celui du ciel : il ne rend rien, il
// décide de plusieurs signaux — `couverture` (le gris, qui précède les gouttes et leur
// survit), `intensite` (les gouttes seules), `degage` (la journée sans un nuage), `couche`
// (l'épaisseur des nappes) et `vent` (ce qui les entraîne). Tout ici les consomme.
const METEO_SEL = (WORLD_SEEDS.trees * 6151) | 0;   // deux mondes différents, deux météos
const meteo = creerMeteo({ sel: METEO_SEL, mode: settings.meteo });
// Une suite fige l'averse pour la juger sans attendre vingt minutes d'horloge ; `null`
// rend la main au monde.
let pluieForcee = null;
// Même ressort pour le vent : juger que les nuages avancent exige de comparer deux instants
// à vent tenu, sinon c'est l'amplitude du jour qui répond à la question et non la dérive.
let ventForce = null;

/**
 * L'état de la météo tel que la scène doit le rendre, reprise en main des suites incluse.
 * Forcer l'averse force le gris qui va avec — une averse sous un ciel bleu n'est pas une
 * averse — et éteint le régime dégagé, qui prétend à l'inverse.
 */
function meteoCourante() {
  const e = meteo.etat();
  if (pluieForcee == null && ventForce == null) return e;
  const k = pluieForcee == null ? e.intensite : pluieForcee;
  const couverture = Math.max(e.couverture, k);
  const degage = k > 0.05 ? 0 : e.degage;
  const vent = ventForce == null ? e.vent : Math.min(1, Math.max(0, Number(ventForce) || 0));
  return {
    ...e, intensite: k, couverture, degage, vent,
    couche: pluieForcee == null ? e.couche : Math.max(0.55 + 0.5 * couverture, e.couche),
  };
}


// ---- le rideau de gouttes ---------------------------------------------------
// Des points, pas des voxels : une goutte n'a rien à partager avec le monde, et quelques
// milliers de sprites coûtent moins cher qu'un tronçon. Tout le mouvement vit dans le vertex
// shader — la chute s'enroule sur `uTemps`, le vent emporte chaque goutte selon sa graine —
// donc aucun tableau n'est renvoyé au GPU image après image. La densité se règle par seuil
// sur cette même graine : épaissir l'averse ne reconstruit rien.
//
// Deux couches, pas une. La seule boîte de 52 cubes autour de la tête rendait une coquille :
// mesuré le 2026-11-18, les gouttes s'arrêtaient à ~45 cubes (anneaux de 15 : 674/3245/581/
// 0/0/0) alors que la brume de pluie rend jusqu'à 60 — la pluie finissait en rond avant le
// ciel bas. La couche proche garde la densité qui se voit à deux mètres, la couche lointaine
// remplit jusqu'à la muraille de brume à un prix dérisoire (des sprites de trois pixels).
const PLUIE_COUCHE_PROCHE = { boite: new THREE.Vector3(56, 44, 56), points: 5200, poids: 1 };
// La couche lointaine remplit jusqu'au mur de brume mais ne doit pas faire un voile : son poids
// est ce qui, empilé sur des milliers de points, donnait l'aspect « nappe épaisse » par-dessus
// les vraies gouttes du premier plan.
const PLUIE_COUCHE_LOINTAINE = { boite: new THREE.Vector3(96, 80, 96), points: 5200, poids: 0.5 };
// La fraction du nuage de points réellement tirée à pleine averse. À 1, l'averse peignait
// 4,6 % du cadre en traits de 9×5 px — un pâté presque carré, large jusqu'à 22 px : le joueur
// lisait de la neige (`probe-neige.mjs`, 2026-11-18). Ramené à moitié, au quart puis au cinquième :
// ce qui fait une averse, c'est la longueur des traits, pas le nombre de voiles qui se chevauchent.
const PLUIE_DENSITE_RIDEAU = 0.2;
// Vitesse de chute moyenne des gouttes (l'attribut `aVitesse` court de 16 à 28) : c'est le
// dénominateur de l'inclinaison peinte. Sans lui, la traînée se couchait d'un coefficient
// arbitraire et se retrouvait inclinée **vent nul**.
const CHUTE_GOUTTE = 22;
const COULEUR_PLUIE_NUIT = new THREE.Color(0x6f7f92);
const COULEUR_PLUIE_JOUR = new THREE.Color(0xdfeaf7);

// ---- les enveloppes intérieures ---------------------------------------------
// Une maison ne doit pas se remplir de pluie, et pas seulement quand le joueur y tient :
// le clip de pièce (`sonderChambre`) est centré sur la caméra, donc dehors rien n'était
// retiré et la pluie tombait visiblement à l'intérieur — le vitrage écrit sa profondeur
// après le rideau, il ne retient rien. Mesuré le 2026-11-18 depuis le trottoir : six
// gouttes sur six dans une maison de 12×4, onze sur onze dans un corps de 3×11, quatre sur
// quatre dans deux maisons de 5×4 et 4×4. Le remède vient des plans du village : une boîte
// par bâtiment, du plancher à la sous-face du toit, rechargée quand le quartier change.
// Vingt-quatre boîtes tiennent dans un uniforme ; au-delà, les plus proches gardent la place.
const ENVELOPPES_MAX = 24;
const ENVELOPPE_RAYON = 72;          // jusqu'où chercher des bâtiments autour de la tête
const ENVELOPPE_INTERVALE = 0.5;     // secondes entre deux relevés des plans
const enveloppesA = [];
const enveloppesB = [];
for (let i = 0; i < ENVELOPPES_MAX; i++) {
  // Hors de portée pour toujours tant qu'elles sont vides : x borné à l'envers, y à l'envers.
  enveloppesA.push(new THREE.Vector4(0, 1e4, 0, 0));
  enveloppesB.push(new THREE.Vector4(-1e4, -1e4, -1e4, 0));
}
let enveloppeN = 0;
let dernierReleveEnveloppe = -10;

function majEnveloppes(maintenant, x, z) {
  if (maintenant - dernierReleveEnveloppe < ENVELOPPE_INTERVALE) return;
  dernierReleveEnveloppe = maintenant;
  const brutes = village.enveloppesSur(
    Math.floor(x - ENVELOPPE_RAYON), Math.floor(z - ENVELOPPE_RAYON),
    Math.floor(x + ENVELOPPE_RAYON), Math.floor(z + ENVELOPPE_RAYON),
  );
  brutes.sort((p, q) => (((p.x0 + p.x1) / 2 - x) ** 2 + ((p.z0 + p.z1) / 2 - z) ** 2)
    - (((q.x0 + q.x1) / 2 - x) ** 2 + ((q.z0 + q.z1) / 2 - z) ** 2));
  enveloppeN = Math.min(ENVELOPPES_MAX, brutes.length);
  for (let i = 0; i < ENVELOPPES_MAX; i++) {
    const b = brutes[i];
    if (b) {
      enveloppesA[i].set(b.x0, b.y0, b.z0, 1);
      enveloppesB[i].set(b.x1, b.y1, b.z1, 1);
    } else {
      enveloppesA[i].set(0, 1e4, 0, 0);
      enveloppesB[i].set(-1e4, -1e4, -1e4, 0);
    }
  }
}

const SHADER_PLUIE = /* glsl */`
  uniform vec3 uBoite;
  uniform float uIntN;                      // combien de boîtes d'intérieur sont remplies
  uniform vec4 uIntA[${ENVELOPPES_MAX}];    // coin bas de chaque enveloppe de bâtiment
  uniform vec4 uIntB[${ENVELOPPES_MAX}];    // coin haut de la même enveloppe
  uniform float uTemps;
  uniform float uHoule;
  uniform vec2 uVent;
  uniform vec4 uChambre;      // x, plafond y, z, rayon : la pièce close qui ne se mouille pas
  uniform float uDedans;
  uniform float uTaille;
  uniform float uPortee;
  uniform float uDensite;
  attribute float aVitesse;
  attribute float aGraine;
  varying float vVoile;
  void main() {
    vec3 p = position;
    p.y = mod(p.y - uTemps * aVitesse + uBoite.y * 0.5, uBoite.y) - uBoite.y * 0.5;
    // Le vent emporte les gouttes sur ses deux axes horizontaux, dans le **repère du monde** :
    // une goutte ne sait rien de la caméra. Chaque goutte le ressent selon sa graine, sinon le
    // rideau entier glisserait d'un bloc comme un papier peint qu'on tire. La houle est une
    // oscillation, pas une dérive : elle agite l'air calme sans jamais donner de côté préféré
    // à la pluie (une dérive constante couchait les gouttes vers +x même vent nul, mesuré le
    // 2026-11-18 — la pluie « changeait de sens » dès qu'on tournait la tête parce que seule
    // sa traînée, elle, suivait le vent).
    float g = 0.6 + 0.8 * aGraine;
    float houle = sin(uTemps * 0.9 + aGraine * 6.2831853) * uHoule;
    p.x = mod(p.x + uTemps * uVent.x * g + houle + uBoite.x * 0.5, uBoite.x) - uBoite.x * 0.5;
    p.z = mod(p.z + uTemps * uVent.y * g + houle * 0.7 + uBoite.z * 0.5, uBoite.z) - uBoite.z * 0.5;
    vec3 monde = (modelMatrix * vec4(p, 1.0)).xyz;
    vec4 oeil = viewMatrix * vec4(monde, 1.0);
    gl_Position = projectionMatrix * oeil;
    float d = max(-oeil.z, 1.0);
    // Taille bornée : un point collé à la caméra couvrirait l'écran au lieu de tremper. Le
    // plafond peut être haut parce que la LARGEUR ne vient pas d'ici mais du lisseur x du
    // fragment shader : à 24 px de long le trait fait encore ~5 px de large (allongement ~4,5).
    // Ce qui faisait le flocon, c'était un carré de 22 px sous un lisseur large (5 px de large
    // pour 9 de haut, mesuré) — pas la taille en elle-même. Rendre les traits plus longs est
    // la façon de garder une pluie lisible quand on éclaircit le rideau.
    gl_PointSize = clamp(uTaille * (34.0 / d), 1.0, 24.0);
    vVoile = (1.0 - smoothstep(uPortee * 0.55, uPortee, d)) * step(aGraine, uDensite);
    // Une pièce close ne se mouille pas : les gouttes qui y flotteraient sont retirées, mais
    // le rideau reste vivant — c'est ce qui laisse voir l'averse par les baies vitrées. Le
    // test de profondeur fait le reste (le plafond masque ce qui est au-dessus de lui).
    if (uDedans > 0.5) {
      float dcx = monde.x - uChambre.x, dcz = monde.z - uChambre.z;
      if (monde.y < uChambre.y && dcx * dcx + dcz * dcz < uChambre.w * uChambre.w) vVoile = 0.0;
    }
    // Et la maison entière se tient au sec, que le joueur soit dedans ou dans la rue : les
    // enveloppes viennent des plans du village (enveloppesSur), rechargées quand le
    // quartier change. La pièce close ci-dessus reste nécessaire — c'est elle qui abrite
    // l'abri que le joueur s'est construit lui-même, qu'aucun plan ne connaît.
    for (int i = 0; i < ${ENVELOPPES_MAX}; i++) {
      vec4 a = uIntA[i], b = uIntB[i];
      float dedans = step(a.x, monde.x) * step(monde.x, b.x)
                   * step(a.y, monde.y) * step(monde.y, b.y)
                   * step(a.z, monde.z) * step(monde.z, b.z)
                   * step(float(i) + 0.5, uIntN);   // au-delà du comptage, rien à retirer
      vVoile *= 1.0 - dedans;
    }
  }`;

const SHADER_PLUIE_FRAGMENT = /* glsl */`
  uniform vec3 uCouleur;
  uniform float uOpacite;
  uniform float uPente;
  varying float vVoile;
  ${GLSL_VERS_SRGB}
  void main() {
    vec2 q = gl_PointCoord - 0.5;
    q.x -= q.y * uPente;                       // la traînée est inclinée, pas verticale
    // Les deux lisseurs définissent la goutte : une baguette haute et **étroite**. Le large
    // avait dérivé (0,06 → 0,30 en x) : mesuré le 2026-11-18, les traits peints sortaient à
    // 9 px de haut sur 5 de large, allongement médian 1,67 — le rapport d'un flocon, et le
    // joueur l'a dit (« on dirait plus de la neige »). À 0,11 le trait restait continu mais
    // faisait 4–6 px de large ; le joueur a redemandé « plus fin », donc 0,07 — un cheveu de
    // pluie, tenu par sa longueur plutôt que par sa largeur. C'est ce rapport, pas la surface
    // mouillée, qui fait la pluie.
    float trait = (1.0 - smoothstep(0.015, 0.07, abs(q.x)))
                * (1.0 - smoothstep(0.04, 0.52, abs(q.y)));
    float a = trait * uOpacite * vVoile;
    if (a < 0.01) discard;
    gl_FragColor = vec4(versSRGB(uCouleur), a);
  }`;

function faireRideauDePluie(couche) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(couche.points * 3);
  const vitesses = new Float32Array(couche.points);
  const graines = new Float32Array(couche.points);
  for (let i = 0; i < couche.points; i++) {
    pos[i * 3] = (hashRoll(i, 1, 7, 9101) - 0.5) * couche.boite.x;
    pos[i * 3 + 1] = (hashRoll(i, 2, 7, 9103) - 0.5) * couche.boite.y;
    pos[i * 3 + 2] = (hashRoll(i, 3, 7, 9107) - 0.5) * couche.boite.z;
    vitesses[i] = 16 + hashRoll(i, 4, 7, 9109) * 12;   // cubes par seconde
    graines[i] = hashRoll(i, 5, 7, 9127);               // densité et dérive individuelles
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aVitesse', new THREE.BufferAttribute(vitesses, 1));
  geo.setAttribute('aGraine', new THREE.BufferAttribute(graines, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), couche.boite.length() * 0.6);
  const m = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: {
      uBoite: { value: couche.boite.clone() },
      uIntA: { value: enveloppesA },
      uIntB: { value: enveloppesB },
      uIntN: { value: 0 },
      uTemps: { value: 0 },
      // Houle basse : une oscillation latérale franche faisait dériver chaque goutte de son
      // côté à elle, ce qui, ajouté aux traits carrés, achevait l'illusion de la neige.
      uHoule: { value: 0.16 },
      uVent: { value: new THREE.Vector2(0, 0) },
      uChambre: { value: new THREE.Vector4(0, 0, 0, 0) },
      uDedans: { value: 0 },
      uTaille: { value: 12.5 },
      uPortee: { value: 90 },
      uCouleur: { value: new THREE.Color(0xdfeaf7) },
      uOpacite: { value: 0 },
      uPente: { value: 0 },
      uDensite: { value: 0 },
    },
    vertexShader: SHADER_PLUIE,
    fragmentShader: SHADER_PLUIE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    // Test de profondeur actif : la roche devant la caméra doit cacher les gouttes, sinon
    // une grotte se remplissait de pluie. Ce qui reste à faire — ne pas tremper l'intérieur
    // d'une pièce tout en laissant voir l'averse par ses baies — se juge dans le vertex
    // shader (`uChambre`) et non plus en éteignant le rideau entier sous un toit.
    depthTest: true,
    fog: false,
  }));
  m.name = 'pluie';
  // Le volume suit la caméra : le culler sur une boîte locale reviendrait à faire
  // disparaître la pluie dès qu'elle regarde ailleurs.
  m.frustumCulled = false;
  // Avant les blocs translucides, pas après : le verre des baies écrit la profondeur, et un
  // rideau peint après lui était poliment rejeté derrière la vitre — l'averse devenait
  // invisible depuis l'intérieur d'une maison. Peint avant, il est ensuite recouvert par le
  // mélange du vitrage, ce qui est exactement ce que veut dire « voir la pluie à travers ».
  m.renderOrder = -1;
  m.visible = false;
  m.userData.poids = couche.poids;
  scene.add(m);
  return m;
}
const rideauxPluie = [
  faireRideauDePluie(PLUIE_COUCHE_PROCHE),
  faireRideauDePluie(PLUIE_COUCHE_LOINTAINE),
];
const rideauPluie = rideauxPluie[0];         // la couche proche : ce que jugent les gros plans

// Sous terre, les lanternes tiennent allumées en plein jour : c'est la roche au-dessus
// de la tête qui décide, pas l'heure. Le relevé se paie une fois par quart de seconde,
// pas par image — c'est une descente de colonne, pas un calcul gratuit.
const HAUT = new THREE.Vector3(0, 1, 0);
// Vecteur de travail : l'axe « droite » de la caméra, pour savoir dans quelle mesure le
// vent traverse l'écran (et donc de combien il couche les gouttes à l'image).
const droiteCaméra = new THREE.Vector3();
let lanterneVivet = etatCiel.lampes;
let dernierReleveToit = -10;
let toitVu = false;
function sousTerre(maintenant) {
  if (maintenant - dernierReleveToit > 0.25) {
    dernierReleveToit = maintenant;
    const hit = raycastVoxel(camera.position, HAUT, 48, true);
    toitVu = !!hit && hit.t < 48;
  }
  return toitVu;
}

// ---- la pièce close ----------------------------------------------------------
// Éteindre le rideau dès qu'un bloc passe au-dessus de la tête supprimait la pluie des
// maisons comme des sous-bois : on ne voyait plus l'averse par aucune fenêtre. Ce qu'on
// veut n'est pas « pas de pluie sous un toit » mais « pas de pluie DANS la pièce » : les
// gouttes qui y flotteraient sont retirées par le vertex shader, tout ce qui tombe dehors
// reste et se voit par les baies. La pièce se reconnaît à un plafond bas qui n'est pas du
// feuillage et des murs tout autour — une couronne d'arbre échoue au premier critère, une
// allée de troncs au second. Un rayon manquant pardonne une porte ouverte.
const CHAMBRE_RAYONS = 8;
const CHAMBRE_PORTÉE = 26;
const CHAMBRE_PLAFOND_MAX = 14;
const chambre = { close: false, rayon: 0, plafond: 0, relevé: -10 };
const directionSonde = new THREE.Vector3();
function sonderChambre(maintenant) {
  if (maintenant - chambre.relevé < 0.25) return chambre;
  chambre.relevé = maintenant;
  const o = camera.position;
  const haut = raycastVoxel(o, HAUT, CHAMBRE_PLAFOND_MAX + 2, true);
  const idPlafond = haut ? world.getBlock(haut.x, haut.y, haut.z) : 0;
  const toit = !!haut && haut.t <= CHAMBRE_PLAFOND_MAX && idPlafond !== BLOCK.LEAVES;
  let touches = 0, plusLoin = 0;
  for (let i = 0; i < CHAMBRE_RAYONS; i++) {
    const a = (i / CHAMBRE_RAYONS) * Math.PI * 2;
    directionSonde.set(Math.cos(a), 0, Math.sin(a));
    const mur = raycastVoxel(o, directionSonde, CHAMBRE_PORTÉE, true);
    if (!mur) continue;
    if (world.getBlock(mur.x, mur.y, mur.z) === BLOCK.LEAVES) continue;   // un tronc ne clos pas une pièce
    touches++;
    if (mur.t > plusLoin) plusLoin = mur.t;
  }
  chambre.close = toit && touches >= CHAMBRE_RAYONS - 1;
  chambre.rayon = Math.min(CHAMBRE_PORTÉE, plusLoin + 1.5);
  chambre.plafond = toit ? o.y + haut.t : o.y + CHAMBRE_PLAFOND_MAX;
  return chambre;
}

// L'altitude d'ancrage des nappes s'appuie sur une **moyenne régionale** du relief,
// lissée dans le temps — jamais sur la colonne sous les pieds. Jugée cube par cube, la
// nappe suivait le gradin du terrain : mesuré sur une ligne droite de vingt-quatre
// cubes, la hauteur de la couche basse passait de 100 à 114 puis retombait à 100, et
// un même nuage se déplaçait de trente-sept pixels à l'écran, pour un joueur qui avance
// à plat (« les nuages ne sont pas stables, ils bougent quand je marche »). Une sonde
// prise tous les trente-deux cubes sur cent quatre-vingt-douze cubes de large ne bouge
// quasiment plus d'un pas à l'autre ; l'amortissement efface ce qui reste.
const NAPPE_PAS_SONDE = 32;
const NAPPE_RAYON_SONDE = 96;
const NAPPE_INTERVALE_SONDE = 0.5;   // secondes entre deux relevés du relief
const NAPPE_TAU = 0.8;               // rapidité de rattrapage de l'ancrage
let solNappe = null;
let cibleSolNappe = 0;
let derniereSondeNappe = -10;

function sonderRelief(x, z) {
  let somme = 0, n = 0;
  for (let dx = -NAPPE_RAYON_SONDE; dx <= NAPPE_RAYON_SONDE; dx += NAPPE_PAS_SONDE) {
    for (let dz = -NAPPE_RAYON_SONDE; dz <= NAPPE_RAYON_SONDE; dz += NAPPE_PAS_SONDE) {
      somme += getTerrainHeight(Math.floor(x + dx), Math.floor(z + dz));
      n++;
    }
  }
  return n ? somme / n : getTerrainHeight(Math.floor(x), Math.floor(z));
}

function majAncrageNappe(delta, maintenant, x, z) {
  if (solNappe === null || maintenant - derniereSondeNappe > NAPPE_INTERVALE_SONDE) {
    derniereSondeNappe = maintenant;
    cibleSolNappe = sonderRelief(x, z);
    // Un saut brutal n'est pas une pente : après une téléportation ou un respawn, la
    // nappe prend la nouvelle valeur sans glisser sur une demi-seconde.
    if (solNappe === null || Math.abs(cibleSolNappe - solNappe) > 32) solNappe = cibleSolNappe;
  }
  solNappe += (cibleSolNappe - solNappe) * Math.min(1, delta * NAPPE_TAU);
  return solNappe;
}

const heureEl = document.getElementById('clock');

/** Applique l'état du ciel aux lumières, à la brume et aux objets du ciel. */
function majCiel(delta, maintenant, m = meteoCourante()) {
  const e = etatCiel;
  // Deux signaux de la météo se partagent le ciel : `couverture` est ce que le dôme porte
  // de gris (il commence avant les gouttes et finit après elles), `intensite` n'est que le
  // rideau. Les confondre — un seul nombre pour les deux — rendait l'averse sortie du bleu.
  const voile = e.couverture != null ? e.couverture : (e.pluie || 0);
  const averse = e.pluie || 0;
  const claire = e.degage || 0;

  ambientLight.color.setHex(e.ambiante.couleur);
  ambientLight.intensity = e.ambiante.intensite;
  sunLight.color.setHex(e.directe.couleur);
  sunLight.intensity = e.directe.intensite;
  sunLight.position.set(e.soleil[0] * 120, Math.abs(e.soleil[1]) * 120 + 8, e.soleil[2] * 120);

  scene.background.setHex(e.ciel);
  scene.fog.color.setHex(e.brume);

  // Le dôme prend le dessus sur le fond uni dès qu'il est devant la caméra.
  const distance = Math.max(120, Math.min(camera.far * 0.55, 900));
  PLANETE_CIEL.position.copy(camera.position);
  dome.scale.setScalar(distance);
  domeUniformes.uZenith.value.setHex(e.ciel);
  domeUniformes.uHorizon.value.setHex(e.horizon);
  domeUniformes.uDirectionSoleil.value.set(e.soleil[0], e.soleil[1], e.soleil[2]);
  // Le renard autour de l'astre suit le ciel, pas seulement l'heure : une journée sans un
  // nuage le fait reprendre du nerf (le soleil « brille »), un ciel chargé l'éteint.
  const renard = Math.max(0, 1 - Math.abs(e.hauteur) * 2.4);
  domeUniformes.uHalo.value = Math.max(0, renard * (0.7 + 0.35 * claire - 0.45 * voile));

  // Les astres se logent juste sous le plan lointain, et non à une distance « commode » :
  // avec leur test de profondeur activé, tout bloc rendu est plus près qu'eux et les
  // masque, alors qu'ils ne recouvrent jamais un cube. C'est ce que veut dire « affichés
  // à l'infini » pour des objets collés à la caméra. Leur rayon apparent reste constant
  // parce que l'échelle suit la distance ; les étoiles restent derrière les disques.
  const astres = camera.far * 0.995;
  disqueSoleil.position.set(e.soleil[0], e.soleil[1], e.soleil[2]).multiplyScalar(astres);
  disqueSoleil.lookAt(camera.position);
  disqueSoleil.scale.setScalar(astres * RAYON_SOLEIL_APPARENT * (1 + 0.06 * claire));
  disqueSoleil.visible = e.hauteur > -0.12;

  disqueLune.position.set(e.lune[0], e.lune[1], e.lune[2]).multiplyScalar(astres);
  disqueLune.lookAt(camera.position);
  disqueLune.scale.setScalar(astres * RAYON_LUNE_APPARENTE);
  disqueLune.visible = e.hauteur < 0.12;

  etoiles.material.opacity = e.etoiles;
  etoiles.visible = e.etoiles > 0.02;
  etoiles.scale.setScalar(camera.far * 0.998);

  // Les nappes suivent la caméra en x/z mais restent **ancrées au monde** : le plan se
  // recentre sur le joueur à chaque image et ses UV compensent exactement ce parcours,
  // sinon le ciel glisserait avec lui comme un plafond peint. L'axe v garde un signe
  // inversé parce que la rotation envoie l'axe local +y vers −z monde. À ce glissement
  // s'ajoute la dérive du vent, sur le cap du monde — les deux couches avancent donc
  // ensemble, à des vitesses différentes.
  const cote = Math.max(360, camera.far * 2.4);
  const sol = majAncrageNappe(delta, maintenant, camera.position.x, camera.position.z);
  const souffle = NAPPE_SOUFFLE_BASE + NAPPE_SOUFFLE_VENT * (m.vent || 0);
  const cap = m.ventDirection || [1, 0];
  // L'épaisseur que la météo donne au jour ne porte que sur ce que le soleil peut diffuser :
  // la nuit, un plafond plus épais n'a rien à éclairer et la nappe doit rester aussi éteinte
  // qu'avant la météo. À midi le facteur vaut un, l'épaisseur s'applique donc telle quelle.
  const couche = 1 + ((m.couche == null ? 1 : m.couche) - 1) * e.jour;
  for (const nappe of nappes) {
    const u = nappe.userData;
    const mat = nappe.material;
    nappe.position.y = u.altitude + sol - camera.position.y;   // le groupe suit déjà la caméra
    nappe.scale.set(cote, cote, 1);
    const rpt = cote / u.tuile;
    mat.uniforms.uTuile.value.set(rpt, rpt);
    const glisse = maintenant * u.vitesse * souffle;
    mat.uniforms.uDecalage.value.set(
      camera.position.x / u.tuile + glisse * cap[0] * 2,
      -camera.position.z / u.tuile - glisse * cap[1] * 2,
    );
    mat.uniforms.uCouleur.value.setHex(e.nuages.couleur);
    // `couche` vient du modèle : il tient la nappe à son épaisseur du jour (jours voilés,
    // jours clairs) et la retire presque entièrement les journées sans un nuage.
    mat.uniforms.uOpacite.value = Math.min(0.98, e.nuages.opacite * u.facteur * couche);
    // L'écriture du ciel suit le modèle : `forme` vient d'un bruit lent de la météo et
    // change l'amas dessiné sous les yeux du joueur. La couche haute décale son choix
    // d'un cran dans l'ordre des formes pour que les deux altitudes ne portent jamais le
    // même dessin (elles portaient la même texture avant le 2026-11-18).
    const indexForme = Math.max(0, ORDRE_FORMES.indexOf(m.forme));
    const tuileForme = NUAGES_TUILES[
      ORDRE_FORMES[(indexForme + (u.decalForme || 0)) % ORDRE_FORMES.length]
    ] || NUAGES_TEXTE;
    if (mat.uniforms.uCarte.value !== tuileForme) mat.uniforms.uCarte.value = tuileForme;
    u.forme = ORDRE_FORMES[(indexForme + (u.decalForme || 0)) % ORDRE_FORMES.length];
    mat.uniforms.uCam.value.copy(camera.position);
    // Le fondu lointain meurt sur le plan lointain lui-même, pas sur le bord du plan
    // géométrique : c'est le seul repère qui garantisse que rien n'est tronqué en vol.
    mat.uniforms.uPortee.value = camera.far * 0.99;
    u.deriveCourante = +(u.vitesse * souffle).toFixed(5);
    nappe.visible = mat.uniforms.uOpacite.value > 0.02;
  }

  // ---- l'averse ----
  // Trois choses seulement : la brume se resserre (c'est le ciel bas), les gouttes
  // tombent, et elles s'arrêtent sous un toit. Les lumières et les teintes viennent
  // déjà grevées du modèle (`cielSousPluie`), rien n'est recompté ici. Le ciel bas se
  // juge sur la couverture, pas sur les gouttes : il se baisse avant elles et remonte
  // après — c'est ce qui fait une pluie annoncée plutôt qu'un orage qui tombe du bleu.
  const serre = 1 - 0.42 * voile;
  scene.fog.near = Math.max(3, brumeSere.near * serre);
  scene.fog.far = brumeSere.far * serre;
  // Le rideau vit aussi sous un toit : c'est la pièce qui se protège (`sonderChambre`), plus
  // la pluie qui s'éteint — une couronne d'arbre ne le coupe donc plus.
  const pleut = averse > 0.02;
  const ch = sonderChambre(maintenant);
  if (pleut) majEnveloppes(maintenant, camera.position.x, camera.position.z);
  // La matrice de CETTE image : `majCiel` tourne avant `render()`, donc lire `matrixWorld`
  // sans la rafraîchir donnait l'axe droite du tour de tête précédent — la traînée suivait
  // la caméra avec une image de retard et « changeait de sens » pendant qu'on tournait.
  camera.updateMatrixWorld();
  droiteCaméra.setFromMatrixColumn(camera.matrixWorld, 0);
  const force = 1.2 + 4.2 * (m.vent || 0);
  const travers = cap[0] * droiteCaméra.x + cap[1] * droiteCaméra.z;
  // L'inclinaison peinte est la vitesse RÉELLE des gouttes projetée sur l'axe droite de la
  // caméra, rapportée à leur vitesse de chute : le même vecteur que celui que suit le vertex
  // shader. Un coefficient libre couchait les gouttes vent nul et faisait virer la traînée
  // avec la tête au lieu de la laisser suivre le vent du monde.
  const pente = Math.max(-0.8, Math.min(0.8, (travers * force) / CHUTE_GOUTTE));
  for (const rideau of rideauxPluie) {
    rideau.position.copy(camera.position);
    rideau.visible = pleut;
    if (!pleut) continue;
    const u = rideau.material.uniforms;
    u.uTemps.value = maintenant;
    // Le seuil sur la graine ne tire qu'une fraction du nuage : à pleine averse, un quart des
    // gouttes, pas 90 %. L'opacité unitaire monte d'autant — ce que le joueur doit lire, c'est
    // une pluie franche et lisible, non une brume de points. Et c'est ce contraste, pas le
    // nombre de voiles, qui fait voir l'averse à travers les baies vitrées (contrôle de la baie).
    u.uDensite.value = +(averse * PLUIE_DENSITE_RIDEAU).toFixed(4);
    u.uOpacite.value = +((0.62 + 0.32 * averse) * rideau.userData.poids).toFixed(4);
    u.uCouleur.value.copy(COULEUR_PLUIE_NUIT).lerp(COULEUR_PLUIE_JOUR, e.jour);
    u.uVent.value.set(cap[0] * force, cap[1] * force);
    // Le fondu meurt sur la muraille de brume rendue, pas sur le bord de la boîte : c'est ce
    // qui fait une pluie qui s'enfonce dans l'averse plutôt qu'une coquille qui s'arrête net
    // à vingt-six cubes (mesuré le 2026-11-18 : rien au-delà de quarante-cinq).
    u.uPortee.value = Math.max(24, Math.min(scene.fog.far * 1.12, u.uBoite.value.x * 0.62));
    u.uPente.value = pente;
    u.uDedans.value = ch.close ? 1 : 0;
    u.uChambre.value.set(camera.position.x, ch.plafond, camera.position.z, ch.rayon);
    u.uIntN.value = enveloppeN;
  }

  // Lanternes : franches la nuit et sous terre, éteintes en plein jour. La montée est
  // amortie pour que le crépuscule allume la ville progressivement plutôt que d'un coup.
  const cible = Math.max(e.lampes, sousTerre(maintenant) ? 1 : 0);
  lanterneVivet += (cible - lanterneVivet) * Math.min(1, delta * 2.2);
  if (Math.abs(lanterneVivet - cible) < 0.004) lanterneVivet = cible;
  const w = world;
  if (w) w.uniformeLampe.value.setScalar(TEINTE_LAMPE * lanterneVivet);

  if (heureEl) {
    const texte = `${heureAffichee(e.heure)} · ${e.phase}`;
    if (heureEl.textContent !== texte) heureEl.textContent = texte;
  }
}

// Remet le ciel à jour sur-le-champ. Le bucle d'images le fait déjà image après image,
// mais une suite (comme le joueur qui change de réglage derrière le panneau) veut lire
// la valeur dans la foulée : `delta` petit garde l'allumage des lanternes amorti, seul
// canal qui le soit.
function rafraichirCiel(delta = 1 / 60, maintenant = performance.now() / 1000) {
  const m = meteoCourante();
  etatCiel = habillerCiel(etatDuCiel(horloge.heure()), m);
  majCiel(delta, maintenant, m);
  return etatCiel;
}

const world = new World(scene);
world.updateChunks(SPAWN_XZ[0], SPAWN_XZ[1], WORLD_BOOT_BUDGET);

// Applies a new view depth right away: the start screen is translucent, so the
// player sees the change behind the panel while dragging the slider. The rest of
// the field streams in from animate() — a jump to 32 chunks must not lock the tab.
function setRenderDistance(value) {
  const next = clampRenderDistance(value);
  settings.renderDistance = next;
  applyFogForDistance(next);
  syncDistanceControl(next); // keep the slider and its readout honest for any caller
  world.updateChunks(camera.position.x, camera.position.z, CHUNK_STREAM_BUDGET, CHUNK_JUMP_MS);
  saveSettings();
  return next;
}

const controls = new PointerLockControls(camera, renderer.domElement);
const hotbar = new Hotbar();
const player = new Player(camera, world, controls, hotbar);

// Block highlight wireframe
// Slightly larger than the cube so it reads as a marker instead of the block's own
// silhouette. It is drawn *with* a depth test on purpose: without one the square stayed
// painted through hills and the player dug at cubes they could not see. Depth-tested
// lines lose against the very block they wrap and paint nothing at all, so the vertices
// are pulled a few centimetres toward the eye (see biaisVersLOeil).
const BIAIS_MARKERS = 0.06;   // cubes vers l'œil, en espace caméra
/**
 * Rend un filaire lisible sans le trahir : test de profondeur actif, plus un léger
 * rappel des sommets vers la caméra. Ce qui n'est que confondu avec la surface du cube
 * visé se détache ; ce qui a vraiment un relief devant soi reste caché, pixel par pixel.
 * Le décalage se compte en espace caméra — un biais en coordonnées clip serait une
 * distance différente à chaque profondeur et traverserait la colline qu'il doit cacher.
 */
function biaisVersLOeil(materiau) {
  materiau.depthTest = true;
  materiau.depthWrite = false;
  materiau.onBeforeCompile = (shader) => {
    // L'inclusion d'origine reste en place (instancing, batching) ; on ne fait que
    // rejeter la projection avec la position caméra rappelée vers l'œil.
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
      #include <project_vertex>
      mvPosition.z += ${BIAIS_MARKERS.toFixed(3)};
      gl_Position = projectionMatrix * mvPosition;
    `);
    if (!shader.vertexShader.includes('mvPosition.z +=')) {
      // Une mise à jour de three qui changerait l'inclusion rendrait les marqueurs
      // invisibles en silence — le défaut d'avant, exactement. Mieux vaut le dire.
      console.warn('biais des marqueurs non appliqué : <project_vertex> introuvable dans le vertex shader');
    }
  };
  // Deux matériaux partagent le même programme : sans clé propre, three les confondrait
  // avec le filaire ordinaire et l'un des deux resterait aveugle à la profondeur.
  materiau.customProgramCacheKey = () => 'mycraft-biais-markers';
  return materiau;
}

const highlightGeo = new THREE.BoxGeometry(1.04, 1.04, 1.04);
const highlightMat = biaisVersLOeil(new THREE.LineBasicMaterial({
  color: 0x000000, linewidth: 2,
}));
const highlight = new THREE.LineSegments(new THREE.EdgesGeometry(highlightGeo), highlightMat);
highlight.visible = false;
highlight.renderOrder = 13;
scene.add(highlight);

// Crosshair face marker: until a click arms a selection, the square sits *on* the face
// being aimed at, which says both which cube and which side of it is targeted. Inset
// into the face so it reads against the texture instead of merging with the block edge.
const faceMarker = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.9, 0.9)),
  biaisVersLOeil(new THREE.LineBasicMaterial({ color: 0x000000 })),
);
faceMarker.visible = false;
faceMarker.renderOrder = 13;
scene.add(faceMarker);
const PLANE_FACES_Z = new THREE.Vector3(0, 0, 1);   // PlaneGeometry's own normal
const aimNormal = new THREE.Vector3();

function showFaceMarker(hit) {
  aimNormal.set(hit.nx, hit.ny, hit.nz);
  if (aimNormal.lengthSq() === 0) {
    // The eye sits inside a solid cube: no face was ever crossed to get there.
    faceMarker.visible = false;
    return;
  }
  faceMarker.position.set(
    hit.x + 0.5 + hit.nx * 0.52,
    hit.y + 0.5 + hit.ny * 0.52,
    hit.z + 0.5 + hit.nz * 0.52,
  );
  faceMarker.quaternion.setFromUnitVectors(PLANE_FACES_Z, aimNormal);
  faceMarker.visible = true;
}

// ==================== TWO-STAGE CUBOID SELECTION ====================
// First click marks the anchor cube; the wheel stretches the far corner along the
// view, looking around swings it. The second click of the same button fills (left)
// or empties (right) the cuboid spanned by the two corners — both included.
const MAX_SELECTION_DEPTH = 64;      // blocks the wheel can push the far corner out
const MAX_SELECTION_CELLS = 32768;   // refuses a box big enough to stall the mesher

const selection = {
  active: false,
  mode: 'create',   // 'create' | 'delete'
  anchor: null,     // { x, y, z } of the marked cube
  hit: null,        // raw raycast behind the anchor, so switching buttons can re-mark
  depth: 0,         // blocks in front of the eye where the crosshair corner sits
  stretched: false, // the wheel has moved the far corner since the box was armed
  status: '',       // last HUD warning (oversized box, nothing aimed at)
};

const selectionFill = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
);
const selectionOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(selectionFill.geometry),
  // Same bias as the highlight: the frame must not be painted through the hills it
  // crosses, or the player reads a cuboid that half of them hides.
  biaisVersLOeil(new THREE.LineBasicMaterial({ color: 0xffffff })),
);
const selectionPreview = new THREE.Group();
selectionPreview.add(selectionFill, selectionOutline);
selectionPreview.visible = false;
// renderOrder lives on the drawables, not the group.
selectionFill.renderOrder = 11;
selectionOutline.renderOrder = 12;
scene.add(selectionPreview);

const selectionHint = document.getElementById('selection-hint');
let lastHintText = null;

function viewDirection() {
  return camera.getWorldDirection(new THREE.Vector3(0, 0, -1));
}

// The far corner sits under the crosshair: it is the cell `depth` blocks in front of
// the eye along the view, not a fixed arm off the anchor. Looking around therefore
// resizes the cuboid instead of swinging it, and empty space stays selectable.
function selectionCorner() {
  const dir = viewDirection();
  const p = camera.position;
  return {
    x: Math.floor(p.x + dir.x * selection.depth),
    y: Math.floor(p.y + dir.y * selection.depth),
    z: Math.floor(p.z + dir.z * selection.depth),
  };
}

function selectionBounds() {
  const a = selection.anchor;
  const b = selectionCorner();
  const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) };
  const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) };
  return {
    min,
    max,
    cells: (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1),
  };
}

// The far corner has to start inside the marked cube, so the box opens as exactly that
// one cube. The view ray's chord through the cell is taken exactly (slab test): seeding
// from the entry distance instead rounds onto the wrong side of a boundary, which opened
// the box one cube too wide on a grazing aim — and put the corner past the marked cube
// whenever that cube sits *before* the hit along the ray (creating on the aimed face).
function seedSelectionDepth(cell, entryT) {
  const dir = viewDirection();
  const p = camera.position;
  let lo = 0.05, hi = Infinity;
  const axes = [[p.x, dir.x, cell.x], [p.y, dir.y, cell.y], [p.z, dir.z, cell.z]];
  for (const [origin, d, c] of axes) {
    if (d === 0) continue;                    // running along this axis: the slab never cuts the chord
    const tIn = (c - origin) / d;
    const tOut = (c + 1 - origin) / d;
    lo = Math.max(lo, Math.min(tIn, tOut));
    hi = Math.min(hi, Math.max(tIn, tOut));
  }
  if (!Number.isFinite(hi) || hi <= lo) return entryT + 0.5;   // tangential graze
  return lo + (hi - lo) * 0.5;
}

// Which cube a click marks for a given mode, from the cube the ray hit: creating grows
// out of the aimed face, digging takes the solid cube the face belongs to.
function cellForHit(hit, mode) {
  if (mode !== 'create') return { x: hit.x, y: hit.y, z: hit.z };
  const ahead = { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz };
  if (ahead.y >= 0 && ahead.y < CHUNK_HEIGHT && !world.isSolid(ahead.x, ahead.y, ahead.z)) return ahead;
  return { x: hit.x, y: hit.y, z: hit.z };
}

function beginSelection(mode) {
  const hit = raycastVoxel(camera.position, viewDirection(), 8);
  if (!hit) {
    selection.status = 'Aucun cube visé';
    return false;
  }
  selection.active = true;
  selection.mode = mode;
  selection.hit = hit;
  selection.anchor = cellForHit(hit, mode);
  selection.depth = seedSelectionDepth(selection.anchor, hit.t);
  selection.stretched = false;
  selection.status = '';
  return true;
}

function cancelSelection() {
  selection.active = false;
  selection.anchor = null;
  selection.hit = null;
  selection.depth = 0;
  selection.stretched = false;
  selection.status = '';
}

// notches > 0 drags the crosshair corner farther from the eye, < 0 pulls it back.
function adjustSelectionDepth(notches) {
  if (!selection.active) return false;
  const next = Math.min(MAX_SELECTION_DEPTH, Math.max(0, selection.depth + notches));
  if (next !== selection.depth) {
    selection.depth = next;
    selection.stretched = true;
  }
  return true;
}

function commitSelection() {
  if (!selection.active) return false;
  const creating = selection.mode === 'create';
  const blockId = player.selectedBlock;
  const { min, max, cells } = selectionBounds();

  if (cells > MAX_SELECTION_CELLS) {
    selection.status = `Trop grand : ${cells} cubes (max ${MAX_SELECTION_CELLS})`;
    return false;
  }

  const edits = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      if (y < 0 || y >= CHUNK_HEIGHT) continue;
      for (let z = min.z; z <= max.z; z++) {
        // Never entomb the player, same rule as single-block placement.
        if (creating && player.intersectsBlock(x, y, z)) continue;
        edits.push([x, y, z, creating ? blockId : BLOCK.AIR]);
      }
    }
  }

  world.setBlocksBulk(edits);
  cancelSelection();
  return true;
}

// Second click of the same button applies the box; the other button re-arms the
// marked cube for the opposite operation instead of losing the anchor.
function clickSelection(mode) {
  if (!selection.active) return beginSelection(mode);
  if (selection.mode === mode) return commitSelection();
  selection.mode = mode;
  // Each mode marks its own cube — creating on the aimed face, digging the solid cube
  // itself. Carrying the previous mode's anchor over would act one cube off the block
  // under the crosshair. A box nobody stretched yet reopens on its own marked cube;
  // once the wheel moved the corner, that stretch is kept as the player left it.
  if (selection.hit) {
    selection.anchor = cellForHit(selection.hit, mode);
    if (!selection.stretched) selection.depth = seedSelectionDepth(selection.anchor, selection.hit.t);
  }
  return true;
}

function updateSelectionHud() {
  let text = null;
  if (selection.active) {
    const { min, max, cells } = selectionBounds();
    const verb = selection.mode === 'create' ? 'Créer' : 'Supprimer';
    text = `${verb} ${min.x},${min.y},${min.z} → ${max.x},${max.y},${max.z}`
      + ` · ${cells} cubes · croix = 2ᵉ cube · molette ±1 (max ${MAX_SELECTION_DEPTH})`
      + ` · 2e clic applique · clic milieu annule`
      + (selection.status ? ` · ${selection.status}` : '');
  } else if (selection.status) {
    // A refused click (nothing aimed at) still has to say why.
    text = selection.status;
  }
  if (text === lastHintText) return;
  lastHintText = text;
  if (text === null) {
    selectionHint.style.display = 'none';
    selectionHint.textContent = '';
    return;
  }
  selectionHint.textContent = text;
  selectionHint.classList.toggle('delete', selection.active && selection.mode === 'delete');
  selectionHint.style.display = 'block';
}

// Paints the pending cuboid and keeps the marked cube outlined.
function updateSelectionVisuals() {
  if (!selection.active) {
    selectionPreview.visible = false;
    return false;
  }
  const { min, max } = selectionBounds();
  const w = max.x - min.x + 1;
  const h = max.y - min.y + 1;
  const d = max.z - min.z + 1;
  selectionPreview.position.set(min.x + w / 2, min.y + h / 2, min.z + d / 2);
  // Nipped in a hair so the white frame sits inside the black square that marks the
  // anchor cube; at identical size the two coincide and only one of them survives.
  selectionPreview.scale.set(w - 0.03, h - 0.03, d - 0.03);
  selectionFill.material.color.setHex(selection.mode === 'create' ? 0x66dd66 : 0xdd5555);
  selectionPreview.visible = true;

  highlight.position.set(selection.anchor.x + 0.5, selection.anchor.y + 0.5, selection.anchor.z + 0.5);
  highlight.visible = true;
  faceMarker.visible = false;
  return true;
}

// Esc or alt-tab hands the pointer back: a half-made box must not stay armed for the
// next click, so losing the lock drops the pending selection.
controls.addEventListener('unlock', () => {
  if (selection.active) cancelSelection();
});

// ==================== INPUT HANDLING ====================
const keys = {};
// PointerLockControls reads the very same object, so no polling timer is needed.
controls.keys = keys;

const blocker = document.getElementById('blocker');

// requestPointerLock rejects when there is no recent user activation; that must
// not surface as an uncaught promise error. Callers get the promise back so they
// can fall back to the start screen as soon as it is refused.
function lockPointer() {
  try {
    const result = renderer.domElement.requestPointerLock();
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return result && typeof result.then === 'function' ? result : null;
  } catch (e) {
    /* pointer lock unavailable right now */
    return null;
  }
}

const inventory = new Inventory(hotbar, controls, blocker, keys, lockPointer);

window.addEventListener('keydown', (e) => {
  // L'écran de réglage du monde est un écran de saisie : le clavier lui appartient, à
  // l'exception d'Échap qui le referme. Sans ce garde, un Z tapé dans le champ de la
  // graine ferait marcher le joueur derrière le panneau.
  if (reglageOuvert) {
    if (e.code === 'Escape') {
      e.preventDefault();
      fermerReglageDuMonde();
    }
    return;
  }

  // A focused slider owns its arrow keys; do not turn them into player movement.
  const target = e.target;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

  keys[e.code] = true;

  if (e.code === 'KeyE') {
    inventory.toggle();
    return;
  }
  if (e.code === 'Escape') {
    if (selection.active) {
      cancelSelection();
      return;
    }
    if (inventory.isOpen()) {
      e.preventDefault();
      inventory.hide();
    }
    return;
  }
  // While the palette is up the cursor belongs to the UI, not the world.
  if (inventory.isOpen()) return;

  // Number keys for hotbar
  if (e.code >= 'Digit1' && e.code <= 'Digit9') {
    hotbar.select(parseInt(e.code.replace('Digit', ''), 10) - 1);
  }
  // T for texture panel
  if (e.code === 'KeyT') {
    toggleTexturePanel();
  }
  // R for reset position
  if (e.code === 'KeyR') {
    player.respawn();
    updateInfo();
  }
  // +/- : assiette de flottaison. Sur AZERTY comme sur QWERTY, la touche du haut de
  // rangée produit `Equal` pour « + » (avec Majuscule) et `Minus` pour « - ».
  if (e.code === 'Equal' || e.code === 'NumpadAdd') {
    player.regleAssiette(ASSIETTE_PAS);
    updateWaterHud(true);
    return;
  }
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
    player.regleAssiette(-ASSIETTE_PAS);
    updateWaterHud(true);
    return;
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

// Wheel: stretches the pending cuboid, otherwise changes the held block.
document.addEventListener('wheel', (e) => {
  if (!controls.isLocked) return;
  if (adjustSelectionDepth(e.deltaY < 0 ? 1 : -1)) return;
  hotbar.cycle(e.deltaY > 0 ? 1 : -1);
});

// Voxel DDA raycast: march through the voxel grid from a point along a direction.
// Returns { x, y, z, nx, ny, nz, t } of the first block the crosshair can reach, or null;
// t is how far along the (normalised) ray that block was entered. Par défaut le rayon
// s'arrête sur tout ce qui se laisse viser — le plein comme le mobilier mural non solide —
// et `neViserQueLePlein` le rend aveugle à ce dernier (le sondeur de plafond, par exemple,
// ne doit pas croire qu'une applique au-dessus de la tête est un toit).
function raycastVoxel(origin, dir, maxDist, neViserQueLePlein = false) {
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const dx = dir.x, dy = dir.y, dz = dir.z;

  let bx = Math.floor(ox), by = Math.floor(oy), bz = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  const fracX = ox - Math.floor(ox);
  const fracY = oy - Math.floor(oy);
  const fracZ = oz - Math.floor(oz);

  let tMaxX = tDeltaX === Infinity ? Infinity : (dx > 0 ? (1 - fracX) : fracX) * tDeltaX;
  let tMaxY = tDeltaY === Infinity ? Infinity : (dy > 0 ? (1 - fracY) : fracY) * tDeltaY;
  let tMaxZ = tDeltaZ === Infinity ? Infinity : (dz > 0 ? (1 - fracZ) : fracZ) * tDeltaZ;

  let nx = 0, ny = 0, nz = 0;
  let t = 0;
  let premier = true;

  while (t <= maxDist) {
    // La toute première cellule est celle d'où part le rayon : on n'y vise rien. Sans cette
    // réserve, un joueur qui traverse une applique — elle n'est pas solide, on marche
    // dedans — casserait l'applique dès qu'il regarderait devant lui.
    const cible = (!premier && !neViserQueLePlein)
      ? world.isTargetable(bx, by, bz) : world.isSolid(bx, by, bz);
    if (cible) {
      return { x: bx, y: by, z: bz, nx, ny, nz, t };
    }
    premier = false;

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      bx += stepX; t = tMaxX; tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      by += stepY; t = tMaxY; tMaxY += tDeltaY;
      nx = 0; ny = -stepY; nz = 0;
    } else {
      bz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
      nx = 0; ny = 0; nz = -stepZ;
    }
  }
  return null;
}

// Block interaction: left button builds a cuboid, right button digs one out. The
// first click of a button marks the anchor cube, its second click applies the box.
document.addEventListener('mousedown', (e) => {
  if (!controls.isLocked) return;
  if (e.button === 1) {
    e.preventDefault();
    cancelSelection();
    return;
  }
  const mode = e.button === 0 ? 'create' : e.button === 2 ? 'delete' : null;
  if (mode) clickSelection(mode);
});

document.addEventListener('contextmenu', (e) => e.preventDefault());

// ==================== UI ====================
const info = document.getElementById('info');
let lastInfoText = null;

/** Ce qui occupe le joueur cette image : ses jambes, ses réacteurs, ses ailes. */
function modeJoueur() {
  if (player.flyMode) return 'Survol (debug)';
  if (player.planant) {
    // Le planeur obéit au regard : dire l'allure sans dire si elle monte laisserait
    // le pilote juger son altitude à l'œil nu. Bandes larges — un texte qui changerait
    // chaque image annulerait la garde de `updateInfo`.
    const vy = player.velocity.y;
    const cap = vy > 0.5 ? 'en montée' : vy < -0.5 ? 'en descente' : 'à plat';
    return `Plané ${Math.round(player.vitesseVol)} c/s · ${cap}`;
  }
  if (player.reacteurs) return 'Réacteurs';
  return 'Marche';
}

function updateInfo() {
  const pos = camera.position;
  const blockName = BLOCK_INFO[player.selectedBlock]?.name || 'Unknown';
  // Le mode change à chaque geste sur Espace : affiché seulement à la seconde, il
  // resterait une image derrière la réalité. D'où la garde sur le texte complet.
  const texte = `
    XYZ: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}
    Bloc: ${blockName}
    Mode: ${modeJoueur()}
    FPS: ${fps}
  `;
  if (texte === lastInfoText) return;
  lastInfoText = texte;
  info.textContent = texte;
}

// ==================== TEXTURE PANEL ====================
const texturePanel = document.getElementById('texture-panel');
const toggleBtn = document.getElementById('toggle-ui');
const closePanel = document.getElementById('close-panel');
const textureUpload = document.getElementById('texture-upload');
const texturePick = document.getElementById('texture-pick');
const textureHint = document.getElementById('texture-hint');
const textureList = document.getElementById('texture-list');

function toggleTexturePanel() {
  texturePanel.style.display = texturePanel.style.display === 'block' ? 'none' : 'block';
}

toggleBtn.addEventListener('click', toggleTexturePanel);
closePanel.addEventListener('click', toggleTexturePanel);

function rebuildVisibleChunks() {
  const pcx = Math.floor(camera.position.x / CHUNK_SIZE);
  const pcz = Math.floor(camera.position.z / CHUNK_SIZE);
  // Repainting is only for the custom-texture panel; at 32 chunks a full repaint
  // would block for tens of seconds to change a tile nobody can see that far out.
  const radius = Math.min(settings.renderDistance, 12);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      world.rebuildChunk(pcx + dx, pcz + dz);
    }
  }
}

// ==================== CUSTOM TEXTURES ====================
// Two hosts share this UI: the Express dev server (GET /textures, POST
// /upload-texture) and the Tauri desktop build, which has no server at all and
// keeps uploaded images in its own application-data folder through Rust commands.
// The `tauriGlobal`/`tauriCore` handles come from the constants block above.
// Absent from a plain browser, and from a desktop build whose plugin failed to
// register; either way the file input below stays the fallback.
const tauriDialog = tauriGlobal && tauriGlobal.dialog ? tauriGlobal.dialog : null;

async function imageSourceFromBytes(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === 'function') bitmap.close();
  return canvas;
}

const textureStore = tauriCore
  ? {
      mode: 'desktop',
      async list() {
        const names = await tauriCore.invoke('list_textures');
        return names.map((name) => ({
          name,
          source: () => tauriCore.invoke('read_texture', { name }).then((bytes) => imageSourceFromBytes(new Uint8Array(bytes))),
        }));
      },
      async save() {
        // WebView2 hands back a File with no usable path, so the desktop build
        // asks the OS for the files and lets Rust copy them into the store.
        if (!tauriDialog) throw new Error('dialogue natif indisponible');
        const picked = await tauriDialog.open({
          multiple: true,
          title: 'Choisir des textures',
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        });
        if (!picked) return 0;
        return tauriCore.invoke('import_textures', { paths: Array.isArray(picked) ? picked : [picked] });
      },
    }
  : {
      mode: 'web',
      async list() {
        const res = await fetch('/textures');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const files = await res.json();
        return files.map((f) => ({
          name: f.filename,
          source: () => fetch(f.url).then((r) => r.blob()).then(imageSourceFromBytes),
        }));
      },
      async save(files) {
        const form = new FormData();
        for (const file of files) form.append('textures', file);
        const res = await fetch('/upload-texture', { method: 'POST', body: form });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return files.length;
      },
    };

// Paints the chosen tile over the atlas tiles of the held block; clicking the same
// entry again brings the procedural tile back.
function bindTextureItem(item, entry) {
  item.addEventListener('click', async () => {
    const blockId = player.selectedBlock;
    if (item.classList.contains('selected')) {
      if (world.restoreBlockTexture(blockId)) {
        item.classList.remove('selected');
        rebuildVisibleChunks();
        hotbar.render();
        inventory.repaintIcons();
      }
      return;
    }
    try {
      const source = await entry.source();
      if (world.setBlockTexture(blockId, source)) {
        document.querySelectorAll('.texture-item.selected').forEach((el) => el.classList.remove('selected'));
        item.classList.add('selected');
        rebuildVisibleChunks();
        hotbar.render();
        inventory.repaintIcons();
      }
    } catch (e) {
      console.warn('image illisible:', entry.name, e);
    }
  });
}

async function loadTextures() {
  let entries;
  try {
    entries = await textureStore.list();
  } catch (e) {
    console.warn('Could not load textures:', e);
    return;
  }
  textureList.innerHTML = '';
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'texture-item';
    const img = document.createElement('img');
    img.alt = '';
    entry.source().then((canvas) => { img.src = canvas.toDataURL('image/png'); }).catch(() => {});
    const label = document.createElement('span');
    label.textContent = entry.name;
    item.appendChild(img);
    item.appendChild(label);
    bindTextureItem(item, entry);
    textureList.appendChild(item);
  }
}

textureUpload.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  try {
    await textureStore.save(files);
    await loadTextures();
  } catch (err) {
    console.error('Upload failed:', err);
  } finally {
    textureUpload.value = '';
  }
});

// The desktop host swaps the file input for the OS picker; the hint doubles as
// the only feedback channel a modal dialog leaves behind.
async function importFromDisk() {
  texturePick.disabled = true;
  const steady = texturePick.dataset.hint || textureHint.textContent;
  try {
    const count = await textureStore.save();
    textureHint.textContent = count ? `${count} image(s) importée(s)` : 'aucune image choisie';
    await loadTextures();
  } catch (err) {
    console.error('Import failed:', err);
    textureHint.textContent = `import impossible : ${err.message}`;
  } finally {
    texturePick.disabled = false;
    setTimeout(() => { textureHint.textContent = steady; }, 2500);
  }
}

if (textureStore.mode === 'desktop') {
  textureUpload.style.display = 'none';
  texturePick.hidden = false;
  texturePick.dataset.hint = 'Les images sont copiées dans le dossier de l’application';
  textureHint.textContent = texturePick.dataset.hint;
  texturePick.addEventListener('click', importFromDisk);
}

loadTextures();

// ==================== START BUTTON ====================
const startBtn = document.getElementById('start-btn');

// ---- view-depth control on the start screen ----
const distanceInput = document.getElementById('render-distance');
const distanceValue = document.getElementById('render-distance-value');

function describeRenderDistance(radius) {
  const blocks = radius * CHUNK_SIZE;
  const chunks = (radius * 2 + 1) ** 2;
  const base = `${radius} chunk${radius > 1 ? 's' : ''} · ~${blocks} blocs · ${chunks} tronçons`;
  return chunks > 400 ? `${base} · chargement progressif` : base;
}

function syncDistanceControl(radius) {
  distanceInput.value = String(radius);
  distanceValue.textContent = describeRenderDistance(radius);
}

distanceInput.min = String(MIN_RENDER_DISTANCE);
distanceInput.max = String(MAX_RENDER_DISTANCE);
syncDistanceControl(settings.renderDistance);
distanceInput.addEventListener('input', () => setRenderDistance(distanceInput.value));

// ---- durée de la journée ----
const jourInput = document.getElementById('day-length');
const jourValue = document.getElementById('day-length-value');

function decrireDureeJour(secondes) {
  const s = bornerDuree(secondes);
  if (s < 120) return `${s} secondes`;
  const m = s / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)} minute${m > 1 ? 's' : ''}`;
}

function syncDayControl() {
  if (!jourInput) return;
  jourInput.min = String(DUREE_JOUR_BORNES.min);
  jourInput.max = String(DUREE_JOUR_BORNES.max);
  jourInput.step = '30';
  jourInput.value = String(settings.dureeJour);
  jourValue.textContent = decrireDureeJour(settings.dureeJour);
}

function setDayLength(value) {
  const next = bornerDuree(value);
  settings.dureeJour = next;
  horloge.reglerDuree(next);   // le monde en cours accélère ou ralentit sans changer d'heure
  syncDayControl();
  saveSettings();
  return next;
}

syncDayControl();
if (jourInput) jourInput.addEventListener('input', () => setDayLength(jourInput.value));

// ---- météo ----
// Le réglage ne fait que choisir le régime ; c'est `meteo.js` qui décide de l'averse.
// « Averse continue » sert aussi bien au joueur qui veut la pluie qu'aux suites, qui ne
// peuvent pas attendre qu'un épisode se présente.
const meteoSelect = document.getElementById('meteo-mode');
const meteoValue = document.getElementById('meteo-mode-value');
const METEO_LIBELLES = { auto: 'automatique', jamais: 'ciel clair', toujours: 'averse' };

function syncMeteoControl() {
  if (!meteoSelect) return;
  meteoSelect.value = settings.meteo;
  if (meteoValue) meteoValue.textContent = METEO_LIBELLES[settings.meteo];
}

function setMeteoMode(value) {
  const next = METEO_MODES.includes(value) ? value : 'auto';
  settings.meteo = next;
  meteo.reglerMode(next);
  pluieForcee = null;   // une reprise en main de test ne survit pas à un changement de réglage
  ventForce = null;     // idem pour le vent figé d'une suite
  rafraichirCiel();     // l'aperçu derrière le panneau doit changer tout de suite
  syncMeteoControl();
  saveSettings();
  return next;
}

syncMeteoControl();
if (meteoSelect) meteoSelect.addEventListener('input', () => setMeteoMode(meteoSelect.value));

// ---- netteté du rendu -----------------------------------------------------
// Le joueur n'avait aucune prise sur le nombre de pixels rendus. Le curseur ne touche
// jamais au monde, seulement au canevas : « native » garde exactement l'image d'avant.
const netreteSel = document.getElementById('netrete');
const netreteValue = document.getElementById('netrete-value');
const NETTETE_LIBELLES = {
  native: 'native', 1: '1×', '0.75': '0,75×', '0.5': '0,5×',
};

function syncNetreteControl() {
  if (!netreteSel) return;
  netreteSel.value = settings.netrete;
  if (netreteValue) {
    const r = renderer.getPixelRatio();
    netreteValue.textContent = `${NETTETE_LIBELLES[settings.netrete] || settings.netrete} · ${Math.round(r * 100)} %`;
  }
}

function reglerNetrete(valeur) {
  const next = NETTETES.includes(String(valeur)) ? String(valeur) : NETTETE_DEFAUT;
  settings.netrete = next;
  appliquerNetrete();
  syncNetreteControl();
  saveSettings();
  return next;
}

syncNetreteControl();
if (netreteSel) netreteSel.addEventListener('change', () => reglerNetrete(netreteSel.value));

startBtn.addEventListener('click', () => {
  if (!worldReady) return;   // stays disabled until the save has been read back
  inventory.hide();
  blocker.style.display = 'none';
  // Solid ground under the feet before the pointer is taken; the rest keeps streaming.
  world.updateChunks(camera.position.x, camera.position.z, WORLD_BOOT_BUDGET);
  // Without the lock there is no mouse look, so keep the start screen up rather
  // than dropping the player into a game they cannot steer.
  const pending = lockPointer();
  if (pending && typeof pending.catch === 'function') {
    pending.catch(() => { blocker.style.display = 'flex'; });
  }
});

// Opening the inventory releases the pointer on purpose: only the start screen
// may cover the game in that case.
controls.addEventListener('unlock', () => {
  if (inventory.isOpen()) return;
  blocker.style.display = 'flex';
  // Échap ouvre cet écran : le bouton d'enregistrement s'y présente dans l'état réel du
  // disque, et sa note explique une bonne fois ce que l'autosauvegarde fait déjà seule.
  majBoutonEnregistrer();
  syncGeomBarre();           // idem pour la barre de pré-cuisson : elle doit dire l'état vrai
  if (saveNote && !saveNote.textContent) {
    saveNote.textContent = `Le monde s’économise seul toutes les ${Math.round(AUTOSAVE_INTERVAL_MS / 1000)} s ; ce bouton écrit tout de suite.`;
  }
});

controls.addEventListener('lock', () => {
  blocker.style.display = 'none';
  // Coming back to the game is a natural moment to settle the disk: whatever the
  // player just did is worth keeping before they walk somewhere new.
  flushWorldSave({ force: true });
});

// ==================== WORLD SAVES ====================
// The terrain regenerates from WORLD_SEEDS, so the disk carries only the player's
// diff and their position. Writes are throttled to AUTOSAVE_INTERVAL_MS and only
// happen when something actually changed, which keeps them off the frame budget.
// `SAVE_SLOT` et `SAVE_PARAMS` viennent du haut du module : la fiche de génération du
// monde doit être connue avant le premier tronçon.
const saveStore = createSaveStore({ slot: SAVE_SLOT, tauriCore });

// Deux identifiants par monde : le slot, qui est un nom de fichier sûr et sert à
// l'adressage, et le nom d'affichage que le joueur choisit librement. Un monde tout
// juste créé n'a pas encore de fichier sur le disque : son nom transite donc par
// l'URL jusqu'au premier enregistrement.
let worldName = cleanWorldName(SAVE_PARAMS.get('name'));

/** Ce qu'on montre au joueur : le nom qu'il a choisi, sinon le nom de fichier. */
function worldLabel(meta) {
  const raw = meta ? meta.name : worldName;
  return cleanWorldName(raw) || (meta ? meta.slot : saveStore.slot);
}

const worldStatusEl = document.getElementById('world-status');
const worldListEl = document.getElementById('world-list');
const worldNewBtn = document.getElementById('world-new');
const worldResetBtn = document.getElementById('world-reset');
const worldNameInput = document.getElementById('world-name');
const worldRenameBtn = document.getElementById('world-rename');
const saveStatusEl = document.getElementById('save-status');

let worldReady = false;
let saveDirty = false;      // an edit happened since the last write
let writingSave = false;    // one request in flight, avoids piling up writes
let finECriture = Promise.resolve();   // sa promesse : qui demande une écriture l'attend
let lastWriteAt = -Infinity;
let writtenEdits = -1;      // diff size as of the last successful write
const writtenPos = new THREE.Vector3(NaN, NaN, NaN);
let lastSaveHudText = null;

// Any block written by the player has to reach the disk eventually.
world.onEdit = () => { saveDirty = true; };

// Ce qui a été écrit se juge sur ce que LE PAYLOAD contenait, pas sur l'état du moment
// où il revient. Sans cette précaution, une écriture partie juste avant une édition se
// termine après elle et déclare « écrit » un fichier qui ne connaît pas l'édition : le
// disque reste en retard jusqu'à la prochaine édition (mesuré le 2026-11-16 par
// `tests/persistence.mjs`, quatre cubes absents du fichier avec `savePending()` faux).
function markWorldWritten(empreinte) {
  saveDirty = false;
  writtenEdits = empreinte ? empreinte.edits : world.modifiedBlocks.size;
  if (empreinte) writtenPos.copy(empreinte.pos); else writtenPos.copy(camera.position);
}

// Cheap enough to run every frame: no allocation, no serialisation.
function needsWorldSave() {
  if (saveDirty) return true;
  if (world.modifiedBlocks.size !== writtenEdits) return true;
  if (!Number.isFinite(writtenPos.x)) return true;
  const dx = camera.position.x - writtenPos.x;
  const dy = camera.position.y - writtenPos.y;
  const dz = camera.position.z - writtenPos.z;
  return dx * dx + dy * dy + dz * dz > PLAYER_SAVE_MOVE_SQ;
}

// True between « Régénérer ce monde » et le rechargement : la page tient encore en
// mémoire l'ancienne fiche, et une autosauvegarde qui partirait à ce moment-là la
// réécrirait sur le disque — où elle reprendrait raison au démarrage suivant.
let regenerEnCours = false;

async function flushWorldSave({ force = false, beacon = false } = {}) {
  if (regenerEnCours) return false;
  if (!worldReady) return false;
  // Une écriture est déjà partie (l'économise périodique, un clic précédent) : on l'attend
  // au lieu de repartir les mains vides. Faire semblant d'enregistrer ferait croire au
  // demandeur que le disque n'est pas à jour alors qu'il vient de le devenir.
  if (writingSave) await finECriture;
  // `force` lifts the throttle (unload, world switch), it never invents work: an
  // unchanged world is left alone on the disk.
  if (!needsWorldSave()) return false;
  const now = performance.now();
  if (!force && now - lastWriteAt < AUTOSAVE_INTERVAL_MS) return false;
  const text = encodeSave({
    seed: WORLD_SEEDS, name: worldName, player: player.saveState(),
    edits: world.modifiedBlocks, monde: MONDE, flux: world.eauNiveaux,
  });
  // L'empreinte est prise ICI, avec le payload : c'est lui qui part sur le disque.
  const empreinteEcrite = { edits: world.modifiedBlocks.size, pos: camera.position.clone() };

  // On the way out the response is worthless, so prefer the one transport the
  // browser promises to deliver after the page is gone.
  if (beacon && saveStore.mode === 'web' && saveStore.saveSoon(text)) {
    lastWriteAt = now;
    markWorldWritten(empreinteEcrite);
    return true;
  }
  if (writingSave) return false;

  writingSave = true;
  lastWriteAt = now;
  finECriture = (async () => {
    try {
      await saveStore.save(text);
      markWorldWritten(empreinteEcrite);
      return true;
    } catch (e) {
      console.warn('Sauvegarde impossible :', e);
      saveDirty = true; // le prochain réveil de l'économise reprendra le diff
      return false;
    } finally {
      writingSave = false;
    }
  })();
  return finECriture;
}

// L'économise automatique ne se paie plus par image : l'écran d'accueil peut dormir le
// bucle pendant des minutes, et une écriture du disque n'a rien à attendre de la
// prochaine image. Le garde-fis est le même (throttlée, et muette tant que rien n'a
// changé), seul son réveil change de nature.
// La géométrie cuite voyage sur le même réveil : elle s'écrit après le monde, jamais
// pendant une image. Un joueur qui vole sans rien poser ne salit aucune sauvegarde mais
// fait mailler des centaines de tronçons — le cache doit avancer aussi dans ce cas-là.
setInterval(() => {
  if (!worldReady) return;
  flushWorldSave();
  verifierPublicationGeom();
}, AUTOSAVE_INTERVAL_MS);

function describeAge(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'à l’instant';
  const s = Math.round(ms / 1000);
  if (s < 60) return `il y a ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

function updateSaveHud() {
  if (!saveStatusEl) return;
  let text;
  if (!worldReady) text = '💾 chargement…';
  else if (writingSave) text = '💾 écriture…';
  else if (needsWorldSave()) text = '💾 en attente';
  else text = Number.isFinite(writtenPos.x) ? `💾 sauvegardé ${describeAge(Date.now() - savedAtLocal)}` : '💾 —';
  if (text === lastSaveHudText) return;
  lastSaveHudText = text;
  saveStatusEl.textContent = text;
}

let savedAtLocal = Date.now();

function setWorldStatus(text) {
  if (worldStatusEl) worldStatusEl.textContent = text;
}

// ---- bouton « Enregistrer » de l'écran d'arrêt ----
// Échap rend la souris et rouvre cet écran : c'est le moment où le joueur veut être sûr
// que ce qu'il vient de bâtir est sur le disque. L'autosauvegarde reprend déjà le
// travail en arrière-plan ; ce bouton, lui, doit dire ce qu'il a fait — une écriture
// muette ressemble à une écriture qui n'a pas eu lieu.
const saveBtn = document.getElementById('save-btn');
const saveNote = document.getElementById('save-note');
let saveBtnBusy = false;

function majBoutonEnregistrer() {
  if (!saveBtn) return;
  // Le bouton reste cliquable pendant une écriture automatique : la demande du joueur
  // attend celle qui est en vol au lieu d'être refusée. Lui seul se met en congé.
  saveBtn.disabled = !worldReady || saveBtnBusy;
  saveBtn.textContent = !worldReady ? '💾 monde en chargement…'
    : (writingSave || saveBtnBusy) ? '💾 écriture…'
    : '💾 Enregistrer le monde';
}

/** Écrit tout de suite et rend le verdict dans la note sous le bouton. */
async function enregistrerMaintenant() {
  // Une écriture en vol n'est pas un motif de refus : `flushWorldSave` l'attend et reprend
  // le diff. Refuser laissait le joueur avec un bouton qui n'avait rien écrit.
  if (!worldReady || saveBtnBusy) return false;
  const regenerait = regenerEnCours;
  saveBtnBusy = true;
  majBoutonEnregistrer();
  let ecrit = false;
  try {
    ecrit = await flushWorldSave({ force: true });
  } finally {
    saveBtnBusy = false;
    majBoutonEnregistrer();
    updateSaveHud();
  }
  if (saveNote) {
    // Verdict lu sur l'état final du disque, pas sur le seul voyage de ce clic : si
    // l'économise périodique vient d'écrire ces mêmes cubes, le joueur a eu ce qu'il veut.
    saveNote.textContent = ecrit
      ? `Monde « ${worldLabel()} » écrit · ${world.modifiedBlocks.size} cube${world.modifiedBlocks.size > 1 ? 's' : ''} modifié${world.modifiedBlocks.size > 1 ? 's' : ''}`
      : regenerait ? 'Régénération du monde en cours : rien à écrire pour l’instant'
      : !needsWorldSave() ? 'Rien de nouveau depuis la dernière écriture : le disque est à jour'
      : 'Échec de l’écriture — voir la console';
  }
  return ecrit;
}

if (saveBtn) saveBtn.addEventListener('click', () => { enregistrerMaintenant(); });

async function readStoredWorld() {
  let timer = null;
  try {
    const text = await Promise.race([
      saveStore.load(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`délai de ${WORLD_LOAD_TIMEOUT_MS} ms dépassé`)), WORLD_LOAD_TIMEOUT_MS);
      }),
    ]);
    // AIR (0) is a legitimate stored value: a dug-out block has to come back as a
    // hole, so the block-id check cannot treat 0 as "unknown".
    return decodeSave(text, {
      isValidBlock: (id) => id === BLOCK.AIR || !!BLOCK_INFO[id],
      height: CHUNK_HEIGHT,
    });
  } catch (e) {
    // A broken or unreadable save must never lock the player out of the game.
    console.warn('Sauvegarde ignorée, monde neuf :', e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ==================== CACHE D'ÎLE ====================
// Le relief se régénère depuis la graine, mais il coûte 18 ms par tronçon — neuf minutes
// et demie pour les 31 416 tronçons de l'île par défaut (mesuré le 2026-11-16). Le cache
// supprime ce temps : le fichier entier (21 Mo compressés) tient en mémoire et chaque
// tronçon se relit à la demande. Tout décompresser d'un coup coûterait 982 Mo, ce qu'aucun
// onglet ne supporte — c'est donc la lecture qui est instantanée, pas la mise en RAM.
//
// Trois moments : lire le fichier (`chargerCacheIle`), le réchauffer autour du joueur
// (`rechaufferAutour`), et, s'il manque ou est périmé, le fabriquer (`cuireIle`) — la
// cuisson s'étale sur des milliers de petites yielded pour que la barre se peigne et que
// le joueur puisse entrer avant la fin.

const ileEl = document.getElementById('ile');
const ileBarreEl = document.getElementById('ile-barre');
const ilePleinEl = document.getElementById('ile-remplissage');
const ileTexteEl = document.getElementById('ile-texte');
const ilePasserBtn = document.getElementById('ile-passer');
const ileRefaireBtn = document.getElementById('ile-refaire');

const ileEtat = {
  cache: null,
  phase: 'attente',        // attente | lecture | cuisson | publication | pret | incomplete | passe
  recus: 0,
  octetsAttendus: 0,
  octets: 0,
  faits: 0,
  total: 0,
  attendus: 0,             // tronçons que compte le disque de l'île, selon la fiche
  complet: false,
  laisseLibre: false,      // le joueur peut entrer pendant qu'il reste à cuire
  motif: '',
  cuisson: null,
  annulee: false,
};

/** Combien de tronçons devrait tenir un cache complet pour la fiche en cours. */
function compterTronconsDeIle() {
  const bornes = bornesIle(MONDE, CHUNK_SIZE);
  let n = 0;
  for (let j = 0; j < bornes.nz; j++)
    for (let i = 0; i < bornes.nx; i++)
      if (bornes.contient(bornes.cx + i, bornes.cz + j)) n++;
  return n;
}

function ileAttendue() {
  return { seed: MONDE.graine, monde: MONDE, chunkSize: CHUNK_SIZE, height: CHUNK_HEIGHT };
}

function decrireOctets(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} Mo`;
  if (n >= 1024) return `${Math.round(n / 1024)} Ko`;
  return `${n} o`;
}

// Repère de départ de la cuisson : seul moyen d'estimer ce qui reste à attendre.
const ileMarques = { start: 0 };

function afficherIle() {
  if (!ileEl || !ilePleinEl || !ileTexteEl) return;
  const e = ileEtat;
  let plein = 0;
  let texte = '';
  if (e.phase === 'lecture') {
    plein = e.octetsAttendus ? e.recus / e.octetsAttendus : 0;
    texte = `Lecture du cache de l’île… ${decrireOctets(e.recus)} sur ${decrireOctets(e.octetsAttendus)}`;
  } else if (e.phase === 'cuisson') {
    plein = e.total ? e.faits / e.total : 0;
    const reste = e.total && e.faits ? Math.max(0, Math.round((e.total - e.faits) * (performance.now() - ileMarques.start) / Math.max(1, e.faits) / 1000)) : null;
    texte = `Fabrication du cache de l’île… ${e.faits} / ${e.total} tronçons`
      + (reste !== null ? ` · reste ~${reste < 60 ? `${reste} s` : `${Math.round(reste / 60)} min`}` : '');
  } else if (e.phase === 'publication') {
    plein = 1;
    texte = 'Publication du cache sur le disque…';
  } else if (e.phase === 'pret') {
    plein = 1;
    const s = e.cache ? e.cache.stats() : null;
    texte = s
      ? (e.complet || !e.attendus
        ? `Île entière sur le disque · ${s.troncons} tronçons · ${decrireOctets(s.octets)} (${s.codec})`
        : `Île sur le disque · ${s.troncons} / ${e.attendus} tronçons — le reste se cuira en tâche de fond`)
      : '';
  } else if (e.phase === 'incomplete') {
    plein = e.total ? e.faits / e.total : 1;
    texte = `Cache incomplet (arrêté à ${e.faits} / ${e.total}) — le reste cuit maintenant, sans vous retenir`;
  } else if (e.phase === 'passe') {
    plein = e.total ? e.faits / e.total : 0;
    texte = e.motif || 'Cache laissé de côté — le terrain se générera à la volée';
  }
  ilePleinEl.style.width = `${Math.round(Math.max(0, Math.min(1, plein)) * 100)}%`;
  if (ileBarreEl) ileBarreEl.setAttribute('aria-valuenow', String(Math.round(plein * 100)));
  ileTexteEl.textContent = texte;
  ileEl.hidden = e.phase === 'attente';
  if (ilePasserBtn) ilePasserBtn.hidden = !(e.phase === 'cuisson' || e.phase === 'lecture');
  if (ileRefaireBtn) ileRefaireBtn.hidden = !!ileEtat.cuisson;
}

/** Rend la main à la boucle d'images : la cuisson ne doit jamais geler l'onglet. */
function rendreLaMain() {
  return new Promise((rendre) => setTimeout(rendre, 0));
}

/** Relit le fichier d'île du disque. Renvoie false s'il manque ou ne correspond pas. */
async function chargerCacheIle() {
  ileEtat.phase = 'lecture';
  ileEtat.recus = 0;
  ileEtat.octetsAttendus = 0;
  afficherIle();
  let octets = null;
  try {
    octets = await saveStore.loadIsland(saveStore.slot, (lus, total) => {
      ileEtat.recus = lus;
      ileEtat.octetsAttendus = total || ileEtat.octetsAttendus;
      if ((lus & 0x3ffff) < 0x4000) afficherIle();        // une repesinte par ~256 Ko reçus
    });
  } catch (e) {
    ileEtat.motif = `cache illisible (${e.message})`;
    return false;
  }
  if (!octets || octets.length === 0) return false;
  const cache = new CacheIle(octets, ileAttendue());
  if (!cache.valide) {
    ileEtat.motif = cache.motif || 'format non reconnu';
    console.info('Cache d’île écarté :', ileEtat.motif);
    return false;
  }
  ileEtat.cache = cache;
  ileEtat.octets = octets.length;
  ileEtat.attendus = compterTronconsDeIle();
  ileEtat.complet = cache.stats().troncons >= ileEtat.attendus;
  world.cacheIle = cache;
  return true;
}

/** Réchauffe les tranches qui couvrent les tronçons autour d'un point, avant d'y mailler. */
async function rechaufferAutour(x, z, rayon) {
  const cache = ileEtat.cache;
  if (!cache) return 0;
  const pcx = Math.floor(x / CHUNK_SIZE);
  const pcz = Math.floor(z / CHUNK_SIZE);
  const liste = [];
  for (let dz = -rayon; dz <= rayon; dz++)
    for (let dx = -rayon; dx <= rayon; dx++) liste.push([pcx + dx, pcz + dz]);
  // Pas de plafond à 8 : la demande porte sur tout le champ rendu et `preparerTranches`
  // ajuste la file chaude dessus. Bornée à 8, elle laissait les tranches du bord froides
  // et ces tronçons repartaient du bruit malgré le fichier (mesuré 5 sur 49 à r=4).
  return preparerTranches(cache, liste, { max: TRANCHES_MAX });
}

/**
 * Cuit toute l'île et l'écrit sur le disque. Les tronçons déjà présents dans un cache
 * partiel sont relus (coût d'une tranche) plutôt que régénérés, ce qui rend la reprise
 * bon marché après un arrêt. Des points d'étape publient régulièrement : rien n'est
 * perdu de ce qui est déjà cuit si l'onglet meurt en route.
 */
async function cuireIle() {
  if (ileEtat.cuisson) return ileEtat.cuisson;
  const bornes = bornesIle(MONDE, CHUNK_SIZE);
  const herite = ileEtat.cache;
  let total = 0;
  for (let j = 0; j < bornes.nz; j++)
    for (let i = 0; i < bornes.nx; i++)
      if (bornes.contient(bornes.cx + i, bornes.cz + j)) total++;

  ileEtat.total = total;
  ileEtat.attendus = total;      // même compte : c'est le disque de l'île, selon la fiche
  ileEtat.faits = 0;
  ileEtat.annulee = false;
  ileEtat.phase = 'cuisson';
  ileMarques.start = performance.now();
  afficherIle();

  const ecrivain = new EcrivainIle({
    chunkSize: CHUNK_SIZE, height: CHUNK_HEIGHT, seed: MONDE.graine, monde: MONDE,
    bornes, codec: codecParDefaut(),
  });

  const promesse = (async () => {
    let dernierEnvoi = performance.now();
    let tour = 0;
    for (let j = 0; j < bornes.nz && !ileEtat.annulee; j++) {
      for (let i = 0; i < bornes.nx && !ileEtat.annulee; i++) {
        const cx = bornes.cx + i;
        const cz = bornes.cz + j;
        if (!bornes.contient(cx, cz)) continue;
        let d = null;
        if (herite && herite.aLeTroncon(cx, cz)) {
          const no = herite.trancheDe(cx, cz);
          if (no >= 0) await herite.rechauffer(no);
          d = herite.troncon(cx, cz);
        }
        if (!d) d = world.fabriquerDonnees(cx, cz);       // sans passer par le monde : 1 Go sinon
        await ecrivain.ajouter(cx, cz, d);
        ileEtat.faits++;
        // Une pause tous les seize tronçons suffit à garder la barre vivante ; pendant
        // la partie on rend la main deux fois plus souvent, le rendu passe avant.
        if (++tour % (worldReady && !ecranPose() ? 8 : 16) === 0) {
          afficherIle();
          await rendreLaMain();
        }
        if (performance.now() - dernierEnvoi > 45000) {
          ileEtat.phase = 'publication';
          afficherIle();
          try { await saveStore.saveIsland(await ecrivain.publier()); } catch (e) { console.warn('Étape non publiée :', e); }
          ileEtat.phase = 'cuisson';
          dernierEnvoi = performance.now();
          afficherIle();
        }
      }
    }

    ileEtat.phase = 'publication';
    afficherIle();
    let ecrit = false;
    try {
      const fichier = await ecrivain.publier();
      await saveStore.saveIsland(fichier);
      const relu = new CacheIle(fichier, ileAttendue());
      if (relu.valide) {
        ileEtat.cache = relu;
        world.cacheIle = relu;
        ileEtat.octets = fichier.length;
        ileEtat.complet = relu.stats().troncons >= (ileEtat.attendus || ileEtat.total);
      }
      ecrit = true;
    } catch (e) {
      console.warn('Cache d’île non publié :', e);
      ileEtat.motif = `publication impossible (${e.message})`;
    }
    ileEtat.phase = ileEtat.annulee || !ecrit ? 'incomplete' : 'pret';
    ileEtat.cuisson = null;
    afficherIle();
    demarrerSansCache();          // la barre est arrivée au bout : plus rien ne retient le joueur
    return ecrit && !ileEtat.annulee;
  })();

  ileEtat.cuisson = promesse;
  return promesse;
}

function laisserTomberLeCacheIle() {
  ileEtat.annulee = true;
  ileEtat.laisseLibre = true;
  if (!ileEtat.cuisson) {
    ileEtat.phase = 'passe';
    afficherIle();
  }
  demarrerSansCache();
}

/** Ce que le joueur peut faire même sans cache : entrer en jeu. */
function demarrerSansCache() {
  if (startBtn.disabled && worldReady) startBtn.disabled = false;
}

if (ilePasserBtn) ilePasserBtn.addEventListener('click', laisserTomberLeCacheIle);

if (ileRefaireBtn) ileRefaireBtn.addEventListener('click', async () => {
  ileRefaireBtn.disabled = true;
  try { await saveStore.clearIsland(saveStore.slot); } catch (e) { console.warn('Cache non effacé :', e); }
  ileEtat.cache = null;
  world.cacheIle = null;
  ileEtat.phase = 'attente';
  ileEtat.motif = '';
  await cuireIle();
  ileRefaireBtn.disabled = false;
});

// ==================== géométrie déjà prête pour la carte ======================
// Le cache d'île rend le relief ; celui-ci rend les triangles. Il s'écrit tout seul,
// pendant que le joueur joue, et se lit tronçon par tronçon : jamais il ne retient le
// démarrage, jamais il ne bloque une image. Trois moments comme pour l'île — relire le
// fichier (`chargerCacheGeom`), le publier par petites touches (`publierGeometrie`,
// accroché à l'économise du monde), et le jeter quand le joueur n'en veut plus.

const geomNoteEl = document.getElementById('geom-note');
const geomJeterBtn = document.getElementById('geom-jeter');

const geomEtat = { octets: 0, publies: 0, motif: '', enCours: false, etape: '', depuis: 0, migrationEssai: 0 };

// ---- la barre de progression des triangles, sur l'écran d'accueil ----
// Elle ne bloque pas l'entrée en jeu : reposer un tronçon depuis le fichier coûte 0,29 ms
// contre 6,94 ms au mailleur, donc attendre l'île entière n'a jamais d'intérêt à être
// *demandé* — elle se taille seule. Le voile posé ne rend rien : c'est là que le four
// rapporte le plus, et c'est pourquoi il y reçoit un crédit qu'aucune image ne lui dispute.
const geomBlocEl = document.getElementById('geom');
const geomBarreEl = document.getElementById('geom-barre');
const geomRemplissageEl = document.getElementById('geom-remplissage');
const geomTexteEl = document.getElementById('geom-texte');

// Le compte des tronçons de l'île, une seule fois : la barre de l'accueil doit dire où
// on en est AVANT même que le four soit armé (sinon le joueur voit un bloc vide et ne
// sait pas ce que le bouton lui promet). `bornesIle` parcourt toute la grille, on garde
// donc le résultat — il ne change pas tant que la fiche du monde est la même.
let _totalTronconsIle = 0;
function totalTronconsIle() {
  if (_totalTronconsIle) return _totalTronconsIle;
  const b = bornesIle(MONDE, CHUNK_SIZE);
  let n = 0;
  for (let j = 0; j < b.nz; j++)
    for (let i = 0; i < b.nx; i++)
      if (b.contient(b.cx + i, b.cz + j)) n++;
  _totalTronconsIle = n;
  return n;
}

/**
 * Combien de tronçons de l'île sont déjà gravés. Le compteur du four ne convient pas ici :
 * il repart de zéro à chaque session, alors que le fichier, lui, sait déjà tout ce qu'il
 * porte — la barre retomberait à 0 % au premier clic du joueur (mesuré : 2 % affichés au
 * menu, puis 0 % dès que le four s'arme). L'écrivain est construit À PARTIR du fichier relu
 * (option `existant`) et s'enrichit ensuite : son compte est l'union des deux, jamais une
 * somme qui compterait deux fois les mêmes tronçons.
 */
function tronconsPrets() {
  const e = world.ecrivainGeom;
  if (e) return e.entrees.size;
  return world.cacheGeom?.stats()?.troncons ?? 0;
}

function syncGeomBarre() {
  if (!geomBlocEl || !geomRemplissageEl) return;
  const actif = budgetGeomOctets() > 0 && GEOM_MODE !== 'ignorer';
  geomBlocEl.hidden = !actif;
  if (!actif) return;
  const c = world.etatCuissonIle();
  const total = c?.attendus || ileEtat.attendus || totalTronconsIle();
  const prets = tronconsPrets();
  const pct = total ? Math.min(100, Math.round((100 * prets) / total)) : 0;
  geomRemplissageEl.style.width = `${pct}%`;
  if (geomBarreEl) geomBarreEl.setAttribute('aria-valuenow', String(pct));
  if (geomTexteEl) {
    geomTexteEl.textContent = prets === 0 && !c
      ? `rien n'est encore gravé · ${total} tronçons à tailler pour l'île entière`
      : c?.sature ? `triangles arrêtés à ${prets}/${total} — ${c.motif || 'taille du disque atteinte'}`
      : `${prets}/${total} tronçons prêts · ${decrireOctets(geomEtat.octets)} au fichier`
        + (geomEtat.etape ? ` · ${geomEtat.etape}` : '')
        + (c?.attenteProlongee ? ' · en attente d’une tranche du relief' : '');
  }
}

function syncGeomControl() {
  if (geomNoteEl) {
    const c = world.etatCuissonIle();
    const s = world.cacheGeom ? world.cacheGeom.stats() : null;
    // Le joueur ne choisit plus la taille : il a le droit de savoir d'où elle vient, sinon
    // un fichier qui s'arrête à mi-île ressemble à une panne.
    const four = !c ? 'plan en cours…'
      : c.sature ? `arrêtée à ${c.faits}/${c.attendus} — ${c.motif || 'taille du disque atteinte'}`
      : c.attenteProlongee ? `${c.faits}/${c.attendus} · en attente d'une tranche d'île`
      : c.enMarche ? `${c.faits}/${c.attendus} tronçons taillés`
      : `île taillée · ${c.faits}/${c.attendus}`;
    const place = budgetGeomOctets();
    geomNoteEl.textContent = geomEtat.motif || (GEOM_MODE === 'ignorer'
      ? 'Cache laissé de côté pour cette session.'
      : !place ? 'Cache éteint : rien n\'est écrit sur le disque.'
      : `${decrireOctets(place)} admis sur le disque, calculés depuis `
        + `${geomBudget.source} · cuisson ${four}`
        + (s ? ` · ${s.troncons} tronçons (${s.codec}) · ${s.decompresse} reposés sans recalcul`
             + (world.geomEnAttente.size ? ` · ${world.geomEnAttente.size} en file` : '')
             + ` · ${decrireOctets(geomEtat.octets)} écrits` : ''));
  }
  syncGeomBarre();          // la barre de l'accueil lit le même état, jamais un autre compte
}

/** Relit le fichier de géométrie. Renvoie false s'il manque ou ne décrit pas ce monde. */
async function chargerCacheGeom() {
  // Tenir la file de maillage pendant la lecture : voir `drainerMailles`. Le garde se lève
  // dans tous les cas, y compris quand le joueur a mis le budget à zéro — sinon la pose
  // du monde resterait suspendue jusqu'au plafond horaire.
  world.cacheGeomEnCours = performance.now();
  try {
    if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return false;
    return await lireCacheGeom();
  } finally {
    world.cacheGeomEnCours = 0;
  }
}

async function lireCacheGeom() {
  let octets = null;
  try {
    octets = await saveStore.loadGeometry(saveStore.slot);
  } catch (e) {
    geomEtat.motif = `géométrie illisible (${e.message})`;
    return false;
  }
  if (!octets || !octets.length) return false;
  const attendu = world.attenduGeom();
  const cache = CacheGeom.depuis(octets, attendu);
  if (!cache) {
    // Pas une erreur : un monde qui change de graine, de fiche, d'atlas ou de mailleur
    // doit simplement repeindre. Le fichier reste sur le disque, au cas où cela revient.
    const motif = lireEnTeteGeom(octets, attendu);
    geomEtat.motif = `triangles du disque écartés : ${motif}`;
    console.info('Cache de géométrie écarté :', motif);
    syncGeomControl();
    return false;
  }
  world.cacheGeom = cache;
  // Vingt-quatre blocs décompressés en main (~11 Mo) : assez pour que la file de maillage
  // puise dedans sans que le plus ancien soit jeté avant d'avoir été posé.
  world.cacheGeom.limitesMain = 48;
  // La capacité annonce à l'écrivain combien de lignes de table réserver dans son en-tête :
  // c'est ce qui lui permet d'ajouter des blocs sans jamais déplacer les anciens. L'île
  // borne le nombre de tronçons possibles, donc la réservation ne grossira pas en route.
  world.ecrivainGeom = new EcrivainGeom({
    ...attendu, maxOctets: budgetGeomOctets(), existant: octets,
    capaciteEntrees: totalTronconsIle(),
  });
  geomEtat.octets = octets.length;
  geomEtat.motif = '';
  syncGeomControl();
  return true;
}

/** Le motif précis du refus, pour que le joueur sache pourquoi ça repart de zéro. */
function lireEnTeteGeom(octets, attendu) {
  const r = lireEnTete(octets, attendu);
  return r.ok ? 'cache pourtant accepté au premier regard' : r.motif;
}

/**
 * Écrit la file sur le disque. Appelé sur le rythme de l'économise du monde — donc après
 * la sauvegarde, hors boucle d'image — et seulement si quelque chose vaut le déplacement :
 * compresser trente tronçons coûte quelques dizaines de millisecondes, réparties entre
 * deux awaited pour ne jamais manger une image.
 */
async function publierGeometrie() {
  if (GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return false;
  if (geomEtat.enCours) return false;
  if (!world.geomEnAttente.size) return false;
  // Un fichier écrit avant la table réservée ne peut pas grossir par ajout : il faudrait
  // déplacer tous les blocs, donc tout réécrire. Sur un gros cache — le joueur a 618 Mo
  // gravés — cette migration ne doit pas tomber pendant qu'il joue ; elle attend le repos,
  // voile posé, où aucune image n'est comptée. On décide AVANT de vider la file, sans quoi
  // chaque tentative reporterait le travail en RAM au lieu de le laisser dans la file bornée.
  const ecrivain = world.ecrivainGeom;
  const auRepos = imageForcee === false && ecranPose();
  if (ecrivain && !ecrivain.appendable && (ecrivain.base || 0) > MIGRATION_CACHE_HORS_REPOS_OCTETS
    && !auRepos) {
    geomEtat.motif = 'cache à migrer : la réécriture attend une pause du joueur';
    return false;
  }
  geomEtat.enCours = true;
  // Nommée à chaque étape : une publication qui ne revient pas doit dire où elle est
  // restée, sinon `enCours` vrai pour toujours se confond avec un monde sans rien à écrire.
  const etape = (nom) => { geomEtat.etape = nom; geomEtat.depuis = performance.now(); };
  let ajoutes = 0;
  try {
    etape('en-tête');
    const attendu = world.attenduGeom();
    const aPublier = [...world.geomEnAttente.entries()];
    if (!world.ecrivainGeom) {
      world.ecrivainGeom = new EcrivainGeom({
        ...attendu, maxOctets: budgetGeomOctets(), capaciteEntrees: totalTronconsIle(),
      });
    }
    for (const [cle, e] of aPublier) {
      etape(`compression ${ajoutes}/${aPublier.length} · ${cle}`);
      try {
        await world.ecrivainGeom.ajouterSerialise(e.cx, e.cz, e.octets, e.empreinte);
        ajoutes++;
      } catch (err) {
        if (/budget/.test(err.message)) {
          // Le disque est plein : on s'arrête là. Si même le premier tronçon n'a pas
          // trouvé de place, le fichier est déjà à son plafond — cuire la suite ne sert à
          // rien, le four l'apprend ici plutôt que de payer le mailleur image après image.
          if (!ajoutes) world.saturerCuissonIle(err.message);
          break;
        }
        if (err && err.suspendu) {
          // Un transformateur qui ne rend pas la main, deux fois de suite : ce tronçon est
          // laissé au mailleur plutôt que de tenir tout le fichier en otage. Il sera recuit
          // à la prochaine repeinture ; les autres, eux, atteignent le disque.
          console.warn('Tronçon non compressé, laissé au mailleur :', cle, err.message);
          geomEtat.motif = `transcodage suspendu sur ${cle} — les autres tronçons sont écrits`;
          world.geomEnAttente.delete(cle);
          world.geomACuire.delete(cle);
          continue;
        }
        throw err;
      }
      // Rendu hors d'atteinte : le tronçon a sa place dans l'écrivain, la file n'a plus
      // à porter ses 420 Ko.
      world.geomEnAttente.delete(cle);
    }
    if (!ajoutes) return false;
    // D'abord la voie bon marché : **ajouter** au fichier ce qui est neuf. Elle n'existe
    // que si l'en-tête en place a le gabarit réservé (sans quoi déplacer le corps fausserait
    // tous les décalages) et ne coûte que les blocs neufs. La voie complète, elle, payait la
    // taille entière du fichier à chaque lot — mesuré le 2026-11-17 : 1 496 ms d'envoi pour
    // 15 Mo déjà en boîte, publié tous les douze tronçons, soit le rendu saccadé du joueur.
    etape('table des décalages');
    const tenterAjout = async () => {
      const morcele = world.ecrivainGeom.publierMorcele();
      if (!morcele) return false;
      etape(`ajout · ${(morcele.append.length / 1024) | 0} Ko`);
      const ajoute = await saveStore.appendGeometry(morcele.append, morcele.base, saveStore.slot);
      if (ajoute && ajoute.success) {
        etape(`table · ${morcele.table.octets.length} o`);
        const tete = await saveStore.putGeometryHead(morcele.table.octets, saveStore.slot, morcele.table.offset);
        if (tete && tete.success) {
          world.ecrivainGeom.marquerAjout(morcele, ajoute.bytes);
          geomEtat.octets = ajoute.bytes;
          return true;
        }
      }
      // Refusé (fichier disparu, désaccord de taille, magasin du bureau sans append) ou
      // interrompu : les octets déjà collés restent là, orphelins hors de la table — donc
      // invisibles — jusqu'à la réécriture.
      world.ecrivainGeom.appendable = false;
      return false;
    };
    let ecrit = await tenterAjout();
    if (!ecrit && !world.ecrivainGeom.appendable) {
      // Cache gravé avant la réservation d'en-tête : ses blocs devraient tous bouger. Les
      // renvoyer est matériellement impossible depuis le navigateur — mesuré le 2026-11-17
      // sur les 618 Mo du joueur : `ERR_BLOB_OUT_OF_MEMORY`, et l'onglet écrasé avec la vue
      // `Uint8Array` nue. Le serveur a ces octets sous la main : il les copie, le jeu ne lui
      // envoie que sa table (~4 Mo), puis les tronçons neufs partent par ajout.
      const depuis = performance.now() - geomEtat.migrationEssai;
      if (geomEtat.migrationEssai && depuis < MIGRATION_ESPACE_MS) {
        // Un refus récent se laisse rejuger plus tard : le juger coûte vingt millisecondes
        // sur les vingt-trois mille lignes du cache, et le voile posé fait défiler soixante
        // images par seconde.
        geomEtat.motif = `migration attendue (${Math.ceil((MIGRATION_ESPACE_MS - depuis) / 1000)} s)`;
      } else {
        geomEtat.migrationEssai = performance.now();
        const migration = world.ecrivainGeom.preparerMigration();
        if (migration) {
          etape(`migration · ${migration.attendu >> 20} Mo copiés chez le serveur · table ${migration.region.length >> 10} Ko`);
          const migre = await saveStore.migrateGeometry(
            migration.region, { attendu: migration.attendu, debut: migration.debut }, saveStore.slot);
          if (migre && migre.success) {
            world.ecrivainGeom.marquerMigration(migration, migre.bytes);
            geomEtat.octets = migre.bytes;
            ecrit = await tenterAjout() || world.ecrivainGeom.nouveaux.size === 0;
          } else {
            geomEtat.motif = `migration refusée (${(migre && migre.status) || '?'}) — la réécriture complète attend`;
          }
        } else if (world.ecrivainGeom.motifMigration) {
          // Refusée par l'écrivain lui-même : le dire, sinon le joueur ne voit qu'un cache qui
          // ne progresse plus et personne ne sait pourquoi.
          geomEtat.motif = `migration impossible : ${world.ecrivainGeom.motifMigration}`;
        }
      }
    }
    if (ecrit) {
      geomEtat.publies += ajoutes;
      geomEtat.motif = '';
      syncGeomControl();
      world.cuireCeQuiAttend({ max: GEOM_EN_ATTENTE_MAX });
      return true;
    }
    if (world.ecrivainGeom.aCorpsManquants) {
      // Des blocs publiés ont rendu leur copie mémoire : c'est au fichier du serveur de la
      // rendre. S'il a disparu entre-temps, ces tronçons sont oubliés — le four les recuit.
      etape('rechargement du fichier');
      try {
        const relus = await saveStore.loadGeometry(saveStore.slot);
        if (relus && relus.length) world.ecrivainGeom.completerDepuis(relus, attendu);
        else world.ecrivainGeom.jeterCorpsSansMemoire();
      } catch (e) {
        world.ecrivainGeom.jeterCorpsSansMemoire();
      }
    }
    if ((world.ecrivainGeom.base || 0) > PLAFOND_ENVOI_NAVIGATEUR_OCTETS) {
      // Et au-delà, le navigateur ne sait tout simplement pas l'envoyer : mesuré le
      // 2026-11-17 sur les 618 Mo du joueur, un corps de 592 Mo échoue en
      // `ERR_BLOB_OUT_OF_MEMORY` et la vue `Uint8Array` nue écrase l'onglet. Le cache en
      // place reste lisible tel quel ; le joueur peut le vider pour repartir d'un fichier
      // neuf, que la voie d'ajout remplira sans jamais rien réécrire.
      // La raison de la migration est conservée devant : sans quoi ce texte général écrase
      // le « pourquoi » précis (mesuré le 2026-11-17, elle noyait le vrai motif).
      geomEtat.motif = `${world.ecrivainGeom.motifMigration ? `migration impossible : ${world.ecrivainGeom.motifMigration} · ` : ''}cache trop volumineux pour une réécriture depuis le navigateur — le vider le refait proprement`;
      syncGeomControl();
      return false;
    }
    const fichier = await world.ecrivainGeom.publier();
    etape(`envoi au serveur · ${(fichier.length / 1024) | 0} Ko`);
    await saveStore.saveGeometry(fichier);
    // Le fichier porte tout : plus rien de ces octets n'a à vivre en RAM.
    world.ecrivainGeom.marquerReecriture(fichier.length);
    geomEtat.octets = fichier.length;
    geomEtat.publies += ajoutes;
    geomEtat.motif = '';
    syncGeomControl();
    // La place libérée dans la file se remplit tout de suite : c'est ce qui fait qu'une
    // longue traversée finit par tout écrire, et non les seuls premiers tronçons.
    world.cuireCeQuiAttend({ max: GEOM_EN_ATTENTE_MAX });
    return true;
  } catch (e) {
    console.warn('Géométrie non publiée :', e);
    geomEtat.motif = `publication manquée (${e.message}) — les tronçons attendent la prochaine`;
    syncGeomControl();
    return false;
  } finally {
    geomEtat.enCours = false;
    geomEtat.etape = '';
  }
}

/** Ce que l'économise du monde nous autorise à écrire sans peser sur l'image. */
function verifierPublicationGeom() {
  if (!worldReady || GEOM_MODE === 'ignorer' || !budgetGeomOctets()) return false;
  // D'abord remettre en file ce qui avait été refusé faute de place, ensuite seulement
  // juger si le moment d'écrire est venu.
  world.cuireCeQuiAttend();
  const n = world.geomEnAttente.size;
  if (!n) return false;
  const attends = performance.now() - world.geomDepuis > GEOM_PUBLIER_APRES_MS;
  if (n < GEOM_PUBLIER_A && !attends) return false;
  publierGeometrie();
  return true;
}

/** Vide le fichier et la mémoire du cache : le monde se repeindra à la main du mailleur. */
async function jeterGeometrie() {
  world.cacheGeom = null;
  world.ecrivainGeom = null;
  world.geomEnAttente.clear();
  world.geomACuire.clear();
  world._fileChauffe.clear();
  geomEtat.octets = 0;
  geomEtat.publies = 0;
  geomEtat.motif = '';
  geomEtat.migrationEssai = 0;          // un cache vidé se rejuge sans attendre l'espace
  try { await saveStore.clearGeometry(saveStore.slot); } catch (e) { console.warn('Géométrie non effacée :', e); }
  syncGeomControl();
  return true;
}

/**
 * Reprise en main de la taille du fichier — par les suites, plus par le joueur : le budget
 * se calcule (`dimensionnerBudgetGeom`). `null` rend la main au calcul. La reprise reporte
 * immédiatement, sans redémarrer : le fichier est rouvert à la nouvelle taille.
 */
async function reglerBudgetGeom(valeur) {
  // `Number(null)` vaut 0 : la main rendue au calcul se déclare AVANT conversion. Rendue,
  // elle efface aussi l'empreinte gardée — une suite qui change le tas annoncé doit voir le
  // chiffre suivre, sinon rien ne distingue un budget calculé d'un budget gravé dans le marbre.
  const brut = valeur === undefined || valeur === null || valeur === '' ? null : Number(valeur);
  geomBudget.force = brut === null || Number.isNaN(brut) ? null : Math.max(0, Math.floor(brut));
  if (geomBudget.force === null) { geomBudget.mo = 0; geomBudget.source = ''; }
  world.cacheGeom = null;
  world.ecrivainGeom = null;
  world.geomEnAttente.clear();
  world.geomACuire.clear();
  world._fileChauffe.clear();
  world.cuissonIle = null;             // le plan de cuisson suit la nouvelle taille
  geomEtat.octets = 0;
  if (budgetGeomOctets()) await chargerCacheGeom(); else syncGeomControl();
  return dimensionnerBudgetGeom();
}

if (geomJeterBtn) geomJeterBtn.addEventListener('click', () => jeterGeometrie());
// Le monde sait qu'il a produit des blocs à écrire mais ne connaît pas le magasin : c'est
// ici que la file pleine devient une écriture.
world._demanderPublicationGeom = verifierPublicationGeom;
// Le panneau ouvre avec son chiffre déjà dessus : la taille n'étant plus un réglage, un
// panneau vide serait la seule réponse du jeu à « combien ça prend, et pourquoi ? ».
syncGeomControl();

async function bootWorld() {
  startBtn.disabled = true;
  setWorldStatus('Chargement du monde…');
  let saved = null;
  try {
    saved = await readStoredWorld();
    // Le fichier porte peut-être une fiche de génération différente de celle du
    // magasin local — mémoire locale effacée, monde copié d'une autre machine. C'est
    // le fichier qui a raison : sans lui, les blocs posés par le joueur retomberaient
    // sur un relief qu'il n'a jamais vu. On range la fiche et on repart une fois ; le
    // garde de session ferme la porte à une boucle de rechargements.
    if (saved && saved.monde && !memesMondes(saved.monde, MONDE)) {
      const cleGarde = `mincraft_fiche_vue:${saveStore.slot}`;
      try {
        localStorage.setItem(mondeStorageKey(saveStore.slot), JSON.stringify(clampMonde(saved.monde)));
        if (!sessionStorage.getItem(cleGarde)) {
          sessionStorage.setItem(cleGarde, '1');
          window.location.reload();
          return;
        }
      } catch (e) {
        console.warn('Fiche du monde non mémorisée :', e);
      }
    }
    // Le cache d'île se lit ici, avant la première pierre posée par le boot : c'est lui
    // qui décide si le relief arrive instantanément ou s'il reste à le fabriquer. Après
    // la fiche, surtout pas avant — une fiche corrigée ci-dessus recharge la page, et
    // cuire l'île sous une fiche périmée ne servirait à rien.
    const ileIgnoree = ILE_MODE === 'ignorer';
    // Tenir la file de maillage dès ici : la lecture du cache d'île qui suit est un `await`,
    // donc une fenêtre d'images pendant laquelle le mailleur pourrait partir sans rien savoir.
    if (GEOM_MODE !== 'ignorer' && budgetGeomOctets()) world.cacheGeomEnCours = performance.now();
    const ilePret = ileIgnoree ? false : await chargerCacheIle();
    // Les triangles du disque se relisent avant la première pierre posée par le boot :
    // les passages d'`updateChunks` ci-dessous maileraient sans savoir que le fichier sait
    // déjà peindre (mesuré 130 reconstructions sur 154 payées dans ce seul intervalle).
    // La lecture ne dépend ni des éditions ni de la fiche — seule la pose compare les
    // empreintes, et elle a lieu bien plus tard, au moment où le tronçon arrive à l'écran.
    await chargerCacheGeom();
    if (saved) {
      // Un nom passé par l'URL (création ou renommage à l'instant) prime : c'est
      // l'intention la plus récente, le fichier peut encore porter l'ancienne.
      if (!worldName) worldName = cleanWorldName(saved.name);
      world.applyEdits(saved.edits, saved.flux);
      player.restoreFromSave(saved.player);
      savedAtLocal = saved.savedAt || Date.now();
    } else {
      mondeVierge = true;
      // Le sol du monument est estampé, pas généré avec le relief : les tronçons qui le
      // portent doivent exister avant qu'on y pose le joueur, sinon il traverse la dalle
      // libre d'air et tombe jusqu'au fond du monde.
      const reveil = resoudreApparition();
      if (reveil) {
        if (ilePret) await rechaufferAutour(reveil.x, reveil.z, 6);
        world.updateChunks(reveil.x, reveil.z, WORLD_BOOT_BUDGET);
      }
      player.placeAtSpawn();
      world.updateChunks(camera.position.x, camera.position.z, WORLD_BOOT_BUDGET);
      savedAtLocal = Date.now();
    }
    // Les triangles du disque ont été relus plus haut, avant le premier `updateChunks`.
    if (!ilePret && !ileIgnoree) {
      // Rien d'exploitable sur le disque : on cuit sous les yeux du joueur, sans le
      // retenir — « Entrer quand même » le laisse partir pendant que la barre avance.
      cuireIle();
    } else if (ilePret) {
      ileEtat.phase = 'pret';
      afficherIle();
      await rechaufferAutour(camera.position.x, camera.position.z, Math.max(4, settings.renderDistance));
      // Un cache arrêté en route vaut ce qu'il vaut : ce qui est dessus arrive
      // instantanément, le reste se cuira derrière le joueur. Le retenir pour ça
      // n'aurait pas de sens — il a déjà un sol sous les pieds.
      if (!ileEtat.complet) {
        ileEtat.laisseLibre = true;
        cuireIle();
      }
    }
  } catch (e) {
    // Replaying a save must never be able to lock the player out of the game: fall
    // back to a fresh world under the feet and keep playing.
    console.warn('Reprise impossible, monde neuf :', e);
    saved = null;
    player.placeAtSpawn();
  } finally {
    worldReady = true;
    // Le bouton ne se débloque qu'une fois l'île lue — ou laissée de côté, ou en cours
    // de cuisson : la promesse faite au joueur est qu'ensuite plus rien n'apparaît
    // sous ses pieds. `demarrerSansCache` le rend dès que la cuisson tombe, et un cache
    // déjà partiel ne retient personne : il a un sol sous les pieds dès l'entrée.
    startBtn.disabled = ileEtat.cuisson !== null && !ileEtat.annulee && !ileEtat.laisseLibre;
    majBoutonEnregistrer();
    syncGeomBarre();         // le menu s'affiche avec sa barre déjà remplie de ce que sait le disque
  }
  if (worldNameInput && !worldNameInput.value) worldNameInput.value = worldName || '';
  // Dire où le joueur se réveille : sans cette ligne, un monde neuf qui s'ouvre sous une
  // colonnade ressemble à un téléportation hasardeuse plutôt qu'à un choix du monde.
  const reveil = !saved && mondeVierge && apparitionDuMonde
    ? ` · réveil dans le temple de (${apparitionDuMonde.ex}, ${apparitionDuMonde.ez})`
    : (!saved && mondeVierge ? ' · aucun temple à portée, apparition en pleine nature' : '');
  setWorldStatus(saved
    ? `Monde « ${worldLabel()} » retrouvé · ${saved.edits.size} bloc${saved.edits.size > 1 ? 's' : ''} modifié${saved.edits.size > 1 ? 's' : ''} · ${describeAge(Date.now() - savedAtLocal)}`
    : `Nouveau monde « ${worldLabel()} » · rien sur le disque pour l’instant${reveil}`);
  refreshWorldList();
}

// ---- world picker on the start screen ----
function describeWorldMeta(meta) {
  const cells = meta.cells ?? meta.edits ?? 0;
  const where = meta.player
    ? ` · en ${Math.round(meta.player.x)}, ${Math.round(meta.player.y)}, ${Math.round(meta.player.z)}`
    : '';
  return `${cells} bloc${cells > 1 ? 's' : ''} modifié${cells > 1 ? 's' : ''}${where} · ${meta.savedAt ? describeAge(Date.now() - meta.savedAt) : 'inconnu'}`;
}

let armedSlot = null;   // a delete only fires on the second click of its own button

function renderWorldList(worlds) {
  if (!worldListEl) return;
  worldListEl.innerHTML = '';
  if (worlds.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'world-empty';
    empty.textContent = 'Aucun monde enregistré pour l’instant';
    worldListEl.appendChild(empty);
    return;
  }
  for (const meta of worlds) {
    const li = document.createElement('li');
    li.className = 'world-item';
    if (meta.slot === saveStore.slot) li.classList.add('active');

    const pick = document.createElement('button');
    pick.className = 'world-pick';
    pick.dataset.slot = meta.slot;
    // Le nom choisi par le joueur, avec le nom de fichier en repli et en infobulle.
    pick.textContent = worldLabel(meta);
    pick.title = `Jouer dans ce monde · fichier ${meta.slot}`;

    const info = document.createElement('span');
    info.className = 'world-meta';
    info.textContent = describeWorldMeta(meta);

    const del = document.createElement('button');
    del.className = 'world-del';
    del.dataset.slot = meta.slot;
    del.textContent = armedSlot === meta.slot ? 'confirmer ?' : '✕';
    del.title = armedSlot === meta.slot
      ? 'Recliquer pour effacer définitivement ce monde'
      : 'Effacer ce monde';

    li.append(pick, info, del);
    worldListEl.appendChild(li);
  }
}

let cachedWorlds = [];   // last listing, reused to repaint without refetching

async function refreshWorldList() {
  let worlds = [];
  try {
    worlds = await saveStore.list();
  } catch (e) {
    console.warn('Liste des mondes indisponible :', e);
  }
  worlds.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  cachedWorlds = worlds;
  renderWorldList(worlds);
}

/**
 * Nom de fichier du prochain monde. Le nom saisi guide le nom de fichier ; s'il est
 * déjà pris, un numéro le distingue plutôt que d'écraser un monde existant.
 */
function nextSlotName(rawName) {
  const taken = new Set(cachedWorlds.map((w) => w.slot));
  const base = slugify(rawName);
  if (base && !taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = (base ? `${base}-${i}` : `monde-${i}`).slice(0, 32);
    if (!taken.has(candidate)) return candidate;
  }
}

// Switching worlds happens from the start screen only: saving where we are, then
// reloading with the other slot is far safer than swapping a live world under the
// meshes, the player and the atlas.
async function openWorld(slot) {
  if (slot === saveStore.slot) return;
  await flushWorldSave({ force: true });
  const url = new URL(window.location.href);
  url.searchParams.set('world', slot);
  window.location.assign(url.toString());
}

async function deleteWorld(slot) {
  armedSlot = null;
  if (slot === saveStore.slot) {
    // Wiping the world being played is a reset, not just a file deletion: the
    // in-memory diff has to go too or the next autosave writes it straight back.
    await resetActiveWorld();
    return;
  }
  try {
    await saveStore.clear(slot);
  } catch (e) {
    console.warn('Suppression impossible :', e);
    return;
  }
  refreshWorldList();
}

// "Réinitialiser": clears the diff in memory and on disk, then puts the player back
// at the spawn point. The next autosave records the virgin world again.
async function resetActiveWorld() {
  try {
    await saveStore.clear();
  } catch (e) {
    console.warn('Effacement impossible :', e);
  }
  world.clearEdits();
  // Le monde redevient vierge : le joueur y est remis comme à sa première venue, sous la
  // colonnade du temple — sinon « Réinitialiser » le rendrait au plein champ alors que la
  // même page, chargée sans fichier, l'y aurait mené.
  mondeVierge = true;
  player.respawn();
  saveDirty = false;
  writtenEdits = 0;
  writtenPos.set(NaN, NaN, NaN);
  savedAtLocal = Date.now();
  armedSlot = null;
  setWorldStatus(`Monde « ${worldLabel()} » réinitialisé`);
  refreshWorldList();
}

/**
 * Donne un nouveau nom d'affichage au monde en jeu. Si le nom saisi se traduit par un
 * autre nom de fichier, le document est écrit sous le nouveau puis l'ancien est
 * supprimé : le joueur ne voit jamais deux fichiers pour un seul monde.
 */
async function renameWorld(rawName) {
  const name = cleanWorldName(rawName);
  if (!name) {
    setWorldStatus('Ce monde n’a pas encore de nom : écris-en un dans le champ.');
    return false;
  }
  const target = slugify(name);
  if (!target) {
    setWorldStatus(`« ${name} » ne donne aucun caractère exploitable comme nom de fichier.`);
    return false;
  }
  // Le listing sert à refuser d'écraser un monde existant : il doit être frais, sinon
  // un monde créé pendant la partie échapperait au contrôle.
  await refreshWorldList();
  if (target !== saveStore.slot && cachedWorlds.some((w) => w.slot === target)) {
    setWorldStatus(`Impossible : un monde occupe déjà le fichier « ${target} ».`);
    return false;
  }

  worldName = name;
  if (worldNameInput) worldNameInput.value = name;
  try {
    // Le nom doit rejoindre le disque même si le diff n'a pas bougé depuis la
    // dernière écriture : sans ce drapeau, needsWorldSave() laisserait le fichier
    // porter l'ancien nom.
    saveDirty = true;
    await flushWorldSave({ force: true });
    if (target !== saveStore.slot) {
      // setNameInSave garantit le nom même si l'écriture ci-dessus a été ignorée
      // (une sauvegarde en cours, par exemple).
      const text = setNameInSave(await saveStore.load(), name);
      if (!text) {
        setWorldStatus('Renommage impossible : le contenu du monde est illisible.');
        return false;
      }
      await saveStore.save(text, target);
      await saveStore.clear();
      setWorldStatus(`Monde renommé « ${name} »`);
      const url = new URL(window.location.href);
      url.searchParams.set('world', target);
      url.searchParams.set('name', name);
      window.location.assign(url.toString());
      return true;
    }
  } catch (e) {
    console.warn('Renommage impossible :', e);
    setWorldStatus(`Renommage impossible : ${e.message}`);
    return false;
  }
  setWorldStatus(`Monde renommé « ${name} »`);
  refreshWorldList();
  return true;
}

if (worldListEl) {
  worldListEl.addEventListener('click', (e) => {
    const target = e.target.closest('button');
    if (!target) return;
    const slot = target.dataset.slot;
    if (!slot) return;
    if (target.classList.contains('world-pick')) {
      openWorld(slot);
    } else if (armedSlot === slot) {
      deleteWorld(slot);
    } else {
      armedSlot = slot;
      renderWorldList(cachedWorlds);
      const doomed = cachedWorlds.find((w) => w.slot === slot);
      setWorldStatus(`Cliquer encore pour effacer « ${worldLabel(doomed || { slot })} »`);
      setTimeout(() => {
        if (armedSlot === slot) {
          armedSlot = null;
          renderWorldList(cachedWorlds);
        }
      }, 4000);
    }
  });
}

if (worldNewBtn) {
  worldNewBtn.addEventListener('click', async () => {
    await flushWorldSave({ force: true });
    // Le nom saisi devient à la fois le nom affiché et, s'il s'y prête, le nom de
    // fichier. Il voyage dans l'URL parce que le monde n'a pas encore de disque.
    const typed = cleanWorldName(worldNameInput ? worldNameInput.value : '');
    const fresh = nextSlotName(typed);
    const url = new URL(window.location.href);
    url.searchParams.set('world', fresh);
    if (typed) url.searchParams.set('name', typed);
    else url.searchParams.delete('name');
    window.location.assign(url.toString());
  });
}

if (worldRenameBtn) {
  worldRenameBtn.addEventListener('click', () => renameWorld(worldNameInput ? worldNameInput.value : ''));
}

if (worldNameInput) {
  worldNameInput.placeholder = worldName || 'Nom du monde';
  worldNameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    renameWorld(worldNameInput.value);
  });
}

if (worldResetBtn) {
  let armedResetAt = 0;
  const original = worldResetBtn.textContent;
  worldResetBtn.addEventListener('click', () => {
    const now = Date.now();
    if (now - armedResetAt > 4000) {
      armedResetAt = now;
      worldResetBtn.textContent = 'Confirmer : tout effacer';
      worldResetBtn.classList.add('confirm');
      setTimeout(() => {
        if (Date.now() - armedResetAt >= 4000) {
          worldResetBtn.textContent = original;
          worldResetBtn.classList.remove('confirm');
        }
      }, 4100);
      return;
    }
    armedResetAt = 0;
    worldResetBtn.textContent = original;
    worldResetBtn.classList.remove('confirm');
    resetActiveWorld();
  });
}

// Leaving the tab, closing the window, or losing focus are the moments where an
// unsaved diff would actually be lost.
window.addEventListener('pagehide', () => flushWorldSave({ force: true, beacon: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushWorldSave({ force: true, beacon: true });
});

bootWorld();

// ==================== RESIZE ====================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Une fenêtre qu'on déplace sur un autre écran change de `devicePixelRatio` sans jamais
  // prévenir : le ratio se recalcule ici, sinon « native » resterait figé sur l'écran d'avant.
  appliquerNetrete();
});

// ==================== GAME LOOP ====================
let lastTime = performance.now();
let fps = 0;
let frameCount = 0;
let fpsTimer = 0;
// Ce qu'a coûté la dernière image, lissé (20 % de poids à la nouvelle). C'est la seule
// boussole du budget de maillage : le nombre d'images par seconde affiché au joueur ne se
// décide qu'à la seconde, alors que le mailleur doit trancher image par image.
let dureeImageEMA = CIBLE_IMAGE_MS;

/**
 * La part d'image laissée au mailleur. À 60 images/s elle rend les 10 ms d'avant ; quand
 * l'image déborde déjà elle se replie sur le plancher, et quand elle a de la place elle
 * double pour rattraper le pop-in plus vite.
 */
function budgetMaillage() {
  const marge = CIBLE_IMAGE_MS - dureeImageEMA;
  return Math.max(BUDGET_MAILLE_MIN_MS, Math.min(BUDGET_MAILLE_MAX_MS, CHUNK_FRAME_MS + marge));
}

const underwaterEl = document.getElementById('underwater');
const swimHintEl = document.getElementById('swim-hint');
// La phrase d'accueil du bandeau vient du HTML : elle y reste la source unique.
const SWIM_HINT_BASE = swimHintEl ? swimHintEl.textContent.trim() : '';

// Teinte d'immersion, bandeau de nage et assiette suivent l'état du joueur. Le DOM
// n'est touché qu'au changement, comme pour les autres bandeaux du HUD ; `force` sert
// au réglage clavier, qui doit se lire immédiatement.
let waterHudState = null;
let assietteVue = null;
function updateWaterHud(force) {
  const etat = player.nage ? (player.sousLEau ? 'sous' : 'surface') : 'hors';
  const assiette = Math.round(player.assiette * 10) / 10;
  if (!force && etat === waterHudState && assiette === assietteVue) return;
  waterHudState = etat;
  assietteVue = assiette;
  if (underwaterEl) underwaterEl.classList.toggle('on', etat === 'sous');
  if (swimHintEl) {
    swimHintEl.classList.toggle('on', etat !== 'hors');
    swimHintEl.textContent = etat === 'hors' ? SWIM_HINT_BASE
      : `${SWIM_HINT_BASE} · assiette ${assiette.toFixed(1)} — + pour s'enfoncer, − pour remonter`;
  }
}

// L'écran de réglage du monde est plein écran et opaque : pendant qu'il est ouvert,
// rien du monde n'est visible derrière lui. On suspend donc tout ce qui se paie par
// image — physique, streaming de tronçons, rendu WebGL — sans arrêter l'horloge :
// `lastTime` continue d'avancer, donc aucune avance de `deltaTime` n'attend le joueur
// à la fermeture (le monde reprendrait sinon un bond d'une demi-seconde).
let reglageOuvert = false;
let framesRendues = 0;
// Les suites jugent le monde sans jamais cliquer « jouer » : elles n'ont pas de souris
// capturée, donc pas d'écran fermé, et devraient voir une page figée. Ce drapeau leur
// rend les images que la pause refuse, sans simuler pour autant la partie réelle.
let imageForcee = false;
let veilleAppliquee = null;

/** Vrai tant que l'écran d'accueil — ou la pause qu'Échap rouvre — couvre la page. */
const ecranPose = () => blocker.style.display !== 'none';

/**
 * L'horloge du fluide. Une vague toutes les `EAU.PAS_MS` millisecondes, jamais plus : le
 * budget de cellules jugées par vague est borné côté automate, et le remaillage des
 * tronçons touchés part dans la file de streaming (`differe`) au lieu d'être payé ici.
 * Deux vagues à la suite sur la même image ne gagneraient rien — la seconde ne juge que
 * des cellules découvertes par la première — et coûtent deux remaillages.
 */
let horlogeEau = 0;
function majEau(deltaTime) {
  if (world.eau.enAttente() === 0) { horlogeEau = 0; return; }
  horlogeEau += deltaTime * 1000;
  if (horlogeEau < EAU.PAS_MS) return;
  horlogeEau = 0;
  world.eau.vague();
}

// Le regard du joueur, lu une fois par image. Il décide de l'ordre dans lequel le monde
// se décharge (`offsetsFor`) et sert aussi au viseur : un seul vecteur partagé plutôt
// qu'une allocation par image.
const directionRegard = new THREE.Vector3(0, 0, -1);

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const brute = now - lastTime;
  const deltaTime = Math.min(brute / 1000, 0.1);
  lastTime = now;
  // Une image à quatre secondes (onglet passé en arrière-plan, réveil sous le voile) n'est
  // pas une mesure : bornée à 250 ms, elle ne peut pas plomber le lissage pour les vingt
  // images qui suivent et priver le monde de mailleur sans raison.
  dureeImageEMA += (Math.min(brute, 250) - dureeImageEMA) * 0.2;

  if (reglageOuvert) return;
  // L'écran d'accueil est opaque : rien du monde n'est visible derrière lui, donc rien
  // ne se dessine, ne se maille, ni n'avance pendant qu'il est posé. Le canevas est masqué
  // en plus — une pleine fenêtre à composer coûte même quand personne ne dessine dedans.
  const enVeille = !imageForcee && ecranPose();
  if (enVeille !== veilleAppliquee) {
    veilleAppliquee = enVeille;
    renderer.domElement.classList.toggle('hors-jeu', enVeille);
  }
  if (enVeille) {
    // Le voile est opaque : rien ne se dessine, aucune physique, aucune horloge. Une seule
    // chose a le droit de continuer — graver des triangles. Elle maille HORS scène, ne touche
    // ni la caméra ni le rendu, et son crédit n'est disputé par aucune image : c'est là qu'il
    // rapporte le plus (mesuré 19,6 tronçons par seconde contre 8,6 pendant qu'on joue).
    // Personne ne le demande plus : tant que le joueur n'est pas dans le monde, l'île se
    // taille. Seule la session peut l'éteindre (`?precuire=ignorer`, les suites qui comptent
    // les passages au mailleur).
    if (!ileEtat.cuisson && budgetGeomOctets() > 0 && GEOM_MODE !== 'ignorer'
        && PRECUIRE_MODE !== 'ignorer' && world.cuissonIleVoulue) {
      // Un four qui n'a pas pu démarrer (`cuissonIle === false`, posé quand la file était
      // vide) ne doit pas rendre le voile muet : on le réarme ici, sinon la barre resterait
      // à zéro sans jamais dire pourquoi. Le désarmement demandé (`precuireIleMaintenant(false)`)
      // passe par `cuissonIleVoulue` et n'est pas remis en cause par cette garde.
      if (!world.cuissonIle && !world.demarrerCuissonIle()) world.cuissonIle = false;
      if (world.cuissonIle) {
        world.cuireIleGeometrie(CUISSON_PRECUISON_MS);
      }
      syncGeomBarre();
    }
    // Le voile posé est le seul moment où la migration d'un vieux cache a le droit de tomber
    // (`publierGeometrie` l'y renvoie). Sans cet appel, elle attendait une pause que personne
    // ne venait vérifier — le cache du joueur restait donc bloqué indéfiniment, et mesuré
    // le 2026-11-17 aucune requête de migration ne partait. Ce qui est déjà payé part ici :
    // aucune image n'est comptée derrière le voile, donc rien n'est volé au rendu.
    verifierPublicationGeom();
    return;
  }
  framesRendues++;

  // FPS counter
  frameCount++;
  fpsTimer += deltaTime;
  if (fpsTimer >= 1) {
    fps = frameCount;
    frameCount = 0;
    fpsTimer = 0;
    updateInfo();
  }

  // Nothing simulates before the saved world is back on screen: physics over
  // ungenerated terrain would drop the player through the void, and streaming the
  // spawn area just to teleport away would burn the frame budget for nothing.
  if (!worldReady) {
    renderer.render(scene, camera);
    return;
  }

  updateSaveHud();   // l'écriture périodique, elle, tourne sur son propre réveil

  // L'heure du monde avance avec les images : la journée se tarit à l'horloge réelle,
  // et le cycle s'arrête avec le reste quand l'écran de réglage est ouvert. La météo
  // compte ses journées sur la même pendule, donc accélérer la journée rapproche aussi
  // les averses — c'est le seul rythme que le joueur règle.
  horloge.avancer(deltaTime);
  meteo.avancer(deltaTime, horloge.duree());
  rafraichirCiel(deltaTime, now / 1000);

  if (controls.isLocked) {
    player.update(deltaTime);
    updateInfo();   // le mode (marche / réacteurs / plané) suit le geste, pas la seconde
    // Ce que le joueur regarde se décharge en premier : au planeur à 34 cubes/s, il
    // traverse son propre champ rendu en moins de quatre secondes.
    directionRegard.set(0, 0, -1).applyQuaternion(camera.quaternion);
    // L'enveloppe du relief reste celle d'avant (10 ms) ; seule la maille suit la marge
    // laissée par l'image. Les confondre affame le terrain quand l'image est lente.
    world.updateChunks(camera.position.x, camera.position.z, Infinity, CHUNK_FRAME_MS,
      directionRegard.x, directionRegard.z, budgetMaillage());
    majEau(deltaTime);

    // The pending cuboid owns the cursor while it lasts; otherwise square off the face
    // under the crosshair — which cube and which of its sides a click would start from.
    if (!updateSelectionVisuals()) {
      const hit = raycastVoxel(camera.position, directionRegard, 8);
      highlight.visible = false;
      if (hit) showFaceMarker(hit);
      else faceMarker.visible = false;
    }
  } else {
    highlight.visible = false;
    faceMarker.visible = false;
    updateSelectionVisuals();
    // Keep filling the world in behind the start screen: a large view depth has to
    // stream in over frames, and the preview is what makes the slider worth having.
    // Même ordre prioritaire qu'en jeu : l'aperçu se remplit dans le sens où regarde la
    // caméra, sinon la vue du réglage se construit à l'opposé de ce qu'elle montre.
    if (world.pendingChunks > 0) {
      directionRegard.set(0, 0, -1).applyQuaternion(camera.quaternion);
      world.updateChunks(camera.position.x, camera.position.z, Infinity, CHUNK_FRAME_MS,
        directionRegard.x, directionRegard.z, budgetMaillage());
    }
  }

  // L'île se taille derrière le joueur : le plan ne se construit qu'une fois et le crédit
  // d'image n'est prêté au mailleur que quand le champ rendu est déjà posé. Ni dans la
  // branche « souris capturée » ni dans celle de l'aperçu — la cuisson regarde le monde,
  // pas la souris, et les sondes de test ne capturent jamais le pointeur.
  //
  // Deux gardes, mesurées le 2026-11-16 : le four ne doit rien demander pendant que les
  // blocs cuisent (il les affamait et le fichier d'île restait à zéro octet), et il suit
  // le joueur — un plan trié depuis la plage ne doit pas s'obstiner à tailler l'autre
  // bout du monde pendant qu'on attend sous les pieds.
  if (world.cuissonIleVoulue && world.cuissonIle === null && !ileEtat.cuisson) {
    if (PRECUIRE_MODE === 'ignorer' || !world.demarrerCuissonIle()) world.cuissonIle = false;
  }
  if (world.cuissonIle && world._centre) {
    const c = world._centre, o = world.cuissonIle.centre;
    if (Math.max(Math.abs(c.pcx - o.pcx), Math.abs(c.pcz - o.pcz)) > c.radius + 8) world.cuissonIle = null;
  }
  if (world.cuissonIle && !ileEtat.cuisson && world.pendingChunks === 0) world.cuireIleGeometrie();

  updateSelectionHud();
  updateWaterHud();
  renderer.render(scene, camera);
}

animate();

// ==================== ÉCRAN DE GÉNÉRATION DU MONDE ====================
// Écran plein écran ouvert depuis l'accueil : la carte à gauche, les curseurs à droite.
// Les curseurs viennent de la fiche (`MONDE_FIELDS`), la carte et les chiffres viennent
// de l'aperçu — même source, donc l'étiquette d'un curseur ne peut pas promettre ce que
// la carte ne montre pas. Rien n'est appliqué à la volée : bouger un curseur redessine
// l'aperçu, mais il faut un clic pour engager un monde, parce qu'une fiche différente
// veut dire un autre relief sous des blocs déjà posés.
const wgEcran = document.getElementById('worldgen-screen');
const wgOuvrir = document.getElementById('worldgen-open');
const wgFermer = document.getElementById('worldgen-close');
const wgResume = document.getElementById('worldgen-resume');
const wgNom = document.getElementById('worldgen-name');
const wgCadre = wgEcran ? wgEcran.querySelector('.wg-cadre') : null;
const wgCarte = document.getElementById('worldgen-map');
const wgChamps = document.getElementById('worldgen-fields');
const wgLecture = document.getElementById('worldgen-readout');
const wgStatut = document.getElementById('worldgen-status');
const wgDefaut = document.getElementById('worldgen-reset');
const wgAppliquer = document.getElementById('worldgen-apply');
const wgNouveau = document.getElementById('worldgen-new');

const ficheEnReglage = Object.assign({}, MONDE);
const champsParCle = new Map();
let armeARegenerer = false;

function memoriserFiche(slot, fiche) {
  try {
    localStorage.setItem(mondeStorageKey(slot), JSON.stringify(clampMonde(fiche)));
    return true;
  } catch (e) {
    console.warn('Fiche du monde non mémorisée :', e);
    return false;
  }
}

function texteValeur(field, valeur) {
  if (field.type === 'checkbox') return valeur ? 'oui' : 'non';
  return `${valeur}${field.unit ? ` ${field.unit}` : ''}`;
}

function syncUnChamp(cle) {
  const vue = champsParCle.get(cle);
  if (!vue) return;
  const { field, entree, valeurVue } = vue;
  if (field.type === 'checkbox') entree.checked = !!ficheEnReglage[cle];
  else entree.value = String(ficheEnReglage[cle]);
  valeurVue.textContent = texteValeur(field, ficheEnReglage[cle]);
}

/** Un curseur sans objet (le rayon hors mode île) se grise plutôt que de disparaître. */
function syncTousLesChamps() {
  for (const [cle, vue] of champsParCle) {
    syncUnChamp(cle);
    const horsService = vue.field.dependsOn && !vue.field.dependsOn(ficheEnReglage);
    vue.entree.disabled = horsService;
    vue.ligne.classList.toggle('hors-service', horsService);
  }
}

function construireChampsDuMonde() {
  if (!wgChamps) return;
  let groupeCourant = null;
  for (const field of MONDE_FIELDS) {
    if (field.group !== groupeCourant) {
      groupeCourant = field.group;
      const titre = document.createElement('div');
      titre.className = 'worldgen-group';
      titre.textContent = groupeCourant.toUpperCase();
      wgChamps.appendChild(titre);
    }
    const ligne = document.createElement('div');
    ligne.className = 'setting-row worldgen-row';
    const label = document.createElement('label');
    label.textContent = field.label;
    label.htmlFor = `worldgen-${field.key}`;
    const entree = document.createElement('input');
    entree.id = `worldgen-${field.key}`;
    entree.dataset.cle = field.key;
    if (field.type === 'checkbox') {
      entree.type = 'checkbox';
    } else {
      entree.type = field.type === 'number' ? 'number' : 'range';
      entree.min = String(field.min);
      entree.max = String(field.max);
      entree.step = String(field.step);
    }
    const valeurVue = document.createElement('output');
    valeurVue.htmlFor = entree.id;
    ligne.append(label, entree, valeurVue);
    if (field.hint) {
      const note = document.createElement('span');
      note.className = 'worldgen-hint';
      note.textContent = field.hint;
      ligne.appendChild(note);
    }
    wgChamps.appendChild(ligne);
    champsParCle.set(field.key, { field, entree, valeurVue, ligne });
    entree.addEventListener('input', () => {
      ficheEnReglage[field.key] = field.type === 'checkbox' ? entree.checked : Number(entree.value);
      syncTousLesChamps();
      repeindreAPartirDeReglage();
    });
  }
  syncTousLesChamps();
}

let minuteurDeCarte = null;
function repeindreAPartirDeReglage(delai = 140) {
  if (!wgCarte) return;
  if (minuteurDeCarte) clearTimeout(minuteurDeCarte);
  // L'échantillonnage coûte une passe de bruit sur toute la carte : on ne le paie
  // qu'une fois le geste du curseur terminé, sinon la page d'accueil ramerait.
  minuteurDeCarte = setTimeout(() => { minuteurDeCarte = null; repeindreCarte(); }, delai);
}

function repeindreCarte() {
  if (!wgCarte) return null;
  const fiche = clampMonde(ficheEnReglage);
  const lu = apercuDuMonde.lire(fiche);
  apercuDuMonde.peindre(wgCarte, fiche);
  if (wgLecture) {
    wgLecture.innerHTML = '';
    for (const ligne of lu.lignes) {
      const item = document.createElement('div');
      item.className = 'worldgen-stat';
      const nom = document.createElement('span');
      nom.textContent = ligne.label;
      const obtenu = document.createElement('b');
      obtenu.textContent = ligne.valeur;
      item.append(nom, obtenu);
      if (ligne.vise) {
        const vise = document.createElement('i');
        vise.textContent = `visé ${ligne.vise}`;
        item.appendChild(vise);
      }
      wgLecture.appendChild(item);
    }
  }
  return lu;
}

function decrireFiche(f) {
  return `${f.ile ? `île de ${f.rayonIle} cubes` : 'continent'} · forêt ${f.foret} %`
    + ` · désert ${f.desert} % · mer ${f.mer} % · grève ${f.largeurPlage} cubes`
    + ` · villes ${f.villesPetites}/${f.villesMoyennes}/${f.villesGrandes}`
    + ` · graine ${f.graine}`;
}

/**
 * La carte est un échantillon de 216 × 216 colonnes qu'on agrandit en cubes nets : ce
 * qui coûte, c'est le nombre de colonnes jugées (une passe de bruit par pixel), pas sa
 * taille à l'écran. On se contente donc de donner au canevas le plus grand carré tenant
 * dans son cadre.
 */
function dimensionnerCarte() {
  if (!wgCarte || !wgCadre) return;
  const cote = Math.max(180, Math.floor(Math.min(wgCadre.clientWidth, wgCadre.clientHeight)));
  wgCarte.style.width = `${cote}px`;
  wgCarte.style.height = `${cote}px`;
}

/** L'accueil garde la trace de la fiche : celle du monde en jeu, et les réglages en attente. */
function majResumeDuMonde() {
  if (!wgResume) return;
  const enJeu = `Génération du monde en jeu : ${decrireFiche(MONDE)}`;
  wgResume.textContent = memesMondes(ficheEnReglage, MONDE)
    ? enJeu
    : `${enJeu} — réglages non appliqués : ${decrireFiche(ficheEnReglage)}`;
}

function ouvrirReglageDuMonde() {
  if (!wgEcran || !wgEcran.hidden) return;
  // Avant tout le reste : coupe le rendu dès l'image suivante.
  reglageOuvert = true;
  wgEcran.hidden = false;
  // Une touche restée enfoncée avant l'ouverture ferait marcher le joueur à la fermeture.
  for (const k in keys) keys[k] = false;
  syncTousLesChamps();
  dimensionnerCarte();
  repeindreCarte();
  if (wgStatut) wgStatut.textContent = `Réglages actuels : ${decrireFiche(ficheEnReglage)}`;
  majResumeDuMonde();
  if (wgFermer) wgFermer.focus();
}

function fermerReglageDuMonde() {
  if (!wgEcran || wgEcran.hidden) return;
  wgEcran.hidden = true;
  reglageOuvert = false;
  majResumeDuMonde();
}

if (wgEcran) {
  construireChampsDuMonde();
  majResumeDuMonde();
  if (wgOuvrir) wgOuvrir.addEventListener('click', ouvrirReglageDuMonde);
  if (wgFermer) wgFermer.addEventListener('click', fermerReglageDuMonde);
  window.addEventListener('resize', () => { if (reglageOuvert) dimensionnerCarte(); });

  if (wgDefaut) {
    wgDefaut.addEventListener('click', () => {
      Object.assign(ficheEnReglage, MONDE_DEFAULTS);
      syncTousLesChamps();
      repeindreAPartirDeReglage(0);
      if (wgStatut) wgStatut.textContent = 'Valeurs par défaut rétablies — celles du monde d\'aujourd\'hui.';
    });
  }

  // Régénérer efface les blocs posés par le joueur : c'est irréversible, donc le
  // second clic doit porter l'intention, comme pour la suppression d'un monde.
  if (wgAppliquer) {
    wgAppliquer.addEventListener('click', async () => {
      if (!armeARegenerer) {
        armeARegenerer = true;
        wgAppliquer.classList.add('confirm');
        wgAppliquer.textContent = 'Confirmer ? le monde sera refait';
        if (wgStatut) wgStatut.textContent = 'Ce bouton défait la sauvegarde de ce monde : recliquez pour régénérer.';
        setTimeout(() => {
          if (!armeARegenerer) return;
          armeARegenerer = false;
          wgAppliquer.classList.remove('confirm');
          wgAppliquer.textContent = 'Régénérer ce monde';
        }, 6000);
        return;
      }
      armeARegenerer = false;
      wgAppliquer.classList.remove('confirm');
      wgAppliquer.textContent = 'Régénérer ce monde';
      memoriserFiche(saveStore.slot, ficheEnReglage);
      regenerEnCours = true;
      await resetActiveWorld();
      // Le fichier porte encore l'ancienne fiche — et c'est LUI qui a raison au démarrage
      // suivant (garde de cohérence avec les blocs posés). Sans cette écriture, le
      // rechargement qui suit annulerait le réglage et le monde reviendrait tel qu'avant.
      try {
        await saveStore.save(encodeSave({
          seed: mondeSeeds(ficheEnReglage.graine), name: worldName,
          player: player.saveState(), edits: new Map(), monde: ficheEnReglage,
          flux: new Map(),
        }));
      } catch (e) {
        console.warn('Fiche non écrite dans la sauvegarde :', e);
      }
      window.location.reload();
    });
  }

  if (wgNouveau) {
    wgNouveau.addEventListener('click', async () => {
      // Le nom se saisit ici : celui de l'accueil est derrière cet écran, donc hors de
      // portée — on ne lui demande rien tant qu'on règle le monde. Vide, c'est la date.
      const saisi = cleanWorldName((wgNom && wgNom.value) || (worldNameInput ? worldNameInput.value : ''));
      const nom = saisi || `Monde du ${new Date().toLocaleDateString('fr-FR')}`;
      await refreshWorldList();
      const slot = nextSlotName(nom);
      memoriserFiche(slot, ficheEnReglage);
      await flushWorldSave({ force: true });
      const url = new URL(window.location.href);
      url.searchParams.set('world', slot);
      url.searchParams.set('name', nom);
      window.location.assign(url.toString());
    });
  }
}

// Headless test hook: drives physics/input without needing pointer lock.
window.__mc = {
  THREE,
  scene,
  camera,
  renderer,
  world,
  player,
  // Le contrôleur aérien se juge sur ses nombres à lui : une suite qui recopie ces
  // chiffres dérive dès qu'on les règle.
  GRAVITY, JUMP_SPEED, MOVE_SPEED, JET_SPEED,
  PLANE_MIN, PLANE_DEFAUT, PLANE_MAX, PLANE_THRUST, PLANE_LIFT_SPEED, PLANE_SINK_MAX,
  // Les nombres du champ de lumière : une suite qui recopie ces seuils dérive au
  // premier réglage, et ils décident de ce qu'on appelle encore « noir ».
  PLANCHER_NUIT, PLANCHER_PIECE, COUVERTE_MINCE, LAMPE_PORTEE, PORTEE_CIEL,
  // La ligne du HUD qui dit ce que fait le joueur, lisible sans attendre l'horloge FPS.
  modeDuJoueur: () => modeJoueur(),
  hotbar,
  inventory,
  controls,
  atlas,
  BLOCK,
  BLOCK_INFO,
  BLOCK_GROUPS,
  ALL_BLOCKS,
  HOTBAR_SIZE,
  settings,
  setRenderDistance,
  MIN_RENDER_DISTANCE,
  MAX_RENDER_DISTANCE,
  DEFAULT_RENDER_DISTANCE,
  CHUNK_STREAM_BUDGET,
  CHUNK_FRAME_MS,
  // ---- netteté et cadence ----
  // Ce que jugent les suites : le canevas réellement alloué (pas l'intention du réglage),
  // et la part d'image que le bucle prête au mailleur image par image.
  NETTETES,
  reglerNetrete: (valeur) => reglerNetrete(valeur),
  netrete: () => ({
    reglage: settings.netrete,
    ratio: renderer.getPixelRatio(),
    tampon: [renderer.domElement.width, renderer.domElement.height],
    fenetre: [window.innerWidth, window.innerHeight],
    devicePixelRatio: window.devicePixelRatio,
  }),
  budgetMaillage: () => ({
    ms: +budgetMaillage().toFixed(2),
    ema: +dureeImageEMA.toFixed(1),
    cible: CIBLE_IMAGE_MS,
    min: BUDGET_MAILLE_MIN_MS,
    max: BUDGET_MAILLE_MAX_MS,
    fixe: CHUNK_FRAME_MS,
  }),
  /** Pose le lissage du temps d'image : sans ce levier, rien ne prouve que le budget suit l'image. */
  reglerDureeImage: (ms) => {
    dureeImageEMA = Number.isFinite(ms) ? Math.max(0, ms) : CIBLE_IMAGE_MS;
    return dureeImageEMA;
  },
  MARGE_CHAMP_RENDU,
  WORLD_BOOT_BUDGET,
  SETTINGS_STORAGE_KEY,
  keys,
  raycastVoxel,
  highlight,
  faceMarker,
  getTerrainHeight,
  SEA_LEVEL,
  findDrySpawn,
  waterTopAt: (x, z) => terrain.waterTopAt(x, z),
  riverAt: (x, z) => terrain.riverAt(x, z),
  CHUNK_SIZE,
  press(code, down = true) { keys[code] = down; },
  releaseAll() { for (const k of Object.keys(keys)) keys[k] = false; },
  // Drives the real window listeners (E, Escape, digits) instead of poking state.
  keyDown(code) { window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true })); },
  keyUp(code) { window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })); },
  look(yawDeg, pitchDeg) {
    camera.rotation.order = 'YXZ';
    camera.rotation.set(THREE.MathUtils.degToRad(pitchDeg ?? 0), THREE.MathUtils.degToRad(yawDeg ?? 0), 0, 'YXZ');
  },
  step(dt = 1 / 60) {
    player.update(dt);
    world.updateChunks(camera.position.x, camera.position.z);
  },
  // Drains the streaming queue synchronously; lets a test assert on a settled world.
  // The first pass must happen unconditionally: right after a teleport `pendingChunks`
  // still carries the old position's count (often zero), and a `while` on it would
  // return without generating anything at the new spot — a silently empty world.
  streamAll() {
    let guard = 0;
    do {
      world.updateChunks(camera.position.x, camera.position.z, 64);
    } while (world.pendingChunks > 0 && guard++ < 500);
    return world.pendingChunks;
  },
  // Génère les données des tronçons d'une fenêtre sans déplacer le centre du flot. Une
  // suite qui juge des colonnes fixes loin du joueur en a besoin : `streamAll` ne charge
  // que autour de la caméra — et le monde s'ouvre aujourd'hui dans un temple, parfois à
  // deux cents cubes de l'apparition historique.
  chargerRegion(x0, z0, x1, z1) {
    let faits = 0;
    for (let cx = Math.floor(x0 / CHUNK_SIZE); cx <= Math.floor(x1 / CHUNK_SIZE); cx++) {
      for (let cz = Math.floor(z0 / CHUNK_SIZE); cz <= Math.floor(z1 / CHUNK_SIZE); cz++) {
        if (world.generateChunkData(cx, cz)) faits++;
      }
    }
    return faits;
  },
  // ---- budget mémoire des mailleurs ----
  // Ce que jugent les suites de rétention : la note courante de tampons, le quota admis,
  // et de quoi l'imposer pour éprouver l'éviction sans saturer un poste de test.
  memoire: () => {
    let reserves = 0, troncons = 0, meshesDessines = 0;
    for (const c of world.chunks.values()) {
      troncons++;
      if (c.horsVue) reserves++;
      else meshesDessines += c.meshes.length;
    }
    return {
      octetsMailles: world.octetsMailles,
      quota: world._rafraichirQuota(performance.now()),
      troncons,
      reserves,
      meshesDessines,
      exposeParLeNavigateur: !!(typeof performance !== 'undefined' && performance.memory
        && Number.isFinite(performance.memory.jsHeapSizeLimit)),
    };
  },
  reglerQuotaGeometrie(octets) {
    world.quotaForce = Number.isFinite(octets) && octets > 0 ? Math.floor(octets) : null;
    return world.quotaForce;
  },
  // La frontière telle que le jeu la juge : une suite qui rejoue la formule de la brume
  // de son côté mesurerait un autre disque que celui que le rangeur applique.
  montreACamera: (cx, cz) => world._montreACamera(cx, cz),
  porteeBrume: () => ({ near: brumeSere.near, far: brumeSere.far, x: world._camX, z: world._camZ }),
  // ---- géométrie prête pour la carte ----
  // Ce que jugent les suites : un tronçon reposé depuis le disque ne doit rien au
  // mailleur, et un bloc touché par le joueur ne doit jamais revenir du fichier.
  geomMode: GEOM_MODE,
  geomEtat: () => ({
    motif: geomEtat.motif,
    octets: geomEtat.octets,
    publies: geomEtat.publies,
    enFile: world.geomEnAttente.size,
    aCuire: world.geomACuire.size,
    aChauffer: world._fileChauffe.size,
    enCours: geomEtat.enCours,
    etape: geomEtat.etape,
    etapeDepuis: geomEtat.enCours ? Math.round(performance.now() - geomEtat.depuis) : 0,
    budgetMo: dimensionnerBudgetGeom(),
    budgetCalcule: geomBudget.source,
    // Les règles du calcul, exposées pour qu'une suite juge la dépendance à la mémoire au
    // lieu de rejouer des chiffres magic.
    reglesBudget: {
      fraction: GEOM_BUDGET_FRACTION, plancherMo: GEOM_BUDGET_PLANCHER_MO,
      plafondMo: GEOM_BUDGET_PLAFOND_MO, defautMo: GEOM_BUDGET_DEFAUT_MO,
    },
    stats: world.cacheGeom ? world.cacheGeom.stats() : null,
    version: MAILLE_VERSION,
    cuisson: world.etatCuissonIle(),
  }),
  /** Le mailleur a-t-il été appelé depuis le dernier appel ? (le cache doit répondre zéro) */
  rebuildsDepuis() {
    const n = world._rebuilds;
    const d = world._rebuildsDepuisDisque;
    world._rebuilds = 0;
    world._rebuildsDepuisDisque = 0;
    return { mailles: n, depuisDisque: d };
  },
  geomPret: (cx, cz) => !!(world.cacheGeom && world.cacheGeom.pret(cx, cz)),
  publierGeometrie: () => publierGeometrie(),
  chargerCacheGeom: () => chargerCacheGeom(),
  jeterGeometrie: () => jeterGeometrie(),
  reglerBudgetGeom: (mo) => reglerBudgetGeom(mo),
  /** Cuisson de fond forcée, hors cadence d'image : ce jugent les suites. */
  cuireGeometrieFond: (maxMs = 1000) => {
    if (world.cuissonIle === null) world.demarrerCuissonIle();   // la sonde n'attend pas l'image
    return world.cuireIleGeometrie(maxMs);
  },
  // ---- cache d'île ----
  // Ce que jugent les suites de chargement : l'état de la barre, ce que le cache sait
  // déjà, et de quoi vider ou relancer une cuisson sans passer par la souris.
  ileMode: ILE_MODE,
  ileEtat: () => ({
    phase: ileEtat.phase,
    motif: ileEtat.motif,
    faits: ileEtat.faits,
    total: ileEtat.total,
    octets: ileEtat.octets,
    attendus: ileEtat.attendus,
    complet: ileEtat.complet,
    laisseLibre: ileEtat.laisseLibre,
    cache: !!ileEtat.cache,
    cuisson: !!ileEtat.cuisson,
    stats: ileEtat.cache ? ileEtat.cache.stats() : null,
  }),
  ileBarre: () => (ileEl && !ileEl.hidden
    ? { pleine: ilePleinEl.style.width, texte: ileTexteEl.textContent }
    : null),
  // La barre des triangles, jugée comme celle de l'île : ce que le joueur lit, pas ce que
  // l'état interne promet. Et le bouton, pilotable pour les suites qui ne savent pas cliquer.
  geomBarre: () => (geomBlocEl && !geomBlocEl.hidden
    ? {
        pleine: geomRemplissageEl.style.width, texte: geomTexteEl.textContent,
        aria: geomBarreEl?.getAttribute('aria-valuenow') ?? null, prets: tronconsPrets(),
      }
    : null),
  // Levier de suite : armer ou désarmer le four de fond. Le joueur n'a plus de prise ici —
  // la pré-cuisson est automatique, c'est la session qui l'éteint (`?precuire=ignorer`) —
  // mais une suite qui compte des mailleurs doit pouvoir le faire sans recharger la page.
  precuireIleMaintenant: (vrai = true) => {
    world.cuissonIleVoulue = !!vrai;
    world.cuissonIle = vrai ? null : false;
    if (vrai && !world.demarrerCuissonIle()) world.cuissonIle = false;
    syncGeomControl();
    return !!world.cuissonIle;
  },
  ileCuire: () => cuireIle(),
  ileRelire: () => chargerCacheIle(),
  ileRechauffer: (x, z, rayon) => rechaufferAutour(x, z, rayon),
  async ileEffacer() {
    ileEtat.cache = null;
    world.cacheIle = null;
    try { await saveStore.clearIsland(saveStore.slot); } catch (e) { /* rien à effacer */ }
    return true;
  },
  feetY() { return player.feetY; },
  respawn: () => player.respawn(),
  settle: () => player.settle(),
  // Drives the two-stage cuboid flow exactly the way the mouse buttons do.
  clickCreate: () => clickSelection('create'),
  clickDelete: () => clickSelection('delete'),
  selectionPreview,
  wheelSelection: (notches = 1) => adjustSelectionDepth(notches),
  cancelSelection: () => cancelSelection(),
  selectionBounds: () => (selection.active ? selectionBounds() : null),
  selectionState: () => ({
    active: selection.active,
    mode: selection.mode,
    depth: selection.depth,
    status: selection.status,
    anchor: selection.anchor ? { ...selection.anchor } : null,
  }),
  MAX_SELECTION_DEPTH,
  MAX_SELECTION_CELLS,
  setBlock: (x, y, z, id) => world.setBlock(x, y, z, id),
  // ---- eau qui coule ----
  // Les suites jugent la propagation sans dépendre du temps réel : `eauVagues` fait avancer
  // l'automate d'un coup, et `eauNiveau` répond la distance enregistrée (null = source).
  eauParams: EAU,
  eauNiveau: (x, y, z) => world.eauNiveaux.get(`${x},${y},${z}`) ?? null,
  eauNageable: (x, y, z) => world.estNageable(x, y, z),
  eauEnAttente: () => world.eau.enAttente(),
  eauReveiller: (x, y, z) => world.eau.reveiller(x, y, z),
  eauVagues: (n = 1) => {
    let evaluees = 0;
    let modifiees = 0;
    for (let i = 0; i < n; i++) {
      const r = world.eau.vague();
      evaluees += r.evaluees;
      modifiees += r.modifiees;
      if (r.enAttente === 0) break;
    }
    return { evaluees, modifiees, enAttente: world.eau.enAttente() };
  },
  /** Toutes les cellules d'eau de passage du monde : `[x, y, z, distance]`. */
  eauCellules: () => {
    const out = [];
    for (const [cle, niv] of world.eauNiveaux) {
      const [x, y, z] = cle.split(',').map(Number);
      out.push([x, y, z, niv]);
    }
    return out;
  },
  // ---- persistence hooks ----
  saveStore,
  SAVE_SLOT,
  WORLD_SEEDS,
  // Où un monde neuf fait apparaître son joueur (null : repli au sec). Les suites jugent
  // le réveil dans le temple sans recalculer la recherche des mailles.
  pointApparition: () => resoudreApparition(),
  mondeVierge: () => mondeVierge,
  // ---- fiche de génération du monde ----
  // La fiche en jeu, ses défauts, la table des curseurs et les seuils que l'étalonnage
  // en a tirés : les suites vérifient l'écran sans dupliquer ces chiffres.
  monde: MONDE,
  MONDE_DEFAULTS,
  MONDE_FIELDS,
  MONDE_SEUILS,
  mondeSeeds,
  clampMonde,
  memesMondes,
  mondeStorageKey,
  apercuDuMonde,
  memoriserFiche,
  ficheReglee: () => Object.assign({}, ficheEnReglage),
  // Règle la fiche de l'écran et repeint la carte — sans recharger, pour qu'un test
  // puisse lire l'aperçu avant d'engager le monde.
  reglerFiche(partiel) {
    Object.assign(ficheEnReglage, clampMonde(Object.assign({}, ficheEnReglage, partiel || {})));
    syncTousLesChamps();
    majResumeDuMonde();
    return repeindreCarte();
  },
  carteDuMonde: () => wgCarte,
  // L'écran lui-même : les suites l'ouvrent sans clic et jugent que le rendu 3D est
  // bien à l'arrêt pendant qu'il occupe la fenêtre (`framesRendues` ne doit plus avancer).
  ouvrirReglage: () => ouvrirReglageDuMonde(),
  fermerReglage: () => fermerReglageDuMonde(),
  reglageOuvert: () => reglageOuvert,
  framesRendues: () => framesRendues,
  // L'écran d'accueil (et la pause d'Échap) endort le bucle : rien ne se dessine ni
  // n'avance tant qu'il est posé. Une suite qui juge le monde sans jamais cliquer
  // « jouer » réveille le bucle avec `image(true)` et le rendort pour vérifier la veille.
  image: (vrai = true) => { imageForcee = !!vrai; return imageForcee; },
  ecranPose: () => ecranPose(),
  horsJeu: () => renderer.domElement.classList.contains('hors-jeu'),
  AUTOSAVE_INTERVAL_MS,
  worldReady: () => worldReady,
  flushSave: () => flushWorldSave({ force: true }),
  savePending: () => saveDirty || writingSave || needsWorldSave(),
  editCount: () => world.modifiedBlocks.size,
  resetWorld: () => resetActiveWorld(),
  deleteWorld: (slot) => deleteWorld(slot),
  listWorlds: () => saveStore.list(),
  openWorld: (slot) => openWorld(slot),
  worldName: () => worldName,
  renameWorld: (name) => renameWorld(name),
  // Les plans des bâtiments d'un tronçon (maisons, tours, escaliers) tels que la
  // génération les a calculés — sert aux suites qui vérifient la praticité dans le
  // monde chargé. Un tronçon peut en porter jusqu'à quatre.
  villageAt: (wx, wz) => village.buildingAt(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)),
  // Ponts et arcs d'un tronçon (tabliers, piles, arcs de triomphe) tels que la
  // génération les a calculés — même principe que `villageAt` pour les bâtiments.
  structuresAt: (wx, wz) => village.structuresAt(Math.floor(wx / CHUNK_SIZE), Math.floor(wz / CHUNK_SIZE)),
  // Échelles de la voirie et des ouvrages (espacement des avenues, garde-tête…) pour
  // que les suites recalculent les coordonnées sans les dupliquer.
  villageParams: village.VILLAGE,
  roadKind: (wx, wz) => village.roadKind(wx, wz),
  // Profil de la chaussée : le relief ramené à un cube par colonne, tel que l'escalier
  // de rue est estampé. `roadSurface` donne le niveau posé sur une cellule (max des
  // avenues qui la couvrent, null hors voirie) ; `surfaceAt` répond « sur quoi marche le
  // joueur » en tout point du monde.
  streetLevel: (axis, k, along) => village.streetLevel(axis, k, along),
  roadSurface: (wx, wz, avecOuvrages = true) => village.roadSurface(wx, wz, avecOuvrages),
  surfaceAt: (wx, wz) => village.surfaceAt(wx, wz),
  cityInfluence: (wx, wz) => village.cityInfluence(wx, wz),
  // Zone climatique d'une cellule (`foret`, `plaine`, `desert`), plan de l'arbre qui y
  // prend racine (null sinon) et échelles du module : les suites vérifient la
  // praticabilité de la forêt sans en dupliquer les constantes.
  biomeAt: (wx, wz) => biomes.biomeAt(wx, wz),
  treeAt: (wx, wz) => biomes.treeAt(wx, wz),
  biomeParams: biomes.BIOMES,
  // Cellule tenue par la voirie ou l'emprise d'un bâtiment — ce sur quoi rien ne pousse.
  cellOccupied: (wx, wz) => village.isOccupied(wx, wz),
  // …et tenue en outre par la cour de deux cubes qui ceinture chaque bâtiment : la
  // bande où aucun arbre ne doit pousser, pour qu'on puisse en faire le tour.
  cellGenante: (wx, wz) => village.blocksVegetation(wx, wz),
  // Plan du temple de la maille (i,j) et temples recoupant une fenêtre : les suites
  // vérifient le monument dans le monde chargé sans en dupliquer les constantes.
  templeAt: (i, j) => village.templeAt(i, j),
  templesSur: (x0, z0, x1, z1) => village.templesSur(x0, z0, x1, z1),
  // --- cycle du jour et lanternes ---
  // L'état du ciel tel qu'il est rendu. `reglerHeure` le fige : une suite qui veut
  // juger la nuit ne peut pas attendre huit minutes, et un contrôle qui dépend de
  // l'heure réelle serait vert un matin et rouge un soir.
  ciel: () => ({ ...etatCiel, lanterneVivet }),
  // La couche de nuages telle qu'elle est rendue. Une suite juge qu'ils ne sont pas des
  // cubes (géométrie), qu'ils tiennent au monde quand le joueur marche (le décalage d'UV
  // compense exactement sa course) et qu'ils s'éteignent avec le jour.
  nuages: () => {
    // Le vent et l'épaisseur du jour sont lus une fois pour les deux couches : ils sortent
    // du même état météo que celui que la scène vient d'appliquer.
    const m = meteoCourante();
    return nappes.map((n) => ({
      nom: n.userData.nom,
      altitude: n.userData.altitude,
      tuile: n.userData.tuile,
      vitesse: n.userData.vitesse,
      // La dérive réellement appliquée cette image (tuiles par seconde), base × vent : c'est
      // elle que juge une suite qui veut prouver que le ciel bouge, et non la constante de
      // fabrication — une nappe à la bonne constante mais dont le vent ne monte jamais à
      // rien resterait peinte immobile.
      derive: +(n.userData.deriveCourante ?? n.userData.vitesse).toFixed(5),
      vent: m.vent,
      couche: m.couche,
      cap: m.ventDirection,
      visible: n.visible,
      geometrie: n.geometry.type,
      opacite: +n.material.uniforms.uOpacite.value.toFixed(4),
      couleur: '#' + n.material.uniforms.uCouleur.value.getHexString(),
      repeat: +n.material.uniforms.uTuile.value.x.toFixed(4),
      // Le dessin réellement posé sur cette couche, et la texture qui le porte : deux
      // nappes portant le même `carte` seraient le même nuage peint deux fois.
      forme: n.userData.forme || null,
      carte: n.material.uniforms.uCarte.value?.uuid || null,
      offsetU: n.material.uniforms.uDecalage.value.x,
      offsetV: n.material.uniforms.uDecalage.value.y,
      // L'ancrage régional tel qu'il est appliqué (identique pour les deux couches) : une
      // suite juge qu'il ne tressaute pas quand le joueur marche sur un gradin.
      solAncre: +(solNappe ?? 0).toFixed(3),
      camX: camera.position.x,
      camZ: camera.position.z,
    }));
  },
  // `delta` et `maintenant` se figent pour qu'une suite puisse dérouler la marche du
  // joueur image par image plutôt que de voir l'amortissement sauter comme à la
  // télécommande (sans quoi le contrôle jugerait un ciel instantané, pas celui du jeu).
  reglerHeure: (h, delta = 10, maintenant = performance.now() / 1000) => {
    horloge.regler(h);
    return rafraichirCiel(delta, maintenant);   // forcée : la valeur doit se lire tout de suite
  },
  // --- pluie ---
  // L'état de la météo et ce que le rideau rend réellement. Une suite ne peut pas
  // attendre vingt minutes d'horloge pour juger une averse : `reglerPluie` la fige et
  // force `majCiel`, exactement comme `reglerHeure` le fait pour l'heure.
  pluie: () => {
    const brut = meteo.etat();
    const m = meteoCourante();
    return {
      ...m,
      // `intensite` est celle que la scène rend — avec une reprise en main de test, ce
      // n'est pas celle de l'automate ; elle reste lisible sous `automate`.
      automate: brut.intensite,
      force: pluieForcee,
      rendu: (() => {
        // La couche proche porte les gros plans jugés par les suites ; `points` et `peints`
        // comptent les deux rideaux, sinon « toutes les gouttes sont dessinées » ne voudrait
        // plus rien dire depuis que le volume a une deuxième couche.
        const u = rideauPluie.material.uniforms;
        let points = 0, allumes = 0;
        for (const r of rideauxPluie) {
          points += r.geometry.attributes.position.count;
          if (r.visible) allumes++;
        }
        return {
          visible: allumes > 0,
          rideaux: allumes,
          points,
          peints: renderer.info.render.points || 0,
          densite: +u.uDensite.value.toFixed(3),
          opacite: +u.uOpacite.value.toFixed(3),
          couleur: '#' + u.uCouleur.value.getHexString(),
          // L'inclinaison réellement peinte cette image : juger qu'un vent couche bien les
          // gouttes se fait sur l'uniforme consommé par le fragment shader, pas sur le cap.
          pente: +u.uPente.value.toFixed(3),
          vent: [+u.uVent.value.x.toFixed(2), +u.uVent.value.y.toFixed(2)],
          houle: +u.uHoule.value.toFixed(2),
          portee: +u.uPortee.value.toFixed(1),
          boites: rideauxPluie.map((r) => [
            r.material.uniforms.uBoite.value.x, r.material.uniforms.uBoite.value.y,
            r.material.uniforms.uBoite.value.z,
          ]),
          // Ce que le relevé de pièce a décidé : la suite juge avec ces chiffres ce qui doit
          // rester au sec, sans rejouer les rayons dans son coin.
          piece: {
            close: chambre.close,
            rayon: +chambre.rayon.toFixed(2),
            plafond: +chambre.plafond.toFixed(2),
            clip: u.uDedans.value,
          },
          // Les enveloppes réellement poussées au shader image après image : la suite rejoue
          // le retrait des gouttes avec ces boîtes-là, jamais avec une liste reconstituée
          // dans son coin — c'est la différence entre juger le jeu et juger son propre code.
          enveloppes: Array.from({ length: enveloppeN }, (_, i) => [
            +enveloppesA[i].x.toFixed(2), +enveloppesA[i].y.toFixed(2), +enveloppesA[i].z.toFixed(2),
            +enveloppesB[i].x.toFixed(2), +enveloppesB[i].y.toFixed(2), +enveloppesB[i].z.toFixed(2),
          ]),
          brume: [+scene.fog.near.toFixed(1), +scene.fog.far.toFixed(1)],
          // Même arrondi que `brume` : la suite compare les deux et jugerait une différence
          // de lecture là où il n'y a qu'une différence de virgule flottante.
          brumeSere: [+brumeSere.near.toFixed(1), +brumeSere.far.toFixed(1)],
        };
      })(),
    };
  },
  reglerPluie: (v, delta = 10, maintenant = performance.now() / 1000) => {
    pluieForcee = v == null ? null : Math.min(1, Math.max(0, Number(v) || 0));
    return rafraichirCiel(delta, maintenant).pluie || 0;
  },
  /** Fige le vent (suites) : `null` rend la main au monde. */
  reglerVent: (v, delta = 1 / 60, maintenant = performance.now() / 1000) => {
    ventForce = v == null ? null : Math.min(1, Math.max(0, Number(v) || 0));
    rafraichirCiel(delta, maintenant);
    return meteoCourante().vent;
  },
  /** Téléporte la pendule météo à `journees` journées depuis l'ouverture (suites). */
  reglerMeteoTemps: (journees, delta = 1 / 60, maintenant = performance.now() / 1000) => {
    meteo.reglerTemps(Number(journees) || 0);
    rafraichirCiel(delta, maintenant);
    return meteoCourante();
  },
  /** Fait défiler la pendule météo de `journees` journées (suites). */
  avancerMeteo: (journees, delta = 1 / 60, maintenant = performance.now() / 1000) => {
    meteo.reglerTemps(meteo.etat().journee + (Number(journees) || 0));
    rafraichirCiel(delta, maintenant);
    return meteo.etat();
  },
  reglerMeteo: (m) => setMeteoMode(m),
  horloge: () => horloge,
  dureeJour: () => settings.dureeJour,
  reglerDureeJour: (v) => setDayLength(v),
  // Candélabres du village dans une région, et lanternes réellement retenues pour le
  // halo d'un tronçon — la seconde réponse exclut donc celles que le joueur a arrachées.
  lampadairesSur: (x0, z0, x1, z1) => village.lampadairesSur(x0, z0, x1, z1),
  lampesInterieuresSur: (x0, z0, x1, z1) => village.lampesInterieuresSur(x0, z0, x1, z1),
  appliquesMuralesSur: (x0, z0, x1, z1) => village.appliquesMuralesSur(x0, z0, x1, z1),
  couloirsSur: (x0, z0, x1, z1) => village.couloirsSur(x0, z0, x1, z1),
  piecesDImmeubleSur: (x0, z0, x1, z1) => village.piecesDImmeubleSur(x0, z0, x1, z1),
  piecesDeMaisonSur: (x0, z0, x1, z1) => village.piecesDeMaisonSur(x0, z0, x1, z1),
  enveloppesSur: (x0, z0, x1, z1) => village.enveloppesSur(x0, z0, x1, z1),
  lampesDuTroncon: (cx, cz) => world.lampesAutour(cx, cz),
  bloc: (x, y, z) => world.getBlock(x, y, z),
  // Le prédicat du culling : ce qui cache vraiment ce qu'il y a derrière (une vitre ne cache rien).
  blocOpaque: (id) => !!BLOCK_INFO[id]?.opaque,
  playerState: () => player.saveState(),
};

# MyCraft — catalogue des fonctionnalités

*Un monde voxel complet, tenu sans moteur de jeu : le terrain, le village, la météo et le rendu sont écrits à la main sur Three.js, servis par un serveur web et empaquetés en application de bureau.*

---

## 1. Le monde : génération procédurale tenue par une seule graine

Le monde n'est pas un fichier d'assets, c'est un calcul. Une seule graine en tire quatre — relief, végétation, bâti, grottes — et deux mondes portant la même graine sont identiques cube pour cube. Rien n'est laissé au hasard de l'exécution : le monde ne s'enregistre que comme le diff du joueur, donc le rejouer revient à le recalculer à l'identique.

Ce que la génération produit :

- **Un relief à sillons**, modelé par un bruit replié, avec des massifs courants et une chaîne qui domine le pays.
- **Des montagnes enneigées gravissables** : la neige apparaît à l'altitude voulue et la pente reste franchissable à pied, étage par étage.
- **Une forêt traversable** : les arbres sont posés en deux passes sur les points hauts, avec une garde-tête qui garantit qu'on peut marcher dessous.
- **Des biomes climatiques** — forêt, désert, plaine — réglés par des seuils sur un champ d'humidité et de sécheresse.
- **Des océans et des rivières intégrées** : une seule ligne de flottaison pour tout le monde, et les rivières sont tracées comme des lignes d'écoulement jusqu'à la mer, jamais comme un filtre ponctuel.
- **Des mines** : charbon, fer, or, diamant distribués sous terre par la graine des grottes.

### L'écran « Génération du monde »

Un panneau permet de régler le monde avant de le créer, avec une carte vue de dessus qui se redessine à chaque curseur :

- **Répartition des superficies** : forêt, désert, mer intérieure, largeur de la plage.
- **Relief et bâti** : hauteur des montagnes, nombre d'étages maximal des immeubles, densité des villes et des villages.
- **Types de ville** : petites, moyennes, grandes — trois poids relatifs, pas trois pourcentages à sommer à cent.
- **Île** : monde en île ou continent, rayon de l'île, largeur de la côte, profondeur du large.
- **Graine** libre, de 1 à 999 999.

Deux garanties tiennent le panneau honnête :

1. **À ses valeurs par défaut il ne corrige rien.** Un monde créé sans toucher à aucun curseur tombe cube pour cube sur le monde d'hier.
2. **Les pourcentages sont étalonnés, pas affichés.** Une part demandée (« 44 % de forêt ») est convertie par bissection en seuil sur le champ de bruit réel, échantillonné une fois par graine. L'étiquette du curseur et la carte dessinée sortent du même calcul, donc le chiffre promis est le monde obtenu.

La fiche du monde voyage avec la sauvegarde : rouvrir un monde, c'est retrouver exactement ses réglages.

---

## 2. L'île paramétrable

Le mode île est le réglage par défaut : la terre s'arrête et l'océan commence, avec de l'eau à perte de vue au large. Le rayon (jusqu'à 3 000 cubes, 1 600 par défaut, soit environ huit minutes de marche depuis l'apparition), la longueur du talus côtier et la profondeur du large sont tous réglables — et la plage suit le niveau de la mer quand il monte, au lieu de disparaître sous les vagues.

---

## 3. Le village : une ville qui se lit comme une ville

Le bâti n'est pas un placement d'objets isolés, c'est une trame urbaine générée par mailles, avec un gradient de densité et plusieurs bâtiments par tronçon.

- **Trois types de ville**, chacun portant son rayon de quartier, son plafond d'étages et sa fréquence de blocs d'immeubles : bourg serré (96 cubes, six étages), ville moyenne (160 cubes, douze étages), métropole (250 cubes, dix-huit étages, un tronçon de centre-bourg sur cinq bâti en bloc débordant).
- **Des immeubles en appartements**, par catégories de 3, 6, 10 et 14 étages, avec couloir muralé, pièces de quatre cubes libres et cage d'escalier au fond ou au bout. La hauteur est bornée par l'escalier lui-même, pas seulement par le tirage.
- **Des maisons** avec cour de deux cubes tout autour — un passage partagé, pas un jardin privé.
- **Des temples**, quatre fois une maison, en pierre grise vitrée avec faîtage d'or, rares sur la carte.
- **Des arcs de triomphe et des ponts** sur les creux ; les ponts sur l'eau sont dimensionnés sur l'eau, pas sur le creux.
- **Une voirie droite qui pose son propre profil** : là où la pente coupe, la chaussée se rattrape en marches, avec des volées de deux colonnes, trois cubes de garde-tête et un seuil pavé.
- **Un anti-enterrement des bâtiments** : quand le terrain arrive contre une façade, c'est la pente d'amont qui est taillée en terrasse, pas le seuil qui est noyé.
- **L'éclairage public et intérieur** : lampadaires en deux parties sur les avenues — un poteau fin non cubique, surmonté d'une lanterne émissive cassable — et des appliques murales adossées aux murs des maisons et des immeubles, orientées par le mur visé.

---

## 4. Se déplacer : marche, vol, nage

- **ZQSD** pour marcher, **Espace** pour sauter.
- **Le contrôleur aérien tient en trois gestes sur Espace, sans touche de vol dédiée** : une pression courte saute, maintenir allume les réacteurs et monte sans limite, relâcher laisse redescendre. En l'air, une nouvelle pression ouvre le **plané** — Z accélère, S freine, et la caméra tient la trajectoire : regarder en haut prend de l'altitude, regarder en bas en perd ; un nouvel Espace rompt le plané.
- **La nage** : Espace remonte, Majuscule coule, et **+ / −** règlent l'assiette, c'est-à-dire la profondeur à laquelle on tient. Un indicateur d'immersion et une aide contextuelle apparaissent sous l'eau.
- **R** renvoie le joueur à son point d'apparition.
- **Un monde neuf s'ouvre dans un temple** : l'apparition met le joueur à l'abri et en hauteur, pas en pleine nature.

---

## 5. Construire et détruire : l'édition en deux temps

Le joueur édite le monde par pavés parallélépipédiques, en deux clics, sans menu :

- **Un carré marque la face visée.** Le premier clic ancre le pavé sur le cube collé à cette face ; le second cube reste sous la croix centrale.
- **Regarder change la taille du pavé** ; la **molette** l'éloigne ou le rapproche ; le **second clic applique**.
- **Clic gauche crée un pavé, clic droit le supprime.** Clic milieu ou **Échap** annule la sélection en cours.

### Les blocs posables

Vingt-trois icônes, rangées en six familles : **Naturel** (herbe, terre, pierre, rocher, sable, gravier, neige, mousse), **Construction** (bois, planches, briques, verre, obsidienne), **Éclairage** (pied de lampadaire, lanterne, applique murale), **Végétaux** (feuilles), **Minerais** (charbon, fer, or, diamant), **Liquides** (eau, lave).

Chaque bloc porte sa matière : solide ou non, opaque ou translucide (verre, eau, lave), ajouré (feuilles), émissif (lanterne, applique), réduit à une boîte hors cube (le poteau de lampadaire, la lanterne), cassable ou non. Quatre variantes d'applique existent dans le monde pour les quatre faces d'adossement, mais la palette n'en montre qu'une : c'est le mur visé qui choisit l'orientation.

### L'inventaire et la barre rapide

- **Neuf emplacements**, accessibles par les touches **1 à 9**, changeables à la molette hors sélection.
- **E** ouvre l'inventaire : une grille groupée par famille, avec une icône 16 × 16 dessinée à partir des textures du bloc. Un clic met le bloc dans l'emplacement actif et le tient immédiatement.
- La disposition de la barre rapide est mémorisée entre les sessions.

---

## 6. L'eau qui coule : un automate, pas une texture

L'eau et la lave obéissent à un automate à distance bornée, écrit hors du rendu pour être jugeable en Node :

- **Portée de 7 cubes**, un pas de **140 ms**, un budget de **512 cases traitées par tour**, plafonné à **24 évaluations** par candidat.
- L'eau descend et s'étale latéralement, **jamais vers le haut**, et n'empiète pas sur les cubes pleins.
- Une file de **20 000 cases** maximum et un plafond de **32 vagues sans écriture** empêchent un déversement infini de saturer la page.
- Le niveau de la mer vit à un seul endroit du code ; la plage, les rivières et l'automate s'y rattachent, ce qui empêche deux systèmes de se contredire.

---

## 7. Le cycle du jour et l'éclairage

- **Le soleil se lève à l'est, culmine à midi et se couche derrière le relief** ; la nuit tombe sur le monde et les lanternes des villes s'allument.
- **Sous terre il fait noir en toute heure** — posez-y une lanterne.
- La durée du jour est réglable de **60 secondes à une heure réelle** (480 s par défaut), avec une horloge au tableau de bord.
- Deux canaux de lumière distincts sont cuits dans le maillage : le canal **ciel** et le canal **lampe**. Séparer les deux est indispensable : si l'obscurité d'une grotte était peinte dans la seule couleur de sommet, une lanterne posée dedans n'aurait plus rien à éclairer.
- **La nuit n'oblige jamais à remailler** : le cycle anime les matériaux et le ciel, pas la géométrie.
- Les blocs émissifs forment un seau de rendu séparé, et une lanterne cassable cesse d'éclairer dès qu'on la casse.

---

## 8. La météo et le ciel

### Un modèle météo pur, séparé du rendu

Le ciel et la pluie viennent d'un modèle sans dépendance ni DOM, qui expose pour chaque instant : couverture, intensité, dégagé, sombre, profondeur de couche, vent et sa direction, et la forme des nuages. Le même code est jugé par les suites Node et exécuté par le navigateur.

### Le ciel change avant la pluie

C'est le contrat demandé, et il tient dans les chiffres :

- Le ciel **grise d'abord, puis les gouttes tombent** : la couverture prend de l'avance (`COUVERTURE_AVANT = 0,10`) et **retarde l'éclaircie à la fin de l'averse** (`ECLAIRCIE_APRES = 0,14`).
- Le ciel prend **quatre états** : bleu profond, gris, et entre les deux un **ciel de plomb** qui peut venir sans une seule goutte.
- Il **respire** (`RESPIRATION = 0,16`) : la couverture ondule au lieu de rester plaquée.
- **De temps en temps une journée entière se découvre** — le soleil y brille davantage dans un ciel profond.
- **Il pleut aussi en journée** : les épisodes sont calés pour que deux averses de suite ne puissent pas passer la nuit entière.
- Les **nuages dérivent avec le vent**, sur **deux couches** qui ne portent pas le même dessin, et leur **forme change au fil du temps** parmi cumulus, stratus et cirrus.
- **Par temps sec, le ciel est exactement celui d'hier** : habiller le ciel avec une météo nulle rend l'objet reçu à l'identique.

### L'averse

- Deux couches de gouttes, **5 200 points chacune**, dans des boîtes de 56 × 44 × 56 et 96 × 80 × 96 cubes : la pluie continue au loin plutôt que de s'arrêter net à quarante-cinq cubes.
- Chaque goutte tombe à **22 cubes par seconde**, avec sa propre graine de vent et une houle légère.
- **La traînée répond au vent réel, dans le repère de la caméra** : la pluie ne change plus de sens quand on tourne la tête.
- **Elle tombe en traits allongés, pas en flocons** — jugée au ratio d'allongement des taches peintes : **4 à 6 en pluie**, contre 1,5 quand on la retransforme en neige. La densité du rideau a été affinée quatre fois (0,45 → 0,34 → 0,28 → **0,2**) jusqu'à ne plus boucher le cadre : **1,2 % du cadre couvert** au lieu de 4,6 %.
- **Elle ne pleut pas à l'intérieur** : un clip de pièce retire les gouttes des volumes clos, et jusqu'à **24 enveloppes de bâtiments** poussées au shader retirent celles des maisons vues depuis la rue.
- **On la voit par les fenêtres** : le rideau est peint avant les blocs translucides, donc le verre reste transparent sur la pluie.

### Trois modes au choix

**Automatique**, **Ciel clair**, **Averse continue** — pour montrer la météo à la demande plutôt que d'attendre qu'elle veuille bien venir.

---

## 9. Le rendu : ce qui est visible est calculé, le reste est économisé

- **Tronçonnage** : le monde est découpé en tronçons de 16 cubes de côté, maillés et jetés au fil du déplacement, avec un double budget d'images pour que le chargement ne gèle pas la scène.
- **Une frontière rendue, pas devinée** : ce qui entre dans le disque de brume se décide au **coin le plus proche** du tronçon, avec une marge d'un tronçon pour couvrir la cime des arbres ; le « four » qui fabrique la géométrie s'arrête **une couronne avant** la frontière, et une garde empêche de repeindre ce qui est à l'écran quand on tourne simplement la tête.
- **Un quota d'octets** : un tronçon hors frontière n'est maillé que si le budget mémoire le permet, sinon il est évincé — la file ne se gonfle pas sans fin.
- **Cache de géométrie sur disque** (format `MCG1`) : ce que le mailleur a déjà payé est écrit sur le disque, dans la forme même que réclame la carte graphique. Au retour, les décors se posent sans être recalculés. Le fichier se remplit tout seul pendant qu'on joue — et pendant qu'on attend à l'accueil, où rien ne se dessine, il taille l'île entière. Sa place est calculée depuis la mémoire annoncée de l'onglet (**un quart du tas**), comme celle des géométries en RAM, et il se vide à chaque bloc touché. Un bouton **« Jeter les triangles du disque »** permet de repartir de zéro, et une barre d'avancement affiche l'état du cache.
- **Cache d'île sur disque** (format `MCI1`) : générer un tronçon coûte **18 ms en moyenne**, soit **neuf minutes et demie** pour les 31 416 tronçons de l'île par défaut. Le cache ramène la relecture à une fraction de milliseconde, avec trois codecs choisis selon ce que sait faire l'hôte :
  - **deflate** — 695 octets par tronçon mesurés (21 Mo pour l'île), 0,13 ms par tronçon quand la tranche de 64 est relue d'un bloc ;
  - **rle** — 2 394 octets par tronçon (72 Mo), mais chaque tronçon se relit seul, sans `CompressionStream`, en **38 µs** ;
  - **brut** — dernier recours, jamais choisi volontairement.
  Des gardes bornent l'en-tête (jusqu'à 4 096 tronçons par dimension, 256 Mo de fichier) pour qu'un fichier truqué ne fasse pas allouer 16 Go.
- **Netteté réglable sur quatre crans** : native (la plus nette), 1× (fluide), 0,75× (très fluide), 0,5× (la plus rapide).
- **Profondeur de champ réglable** de 2 à 32 tronçons.
- **Le contour de sélection est un vrai objet 3D** avec test de profondeur et biais caméra, jugé à l'image dans les suites.

---

## 10. Sauvegardes et mondes multiples

- **Plusieurs mondes enregistrés**, listés à l'accueil : nouveau, renommé, chargé, réinitialisé.
- **Enregistrer le monde** depuis l'écran de pause, avec un statut visible.
- **La sauvegarde ne stocke que le diff du joueur** — terrains et village se recalculent depuis la graine. Une sauvegarde reste donc petite et un monde se régénère à l'identique.
- Trois familles de routes côté serveur : `/world-save` (liste, lecture, écriture, suppression, avec une taille maximale imposée au corps de requête), `/world-island` (cache d'île) et `/world-geometry` (cache de géométrie, avec ajout incrémental, mise à jour d'en-tête et migration de format).

---

## 11. Interface et confort

- **Écran d'accueil** avec bouton Jouer, liste des mondes, accès aux réglages — et **aucun rendu pendant qu'il est affiché** : le temps d'attente sert au cache, pas à dessiner une scène personne ne regarde.
- **Tableau de bord** : horloge, informations de position, barre du cache de géométrie, barre du cache d'île, réticule, indications contextuelles de sélection et de nage, voile d'immersion.
- **Réglages en direct**, mémorisés entre les sessions : profondeur de champ, durée du jour, mode météo, netteté.
- **Textures personnalisées** : la touche **T** ouvre le panneau ; on envoie jusqu'à **six fichiers à la fois**, ils sont déposés dans `public/custom-textures/`, servis en statique et listés par le serveur.

---

## 12. Serveur web et application de bureau

- **Serveur Node/Express** : sert le client, les routes de sauvegarde et de caches, et les textures personnalisées. Démarrage : `npm start`.
- **Application de bureau Tauri** (Windows x64) : une fenêtre native autour du même client. Les scripts fournis construisent la version **portable** (`npm run desktop:build:portable`), l'**installeur** (`npm run desktop:build:installer`), préparent une **signature** (`npm run desktop:build:sign`) et **vérifient le paquet** (`npm run check:desktop`). Les livrables produits sont présents dans `release/windows-x64` : `MyCraft.exe` et `MyCraft_1.0.0_x64-setup.exe`. La signature du paquet reste à finaliser côté utilisateur.

---

## 13. Comment ces fonctionnalités sont tenues : 27 suites jouées

Aucune de ces affirmations ne repose sur une lecture de code : elles sont jugées par des suites **jouées de bout en bout** dans un vrai navigateur sans tête (Playwright), qui bootent le jeu, déplacent le joueur, tapent aux touches, lisent des pixels et comptent des triangles. Vingt-cinq d'entre elles s'enchaînent avec `npm run test:e2e` ; une feuille de contact (`npm run test:report`) en rassemble les images.

Suites thématiques : île, ciel, éclairage, chargement, mémoire, village, biomes, océan, eau, collisions et rendu, inventaire, réglages, sélection, persistance, génération du monde (modèle et écran), nuit, pluie, streaming, frontière rendue, quatre suites pour le cache de géométrie, fluidité, vol.

Quelques décomptes mesurés lors de la dernière campagne verte :

| Suite | Contrôles |
|---|---|
| village | 131 |
| nuit | 84 |
| pluie | 73 |
| render-collision | 62 |
| ciel | 39 |
| geom-cache | 22 |
| eclairage | 16 |
| memoire | 13 |
| streaming | 11 |
| frontiere | 7 |

**La méthode, autant que les chiffres.** Chaque mécanisme demandé est accompagné d'un **sabotage** qui neutralise précisément ce mécanisme-là : si le contrôle correspondant ne rougit pas, le contrôle ne prouvait rien et il est réécrit. C'est ainsi que l'averse a été jugée — transformer le lisseur de la goutte en pâté fait tomber le contrôle de l'allongement (1,54 contre 4 à 6), et rendre sa pleine densité au rideau fait tomber celui de l'emprise. Un déroulé qui n'affiche pas son décompte `N/M contrôles` est déclaré **non recevable**, jamais vert.

**Limites connues, dites telles quelles :** la garde de visibilité par la baie vitrée ne laisse qu'environ 20 % de marge au-dessus de son plancher ; le compteur de pluie sous une dalle basse (0,24 à 0,32 % pour un plancher de 0,2 %) ne prouvera plus rien sous environ 0,15 de facteur de densité ; l'allongement des traits est mesuré à midi, la nuit étant jugée à la teinte et à l'opacité ; les hautes nefs de plus de quatorze cubes et les derniers étages des immeubles ne sont pas échantillonnés ; les abris construits par le joueur utilisent encore le cylindre historique plutôt que les enveloppes de bâtiment.

---

## Pour démarrer en trois lignes

```bash
npm install
npm start          # client sur http://localhost:8080
npm run test:e2e   # les 25 suites jouées
```

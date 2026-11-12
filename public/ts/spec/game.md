lit le code dans modele-game.ts
générer les config ressources  dans un fichier json modifiable

le autonomieJetpack est la duree pendant laquelle le jetpack peut etre actif ,
Il consomme de l'energie , l'configNiveauJoueur[autonomieJetpack] donne le temps pour une cellule d'energie

quand on presse espace on monte tant que l'energie' est superieur a zero , quand elle est a zero on redescend si on ne presse pas espace il se recharge
quand on saute de haut on peu amortir la chute





ajouter les ressources dans le monde
les ressources ne sont pas des cubes mais des losange 3D de differente couleur quand on detruit une zone toute les ressource tombe elle sont recolter avec une zone de construction
la vie et l'energie  n'ai pas sous terre elle est forcement visible elle peut etre dans les batiment ou les maison ou dans la rue

le dimand et l'or sont sous terre
toute les ressources dans un rayon  configNiveauJoueur[rayonAttractionRessource] sous attirée et recupérer automatiquement  et non sacEstPlein()



à l'écran afficher l'energie et la vie




dx dy  dz sont la dimension de zone d'action
 dx*dy*dz <= transport pour detuire et recolté ajouter a l'inventaire
 dx*dy*dz <= transport pour construire



dans l'inventaire affichier les amelioriations dans deux ecran joueur et arme 

dans inventaire afficher les valeurs de l'arme et du joueur





histoire dans un monde un nid pacifique , et un nid agressif 


le monde commence positionnement des deux nids d'une distance d

nid agressif : nombre d'enemi fixe ou spawn infini


le joueur est dans un temple et est réveillé par le nid pacifique , histoire le nid pacifique ne connaissais pas le nid agressif et il y a eu des attaque , le plus vieux habitant connaissais une prohecie du sauveur dans un tempple qui pourrait detruire le nid agressif






générer les drones de config 
avoir une interface pour consulter la fiche technique des drones et leur paramettre
quand le jeux commence il faut creer un nid

un projectile peut etre une sphere ou un faisceau d'energie , il faut générer un type de sphere ou de faisceu en fonction de l'arme



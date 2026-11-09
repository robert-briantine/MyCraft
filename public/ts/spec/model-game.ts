enum Level {
    N1="1",
    N2="2",
    N3="3",
    N4="4",
    N5="5",
    N6="6"
}
const upgrade:{[e in Level]:Level} = {
    "1":Level.N2,
    "2":Level.N3,
    "3":Level.N4,
    "4":Level.N5,
    "5":Level.N6,
    "6":Level.N6
}

interface Drone {
    vitesse: Level
    rayonDetection: Level
    arme: Level
    distanceMaxiNid: Level
    vie: Level
    dureeSommeil: Level
    periodeProduction: Level
}
interface Nid {
    vie: number

}
interface Arme {
    porte: Level
    vitesse: Level
    periodeTire: Level
    rayonDegatImpact: Level
    rayonProjectile: Level
    degat: Level
}
type ConfigArme ={[name in keyof Arme]:{[l in Level]:number}}

interface Joueur {
    energie: number
    vie: number
    armeSlot1: Arme,
    armeSlot2: Arme,
    armeSlot3: Arme,
    transport: number
    dureeJetpack: Level
    volumeConstruction: number
    volumeDestruction: number
    sac: Sac
}

type SlotArme ="armeSlot1"|"armeSlot2"|"armeSlot3"


function energiePourTire(arme: Arme,configArme:ConfigArme): number {
    const porte = configArme["porte"][arme.porte]
    const vitesse = configArme["vitesse"][arme.vitesse]
    const rayonDegatImpact = configArme["rayonDegatImpact"][arme.rayonDegatImpact]
    const rayonProjectile = configArme["rayonProjectile"][arme.rayonProjectile]
    const periodeTire = configArme["periodeTire"][arme.periodeTire]
    return (porte * vitesse * rayonDegatImpact * rayonProjectile) / periodeTire
}
function initJoueur(): Joueur {
    return {
        armeSlot1: {
            degat: Level.N1,
            periodeTire: Level.N1,
            porte: Level.N1,
            rayonDegatImpact: Level.N1,
            rayonProjectile: Level.N1,
            vitesse: Level.N1
        },
        armeSlot2: {
            degat: Level.N1,
            periodeTire: Level.N1,
            porte: Level.N1,
            rayonDegatImpact: Level.N1,
            rayonProjectile: Level.N1,
            vitesse: Level.N1
        },
        armeSlot3: {
            degat: Level.N1,
            periodeTire: Level.N1,
            porte: Level.N1,
            rayonDegatImpact: Level.N1,
            rayonProjectile: Level.N1,
            vitesse: Level.N1
        },
        energie: 100,
        dureeJetpack: Level.N1,
        sac: {
            diamand: 0,
            energie: 10,
            or: 0,
            vie: 0
        },
        transport: 10,
        vie: 10,
        volumeConstruction: 8,
        volumeDestruction: 8

    }

}
type Ressource = "vie" | "energie" | "diamand" | "or"
type UpgradeKeyOfJoueur = "dureeJetpack" 
type KeyOfJoueur = "energie" |  "vie" | "volumeConstruction" | "volumeDestruction"
const ressources: Ressource[] = ["diamand", "energie", "or", "vie"]
type Sac = { [name in Ressource]: number }


interface AmeliorationArme {
    sac: Sac
    factor: number
}
interface AmeliorationJoueur {
    sac: Sac
    unit: number
    factor: number
}
interface UpgradeAmeliorationJoueur {
    sac: Sac
    factor: number
}
interface Zone {
    dx:number
    dy:number
    dz:number
}

interface Config {
    drones: { [name: string]: Drone }
    ameliorationArme: { [name in keyof Arme]: AmeliorationArme }
    ameliorationJoueur: { [name in KeyOfJoueur]: AmeliorationJoueur }
    upgradeAmeliorationJoueur: { [name in UpgradeKeyOfJoueur]: UpgradeAmeliorationJoueur }
}

function sacEstPlein(joueur: Joueur) {
    let total = 0
    for (const r of ressources) {
        total += joueur.sac[r]
    }
    return (total >= joueur.transport)
}


function estVolumeConstructionValide(zone:Zone , joueur:Joueur) {
    return (zone.dx*zone.dy*zone.dz ) <= joueur.volumeConstruction

}
function estVolumeDestructionValide(zone:Zone , joueur:Joueur) {
    return (zone.dx*zone.dy*zone.dz) <= joueur.volumeDestruction

}
function ameliorerArme(p: keyof Arme, config: Config,i:SlotArme, joueur: Joueur): boolean {

    for (const e of ressources) {
        if (config.ameliorationArme[p].sac[e] !== joueur.sac[e]) {
            return false
        }
    }
    for (const r of ressources) {
        joueur.sac[r] -= config.ameliorationArme[p].sac[r]
    }
    joueur[i][p] =upgrade[joueur[i][p]]
    for (const r of ressources) {
        config.ameliorationArme[p].sac[r] = config.ameliorationArme[p].sac[r] * config.ameliorationArme[p].factor
    }

    return true
}
function ameliorerJoueur(p: KeyOfJoueur, config: Config,i:number, joueur: Joueur): boolean {
    for (const e of ressources) {
        if (config.ameliorationJoueur[p].sac[e] !== joueur.sac[e]) {
            return false
        }
    }
    for (const r of ressources) {
        joueur.sac[r] -= config.ameliorationJoueur[p].sac[r]
    }
    joueur[p] = joueur[p]+  config.ameliorationJoueur[p].unit
    for (const r of ressources) {
        config.ameliorationJoueur[p].sac[r] = config.ameliorationJoueur[p].sac[r] * config.ameliorationJoueur[p].factor
    }

    return true
}

function upgradeAmeliorerJoueur(p: UpgradeKeyOfJoueur, config: Config,i:number, joueur: Joueur): boolean {
    for (const e of ressources) {
        if (config.upgradeAmeliorationJoueur[p].sac[e] !== joueur.sac[e]) {
            return false
        }
    }
    for (const r of ressources) {
        joueur.sac[r] -= config.upgradeAmeliorationJoueur[p].sac[r]
    }
    joueur[p] = upgrade[joueur[p]]
    for (const r of ressources) {
        config.upgradeAmeliorationJoueur[p].sac[r] = config.upgradeAmeliorationJoueur[p].sac[r] * config.upgradeAmeliorationJoueur[p].factor
    }

    return true
}



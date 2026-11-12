enum Level {
    N1 = "1",
    N2 = "2",
    N3 = "3",
    N4 = "4",
    N5 = "5",
    N6 = "6"
}
const upgrade: { [e in Level]: Level } = {
    "1": Level.N2,
    "2": Level.N3,
    "3": Level.N4,
    "4": Level.N5,
    "5": Level.N6,
    "6": Level.N6
}

interface DroneDescription {
    vitesse: Level
    rayonDetection: Level
    arme: ArmeDescription
    distanceMaxiNid: Level
    vieMax: Level
    dureeSommeil: Level
    periodeProduction: Level
    hauteurMin: Level
    deltatHauteurMax: Level
    autonomieApnee: Level
}

interface Production {
    droneDescription: DroneDescription
    count: number
}
interface NidDescription {
    vieMax: Level
    productions: Production[]
    position: "grotte" | "sommetMontagne" | "ocean" | "foret"


}
interface ArmeDescription {
    porte: Level
    vitesse: Level
    periodeTire: Level
    rayonDegatImpact: Level
    rayonProjectile: Level
    degat: Level
    paralise: Level
}
type FieldsOfType<T, U> = keyof {
    [K in keyof T as NonNullable<T[K]> extends U ? K : never]: T[K]
};
type ConfigNiveauArme = { [name in keyof ArmeDescription]: { [l in Level]: number } }
type ConfigNiveauJoueur = { [name in FieldsOfType<Joueur, Level>]: { [l in Level]: number } }
type ConfigNiveauDrone = { [name in keyof DroneDescription]: { [l in Level]: number } }
export let configNiveauArme: ConfigNiveauArme
export let configNiveauJoueur: ConfigNiveauJoueur

interface Joueur {
    energie: number
    vie: number
    armeSlot1: ArmeDescription,
    armeSlot2: ArmeDescription,
    armeSlot3: ArmeDescription,
    transport: number
    autonomieJetpack: Level
    autonomieApnee: Level
    rayonAttractionRessource: Level
    sac: Sac
}



type SlotArme = FieldsOfType<Joueur, ArmeDescription>

function energiePourTire(arme: ArmeDescription, configArme: ConfigNiveauArme): number {
    const porte = configArme["porte"][arme.porte]
    const vitesse = configArme["vitesse"][arme.vitesse]
    const rayonDegatImpact = configArme["rayonDegatImpact"][arme.rayonDegatImpact]
    const rayonProjectile = configArme["rayonProjectile"][arme.rayonProjectile]
    const periodeTire = configArme["periodeTire"][arme.periodeTire]
    return (porte * vitesse * rayonDegatImpact * rayonProjectile) / periodeTire
}

function initArme(): ArmeDescription {
    return {
        degat: Level.N1,
        periodeTire: Level.N1,
        porte: Level.N1,
        rayonDegatImpact: Level.N1,
        rayonProjectile: Level.N1,
        vitesse: Level.N1,
        paralise: Level.N1
    }
}
function initJoueur(): Joueur {
    return {
        armeSlot1: initArme(),
        armeSlot2: initArme(),
        armeSlot3: initArme(),
        energie: 100,
        autonomieJetpack: Level.N1,
        autonomieApnee: Level.N1,
        sac: {
            diamand: 0,
            energie: 10,
            or: 0,
            vie: 0,
            fer: 0
        },
        transport: 10,
        vie: 10,

        rayonAttractionRessource: Level.N1

    }

}


type Ressource = "vie" | "energie" | "diamand" | "or" | "fer"
type UpgradeKeyOfJoueur = FieldsOfType<Joueur, Level>
type KeyOfJoueur = FieldsOfType<Joueur, number>
const ressources: Ressource[] = ["diamand", "energie", "or", "vie", "fer"]
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
    dx: number
    dy: number
    dz: number
}

interface Config {
    droneConfig: ConfigNiveauDrone
    ameliorationArme: { [name in keyof ArmeDescription]: AmeliorationArme }
    ameliorationJoueur: { [name in KeyOfJoueur]: AmeliorationJoueur }
    upgradeAmeliorationJoueur: { [name in UpgradeKeyOfJoueur]: UpgradeAmeliorationJoueur }
}



interface Drone {
    droneDescription: DroneDescription
    nid: Nid
    vie: number

}
interface Nid {
    nidDescription: NidDescription
    vie: number
    count: number
    time: number
    idxProduction: number
}
class Monde {
    drones: Drone[] = []
    nids: Nid[] = []
    joueur: Joueur
    config: Config
    constructor(joueur: Joueur, config: Config) {
        this.joueur = joueur
        this.config = config
    }
    step(time: number) {
        for (const n of this.nids) {
            let p = n.nidDescription.productions[n.idxProduction]
            const deltat = time - n.time
            let periode: number = this.config.droneConfig["periodeProduction"][p.droneDescription.periodeProduction]
            if (deltat > periode) {
                n.time = time
                if (n.count === p.count) {
                    n.count = 0
                    n.idxProduction++
                    if (n.idxProduction === n.nidDescription.productions.length) {
                        n.idxProduction = 0
                    }
                    p = n.nidDescription.productions[n.idxProduction]

                }
                const drone: Drone = {
                    droneDescription: p.droneDescription,
                    vie: this.config.droneConfig["vieMax"][p.droneDescription.vieMax],
                    nid: n
                }
                this.drones.push(drone)
                n.count++

            }

        }



    }
    dronePourDestruction() {
        return this.drones.filter((d) => this.nids.every((n) => n !== d.nid) || d.vie <= 0)
    }
    nidPourDestruction() {
        return this.nids.filter((n) => n.vie <= 0)

    }

    sacEstPlein() {
        let total = 0
        for (const r of ressources) {
            total += this.joueur.sac[r]
        }
        return (total >= this.joueur.transport)
    }
    peutRecuperer(zone: Zone): boolean {
        return true;
    }


    ameliorerArme(p: keyof ArmeDescription, i: SlotArme): boolean {

        for (const e of ressources) {
            if (this.config.ameliorationArme[p].sac[e] < this.joueur.sac[e]) {
                return false
            }
        }
        for (const r of ressources) {
            this.joueur.sac[r] -= this.config.ameliorationArme[p].sac[r]
        }
        this.joueur[i][p] = upgrade[this.joueur[i][p]]
        for (const r of ressources) {
            this.config.ameliorationArme[p].sac[r] = this.config.ameliorationArme[p].sac[r] * this.config.ameliorationArme[p].factor
        }

        return true
    }
    ameliorerJoueur(p: KeyOfJoueur): boolean {
        for (const e of ressources) {
            if (this.config.ameliorationJoueur[p].sac[e] < this.joueur.sac[e]) {
                return false
            }
        }
        for (const r of ressources) {
            this.joueur.sac[r] -= this.config.ameliorationJoueur[p].sac[r]
        }
        this.joueur[p] = this.joueur[p] + this.config.ameliorationJoueur[p].unit
        for (const r of ressources) {
            this.config.ameliorationJoueur[p].sac[r] = this.config.ameliorationJoueur[p].sac[r] * this.config.ameliorationJoueur[p].factor
        }

        return true
    }

    upgradeAmeliorerJoueur(p: UpgradeKeyOfJoueur, config: Config): boolean {
        for (const e of ressources) {
            if (config.upgradeAmeliorationJoueur[p].sac[e] < this.joueur.sac[e]) {
                return false
            }
        }
        for (const r of ressources) {
            this.joueur.sac[r] -= config.upgradeAmeliorationJoueur[p].sac[r]
        }
        this.joueur[p] = upgrade[this.joueur[p]]
        for (const r of ressources) {
            config.upgradeAmeliorationJoueur[p].sac[r] = config.upgradeAmeliorationJoueur[p].sac[r] * config.upgradeAmeliorationJoueur[p].factor
        }

        return true
    }
}



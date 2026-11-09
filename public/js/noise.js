// ===== NOISE =====
// Le bruit simplex du monde, sous sa seule forme. Le jeu en portait sa propre copie
// dans `game.js` et un second exemplaire, désaccordé — son tirage de péremutation
// n'était plus le même — dormait ici sans jamais être importé. Mesurer un relief avec
// l'un et le rendre avec l'autre donne deux mondes différents : c'est cette divergence
// que supprime ce module. Il reste sans dépendance, pour que les suites Node évaluent
// exactement le relief que le navigateur dessine.

export class SimplexNoise {
  constructor(seed = Math.random()) {
    this.p = new Uint8Array(512);
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    let s = Math.floor(seed * 65536) || 1;
    for (let i = 255; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      const j = s % (i + 1);
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < 512; i++) this.p[i] = perm[i & 255];
  }
  noise2D(x, y) {
    const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
    const s = (x + y) * F2;
    const i = Math.floor(x + s), j = Math.floor(y + s);
    const t = (i + j) * G2, X0 = i - t, Y0 = j - t;
    const x0 = x - X0, y0 = y - Y0;
    const [i1, j1] = x0 > y0 ? [1, 0] : [0, 1];
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    const grad = (h, gx, gy) => { const hm = h & 7, u = hm < 4 ? gx : gy, v = hm < 4 ? gy : gx; return ((hm&1)?-u:u)+((hm&2)?-v:v); };
    let n0=0,n1=0,n2=0;
    let d=0.5-x0*x0-y0*y0; if(d>0){d*=d;n0=d*d*grad(this.p[ii+this.p[jj]],x0,y0);}
    d=0.5-x1*x1-y1*y1; if(d>0){d*=d;n1=d*d*grad(this.p[ii+i1+this.p[jj+j1]],x1,y1);}
    d=0.5-x2*x2-y2*y2; if(d>0){d*=d;n2=d*d*grad(this.p[ii+1+this.p[jj+1]],x2,y2);}
    return 70*(n0+n1+n2);
  }
  octave(x, y, oct=4, persist=0.5) {
    let total=0,freq=1,amp=1,maxV=0;
    for(let i=0;i<oct;i++){total+=this.noise2D(x*freq,y*freq)*amp;maxV+=amp;amp*=persist;freq*=2;}
    return total/maxV;
  }
}

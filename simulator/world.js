import { REGION_SIZE_M, toXY, fromXY, mulberry32, gaussian, compass } from '@emberwatch/shared';

const CELL_M = 200;
const toRad = (d) => (d * Math.PI) / 180;

// A coarse cellular fire model over the monitored region. Each cell has fuel
// and moisture; burning cells ignite neighbours with a probability that grows
// with fuel, dryness and wind alignment. Sensors then sample heat and a smoke
// plume that drifts downwind. Fire dynamics run faster than real time so a
// spread is visible within a couple of minutes.
export class World {
  constructor({ seed = 7, fireSpeed = 1 } = {}) {
    this.rand = mulberry32(seed);
    this.cols = Math.ceil(REGION_SIZE_M.x / CELL_M);
    this.rows = Math.ceil(REGION_SIZE_M.y / CELL_M);
    const n = this.cols * this.rows;
    this.fuel = new Float32Array(n);
    this.moisture = new Float32Array(n);
    this.intensity = new Float32Array(n);
    this.age = new Float32Array(n);
    this.burnt = new Uint8Array(n);
    this.burning = new Set();
    this.fireSpeed = fireSpeed;
    // Meteorological convention: direction the wind blows FROM.
    this.wind = { dir: 292, speed: 22 };
    this.elapsed = 0;
    this.initTerrain();
  }

  initTerrain() {
    // Smooth value noise for fuel load, with drier ridges in the north.
    const r = this.rand;
    const coarse = [];
    const cw = 8;
    const ch = 6;
    for (let i = 0; i < (cw + 1) * (ch + 1); i++) coarse.push(r());
    const sample = (u, v) => {
      const x = u * cw;
      const y = v * ch;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const at = (i, j) => coarse[Math.min(j, ch) * (cw + 1) + Math.min(i, cw)];
      const a = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const b = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      return a * (1 - fy) + b * fy;
    };
    for (let j = 0; j < this.rows; j++) {
      for (let i = 0; i < this.cols; i++) {
        const k = j * this.cols + i;
        const noise = sample(i / this.cols, j / this.rows);
        this.fuel[k] = 0.45 + 0.55 * noise;
        this.moisture[k] = 0.12 + 0.25 * (1 - noise) - (j / this.rows) * 0.06;
      }
    }
  }

  cellAt(x, y) {
    const i = Math.floor(x / CELL_M);
    const j = Math.floor(y / CELL_M);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return -1;
    return j * this.cols + i;
  }

  ignite(lat, lng) {
    const { x, y } = toXY({ lat, lng });
    const k = this.cellAt(x, y);
    if (k < 0) return false;
    // Light a small cluster so the fire takes hold reliably.
    const i0 = k % this.cols;
    const j0 = Math.floor(k / this.cols);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (Math.abs(di) + Math.abs(dj) > 1) continue;
        const i = i0 + di;
        const j = j0 + dj;
        if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
        const c = j * this.cols + i;
        this.burnt[c] = 0;
        this.intensity[c] = Math.max(this.intensity[c], di === 0 && dj === 0 ? 0.5 : 0.2);
        this.age[c] = 0;
        this.burning.add(c);
      }
    }
    return true;
  }

  extinguish() {
    for (const c of this.burning) this.intensity[c] = 0;
    this.burning.clear();
  }

  setWind(dir, speed) {
    this.wind = { dir, speed };
  }

  // Direction the fire is pushed toward, as a unit vector in metres space.
  spreadVector() {
    const toward = toRad((this.wind.dir + 180) % 360);
    return { x: Math.sin(toward), y: Math.cos(toward) };
  }

  step(dtSec) {
    this.elapsed += dtSec;
    if (!this.burning.size) return;
    const dt = dtSec * this.fireSpeed;
    const sv = this.spreadVector();
    const windK = 0.075 * this.wind.speed;
    const ignitions = [];

    for (const c of this.burning) {
      this.age[c] += dt;
      const peakAt = 25;
      const burnFor = 110 * this.fuel[c];
      if (this.age[c] < peakAt) {
        this.intensity[c] = Math.min(1, this.intensity[c] + dt * 0.04);
      } else if (this.age[c] > burnFor) {
        this.intensity[c] = Math.max(0, this.intensity[c] - dt * 0.02);
        if (this.intensity[c] <= 0.02) {
          this.intensity[c] = 0;
          this.burnt[c] = 1;
          this.burning.delete(c);
          continue;
        }
      }
      if (this.intensity[c] < 0.35) continue;

      const i0 = c % this.cols;
      const j0 = Math.floor(c / this.cols);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) continue;
          const n = j * this.cols + i;
          if (this.burnt[n] || this.burning.has(n)) continue;
          const len = Math.hypot(di, dj);
          const align = (di * sv.x + dj * sv.y) / len;
          const p =
            0.012 * dt * this.intensity[c] * this.fuel[n] * (1 - this.moisture[n]) * Math.exp(windK * align) / len;
          if (this.rand() < p) ignitions.push(n);
        }
      }
    }
    for (const n of ignitions) {
      this.burning.add(n);
      this.intensity[n] = 0.15;
      this.age[n] = 0;
    }
  }

  // Ambient weather with a daily cycle, slightly different per zone.
  ambient(zone, now = Date.now()) {
    const d = new Date(now);
    const hour = d.getHours() + d.getMinutes() / 60;
    const day = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
    const dry = { north: 3, east: 1, west: 0, south: -1 }[zone] ?? 0;
    return {
      t: 25 + 7 * day + dry * 0.8,
      h: Math.max(8, 38 - 16 * day - dry * 2.5),
    };
  }

  // What a sensor at (x, y) would measure right now from the fire alone.
  fireEffect(x, y) {
    if (!this.burning.size) return { heat: 0, smoke: 0, onFire: false };
    const sv = this.spreadVector();
    let heat = 0;
    let smoke = 0;
    let onFire = false;
    const own = this.cellAt(x, y);
    for (const c of this.burning) {
      const I = this.intensity[c];
      if (I <= 0) continue;
      const cx = ((c % this.cols) + 0.5) * CELL_M;
      const cy = (Math.floor(c / this.cols) + 0.5) * CELL_M;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy);
      if (d < 700) heat += I * 220 * Math.exp(-d / 140);
      // Plume: strongest downwind, widening with distance.
      const along = dx * sv.x + dy * sv.y;
      const cross = Math.abs(dx * sv.y - dy * sv.x);
      if (along > -150 && along < 2500) {
        const a = Math.max(along, 0);
        const width = 90 + 0.3 * a;
        smoke += I * 650 * Math.exp(-a / 900) * Math.exp(-(cross * cross) / (2 * width * width));
      }
      if (d < 400) smoke += I * 260 * Math.exp(-d / 160);
      if (c === own && I > 0.85) onFire = true;
    }
    return { heat: Math.min(heat, 160), smoke: Math.min(smoke, 4500), onFire };
  }

  describe() {
    const cells = this.burning.size;
    return {
      burningCells: cells,
      areaHa: Math.round((cells * CELL_M * CELL_M) / 10000),
      wind: { ...this.wind, compass: compass(this.wind.dir) },
    };
  }
}

export function noise(rand, sigma) {
  return gaussian(rand) * sigma;
}

export { fromXY };

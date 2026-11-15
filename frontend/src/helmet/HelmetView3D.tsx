/**
 * Vue 3D du casque (three.js via @react-three/fiber). Chargée à la demande (React.lazy) : mode casque et panneau
 * « Vue casque » de Supervision uniquement.
 *
 * Terrain = grille 5 m + couloir DTM 1 m autour de la caméra + anneau CTX à l'horizon, texturé par l'ortho HiRISE.
 * Aucune géométrie inventée : seuls les DTM et l'ortho de l'équipe data (pipeline/scene_export.py) sont affichés ;
 * balises, tracé et obstacle sont des repères d'interface. Géométrie et caméra : domain/scene.ts.
 */
import { Line } from '@react-three/drei';
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { Component, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { loadScene } from '../data';
import { returnPlan } from '../domain/mission';
import type { LonLat } from '../domain/projection';
import { beacons, cameraPose, type CameraPose, type Dataset, drape, FOV_DEG, groundPoint, type Raster, type SceneData } from '../domain/scene';
import { toGridXY } from '../domain/terrain';
import { useMission } from '../store';

const SKY_TOP = '#9c7a62';
const DUST = '#c9a283'; // brouillard de poussière et bas du ciel
const ORTHO_TINT = '#e8c2a0'; // teinte de rendu appliquée à l'ortho en niveaux de gris
const HORIZON_COLOR = '#b48a69';
const PATCH_HALF_M = 150; // couloir 1 m affiché autour de la caméra
const PATCH_STEP_M = 50; // déplacement de la caméra avant de recalculer le couloir affiché

/* ---------------- Géométrie des grilles ---------------- */

type Win = [number, number, number, number]; // colonne 0, ligne 0, colonne 1, ligne 1 (exclues)

/** Sommets aux centres de cellules (Y = altitude − altitude de A, non exagérée) et UV de l'ortho. */
function gridGeometry(sd: SceneData, r: Raster, win: Win, ortho: Dataset | null) {
  const [c0, l0, c1, l1] = win;
  const w = c1 - c0, h = l1 - l0;
  const pos = new Float32Array(w * h * 3);
  const uv = ortho ? new Float32Array(w * h * 2) : null;
  const ok = new Uint8Array(w * h);
  for (let l = 0; l < h; l++) {
    const y = r.origin.y - (l0 + l + 0.5) * r.cell_m;
    for (let c = 0; c < w; c++) {
      const x = r.origin.x + (c0 + c + 0.5) * r.cell_m;
      const z = r.values[(l0 + l) * r.width + c0 + c];
      const k = l * w + c;
      ok[k] = Number.isFinite(z) ? 1 : 0;
      pos.set([x - sd.center[0], ok[k] ? z - sd.baseAlt : 0, -(y - sd.center[1])], k * 3);
      if (uv && ortho) {
        uv[k * 2] = (x - ortho.origin.x) / (ortho.width * ortho.cell_m);
        uv[k * 2 + 1] = 1 - (ortho.origin.y - y) / (ortho.height * ortho.cell_m);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return { geo, w, h, ok };
}

/** Triangles des quadrilatères dont les quatre sommets existent et que `skip` n'exclut pas. */
function gridIndex(w: number, h: number, ok: Uint8Array, skip?: Uint8Array): THREE.BufferAttribute {
  const idx: number[] = [];
  for (let l = 0; l < h - 1; l++) {
    for (let c = 0; c < w - 1; c++) {
      const a = l * w + c, b = a + 1, d = a + w, e = d + 1;
      if (!(ok[a] && ok[b] && ok[d] && ok[e]) || skip?.[a]) continue;
      idx.push(a, d, b, b, d, e);
    }
  }
  return new THREE.BufferAttribute(new Uint32Array(idx), 1);
}

/** Fenêtre du couloir 1 m autour du point (projection des grilles), ou null hors du couloir. */
function patchWindow(r: Raster, [x, y]: [number, number]): Win | null {
  const c0 = Math.max(0, Math.floor((x - PATCH_HALF_M - r.origin.x) / r.cell_m));
  const c1 = Math.min(r.width, Math.ceil((x + PATCH_HALF_M - r.origin.x) / r.cell_m));
  const l0 = Math.max(0, Math.floor((r.origin.y - (y + PATCH_HALF_M)) / r.cell_m));
  const l1 = Math.min(r.height, Math.ceil((r.origin.y - (y - PATCH_HALF_M)) / r.cell_m));
  return c1 - c0 > 1 && l1 - l0 > 1 ? [c0, l0, c1, l1] : null;
}

const finiteAt = (r: Raster, x: number, y: number) => {
  const c = Math.floor((x - r.origin.x) / r.cell_m), l = Math.floor((r.origin.y - y) / r.cell_m);
  return c >= 0 && l >= 0 && c < r.width && l < r.height && Number.isFinite(r.values[l * r.width + c]);
};

function Terrain({ sd, center, exag }: { sd: SceneData; center: [number, number]; exag: number }) {
  const ortho = useLoader(THREE.TextureLoader, `/data/terrain/${sd.ortho.file}`);
  ortho.colorSpace = THREE.SRGBColorSpace;
  ortho.anisotropy = 8;
  const g = sd.grid;
  const grid5 = useMemo(() => gridGeometry(sd, { ...g, values: g.altitude }, [0, 0, g.width, g.height], sd.ortho), [sd, g]);
  const win = useMemo(() => patchWindow(sd.corridor, center), [sd, center]);
  const patch = useMemo(() => {
    if (!win) return null;
    const p = gridGeometry(sd, sd.corridor, win, sd.ortho);
    p.geo.setIndex(gridIndex(p.w, p.h, p.ok));
    return p.geo;
  }, [sd, win]);
  // Trou dans la grille 5 m sous le couloir 1 m affiché (quadrilatères entièrement couverts)
  useMemo(() => {
    const skip = new Uint8Array(g.width * g.height);
    if (win) {
      const cr = sd.corridor;
      const [x0, x1] = [cr.origin.x + win[0] * cr.cell_m, cr.origin.x + win[2] * cr.cell_m];
      const [y1, y0] = [cr.origin.y - win[1] * cr.cell_m, cr.origin.y - win[3] * cr.cell_m];
      const cx = (c: number) => g.origin.x + (c + 0.5) * g.cell_m, ly = (l: number) => g.origin.y - (l + 0.5) * g.cell_m;
      const inside = (x: number, y: number) => x >= x0 + 1 && x <= x1 - 1 && y >= y0 + 1 && y <= y1 - 1 && finiteAt(cr, x, y);
      for (let l = 0; l < g.height - 1; l++) {
        for (let c = 0; c < g.width - 1; c++) {
          if (inside(cx(c), ly(l)) && inside(cx(c + 1), ly(l)) && inside(cx(c), ly(l + 1)) && inside(cx(c + 1), ly(l + 1))) skip[l * g.width + c] = 1;
        }
      }
    }
    grid5.geo.setIndex(gridIndex(grid5.w, grid5.h, grid5.ok, skip));
  }, [grid5, win, g, sd]);
  const horizon = useMemo(() => {
    const r = sd.horizon;
    const p = gridGeometry(sd, r, [0, 0, r.width, r.height], null);
    // Anneau : on retire les quadrilatères entièrement dans l'emprise de la grille 5 m
    const [gx0, gx1, gy1, gy0] = [g.origin.x, g.origin.x + g.width * g.cell_m, g.origin.y, g.origin.y - g.height * g.cell_m];
    const skip = new Uint8Array(r.width * r.height);
    for (let l = 0; l < r.height - 1; l++) {
      for (let c = 0; c < r.width - 1; c++) {
        const x0 = r.origin.x + (c + 0.5) * r.cell_m, x1 = x0 + r.cell_m, y0 = r.origin.y - (l + 1.5) * r.cell_m, y1 = y0 + r.cell_m;
        if (x0 >= gx0 && x1 <= gx1 && y0 >= gy0 && y1 <= gy1) skip[l * r.width + c] = 1;
      }
    }
    p.geo.setIndex(gridIndex(p.w, p.h, p.ok, skip));
    p.geo.computeVertexNormals();
    return p.geo;
  }, [sd, g]);
  useEffect(() => () => grid5.geo.dispose(), [grid5]);
  useEffect(() => () => patch?.dispose(), [patch]);
  useEffect(() => () => horizon.dispose(), [horizon]);

  return (
    <group scale={[1, exag, 1]}>
      <mesh geometry={grid5.geo}>
        <meshBasicMaterial map={ortho} color={ORTHO_TINT} />
      </mesh>
      {patch && (
        <mesh geometry={patch}>
          <meshBasicMaterial map={ortho} color={ORTHO_TINT} polygonOffset polygonOffsetFactor={-1} polygonOffsetUnits={-2} />
        </mesh>
      )}
      <mesh geometry={horizon}>
        <meshLambertMaterial color={HORIZON_COLOR} polygonOffset polygonOffsetFactor={2} polygonOffsetUnits={4} />
      </mesh>
    </group>
  );
}

/* ---------------- Ciel, caméra ---------------- */

const skyMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { top: { value: new THREE.Color(SKY_TOP) }, bottom: { value: new THREE.Color(DUST) } },
  vertexShader: 'varying vec3 vP; void main() { vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main() { float t = clamp(vP.y * 3.0, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, t), 1.0); }',
});

function Sky() {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ camera }) => ref.current?.position.copy(camera.position));
  return (
    <mesh ref={ref} material={skyMaterial} renderOrder={-1} frustumCulled={false}>
      <sphereGeometry args={[30000, 32, 16]} />
    </mesh>
  );
}

interface Look {
  free: boolean;
  yaw: number;
  pitch: number;
}

function CameraRig({ pose, look }: { pose: CameraPose; look: React.RefObject<Look> }) {
  const { camera, scene } = useThree();
  const first = useRef(true);
  if (import.meta.env.DEV) (window as unknown as { __eva3d?: object }).__eva3d = { camera, scene, pose, look: look.current }; // diagnostic (tests)
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), t: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) }), []);
  useFrame((_, dt) => {
    const target = new THREE.Vector3(...pose.position);
    const k = first.current ? 1 : 1 - Math.exp(-dt * 5);
    camera.position.lerp(target, k);
    if (look.current.free) {
      camera.quaternion.setFromEuler(new THREE.Euler(look.current.pitch, look.current.yaw, 0, 'YXZ'));
    } else {
      // Matrix4.lookAt suit la convention des caméras (regard vers −Z), contrairement à Object3D.lookAt
      tmp.t.set(pose.target[0], camera.position.y, pose.target[2]);
      tmp.q.setFromRotationMatrix(tmp.m.lookAt(camera.position, tmp.t, tmp.up));
      camera.quaternion.slerp(tmp.q, first.current ? 1 : 1 - Math.exp(-dt * 4));
      const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      look.current.yaw = e.y;
      look.current.pitch = e.x;
    }
    first.current = false;
  });
  return null;
}

/* ---------------- Repères ---------------- */

const BEACON_COLORS: Record<string, string> = { A: '#F3EFEA', B: '#EE8A1B' };

/** Étiquette lisible à taille constante : texte dessiné sur un canvas 2D, affiché en sprite. */
function Label({ text, position, bg = 'rgba(16,13,11,0.8)' }: { text: string; position: [number, number, number]; bg?: string }) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d')!;
    const font = '700 26px Inter, system-ui, sans-serif';
    ctx.font = font;
    c.width = Math.ceil(ctx.measureText(text).width) + 24;
    c.height = 40;
    ctx.font = font;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(0, 0, c.width, c.height, 10);
    ctx.fill();
    ctx.fillStyle = '#F3EFEA';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 12, c.height / 2 + 1);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [text, bg]);
  useEffect(() => () => tex.dispose(), [tex]);
  const h = 0.045; // hauteur relative à l'écran (sizeAttenuation désactivée)
  return (
    <sprite position={position} scale={[(h * tex.image.width) / tex.image.height, h, 1]} center={new THREE.Vector2(0.5, 0)} renderOrder={10}>
      <spriteMaterial map={tex} sizeAttenuation={false} depthTest={false} transparent fog={false} />
    </sprite>
  );
}

function Markers({ sd, exag }: { sd: SceneData; exag: number }) {
  const { s, view, data } = useMission();
  const toLL = data.projection.toLonLat;
  const route = useMemo(() => drape(sd, data.route.map(toLL), exag), [sd, data, exag, toLL]);
  const bs = useMemo(() => beacons(sd, data, exag), [sd, data, exag]);
  const legPath = s.leg?.kind === 'out' && s.leg.path !== data.route && s.incident?.choice ? s.leg.path : null;
  const detour = useMemo(() => (legPath ? drape(sd, legPath.map(toLL), exag) : null), [sd, legPath, exag, toLL]);
  const back = view.alert === 'return' ? (s.leg?.kind === 'back' ? s.leg.path : returnPlan(s, data).path) : null;
  const backLine = useMemo(() => (back && back.length > 1 ? drape(sd, back.map(toLL), exag, 2, 0.35) : null), [sd, back, exag, toLL]);
  return (
    <>
      {route.length > 1 && <Line points={route} color="#4CC6EA" lineWidth={4} transparent opacity={backLine ? 0.45 : 0.9} />}
      {detour && detour.length > 1 && <Line points={detour} color="#F2C230" lineWidth={4} />}
      {backLine && <Line points={backLine} color="#F4605A" lineWidth={5} />}
      {bs.map((b) => (
        <group key={b.id} position={b.position}>
          <mesh position={[0, 1.5, 0]}>
            <cylinderGeometry args={[0.12, 0.12, 3, 8]} />
            <meshBasicMaterial color={BEACON_COLORS[b.id] ?? '#4CC6EA'} />
          </mesh>
          <mesh position={[0, 3.2, 0]}>
            <sphereGeometry args={[0.45, 16, 8]} />
            <meshBasicMaterial color={BEACON_COLORS[b.id] ?? '#4CC6EA'} />
          </mesh>
          <Label text={b.label} position={[0, 4, 0]} />
        </group>
      ))}
      {s.obstacles.map((o) => {
        const p = groundPoint(sd, o.lonlat, exag);
        return (
          <group key={o.id} position={p}>
            <mesh position={[0, 1.25, 0]}>
              <cylinderGeometry args={[o.radiusM, o.radiusM, 2.5, 48, 1, true]} />
              <meshBasicMaterial color="#F4605A" transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Label text={`Obstacle · ${o.radiusM} m`} position={[0, 3, 0]} bg="rgba(120,20,16,0.92)" />
          </group>
        );
      })}
    </>
  );
}

/* ---------------- Composant ---------------- */

class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  render() {
    return this.state.error ? <div className="view3d-msg">Vue 3D indisponible : {this.state.error}</div> : this.props.children;
  }
}

/** Vue 3D synchronisée avec la mission ; `hud` : placement des commandes pour le plein écran du casque. */
export default function HelmetView3D({ hud = false }: { hud?: boolean }) {
  const { view, data } = useMission();
  const [sd, setSd] = useState<SceneData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exag, setExag] = useState(1);
  const [free, setFree] = useState(false);
  const look = useRef<Look>({ free: false, yaw: 0, pitch: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const lastToward = useRef<LonLat | null>(null);
  look.current.free = free;

  useEffect(() => {
    loadScene().then(setSd, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (hud) box.current?.focus();
  }, [hud]);

  const here = data.projection.toLonLat(view.position);
  const nextW = view.next ? data.waypoints.find((w) => w.id === view.next!.id) : null;
  if (nextW) lastToward.current = data.projection.toLonLat(nextW.xy);
  else if (!lastToward.current) lastToward.current = data.projection.toLonLat(data.waypoints[data.waypoints.length - 1].xy);
  const pose = sd ? cameraPose(sd, here, lastToward.current, exag) : null;
  // Couloir 1 m recalculé quand la caméra s'est déplacée de PATCH_STEP_M
  const xy = sd ? toGridXY(sd.grid, here) : [0, 0];
  const cx = Math.round(xy[0] / PATCH_STEP_M) * PATCH_STEP_M, cy = Math.round(xy[1] / PATCH_STEP_M) * PATCH_STEP_M;
  const center = useMemo<[number, number]>(() => [cx, cy], [cx, cy]);

  const follow = () => setFree(false);
  const ds = sd?.datasets;
  const offset = ds?.horizon.vertical_offset_m;

  return (
    <div
      ref={box}
      className={`view3d${hud ? ' view3d-hud' : ''}`}
      tabIndex={0}
      aria-label="Vue 3D du casque. Glisser pour regarder librement ; touche S ou Échap pour revenir au suivi."
      onKeyDown={(e) => {
        if (e.key === 's' || e.key === 'S' || e.key === 'Escape') follow();
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, y: e.clientY, moved: false };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.moved && Math.hypot(dx, dy) < 3) return;
        d.moved = true;
        d.x = e.clientX;
        d.y = e.clientY;
        if (!look.current.free) setFree(true);
        look.current.free = true;
        look.current.yaw -= dx * 0.004;
        look.current.pitch = Math.max(-1.2, Math.min(1.2, look.current.pitch - dy * 0.004));
      }}
      onPointerUp={() => (drag.current = null)}
    >
      {error && <div className="view3d-msg">Vue 3D indisponible : {error}</div>}
      {!sd && !error && <div className="view3d-msg">Chargement du terrain 3D…</div>}
      {sd && pose && (
        <Boundary>
          <Canvas camera={{ fov: FOV_DEG, near: 0.3, far: 40000, position: pose.position }} gl={{ antialias: true }} dpr={[1, 1.5]}>
            <color attach="background" args={[DUST]} />
            <fog attach="fog" args={[DUST, 300, 14000]} />
            <hemisphereLight args={['#f0d2b4', '#5a3e2c', 0.9]} />
            <directionalLight position={[-3000, 2500, 1500]} intensity={1.2} />
            <Sky />
            <Suspense fallback={null}>
              <Terrain sd={sd} center={center} exag={exag} />
            </Suspense>
            <Markers sd={sd} exag={exag} />
            <CameraRig pose={pose} look={look} />
          </Canvas>
        </Boundary>
      )}

      <div className="view3d-controls" onPointerDown={(e) => e.stopPropagation()}>
        <button className="chip" aria-pressed={exag === 2} onClick={() => setExag(exag === 2 ? 1 : 2)}>Relief ×2</button>
        <button className="chip" aria-pressed={!free} onClick={follow} title="Touche S ou Échap">{free ? 'Regard libre · S : suivi' : 'Suivi automatique'}</button>
      </div>
      {exag === 2 && <div className="view3d-exag" role="status">Exagération verticale ×2</div>}
      <div className="view3d-prov">
        Relief : DTM HiRISE 1 m (couloir ±150 m) et 5 m · horizon : DTM CTX 20 m (USGS){offset !== undefined ? `, recalé de ${offset.toFixed(2).replace('.', ',')} m` : ''} · image : ortho HiRISE 25 cm moyennée à 1,5 m, teinte de rendu · position simulée
      </div>
    </div>
  );
}

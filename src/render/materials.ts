/**
 * Scene materials.
 *
 * Today the shading panel exposes one material per role — the cloth, the
 * collision reference model and the floor pedestal — because that is all the
 * studio can vary. The library is deliberately shaped as the single place the
 * renderer asks "what is this surface made of": `forPiece` already takes a piece
 * id, so when a materials node lands after Remesh it can start answering with
 * per-piece materials (and hand out texture bindings) without the renderer, the
 * runtimes or the shading control having to change.
 */

export type MaterialId = 'cloth' | 'reference' | 'pedestal';

export type MaterialParams = {
  /** Linear RGB, 0..1 — the same space the PBR shader works in. */
  color: [number, number, number];
  /** 0 = mirror, 1 = fully diffuse. */
  roughness: number;
  /** 0 = dielectric, 1 = metal. */
  metallic: number;
};

export const MATERIAL_IDS: readonly MaterialId[] = ['cloth', 'reference', 'pedestal'];

/** The pedestal reads as a darker twin of the reference model. */
export const PEDESTAL_DARKENING = 0.75;

/** Values the studio opens with. The reference colour is #d2c0b7 in sRGB. */
export const DEFAULT_MATERIALS: Record<MaterialId, MaterialParams> = {
  cloth: { color: [0.9, 0.01, 0.01], roughness: 0.75, metallic: 0 },
  reference: { color: [0.65237, 0.535642, 0.481952], roughness: 0.37, metallic: 0 },
  // The pedestal is the same material, so it starts with the reference's shading.
  pedestal: { color: [0.65237, 0.535642, 0.481952], roughness: 0.37, metallic: 0 },
};

const SETTINGS_KEY = 'patternCanvas.materials';

export function clamp01(value: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

export function clampColor(
  value: unknown,
  fallback: [number, number, number]
): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [0, 1, 2].map((i) => clamp01(value[i] as number, fallback[i]!)) as [
    number,
    number,
    number,
  ];
}

export function normalizeMaterial(
  value: Partial<MaterialParams> | undefined,
  fallback: MaterialParams
): MaterialParams {
  return {
    color: clampColor(value?.color, fallback.color),
    roughness: clamp01(value?.roughness as number, fallback.roughness),
    metallic: clamp01(value?.metallic as number, fallback.metallic),
  };
}

export function loadMaterialSettings(): Record<MaterialId, MaterialParams> {
  const defaults = cloneDefaults();
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<MaterialId, Partial<MaterialParams>>>;
    for (const id of MATERIAL_IDS) {
      defaults[id] = normalizeMaterial(parsed[id], DEFAULT_MATERIALS[id]);
    }
    return defaults;
  } catch {
    return cloneDefaults();
  }
}

function cloneDefaults(): Record<MaterialId, MaterialParams> {
  return {
    cloth: normalizeMaterial(DEFAULT_MATERIALS.cloth, DEFAULT_MATERIALS.cloth),
    reference: normalizeMaterial(DEFAULT_MATERIALS.reference, DEFAULT_MATERIALS.reference),
    pedestal: normalizeMaterial(DEFAULT_MATERIALS.pedestal, DEFAULT_MATERIALS.pedestal),
  };
}

function saveMaterialSettings(params: Record<MaterialId, MaterialParams>): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(params));
  } catch {
    /* private mode: the settings just do not persist */
  }
}

/** sRGB hex for the colour picker, gamma 2.2 to match the shader's output. */
export function linearToHex(color: [number, number, number]): string {
  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value)) ** (1 / 2.2) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

export function hexToLinear(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return [1, 1, 1];
  const value = match[1]!;
  const channel = (offset: number) =>
    (parseInt(value.slice(offset, offset + 2), 16) / 255) ** 2.2;
  return [channel(0), channel(2), channel(4)];
}

export class MaterialLibrary {
  private params: Record<MaterialId, MaterialParams>;
  private listeners = new Set<() => void>();

  constructor(initial: Record<MaterialId, MaterialParams> = loadMaterialSettings()) {
    this.params = initial;
  }

  get(id: MaterialId): MaterialParams {
    return { ...this.params[id], color: [...this.params[id].color] };
  }

  set(id: MaterialId, patch: Partial<MaterialParams>): void {
    const next = normalizeMaterial({ ...this.params[id], ...patch }, this.params[id]);
    if (sameMaterial(next, this.params[id])) return;
    this.params = { ...this.params, [id]: next };
    saveMaterialSettings(this.params);
    for (const listener of this.listeners) listener();
  }

  /**
   * The pedestal's colour always follows the reference model, 25% darker; its
   * roughness and metallic are its own.
   */
  pedestal(): MaterialParams {
    const reference = this.params.reference;
    const own = this.params.pedestal;
    return {
      color: reference.color.map((channel) => channel * PEDESTAL_DARKENING) as [
        number,
        number,
        number,
      ],
      roughness: own.roughness,
      metallic: own.metallic,
    };
  }

  /**
   * The material a piece is drawn with. Every piece uses the cloth material
   * until a materials node assigns per-piece materials, which is where this
   * lookup will grow: the renderer never decides for itself what a surface is
   * made of.
   */
  forPiece(_pieceId?: string | null): MaterialParams {
    return this.get('cloth');
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function sameMaterial(a: MaterialParams, b: MaterialParams): boolean {
  return (
    a.roughness === b.roughness &&
    a.metallic === b.metallic &&
    a.color[0] === b.color[0] &&
    a.color[1] === b.color[1] &&
    a.color[2] === b.color[2]
  );
}

/**
 * Viewport shading control: the wireframe / simple / PBR toggle that sits to the
 * left of the navigation gnomon, plus the panel behind it for picking an HDRI and
 * blurring its background.
 */
import type { Renderer } from '../Renderer';
import {
  MaterialLibrary,
  PEDESTAL_DARKENING,
  hexToLinear,
  linearToHex,
  type MaterialId,
} from '../render/materials';
import {
  Environment,
  MAX_EXPOSURE,
  MIN_EXPOSURE,
  SHADING_MODES,
  listHdris,
  nextShadingMode,
  shadingModeLabel,
  type ShadingMode,
} from '../render/environment';
import { TONEMAP_MODES, tonemapLabel, type TonemapMode } from '../render/tonemapping';

/** How each material reads in the panel. */
const MATERIAL_ROWS: ReadonlyArray<{ id: MaterialId; label: string; derivedColor?: string }> = [
  { id: 'reference', label: 'Reference model' },
  { id: 'pedestal', label: 'Pedestal', derivedColor: 'reference, 25% darker' },
  { id: 'cloth', label: 'Cloth' },
];

export type ShadingControlOptions = {
  /** The renderer this control drives. */
  renderer: Renderer;
  /** Shared HDRI environment, or null when the device has none. */
  environment: Environment | null;
  /** Shared scene materials, or null when the studio has none (demo pages). */
  materials?: MaterialLibrary | null;
  /** Redraw the viewport after a change that is not a mode switch. */
  onInvalidate: () => void;
};

/** What each operator looks like, in the words of the reference project. */
const TONEMAP_NOTES: Record<TonemapMode, string> = {
  reinhard: 'Reinhard — gentle, low-contrast roll-off',
  uncharted2: 'Uncharted 2 — filmic curve with a white point',
  aces: 'ACES — film-industry standard (default)',
  lottes: 'Lottes — steep filmic curve, deep shadows',
};

const MODE_ICONS: Record<ShadingMode, string> = {
  wireframe: '◇',
  simple: '◑',
  pbr: '●',
};

export class ViewportShadingControl {
  readonly root: HTMLElement;
  private button: HTMLButtonElement;
  private panel: HTMLDivElement;
  private modeButtons = new Map<ShadingMode, HTMLButtonElement>();
  private hdriSelect: HTMLSelectElement;
  private blurInput: HTMLInputElement;
  private blurValue: HTMLElement;
  private exposureInput: HTMLInputElement;
  private exposureValue: HTMLElement;
  private backgroundToggle: HTMLInputElement;
  private tonemapButtons = new Map<TonemapMode, HTMLButtonElement>();
  private materialFields = new Map<
    MaterialId,
    { color: HTMLInputElement; roughness: HTMLInputElement; roughnessOut: HTMLElement; metallic: HTMLInputElement; metallicOut: HTMLElement }
  >();
  private unsubscribe: (() => void) | null = null;
  private materialsUnsubscribe: (() => void) | null = null;
  private opts: ShadingControlOptions;
  private hdris: string[] = [];
  private panelOpen = false;

  constructor(host: HTMLElement, opts: ShadingControlOptions) {
    this.opts = opts;

    this.root = document.createElement('div');
    this.root.className = 'viewport-shading';

    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'viewport-shading-btn';
    this.button.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.cycle();
    });

    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'viewport-shading-caret';
    caret.title = 'Shading options — environment and background blur';
    caret.setAttribute('aria-label', 'Shading options');
    caret.textContent = '▾';
    caret.addEventListener('pointerdown', (e) => e.stopPropagation());
    caret.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.togglePanel();
    });

    this.root.append(this.button, caret);

    this.panel = document.createElement('div');
    this.panel.className = 'viewport-shading-panel';
    this.panel.hidden = true;
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.panel.innerHTML = `
      <div class="viewport-shading-row viewport-shading-modes" role="group" aria-label="Shading mode"></div>
      <label class="viewport-shading-field">
        <span>HDRI</span>
        <select class="viewport-shading-hdri"></select>
      </label>
      <label class="viewport-shading-field">
        <span>Background blur</span>
        <input type="range" class="viewport-shading-blur" min="0" max="100" step="1" />
        <output class="viewport-shading-blur-value"></output>
      </label>
      <label class="viewport-shading-field">
        <span>Exposure</span>
        <input type="range" class="viewport-shading-exposure" min="${MIN_EXPOSURE * 100}" max="${MAX_EXPOSURE * 100}" step="5" />
        <output class="viewport-shading-exposure-value"></output>
      </label>
      <label class="viewport-shading-check">
        <input type="checkbox" class="viewport-shading-background" />
        <span>Show background</span>
      </label>
      <details class="viewport-shading-materials">
        <summary>Materials</summary>
        <div class="viewport-shading-material-list"></div>
      </details>
      <details class="viewport-shading-tonemap">
        <summary>Tonemapping</summary>
        <div
          class="viewport-shading-tonemap-list"
          role="group"
          aria-label="Tonemapping operator"
        ></div>
      </details>
      <p class="viewport-shading-hint">
        The HDRI is unwrapped as a sphere and also lights PBR shading; exposure
        applies to both.
      </p>
    `;
    this.root.appendChild(this.panel);

    const modes = this.panel.querySelector('.viewport-shading-modes') as HTMLElement;
    for (const mode of SHADING_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'viewport-shading-mode';
      btn.dataset.mode = mode;
      btn.textContent = `${MODE_ICONS[mode]} ${shadingModeLabel(mode)}`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setMode(mode);
      });
      modes.appendChild(btn);
      this.modeButtons.set(mode, btn);
    }

    this.hdriSelect = this.panel.querySelector('.viewport-shading-hdri') as HTMLSelectElement;
    this.hdriSelect.addEventListener('change', () => {
      const environment = this.opts.environment;
      if (!environment) return;
      void environment.setHdri(this.hdriSelect.value || null).catch((error: unknown) => {
        this.hdriSelect.title = error instanceof Error ? error.message : 'Could not load that HDRI';
      });
    });

    this.blurInput = this.panel.querySelector('.viewport-shading-blur') as HTMLInputElement;
    this.blurValue = this.panel.querySelector('.viewport-shading-blur-value') as HTMLElement;
    this.blurInput.addEventListener('input', () => {
      const value = Number(this.blurInput.value) / 100;
      this.blurValue.textContent = `${this.blurInput.value}%`;
      this.opts.environment?.setBlur(value);
      this.opts.onInvalidate();
    });

    this.exposureInput = this.panel.querySelector(
      '.viewport-shading-exposure'
    ) as HTMLInputElement;
    this.exposureValue = this.panel.querySelector(
      '.viewport-shading-exposure-value'
    ) as HTMLElement;
    this.exposureInput.addEventListener('input', () => {
      const value = Number(this.exposureInput.value) / 100;
      this.exposureValue.textContent = `${value.toFixed(2)}x`;
      this.opts.environment?.setExposure(value);
      this.opts.onInvalidate();
    });

    this.buildMaterialRows();
    this.buildTonemapRows();

    this.backgroundToggle = this.panel.querySelector(
      '.viewport-shading-background'
    ) as HTMLInputElement;
    this.backgroundToggle.addEventListener('change', () => {
      this.opts.environment?.setBackgroundVisible(this.backgroundToggle.checked);
      this.opts.onInvalidate();
    });

    host.appendChild(this.root);
    this.bindOutsideClick();
    this.syncFromState();

    const materials = this.opts.materials ?? null;
    if (materials) {
      this.materialsUnsubscribe = materials.onChange(() => this.syncMaterialFields());
    }

    const environment = this.opts.environment;
    if (environment) {
      this.unsubscribe = environment.onChange(() => this.syncEnvironmentFields());
      void this.loadHdriList();
    } else {
      this.hdriSelect.disabled = true;
      this.blurInput.disabled = true;
      this.exposureInput.disabled = true;
      this.backgroundToggle.disabled = true;
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.materialsUnsubscribe?.();
    this.materialsUnsubscribe = null;
    document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
    this.root.remove();
  }

  /** Re-read the renderer: the mode can change without this control knowing. */
  syncFromState(): void {
    const mode = this.opts.renderer.getShadingMode();
    this.button.textContent = `${MODE_ICONS[mode]} ${shadingModeLabel(mode)}`;
    this.button.title = 'Viewport shading — click to cycle wireframe, simple, PBR';
    this.button.dataset.mode = mode;
    for (const [candidate, btn] of this.modeButtons) {
      btn.classList.toggle('is-active', candidate === mode);
    }
    this.syncEnvironmentFields();
  }

  /** One colour + roughness/metallic row per material in the library. */
  private buildMaterialRows(): void {
    const list = this.panel.querySelector('.viewport-shading-material-list') as HTMLElement;
    const materials = this.opts.materials ?? null;
    for (const row of MATERIAL_ROWS) {
      const wrap = document.createElement('div');
      wrap.className = 'viewport-shading-material';
      wrap.dataset.material = row.id;

      const head = document.createElement('label');
      head.className = 'viewport-shading-material-head';
      const name = document.createElement('span');
      name.textContent = row.label;
      const color = document.createElement('input');
      color.type = 'color';
      color.className = 'viewport-shading-material-color';
      color.title = row.derivedColor ? `Follows the ${row.derivedColor}` : `${row.label} colour`;
      head.append(name, color);
      wrap.appendChild(head);
      if (row.derivedColor) color.disabled = true;

      const slider = (label: string, cls: string) => {
        const field = document.createElement('label');
        field.className = 'viewport-shading-material-field';
        const text = document.createElement('span');
        text.textContent = label;
        const input = document.createElement('input');
        input.type = 'range';
        input.className = cls;
        input.min = '0';
        input.max = '100';
        input.step = '1';
        const out = document.createElement('output');
        field.append(text, input, out);
        wrap.appendChild(field);
        return { input, out };
      };
      const roughness = slider('Roughness', 'viewport-shading-material-roughness');
      const metallic = slider('Metallic', 'viewport-shading-material-metallic');

      list.appendChild(wrap);
      this.materialFields.set(row.id, {
        color,
        roughness: roughness.input,
        roughnessOut: roughness.out,
        metallic: metallic.input,
        metallicOut: metallic.out,
      });

      const apply = (patch: { color?: [number, number, number]; roughness?: number; metallic?: number }) => {
        materials?.set(row.id, patch);
        this.opts.onInvalidate();
      };
      color.addEventListener('input', () => apply({ color: hexToLinear(color.value) }));
      roughness.input.addEventListener('input', () =>
        apply({ roughness: Number(roughness.input.value) / 100 })
      );
      metallic.input.addEventListener('input', () =>
        apply({ metallic: Number(metallic.input.value) / 100 })
      );
      if (!materials) {
        color.disabled = true;
        roughness.input.disabled = true;
        metallic.input.disabled = true;
      }
    }
    this.syncMaterialFields();
  }

  /** One button per operator: they all live in the shaders, picked by a uniform. */
  private buildTonemapRows(): void {
    const list = this.panel.querySelector('.viewport-shading-tonemap-list') as HTMLElement;
    for (const mode of TONEMAP_MODES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'viewport-shading-tonemap-option';
      btn.dataset.tonemap = mode;
      btn.textContent = tonemapLabel(mode);
      btn.title = TONEMAP_NOTES[mode];
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.opts.environment?.setTonemap(mode);
        this.opts.onInvalidate();
        this.syncEnvironmentFields();
      });
      if (!this.opts.environment) btn.disabled = true;
      list.appendChild(btn);
      this.tonemapButtons.set(mode, btn);
    }
  }

  private syncMaterialFields(): void {
    const materials = this.opts.materials ?? null;
    if (!materials) return;
    const pedestal = materials.pedestal();
    for (const [id, fields] of this.materialFields) {
      const material = id === 'pedestal' ? pedestal : materials.get(id);
      const hex = linearToHex(material.color);
      if (fields.color.value !== hex) fields.color.value = hex;
      fields.color.title =
        id === 'pedestal'
          ? `Pedestal — follows the reference model, ${Math.round(PEDESTAL_DARKENING * 100)}% darker`
          : fields.color.title;
      const roughness = Math.round(material.roughness * 100);
      const metallic = Math.round(material.metallic * 100);
      if (Number(fields.roughness.value) !== roughness) fields.roughness.value = String(roughness);
      if (Number(fields.metallic.value) !== metallic) fields.metallic.value = String(metallic);
      fields.roughnessOut.textContent = `${roughness}%`;
      fields.metallicOut.textContent = `${metallic}%`;
    }
  }

  private syncEnvironmentFields(): void {
    const settings = this.opts.environment?.currentSettings;
    if (!settings) return;
    if (this.hdriSelect.value !== (settings.hdri ?? '')) {
      this.hdriSelect.value = settings.hdri ?? '';
    }
    const percent = Math.round(settings.blur * 100);
    if (Number(this.blurInput.value) !== percent) {
      this.blurInput.value = String(percent);
    }
    this.blurValue.textContent = `${percent}%`;
    const exposure = Math.round(settings.exposure * 100);
    if (Number(this.exposureInput.value) !== exposure) {
      this.exposureInput.value = String(exposure);
    }
    this.exposureValue.textContent = `${(exposure / 100).toFixed(2)}x`;
    this.backgroundToggle.checked = settings.background;
    for (const [mode, btn] of this.tonemapButtons) {
      btn.classList.toggle('is-active', mode === settings.tonemap);
    }
    this.blurInput.disabled = !settings.hdri;
    this.exposureInput.disabled = !settings.hdri;
    this.syncMaterialFields();
  }

  private async loadHdriList(): Promise<void> {
    this.hdris = await listHdris();
    const options = ['<option value="">None</option>'].concat(
      this.hdris.map((file) => `<option value="${file}">${file.replace(/\.\w+$/, '')}</option>`)
    );
    this.hdriSelect.innerHTML = options.join('');
    this.syncEnvironmentFields();
  }

  private cycle(): void {
    this.setMode(nextShadingMode(this.opts.renderer.getShadingMode()));
  }

  private setMode(mode: ShadingMode): void {
    this.opts.renderer.setShadingMode(mode);
    this.opts.environment?.rememberShadingMode(mode);
    this.syncFromState();
    this.opts.onInvalidate();
  }

  private togglePanel(): void {
    this.panelOpen = !this.panelOpen;
    this.panel.hidden = !this.panelOpen;
    if (this.panelOpen) this.syncFromState();
  }

  private closePanel(): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.panel.hidden = true;
  }

  private onDocumentPointerDown = (e: PointerEvent): void => {
    if (!this.panelOpen) return;
    if (e.target instanceof Node && this.root.contains(e.target)) return;
    this.closePanel();
  };

  private bindOutsideClick(): void {
    document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
  }
}

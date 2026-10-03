import {
  MEASUREMENT_FIELDS,
  MEASUREMENT_GROUPS,
  MANDATORY_MEASUREMENT_IDS,
  isWeightField,
  type MeasurementField,
} from '../project/measurements';
import type { Avatar, AvatarLibrary } from '../project/avatars';
import {
  addAvatar,
  duplicateAvatar,
  loadAvatarLibrary,
  removeAvatar,
  setActiveAvatar,
  updateAvatar,
} from '../persistence/avatarLibrary';
import { FIELD_DRIVERS, autoCapableFields } from '../avatar/makehuman/generate';

export type AvatarReport = {
  heightCm: number;
  measured: Record<string, number>;
  saturated: string[];
  driven?: string[];
  applied?: boolean;
};

export type AvatarGenerationOptions = { sdfResolution?: number };

export type AvatarPreviewElements = { canvas: HTMLCanvasElement; overlay: HTMLElement };

export type AvatarModalCallbacks = {
  onClose: () => void;
  /** Fired after any library change, so the host can refresh dependents. */
  onChange?: (library: AvatarLibrary) => void;
  /** Render the 3D preview + rulers for an avatar (does not touch the sims). */
  onPreview?: (
    avatar: Avatar,
    elements: AvatarPreviewElements,
    setStatus: (text: string) => void
  ) => Promise<AvatarReport | null>;
  /** Called before the preview canvas is replaced/destroyed. */
  onPreviewDispose?: (canvas: HTMLCanvasElement) => void;
  /** Toggle the 3D ruler overlay. */
  onShowRulers?: (show: boolean) => void;
  /** Hovering a measurement row highlights its ruler in the 3D view (null = none). */
  onHighlightField?: (field: string | null) => void;
  /** Generate + bake the avatar and apply it to the sims. */
  onGenerate?: (
    avatar: Avatar,
    setStatus: (text: string) => void,
    options: AvatarGenerationOptions
  ) => Promise<AvatarReport | null>;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LENGTH_UNIT = { cm: 'cm', in: 'in' } as const;

const FIELD_LABELS = new Map(MEASUREMENT_FIELDS.map((f) => [f.id, f.label]));

/** Fields a 3D avatar's measurements can drive (plus height). */
const DRIVEN_FIELDS: readonly string[] = [...Object.keys(FIELD_DRIVERS), 'height'];

/** Fields the model can produce but which the user need not supply. */
const AUTO_FIELDS: readonly string[] = autoCapableFields();

/**
 * Unified avatar editor. Three columns: the avatar list, a live 3D view with
 * measurement "tape" rulers, and the measurement fields. The 2D/3D, ruler and
 * gender controls sit above the viewport; the SDF/generate controls below it.
 *
 * Measurements that the model can produce carry a toggle: on = take the value
 * from the generated model, off = enter it by hand.
 */
export class AvatarModal {
  private readonly root: HTMLElement;
  private readonly callbacks: AvatarModalCallbacks;
  private library: AvatarLibrary | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private previewCanvas: HTMLCanvasElement | null = null;
  private overlayEl: HTMLElement | null = null;
  private previewToken = 0;
  private showRulers = true;
  /** Keys of collapsed accordions, preserved across re-renders. */
  private readonly accordionKeys = new Set<string>();

  constructor(root: HTMLElement, callbacks: AvatarModalCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  async open(): Promise<void> {
    this.library = await loadAvatarLibrary();
    this.render();
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.previewToken++;
    if (this.previewCanvas) this.callbacks.onPreviewDispose?.(this.previewCanvas);
    this.previewCanvas = null;
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  private get active(): Avatar | null {
    const library = this.library;
    if (!library) return null;
    return library.sets.find((s) => s.id === library.activeId) ?? library.sets[0] ?? null;
  }

  private render(): void {
    const library = this.library;
    const active = this.active;
    if (!library || !active) return;

    // The previous preview canvas is about to be replaced — release its GPU buffers.
    this.previewToken++;
    if (this.previewCanvas) {
      this.callbacks.onPreviewDispose?.(this.previewCanvas);
      this.previewCanvas = null;
    }

    const is3d = active.kind === '3d';
    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal measure-modal avatar-modal" role="dialog" aria-labelledby="avatarTitle">
          <div class="studio-modal-header">
            <h2 id="avatarTitle">Avatars</h2>
            <button type="button" class="studio-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div class="measure-layout">
            <aside class="measure-sets">
              <div class="measure-sets-head">
                <span>People</span>
                <div class="measure-sets-buttons">
                  <button type="button" data-set-act="add" title="Add an avatar" aria-label="Add an avatar">+</button>
                  <button type="button" data-set-act="duplicate" title="Duplicate this avatar" aria-label="Duplicate this avatar">⧉</button>
                  <button type="button" data-set-act="remove" class="is-danger" title="Delete this avatar" aria-label="Delete this avatar" ${
                    library.sets.length <= 1 ? 'disabled' : ''
                  }>−</button>
                </div>
              </div>
              <div class="measure-set-list" role="tablist" aria-label="Avatars">
                ${library.sets
                  .map(
                    (set) => `
                  <button type="button" role="tab" class="measure-set-tab${
                    set.id === active.id ? ' is-active' : ''
                  }" data-set-id="${set.id}" aria-selected="${set.id === active.id}">
                    <span class="measure-set-name">${escapeHtml(set.name)}</span>
                    <span class="measure-set-count">${set.kind === '3d' ? '3D' : '2D'} · ${
                      Object.keys(set.values).length
                    }/${MEASUREMENT_FIELDS.length}</span>
                  </button>`
                  )
                  .join('')}
              </div>
            </aside>
            <section class="measure-fields">
              <div class="measure-fields-head">
                <label class="measure-name">
                  <span>Name</span>
                  <input type="text" id="measureName" value="${escapeHtml(active.name)}" />
                </label>
                <label class="measure-unit">
                  <span>Units</span>
                  <select id="measureUnit">
                    <option value="cm"${active.unit === 'cm' ? ' selected' : ''}>cm</option>
                    <option value="in"${active.unit === 'in' ? ' selected' : ''}>in</option>
                  </select>
                </label>
              </div>
              <div class="avatar-split">
                <div class="avatar-view${is3d ? '' : ' is-2d'}">
                  <div class="avatar-view-head">
                    <select id="avatarKind" aria-label="Avatar kind">
                      <option value="2d"${!is3d ? ' selected' : ''}>2D — measurements only</option>
                      <option value="3d"${is3d ? ' selected' : ''}>3D — generated model</option>
                    </select>
                    <label class="avatar-3d-rulers">
                      <input type="checkbox" id="avatarShowRulers"${this.showRulers ? ' checked' : ''} />
                      <span>Rulers</span>
                    </label>
                  </div>
                  <label class="avatar-3d-slider avatar-3d-only">
                    <span class="avatar-3d-slider-label">Sex Hormones at Puberty</span>
                    <input type="range" id="avatarGender" min="0" max="1" step="0.01" value="${active.gender.toFixed(
                      2
                    )}" />
                    <span class="avatar-3d-slider-scale"><em>Female</em><em>Male</em></span>
                  </label>
                  <div class="avatar-view-canvas">
                    <canvas class="avatar-canvas"></canvas>
                    <div class="avatar-view-overlay"></div>
                    <div class="avatar-view-hint">Drag to rotate · shift-drag to move up/down · scroll to zoom · hover a ruler</div>
                    <div class="avatar-view-empty" id="avatarViewEmpty">${
                      is3d ? 'Preparing 3D view…' : 'Switch to 3D to see the model'
                    }</div>
                  </div>
                  <div class="avatar-view-foot avatar-3d-only">
                    <label class="avatar-3d-collision">
                      <span>Collision</span>
                      <select id="avatarCollision">
                        <option value="triangle"${!active.sdfResolution ? ' selected' : ''}>Triangle mesh</option>
                        <option value="32"${active.sdfResolution === 32 ? ' selected' : ''}>SDF 32³ — fastest</option>
                        <option value="48"${active.sdfResolution === 48 ? ' selected' : ''}>SDF 48³ — balanced</option>
                        <option value="64"${active.sdfResolution === 64 ? ' selected' : ''}>SDF 64³ — high detail</option>
                      </select>
                    </label>
                    <label class="avatar-3d-decouple">
                      <input type="checkbox" id="avatarDecoupled"${active.decoupled ? ' checked' : ''} />
                      <span>Decouple — edit the model directly</span>
                    </label>
                    <div class="avatar-3d-actions">
                      <button type="button" class="primary" id="avatarGenerate">Generate model</button>
                      <span class="muted" id="avatar3dStatus">${active.model ? 'Model cached' : 'Not generated yet'}</span>
                    </div>
                  </div>
                </div>
                <div class="measure-scroll" id="measureScroll">
                  ${this.sectionsHtml(active)}
                </div>
              </div>
            </section>
          </div>
          <div class="studio-modal-actions measure-actions">
            <span class="muted measure-hint">Saved on this device · available in every project</span>
            <button type="button" class="primary" data-modal-close>Done</button>
          </div>
        </div>
      </div>
    `;
    this.bind(active);

    this.previewCanvas = this.root.querySelector('.avatar-canvas');
    this.overlayEl = this.root.querySelector('.avatar-view-overlay');
    if (is3d) void this.refreshPreview(active);
  }

  /** Required (driver) measurements first, then everything the model can derive. */
  private sectionsHtml(active: Avatar): string {
    const mandatory = new Set(MANDATORY_MEASUREMENT_IDS);
    const required = MEASUREMENT_FIELDS.filter((f) => mandatory.has(f.id));
    const additional = MEASUREMENT_FIELDS.filter((f) => !mandatory.has(f.id));
    return [
      this.sectionHtml('required', 'Required measurements', required, active),
      this.sectionHtml('additional', 'Derived & additional', additional, active),
    ].join('');
  }

  private sectionHtml(
    id: string,
    title: string,
    fields: readonly MeasurementField[],
    active: Avatar
  ): string {
    const key = `sec:${id}`;
    const groups = MEASUREMENT_GROUPS.map((group) => {
      const inGroup = fields.filter((f) => f.group === group.id);
      return inGroup.length ? this.groupHtml(`${key}:${group.id}`, group.label, inGroup, active) : '';
    }).join('');
    return `
      <details class="measure-section" data-acc="${key}"${this.accordionKeys.has(key) ? '' : ' open'}>
        <summary>
          <span>${escapeHtml(title)}</span>
          <span class="measure-section-count">${fields.length}</span>
        </summary>
        <div class="measure-section-body">${groups}</div>
      </details>`;
  }

  private groupHtml(key: string, label: string, fields: readonly MeasurementField[], active: Avatar): string {
    return `
      <details class="measure-group" data-acc="${key}"${this.accordionKeys.has(key) ? '' : ' open'}>
        <summary>${escapeHtml(label)}</summary>
        <div class="measure-grid">
          ${fields.map((field) => this.fieldHtml(field.id, field.label, field.tip, active)).join('')}
        </div>
      </details>`;
  }

  private fieldHtml(id: string, label: string, tip: string, active: Avatar): string {
    const value = active.values[id];
    const suffix = isWeightField(id) ? 'kg' : LENGTH_UNIT[active.unit];
    const driven = DRIVEN_FIELDS.includes(id);
    const autoCapable = AUTO_FIELDS.includes(id);
    const auto = autoCapable && this.isAuto(id);
    const classes = ['measure-field'];
    if (driven) classes.push('is-driven');
    if (autoCapable) classes.push('has-auto');
    if (auto) classes.push('is-auto');
    return `
      <div class="${classes.join(' ')}"${driven ? ' data-driven="true"' : ''}>
        <div class="measure-field-row" data-field="${id}">
          ${
            autoCapable
              ? `<button type="button" class="measure-auto${auto ? ' is-on' : ''}" data-auto-field="${id}"
                   aria-pressed="${auto}" title="${
                     auto
                       ? 'Using the generated model value — click to enter manually'
                       : 'Manual — click to use the generated model value'
                   }">⇄</button>`
              : '<span class="measure-auto-spacer"></span>'
          }
          <label class="measure-field-label" for="mf-${id}" title="${escapeHtml(tip)}">${escapeHtml(label)}</label>
        </div>
        <span class="measure-field-input">
          <input type="number" id="mf-${id}" step="0.1" inputmode="decimal"
            data-measure-id="${id}"
            value="${value === undefined ? '' : String(value)}"
            placeholder="—"${auto ? ' readonly' : ''} />
          <span class="measure-field-unit">${suffix}</span>
        </span>
      </div>`;
  }

  /** On = value comes from the generated model (unless overridden to manual). */
  private isAuto(field: string): boolean {
    const active = this.active;
    if (!active || !AUTO_FIELDS.includes(field)) return false;
    return !(active.manual ?? []).includes(field);
  }

  private setPreviewStatus(text: string): void {
    const empty = this.root.querySelector('#avatarViewEmpty') as HTMLElement | null;
    if (empty) {
      empty.textContent = text;
      empty.hidden = text === '';
    }
  }

  private async refreshPreview(active: Avatar): Promise<void> {
    const canvas = this.previewCanvas;
    const overlay = this.overlayEl;
    if (!canvas || !overlay || !this.callbacks.onPreview) {
      this.setPreviewStatus('');
      return;
    }
    const token = ++this.previewToken;
    this.setPreviewStatus('Preparing 3D view…');
    try {
      const report = await this.callbacks.onPreview(active, { canvas, overlay }, (text) =>
        this.setPreviewStatus(text)
      );
      if (token !== this.previewToken) return;
      this.setPreviewStatus('');
      if (report) this.applyReport(report, false);
    } catch {
      if (token === this.previewToken) this.setPreviewStatus('Could not render preview');
    }
  }

  private bind(active: Avatar): void {
    this.root.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.callbacks.onClose();
    });
    this.root.querySelectorAll('[data-modal-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.callbacks.onClose());
    });

    this.root.querySelectorAll('details[data-acc]').forEach((el) => {
      el.addEventListener('toggle', () => {
        const key = (el as HTMLElement).dataset.acc;
        if (!key) return;
        if ((el as HTMLDetailsElement).open) this.accordionKeys.delete(key);
        else this.accordionKeys.add(key);
      });
    });

    // Hovering the label side of a row highlights the matching ruler in the 3D view.
    this.root.querySelectorAll<HTMLElement>('.measure-field-row[data-field]').forEach((row) => {
      const field = row.dataset.field;
      if (!field) return;
      row.addEventListener('pointerenter', () => this.callbacks.onHighlightField?.(field));
      row.addEventListener('pointerleave', () => this.callbacks.onHighlightField?.(null));
    });

    this.root.querySelector('[data-set-act="add"]')?.addEventListener('click', () => {
      void addAvatar().then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });
    this.root.querySelector('[data-set-act="duplicate"]')?.addEventListener('click', () => {
      void duplicateAvatar(active.id).then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });
    this.root.querySelector('[data-set-act="remove"]')?.addEventListener('click', () => {
      if (!confirm(`Delete “${active.name}” and its measurements?`)) return;
      void removeAvatar(active.id).then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });

    this.root.querySelectorAll('.measure-set-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const id = (tab as HTMLElement).dataset.setId;
        if (!id || id === active.id) return;
        void setActiveAvatar(id).then((library) => {
          this.library = library;
          this.render();
        });
      });
    });

    const nameInput = this.root.querySelector('#measureName') as HTMLInputElement | null;
    nameInput?.addEventListener('input', () => {
      const label = this.root.querySelector('.measure-set-tab.is-active .measure-set-name');
      if (label) label.textContent = nameInput.value;
      this.queuePatch({ name: nameInput.value });
    });

    const unitSelect = this.root.querySelector('#measureUnit') as HTMLSelectElement | null;
    unitSelect?.addEventListener('change', () => {
      const unit = unitSelect.value === 'in' ? 'in' : 'cm';
      if (unit === active.unit) return;
      // Convert the stored numbers too — the values are kept in this unit.
      const factor = unit === 'in' ? 1 / 2.54 : 2.54;
      const values: Record<string, number> = {};
      for (const [id, value] of Object.entries(active.values)) {
        values[id] = isWeightField(id) ? value : Math.round(value * factor * 10) / 10;
      }
      void updateAvatar(active.id, { unit, values }).then((library) => {
        this.library = library;
        this.render();
      });
    });

    const kindSelect = this.root.querySelector('#avatarKind') as HTMLSelectElement | null;
    kindSelect?.addEventListener('change', () => {
      const kind = kindSelect.value === '3d' ? '3d' : '2d';
      void updateAvatar(active.id, { kind }).then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });

    const showRulers = this.root.querySelector('#avatarShowRulers') as HTMLInputElement | null;
    showRulers?.addEventListener('change', () => {
      this.showRulers = showRulers.checked;
      this.callbacks.onShowRulers?.(showRulers.checked);
    });

    const genderSlider = this.root.querySelector('#avatarGender') as HTMLInputElement | null;
    genderSlider?.addEventListener('input', () => {
      this.queuePatch({ gender: Number(genderSlider.value) });
    });

    const decoupled = this.root.querySelector('#avatarDecoupled') as HTMLInputElement | null;
    decoupled?.addEventListener('change', () => {
      void updateAvatar(active.id, { decoupled: decoupled.checked }).then((library) => {
        this.library = library;
        this.notify();
      });
    });

    const collision = this.root.querySelector('#avatarCollision') as HTMLSelectElement | null;
    collision?.addEventListener('change', () => {
      const sdfResolution = collision.value === 'triangle' ? 0 : Number(collision.value);
      void updateAvatar(active.id, { sdfResolution }).then((library) => {
        this.library = library;
        this.notify();
      });
    });

    this.root.querySelector('#avatarGenerate')?.addEventListener('click', () => {
      void this.handleGenerate();
    });

    // Model/manual toggle for non-critical measurements.
    this.root.querySelectorAll('button[data-auto-field]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const field = (btn as HTMLElement).dataset.autoField;
        if (!field) return;
        const current = active.manual ?? [];
        const manual = this.isAuto(field);
        const next = manual ? [...new Set([...current, field])] : current.filter((f) => f !== field);
        void updateAvatar(active.id, { manual: next }).then((library) => {
          this.library = library;
          this.notify();
          this.render();
        });
      });
    });

    this.root.querySelectorAll('input[data-measure-id]').forEach((input) => {
      input.addEventListener('input', () => {
        const el = input as HTMLInputElement;
        const id = el.dataset.measureId;
        if (!id) return;
        const next = { ...(this.active?.values ?? {}) };
        const raw = el.value.trim();
        if (raw === '') delete next[id];
        else {
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          next[id] = n;
        }
        this.queuePatch({ values: next });
        this.updateCount();
      });
    });
  }

  private updateCount(): void {
    const count = this.root.querySelector('.measure-set-tab.is-active .measure-set-count');
    if (!count) return;
    const values = this.active?.values ?? {};
    count.textContent = `${this.active?.kind === '3d' ? '3D' : '2D'} · ${Object.keys(values).length}/${
      MEASUREMENT_FIELDS.length
    }`;
  }

  private async handleGenerate(): Promise<void> {
    const active = this.active;
    if (!active || !this.callbacks.onGenerate) return;

    const status = this.root.querySelector('#avatar3dStatus') as HTMLElement | null;
    const button = this.root.querySelector('#avatarGenerate') as HTMLButtonElement | null;
    const setStatus = (text: string) => {
      if (status) status.textContent = text;
    };

    button?.setAttribute('disabled', 'true');
    setStatus('Generating…');

    try {
      await this.flush();
      const info = await this.callbacks.onGenerate(active, setStatus, {
        sdfResolution: active.sdfResolution || undefined,
      });
      if (info) {
        this.applyReport(info, true);
        void this.refreshPreview(active);
      }
    } finally {
      button?.removeAttribute('disabled');
    }
  }

  /**
   * Show the status and pull the model's values into any field toggled to
   * "use generated value".
   */
  private applyReport(report: AvatarReport, applied: boolean): void {
    const active = this.active;
    if (!active) return;

    const status = this.root.querySelector('#avatar3dStatus') as HTMLElement | null;
    if (status) {
      const warn = report.saturated.length
        ? ` · outside range: ${report.saturated.map((f) => FIELD_LABELS.get(f) ?? f).join(', ')}`
        : '';
      status.textContent = `Height ${report.heightCm.toFixed(1)} cm${
        applied ? ' · applied to sims' : ''
      }${warn}`;
    }

    const convert = active.unit === 'in';
    const next = { ...active.values };
    let changed = false;
    for (const field of AUTO_FIELDS) {
      if (!this.isAuto(field)) continue;
      const measured = report.measured[field];
      if (!Number.isFinite(measured)) continue;
      const factor = isWeightField(field) ? 1 : convert ? 1 / 2.54 : 1;
      const value = Math.round(measured * factor * 10) / 10;
      if (next[field] !== value) {
        next[field] = value;
        changed = true;
      }
      const input = this.root.querySelector(`input[data-measure-id="${field}"]`) as HTMLInputElement | null;
      if (input) input.value = String(value);
    }
    if (changed) {
      this.queuePatch({ values: next });
      this.updateCount();
    }
  }

  /** Coalesce keystrokes into one write; also used to flush before generating. */
  private queuePatch(
    patch: Partial<
      Pick<Avatar, 'name' | 'unit' | 'values' | 'kind' | 'gender' | 'decoupled' | 'model' | 'manual'>
    >
  ): void {
    const active = this.active;
    if (!active) return;
    Object.assign(active, patch);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flush();
    }, 300);
  }

  private async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const set = this.active;
    if (!set) return;
    const library = await updateAvatar(set.id, {
      name: set.name,
      unit: set.unit,
      values: set.values,
      kind: set.kind,
      gender: set.gender,
      decoupled: set.decoupled,
      manual: set.manual,
    });
    this.library = library;
    this.notify();
  }

  private notify(): void {
    if (this.library) this.callbacks.onChange?.(this.library);
  }
}

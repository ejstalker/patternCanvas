import {
  MEASUREMENT_FIELDS,
  MEASUREMENT_GROUPS,
  isWeightField,
  type MeasurementLibrary,
  type MeasurementSet,
} from '../project/measurements';
import {
  addMeasurementSet,
  duplicateMeasurementSet,
  loadMeasurementLibrary,
  removeMeasurementSet,
  setActiveMeasurementSet,
  updateMeasurementSet,
} from '../persistence/measurementLibrary';

export type MeasurementModalCallbacks = {
  onClose: () => void;
  /** Fired after any change, so the host can refresh status text. */
  onChange?: (library: MeasurementLibrary) => void;
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const LENGTH_UNIT = { cm: 'cm', in: 'in' } as const;

/**
 * Two-pane editor for the global body-measurement library: the people you draft
 * for down the left as vertical tabs, their numbers on the right.
 *
 * Everything writes straight through to the library as you type — there is no
 * Save button, because these sets belong to the studio rather than to one
 * project and losing them to a closed dialog would be hostile.
 */
export class MeasurementModal {
  private readonly root: HTMLElement;
  private readonly callbacks: MeasurementModalCallbacks;
  private library: MeasurementLibrary | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement, callbacks: MeasurementModalCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
  }

  async open(): Promise<void> {
    this.library = await loadMeasurementLibrary();
    this.render();
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.root.hidden = true;
    this.root.innerHTML = '';
  }

  private get active(): MeasurementSet | null {
    const library = this.library;
    if (!library) return null;
    return library.sets.find((s) => s.id === library.activeId) ?? library.sets[0] ?? null;
  }

  private render(): void {
    const library = this.library;
    const active = this.active;
    if (!library || !active) return;

    this.root.hidden = false;
    this.root.innerHTML = `
      <div class="studio-modal-backdrop" data-modal-dismiss>
        <div class="studio-modal measure-modal" role="dialog" aria-labelledby="measureTitle">
          <div class="studio-modal-header">
            <h2 id="measureTitle">Body measurements</h2>
            <button type="button" class="studio-modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div class="measure-layout">
            <aside class="measure-sets">
              <div class="measure-sets-head">
                <span>People</span>
                <div class="measure-sets-buttons">
                  <button type="button" data-set-act="add" title="Add a person" aria-label="Add a person">+</button>
                  <button type="button" data-set-act="duplicate" title="Duplicate this person" aria-label="Duplicate this person">⧉</button>
                  <button type="button" data-set-act="remove" class="is-danger" title="Delete this person" aria-label="Delete this person" ${
                    library.sets.length <= 1 ? 'disabled' : ''
                  }>−</button>
                </div>
              </div>
              <div class="measure-set-list" role="tablist" aria-label="Measurement sets">
                ${library.sets
                  .map(
                    (set) => `
                  <button type="button" role="tab" class="measure-set-tab${
                    set.id === active.id ? ' is-active' : ''
                  }" data-set-id="${set.id}" aria-selected="${set.id === active.id}">
                    <span class="measure-set-name">${escapeHtml(set.name)}</span>
                    <span class="measure-set-count">${Object.keys(set.values).length}/${MEASUREMENT_FIELDS.length}</span>
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
              <div class="measure-scroll">
                ${MEASUREMENT_GROUPS.map((group) => this.groupHtml(group.id, group.label, active)).join('')}
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
  }

  private groupHtml(groupId: string, label: string, active: MeasurementSet): string {
    const fields = MEASUREMENT_FIELDS.filter((f) => f.group === groupId);
    if (fields.length === 0) return '';
    return `
      <div class="measure-group">
        <h4>${escapeHtml(label)}</h4>
        <div class="measure-grid">
          ${fields
            .map((field) => {
              const value = active.values[field.id];
              const suffix = isWeightField(field.id) ? 'kg' : LENGTH_UNIT[active.unit];
              return `
              <label class="measure-field" title="${escapeHtml(field.tip)}">
                <span class="measure-field-label">${escapeHtml(field.label)}</span>
                <span class="measure-field-input">
                  <input type="number" step="0.1" inputmode="decimal"
                    data-measure-id="${field.id}"
                    value="${value === undefined ? '' : String(value)}"
                    placeholder="—" />
                  <span class="measure-field-unit">${suffix}</span>
                </span>
              </label>`;
            })
            .join('')}
        </div>
      </div>
    `;
  }

  private bind(active: MeasurementSet): void {
    this.root.querySelector('[data-modal-dismiss]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.callbacks.onClose();
    });
    this.root.querySelectorAll('[data-modal-close]').forEach((btn) => {
      btn.addEventListener('click', () => this.callbacks.onClose());
    });

    this.root.querySelector('[data-set-act="add"]')?.addEventListener('click', () => {
      void addMeasurementSet().then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });
    this.root.querySelector('[data-set-act="duplicate"]')?.addEventListener('click', () => {
      void duplicateMeasurementSet(active.id).then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });
    this.root.querySelector('[data-set-act="remove"]')?.addEventListener('click', () => {
      if (!confirm(`Delete “${active.name}” and its measurements?`)) return;
      void removeMeasurementSet(active.id).then((library) => {
        this.library = library;
        this.notify();
        this.render();
      });
    });

    this.root.querySelectorAll('.measure-set-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const id = (tab as HTMLElement).dataset.setId;
        if (!id || id === active.id) return;
        void setActiveMeasurementSet(id).then((library) => {
          this.library = library;
          this.render();
        });
      });
    });

    const nameInput = this.root.querySelector('#measureName') as HTMLInputElement | null;
    nameInput?.addEventListener('input', () => {
      // Keep the tab label in step without rebuilding the whole dialog mid-typing.
      const label = this.root.querySelector('.measure-set-tab.is-active .measure-set-name');
      if (label) label.textContent = nameInput.value;
      this.queuePatch({ name: nameInput.value });
    });

    const unitSelect = this.root.querySelector('#measureUnit') as HTMLSelectElement | null;
    unitSelect?.addEventListener('change', () => {
      const unit = unitSelect.value === 'in' ? 'in' : 'cm';
      void updateMeasurementSet(active.id, { unit }).then((library) => {
        this.library = library;
        this.render();
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
        const count = this.root.querySelector('.measure-set-tab.is-active .measure-set-count');
        if (count) count.textContent = `${Object.keys(next).length}/${MEASUREMENT_FIELDS.length}`;
      });
    });
  }

  /** Coalesce keystrokes into one write. */
  private queuePatch(patch: Parameters<typeof updateMeasurementSet>[1]): void {
    const active = this.active;
    if (!active) return;
    if (patch.name !== undefined) active.name = patch.name;
    if (patch.values !== undefined) active.values = patch.values;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const set = this.active;
      if (!set) return;
      void updateMeasurementSet(set.id, {
        name: set.name,
        unit: set.unit,
        values: set.values,
      }).then((library) => {
        this.library = library;
        this.notify();
      });
    }, 300);
  }

  private notify(): void {
    if (this.library) this.callbacks.onChange?.(this.library);
  }
}

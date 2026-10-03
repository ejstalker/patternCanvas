import type { BlockDefinition } from './spec';
import { SKIRT_BLOCK } from './skirt';

/**
 * The built-in block library.
 *
 * Only the skirt is here so far — the bodice blocks need real bezier handles for
 * their armhole and neckline French curves and land next. The shape of this list
 * is the whole point: a definition is a component, and adding one is adding an
 * entry, not changing the system.
 */
export const BLOCK_DEFINITIONS: BlockDefinition[] = [SKIRT_BLOCK];

export function getBlockDefinition(id: string): BlockDefinition | null {
  return BLOCK_DEFINITIONS.find((definition) => definition.id === id) ?? null;
}

/** Group the library for the placement menu. */
export function blockDefinitionsByCategory(): Array<{
  category: BlockDefinition['category'];
  label: string;
  definitions: BlockDefinition[];
}> {
  const labels: Record<BlockDefinition['category'], string> = {
    bodice: 'Bodice',
    skirt: 'Skirt',
  };
  const out: Array<{
    category: BlockDefinition['category'];
    label: string;
    definitions: BlockDefinition[];
  }> = [];
  for (const definition of BLOCK_DEFINITIONS) {
    let group = out.find((entry) => entry.category === definition.category);
    if (!group) {
      group = { category: definition.category, label: labels[definition.category], definitions: [] };
      out.push(group);
    }
    group.definitions.push(definition);
  }
  return out;
}

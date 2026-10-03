import type { BlockDefinition } from './spec';
import { BODICE_BACK_BLOCK, BODICE_FRONT_BLOCK } from './bodice';
import { SKIRT_BLOCK } from './skirt';

/**
 * The built-in block library.
 *
 * A definition is a component: adding one is adding an entry here, not changing
 * the system. Pieces a definition drafts are ordinary `PatternPiece`s, so
 * meshing, seams, drape and export need no special case for any of them.
 */
export const BLOCK_DEFINITIONS: BlockDefinition[] = [
  BODICE_FRONT_BLOCK,
  BODICE_BACK_BLOCK,
  SKIRT_BLOCK,
];

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

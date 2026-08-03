/**
 * Constraint graph builders re-exported / helpers for XPBD engines.
 * Topology construction lives in meshTopology.ts.
 */
export type {
  StretchConstraint,
  BendConstraint,
  LraConstraint,
  ClothTopology,
} from './meshTopology';
export { buildClothTopology, buildBendConstraints, FALLBACK_PIECE_ID } from './meshTopology';
